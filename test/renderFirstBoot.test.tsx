/**
 * Render-first boot (#364): the first paint must show the last-persisted
 * projects/threads/selection instead of the empty states, and a thread
 * switch must paint the cached transcript instead of the "Select a thread"
 * pane while threads.get is in flight.
 *
 * Run: node --import=./test/support/render.mjs --test test/renderFirstBoot.test.tsx
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { mount, inAct } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  thread,
  detail,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import type { ThreadDetail, ThreadInfo } from "../src/shared/ipc";

const SNAPSHOT_KEY = "coder.bootSnapshot.v1";
const DETAIL_KEY = "coder.threadDetail.v1";

function marker(text: string) {
  return { id: `m-${text}`, role: "assistant" as const, text, createdAt: Date.now() };
}

function seedSnapshot(snap: {
  savedAt?: number;
  projects?: unknown[];
  threads?: unknown[];
  selectedThreadId?: string | null;
  /** Extra raw fields, e.g. padding for the oversized case. */
  extra?: Record<string, unknown>;
}) {
  window.localStorage.setItem(
    SNAPSHOT_KEY,
    JSON.stringify({
      savedAt: Date.now(),
      projects: [],
      threads: [],
      selectedThreadId: null,
      ...snap.extra,
      ...snap,
      extra: undefined,
    }),
  );
}

