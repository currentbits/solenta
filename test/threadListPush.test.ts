/**
 * threads:changed row patches (#1475): main's encoder + the renderer's
 * applier must leave exactly the list a full push would.
 * Run: node --experimental-strip-types --test test/threadListPush.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applyThreadListPush,
  reconcileThreadList,
} from "../src/threadPatch.ts";
import type { ThreadInfo, ThreadListPush } from "../src/shared/ipc.ts";

const require = createRequire(import.meta.url);
const { Store } = require("../electron/store.js");
const { listThreads } = require("../electron/services.js");
const { createThreadListEncoder } = require("../electron/threadListPush.js");

type Row = { id: string; [k: string]: unknown };

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function row(id: string, projectId: string): Row {
  return {
    id,
    projectId,
    title: id,
    provider: "claude",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    hypotheses: [{ id: "h", text: "detail-only" }],
    suggestions: [],
    lastActivity: "detail-only",
  };
}

describe("threads:changed row patches", () => {
  for (const seed of [1, 2, 3]) {
    it(`patched list equals listThreads after random edits (seed ${seed})`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-list-push-"));
      try {
        const store = new Store(path.join(dir, "store.json"));
        store.setProjects([
          { id: "p1", name: "one", slug: "one", path: dir },
          { id: "p2", name: "two", slug: "two", path: dir },
        ]);
        let n = 0;
        store.setThreads(
          Array.from({ length: 40 }, () => row(`t${n++}`, n % 2 ? "p1" : "p2")),
        );
        const encode = createThreadListEncoder();
        const rand = seeded(seed);
        const pick = () => {
          const all = store.getThreads();
          return all[Math.floor(rand() * all.length)];
        };
        const edits: Array<() => void> = [
          () => store.updateThread(pick().id, { title: `r${rand()}` }),
          () => store.updateThread(pick().id, { pinned: rand() < 0.5 }),
          () => store.updateThread(pick().id, { archived: rand() < 0.5 }),
          () => store.updateThread(pick().id, { status: "working" }),
          () => store.updateThread(pick().id, { trashedAt: Date.now() }),
          () => store.updateThread(pick().id, { memoryConsolidate: true }),
          () => store.removeThread(pick().id),
          () =>
            store.setThreads([row(`t${n++}`, "p1"), ...store.getThreads()]),
          () => store.setThreads(store.getThreads().slice().reverse()),
          () => store.setProjects(store.getProjects().slice()),
          () => {}, // no-op tick still pushes
        ];

        let held: ThreadInfo[] = [];
        let heldSeq: number | null = null;
        let patches = 0;
        for (let step = 0; step < 400; step++) {
          if (store.getThreads().length < 5) {
            store.setThreads([row(`t${n++}`, "p2"), ...store.getThreads()]);
          }
          edits[Math.floor(rand() * edits.length)]();
          const full = listThreads(store);
          // structuredClone stands in for the IPC hop: no shared identity.
          const push = structuredClone(encode(full)) as ThreadListPush;
          if (!Array.isArray(push) && "base" in push) patches++;
          const next = applyThreadListPush(held, push, heldSeq);
          assert.ok(next, `step ${step}: in-order patch must apply`);
          held = reconcileThreadList(held, next);
          heldSeq = Array.isArray(push) ? null : push.seq;
          assert.deepEqual(held, structuredClone(full), `step ${step}`);
        }
        assert.ok(patches > 200, `most pushes are patches (${patches})`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("a single-row change pushes only that row", () => {
    const encode = createThreadListEncoder();
    const a = { id: "a", title: "a" };
    const b = { id: "b", title: "b" };
    encode([a, b]);
    const b2 = { id: "b", title: "renamed" };
    assert.deepEqual(encode([a, b2]), {
      seq: 2,
      base: 1,
      upserts: [b2],
      removedIds: [],
    });
    assert.deepEqual(encode([b2]), {
      seq: 3,
      base: 2,
      upserts: [],
      removedIds: ["a"],
    });
  });

  it("falls back to a full list when a row is added or the order moves", () => {
    const encode = createThreadListEncoder();
    const a = { id: "a" };
    const b = { id: "b" };
    encode([a, b]);
    assert.deepEqual(encode([b, a]), { seq: 2, threads: [b, a] });
    const c = { id: "c" };
    assert.deepEqual(encode([b, a, c]), { seq: 3, threads: [b, a, c] });
  });

  it("refuses a patch on top of the wrong base or an unknown row", () => {
    const list = [{ id: "a" }] as ThreadInfo[];
    const patch = {
      seq: 5,
      base: 4,
      upserts: [{ id: "a", title: "x" }] as ThreadInfo[],
      removedIds: [],
    };
    assert.equal(applyThreadListPush(list, patch, 3), null);
    assert.equal(applyThreadListPush(list, patch, null), null);
    assert.ok(applyThreadListPush(list, patch, 4));
    const stranger = { ...patch, upserts: [{ id: "zz" }] as ThreadInfo[] };
    assert.equal(applyThreadListPush(list, stranger, 4), null);
  });
});