async function boot(fake: FakeCoder, seed?: () => void) {
  // window must exist before seeding storage and installing the fake, and
  // dom.ts creates it on first mount, so mount an empty shell first.
  const shell = await mount(<div />);
  seed?.();
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

beforeEach(() => {
  // The dom singleton (and its localStorage) outlives each test; a snapshot
  // written by one test's debounced persist must not hydrate the next.
  (globalThis as { window?: Window }).window?.localStorage.clear();
});

describe("render-first boot (#364)", () => {
  it("paints cached thread titles before threads.list resolves, then reconciles", async () => {
    const cached = [
      thread({ id: "tc1", title: "cached alpha title" }),
      thread({ id: "tc2", title: "cached beta title" }),
    ];
    const fresh = [thread({ id: "tf1", title: "fresh gamma title" })];
    const fake = createFakeCoder({
      threads: fresh,
      details: {
        // threads.get merges the returned row into the list; give the cached
        // selection a detail with its own row or the fake's default row
        // ("first thread") overwrites the cached title mid-test.
        tc1: detail({ thread: cached[0]! }),
        tf1: detail({ thread: fresh[0]! }),
      },
    });
    // Hold threads.list until the test releases it, so the pre-reconcile
    // paint is observable.
    let resolveList: ((t: ThreadInfo[]) => void) | null = null;
    fake.api.threads.list = (() =>
      new Promise<ThreadInfo[]>((res) => {
        resolveList = res;
      })) as typeof fake.api.threads.list;

    const m = await boot(fake, () => {
      seedSnapshot({ threads: cached, selectedThreadId: "tc1" });
    });
    try {
      await m.flush();
      assert.ok(
        m.text().includes("cached alpha title"),
        `cached titles must paint before the list resolves, got: ${m.text().slice(0, 200)}`,
      );
      assert.ok(
        !m.text().includes("fresh gamma title"),
        "the fresh list must not have landed yet",
      );
      assert.ok(
        !m.text().includes("No threads yet"),
        "the empty sidebar state must not flash",
      );

      await inAct(async () => {
        resolveList!(fresh);
        await Promise.resolve();
      });
      await m.flush();
      assert.ok(
        m.text().includes("fresh gamma title"),
        "the fresh list must reconcile once it resolves",
      );
      assert.ok(
        !m.text().includes("cached alpha title"),
        "cached rows must be replaced by the reconcile",
      );
    } finally {
      m.unmount();
    }
  });

  it("restores the cached selection when the id still exists in the fresh list", async () => {
    const t1 = thread({ id: "t1", title: "first thread" });
    const t2 = thread({ id: "t2", title: "second thread" });
    const fake = createFakeCoder({
      threads: [t1, t2],
      details: {
        t1: detail({ thread: t1, messages: [marker("transcript one")] }),
        t2: detail({ thread: t2, messages: [marker("transcript two")] }),
      },
    });
    const m = await boot(fake, () => {
      // Without the snapshot, boot would prefer t1 (first non-archived).
      seedSnapshot({ threads: [t1, t2], selectedThreadId: "t2" });
    });
    try {
      await m.flush();
      assert.ok(
        fake.of("threads.get").some((c) => c.args[0] === "t2"),
        "the cached selection must survive the fresh list landing",
      );
      assert.ok(
        m.text().includes("transcript two"),
        `the cached selection's transcript must render, got: ${m.text().slice(0, 200)}`,
      );
    } finally {
      m.unmount();
    }
  });

  it("falls back to the preferred thread when the cached selection is gone", async () => {
    const t1 = thread({ id: "t1", title: "surviving thread" });
    const fake = createFakeCoder({
      threads: [t1],
      details: { t1: detail({ thread: t1 }) },
    });
    const m = await boot(fake, () => {
      seedSnapshot({ threads: [t1], selectedThreadId: "ghost" });
    });
    try {
      await m.flush();
      assert.ok(
        fake.of("threads.get").some((c) => c.args[0] === "t1"),
        "a deleted cached selection must fall back to the fresh list's preferred thread",
      );
    } finally {
      m.unmount();
    }
  });

  it("ignores a corrupt snapshot and boots normally", async () => {
    const t1 = thread({ id: "t1", title: "normal boot title" });
    const fake = createFakeCoder({ threads: [t1] });
    const m = await boot(fake, () => {
      window.localStorage.setItem(SNAPSHOT_KEY, "{not json");
    });
    try {
      await m.flush();
      assert.ok(
        m.text().includes("normal boot title"),
        `a corrupt snapshot must fall back to the normal load, got: ${m.text().slice(0, 200)}`,
      );
    } finally {
      m.unmount();
    }
  });

  it("ignores a stale snapshot", async () => {
    const fresh = thread({ id: "tf", title: "fresh boot title" });
    const fake = createFakeCoder({ threads: [fresh] });
    const m = await boot(fake, () => {
      seedSnapshot({
        savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        threads: [thread({ id: "old", title: "ancient title" })],
        selectedThreadId: "old",
      });
    });
    try {
      await m.flush();
      assert.ok(m.text().includes("fresh boot title"));
      assert.ok(
        !m.text().includes("ancient title"),
        "a week-old snapshot must not hydrate",
      );
    } finally {
      m.unmount();
    }
  });

  it("ignores an oversized snapshot", async () => {
    const fresh = thread({ id: "tf", title: "fresh boot title" });
    const fake = createFakeCoder({ threads: [fresh] });
    const m = await boot(fake, () => {
      seedSnapshot({
        threads: [thread({ id: "big", title: "padded title" })],
        extra: { padding: "x".repeat(4_100_000) },
      });
    });
    try {
      await m.flush();
      assert.ok(m.text().includes("fresh boot title"));
      assert.ok(
        !m.text().includes("padded title"),
        "an oversized snapshot must not hydrate",
      );
    } finally {
      m.unmount();
    }
  });

  it("paints the cached transcript on thread switch instead of the empty pane", async () => {
    const ta = thread({ id: "ta", title: "alpha thread" });
    const tb = thread({ id: "tb", title: "beta thread" });
    const taDetail = detail({
      thread: ta,
      messages: [marker("alpha transcript marker")],
    });
    const tbCached: ThreadDetail = detail({
      thread: tb,
      messages: [marker("beta cached marker")],
    });
    const tbFresh: ThreadDetail = detail({
      thread: tb,
      messages: [marker("beta fresh marker")],
    });
    const fake = createFakeCoder({
      threads: [ta, tb],
      details: { ta: taDetail, tb: tbFresh },
    });
    // Hold threads.get(tb) so the switch is observable mid-flight.
    const origGet = fake.api.threads.get;
    let resolveTb: ((d: ThreadDetail) => void) | null = null;
    fake.api.threads.get = ((id: string) => {
      if (id === "tb") {
        fake.calls.push({ channel: "threads.get", args: [id] });
        return new Promise<ThreadDetail>((res) => {
          resolveTb = res;
        });
      }
      return origGet(id);
    }) as typeof fake.api.threads.get;

    const m = await boot(fake, () => {
      window.localStorage.setItem(DETAIL_KEY, JSON.stringify(tbCached));
    });
    try {
      await m.flush();
      assert.ok(
        m.text().includes("alpha transcript marker"),
        "precondition: the boot-selected thread's transcript renders",
      );

      const card = m.query('button[aria-label="Select thread: beta thread"]');
      assert.ok(card, "the beta thread card must be present");
      await m.click(card);
      await m.flush();

      assert.ok(
        m.text().includes("beta cached marker"),
        `the cached transcript must paint during the fetch, got: ${m.text().slice(0, 200)}`,
      );
      assert.ok(
        !m.text().includes("Select a thread"),
        "the empty pane must not flash while the cached detail is showing",
      );

      await inAct(async () => {
        resolveTb!(tbFresh);
        await Promise.resolve();
      });
      await m.flush();
      assert.ok(
        m.text().includes("beta fresh marker"),
        "the fresh detail must replace the cached one once it resolves",
      );
    } finally {
      m.unmount();
    }
  });
});
