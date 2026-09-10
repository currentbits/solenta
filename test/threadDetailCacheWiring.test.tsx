/**
 * Renderer ThreadDetail cache bound (#1225), through the real useCoder hook.
 * Run: node --import=./test/support/render.mjs --test test/threadDetailCacheWiring.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setFlagsFromString } from "v8";
import { runInNewContext } from "vm";
import { inAct, mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
  detail,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import { useCoder } from "../src/useCoder";
import {
  DETAIL_CACHE_MAX_BYTES,
  DETAIL_CACHE_MAX_ENTRIES,
  estimateThreadDetailBytes,
} from "../src/threadDetailCache.ts";
import type { ChatMessage, ThreadDetail, ThreadInfo } from "../src/shared/ipc";

type Coder = ReturnType<typeof useCoder>;

function markerMsg(id: string, text: string): ChatMessage {
  return { id: `m-${id}`, role: "assistant", text, createdAt: Date.now() };
}

function Probe({ latest }: { latest: { current: Coder | null } }) {
  const coder = useCoder();
  latest.current = coder;
  // Same gate App uses: a cache miss must not paint the previous thread.
  const open =
    coder.detail && coder.detail.thread.id === coder.selectedThreadId
      ? coder.detail
      : null;
  return (
    <div
      data-selected={coder.selectedThreadId ?? ""}
      data-detail={open?.thread.id ?? ""}
      data-marker={open?.messages[0]?.text?.slice(0, 80) ?? ""}
      data-n={String(open?.messages.length ?? 0)}
      data-error={coder.detailError ?? ""}
    />
  );
}

async function boot(fake: FakeCoder, latest: { current: Coder | null }) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  const m = await mount(<Probe latest={latest} />);
  await m.flush();
  return m;
}

async function waitFor(
  m: { flush: () => Promise<void> },
  pred: () => boolean,
  message: string,
): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (pred()) return;
    await m.flush();
  }
  throw new Error(message);
}

beforeEach(() => {
  (globalThis as { window?: Window }).window?.localStorage.clear();
});

afterEach(() => {
  (globalThis as { window?: Window }).window?.localStorage.clear();
});

describe("useCoder detail cache bound (#1225)", () => {
  it("evicts the oldest visited transcript so a held refetch does not paint it", async () => {
    const count = DETAIL_CACHE_MAX_ENTRIES + 4;
    const rows: ThreadInfo[] = Array.from({ length: count }, (_, i) =>
      thread({ id: `t${i}`, title: `thread ${i}` }),
    );
    const fake = createFakeCoder({
      projects: [project()],
      threads: rows,
      details: Object.fromEntries(
        rows.map((row) => [
          row.id,
          detail({
            thread: row,
            messages: [markerMsg(row.id, `marker:${row.id}`)],
          }),
        ]),
      ),
    });
    const latest: { current: Coder | null } = { current: null };
    const m = await boot(fake, latest);
    try {
      await waitFor(
        m,
        () => latest.current?.detail?.thread.id === rows[0]!.id,
        "boot must select the first thread",
      );
      for (const row of rows) {
        await inAct(() => {
          latest.current!.selectThread(row.id);
        });
        await waitFor(
          m,
          () => m.query("[data-detail]")?.getAttribute("data-detail") === row.id,
          `expected detail ${row.id}`,
        );
      }

      window.localStorage.clear();
      const origGet = fake.api.threads.get;
      let releaseOldest: ((d: ThreadDetail) => void) | null = null;
      fake.api.threads.get = ((id: string) => {
        if (id === "t0") {
          fake.calls.push({ channel: "threads.get", args: [id] });
          return new Promise<ThreadDetail>((res) => {
            releaseOldest = res;
          });
        }
        return origGet(id);
      }) as typeof fake.api.threads.get;

      await inAct(() => {
        latest.current!.selectThread("t0");
      });
      await m.flush();
      assert.equal(
        m.query("[data-marker]")?.getAttribute("data-marker"),
        "",
        "evicted t0 must not paint from the session cache while threads.get is held",
      );

      await inAct(async () => {
        releaseOldest!(
          detail({
            thread: rows[0]!,
            messages: [markerMsg("t0", "marker:t0-fresh")],
          }),
        );
        await Promise.resolve();
      });
      await waitFor(
        m,
        () =>
          m.query("[data-marker]")?.getAttribute("data-marker") ===
          "marker:t0-fresh",
        "evicted thread must refetch",
      );
    } finally {
      m.unmount();
    }
  });

  it("still paints a recent working-set thread while threads.get is held", async () => {
    const count = DETAIL_CACHE_MAX_ENTRIES + 4;
    const rows: ThreadInfo[] = Array.from({ length: count }, (_, i) =>
      thread({ id: `t${i}`, title: `thread ${i}` }),
    );
    const fake = createFakeCoder({
      projects: [project()],
      threads: rows,
      details: Object.fromEntries(
        rows.map((row) => [
          row.id,
          detail({
            thread: row,
            messages: [markerMsg(row.id, `marker:${row.id}`)],
          }),
        ]),
      ),
    });
    const latest: { current: Coder | null } = { current: null };
    const m = await boot(fake, latest);
    try {
      for (const row of rows) {
        await inAct(() => {
          latest.current!.selectThread(row.id);
        });
        await waitFor(
          m,
          () => m.query("[data-detail]")?.getAttribute("data-detail") === row.id,
          `expected detail ${row.id}`,
        );
      }
      window.localStorage.clear();
      const recentId = `t${count - 2}`;
      const origGet = fake.api.threads.get;
      fake.api.threads.get = ((id: string) => {
        if (id === recentId) {
          fake.calls.push({ channel: "threads.get", args: [id] });
          return new Promise<ThreadDetail>(() => {});
        }
        return origGet(id);
      }) as typeof fake.api.threads.get;

      await inAct(() => {
        latest.current!.selectThread(recentId);
      });
      await m.flush();
      assert.equal(
        m.query("[data-marker]")?.getAttribute("data-marker"),
        `marker:${recentId}`,
        "a recent cached thread must still render-first",
      );
    } finally {
      m.unmount();
    }
  });

  it("drops a deleted thread from the cache, including remote threads:changed", async () => {
    const a = thread({ id: "ta", title: "alpha" });
    const b = thread({ id: "tb", title: "beta" });
    const fake = createFakeCoder({
      projects: [project()],
      threads: [a, b],
      details: {
        ta: detail({ thread: a, messages: [markerMsg("ta", "marker:ta")] }),
        tb: detail({ thread: b, messages: [markerMsg("tb", "marker:tb")] }),
      },
    });
    const latest: { current: Coder | null } = { current: null };
    const m = await boot(fake, latest);
    try {
      await waitFor(
        m,
        () => latest.current?.detail?.thread.id === "ta",
        "boot selects alpha",
      );
      await inAct(() => {
        latest.current!.selectThread("tb");
      });
      await waitFor(
        m,
        () => m.query("[data-detail]")?.getAttribute("data-detail") === "tb",
        "beta open",
      );

      await inAct(() => {
        fake.emitThreads([b]);
      });
      await m.flush();
      window.localStorage.clear();

      const origGet = fake.api.threads.get;
      fake.api.threads.get = ((id: string) => {
        if (id === "ta") {
          fake.calls.push({ channel: "threads.get", args: [id] });
          return new Promise<ThreadDetail>(() => {});
        }
        return origGet(id);
      }) as typeof fake.api.threads.get;

      await inAct(() => {
        latest.current!.selectThread("ta");
      });
      await m.flush();
      assert.equal(
        m.query("[data-marker]")?.getAttribute("data-marker"),
        "",
        "a remotely deleted thread must not paint from cache",
      );
    } finally {
      m.unmount();
    }
  });

  it("drops cached details for a removed project", async () => {
    const p1 = project({ id: "p1", name: "one" });
    const p2 = project({ id: "p2", name: "two", path: "/tmp/two" });
    const a = thread({ id: "ta", title: "alpha", projectId: "p1" });
    const b = thread({ id: "tb", title: "beta", projectId: "p2" });
    const fake = createFakeCoder({
      projects: [p1, p2],
      threads: [a, b],
      details: {
        ta: detail({ thread: a, messages: [markerMsg("ta", "marker:ta")] }),
        tb: detail({ thread: b, messages: [markerMsg("tb", "marker:tb")] }),
      },
    });
    const latest: { current: Coder | null } = { current: null };
    const m = await boot(fake, latest);
    try {
      await waitFor(
        m,
        () => latest.current?.detail?.thread.id === "ta",
        "boot selects alpha",
      );
      await inAct(() => {
        latest.current!.selectThread("tb");
      });
      await waitFor(
        m,
        () => m.query("[data-detail]")?.getAttribute("data-detail") === "tb",
        "beta open",
      );

      await inAct(async () => {
        await latest.current!.removeProject("p1");
      });
      await m.flush();
      window.localStorage.clear();

      const origGet = fake.api.threads.get;
      fake.api.threads.get = ((id: string) => {
        if (id === "ta") {
          fake.calls.push({ channel: "threads.get", args: [id] });
          return new Promise<ThreadDetail>(() => {});
        }
        return origGet(id);
      }) as typeof fake.api.threads.get;

      await inAct(() => {
        latest.current!.selectThread("ta");
      });
      await m.flush();
      assert.equal(
        m.query("[data-marker]")?.getAttribute("data-marker"),
        "",
        "a removed project's thread must not paint from cache",
      );
    } finally {
      m.unmount();
    }
  });

  it("does not keep an oversized transcript after switching away", async () => {
    const small = thread({ id: "ts", title: "small" });
    const big = thread({ id: "tb", title: "big" });
    const hugeText = "H".repeat(DETAIL_CACHE_MAX_BYTES + 1024);
    const fake = createFakeCoder({
      projects: [project()],
      threads: [small, big],
      details: {
        ts: detail({
          thread: small,
          messages: [markerMsg("ts", "marker:small")],
        }),
        tb: detail({
          thread: big,
          messages: [markerMsg("tb", hugeText)],
        }),
      },
    });
    const latest: { current: Coder | null } = { current: null };
    const m = await boot(fake, latest);
    try {
      await waitFor(
        m,
        () => latest.current?.detail?.thread.id === "ts",
        "boot selects small",
      );
      await inAct(() => {
        latest.current!.selectThread("tb");
      });
      await waitFor(
        m,
        () => m.query("[data-detail]")?.getAttribute("data-detail") === "tb",
        "oversized detail must still be visible while selected",
      );
      await inAct(() => {
        latest.current!.selectThread("ts");
      });
      await waitFor(
        m,
        () => m.query("[data-detail]")?.getAttribute("data-detail") === "ts",
        "small thread open",
      );
      window.localStorage.clear();

      const origGet = fake.api.threads.get;
      fake.api.threads.get = ((id: string) => {
        if (id === "tb") {
          fake.calls.push({ channel: "threads.get", args: [id] });
          return new Promise<ThreadDetail>(() => {});
        }
        return origGet(id);
      }) as typeof fake.api.threads.get;

      await inAct(() => {
        latest.current!.selectThread("tb");
      });
      await m.flush();
      assert.equal(
        m.query("[data-marker]")?.getAttribute("data-marker"),
        "",
        "oversized detail must not stay cached after switch-away",
      );
    } finally {
      m.unmount();
    }
  });

  it("drops a locally deleted thread from the cache", async () => {
    const a = thread({ id: "ta", title: "alpha" });
    const b = thread({ id: "tb", title: "beta" });
    const fake = createFakeCoder({
      projects: [project()],
      threads: [a, b],
      details: {
        ta: detail({ thread: a, messages: [markerMsg("ta", "marker:ta")] }),
        tb: detail({ thread: b, messages: [markerMsg("tb", "marker:tb")] }),
      },
    });
    const latest: { current: Coder | null } = { current: null };
    const m = await boot(fake, latest);
    try {
      await waitFor(
        m,
        () => latest.current?.detail?.thread.id === "ta",
        "boot selects alpha",
      );
      await inAct(async () => {
        await latest.current!.deleteThread();
      });
      await m.flush();
      window.localStorage.clear();

      const origGet = fake.api.threads.get;
      fake.api.threads.get = ((id: string) => {
        if (id === "ta") {
          fake.calls.push({ channel: "threads.get", args: [id] });
          return new Promise<ThreadDetail>(() => {});
        }
        return origGet(id);
      }) as typeof fake.api.threads.get;

      await inAct(() => {
        latest.current!.selectThread("ta");
      });
      await m.flush();
      assert.equal(
        m.query("[data-marker]")?.getAttribute("data-marker"),
        "",
        "a locally deleted thread must not paint from cache",
      );
    } finally {
      m.unmount();
    }
  });

  it("does not keep a streamed update that grows past the byte budget", async () => {
    const a = thread({ id: "ta", title: "alpha", status: "working" });
    const b = thread({ id: "tb", title: "beta" });
    const fake = createFakeCoder({
      projects: [project()],
      threads: [a, b],
      details: {
        ta: detail({ thread: a, messages: [markerMsg("ta", "marker:ta")] }),
        tb: detail({ thread: b, messages: [markerMsg("tb", "marker:tb")] }),
      },
    });
    const latest: { current: Coder | null } = { current: null };
    const m = await boot(fake, latest);
    try {
      await waitFor(
        m,
        () => m.query("[data-detail]")?.getAttribute("data-detail") === "ta",
        "alpha open",
      );
      await inAct(() => {
        fake.emitThread(
          detail({
            thread: a,
            messages: [
              markerMsg("ta", "G".repeat(DETAIL_CACHE_MAX_BYTES + 1024)),
            ],
          }),
        );
      });
      await waitFor(
        m,
        () =>
          (m.query("[data-marker]")?.getAttribute("data-marker") ?? "").startsWith(
            "G",
          ),
        "oversized streamed transcript remains visible while selected",
      );
      await inAct(() => {
        latest.current!.selectThread("tb");
      });
      await waitFor(
        m,
        () => m.query("[data-detail]")?.getAttribute("data-detail") === "tb",
        "beta open",
      );
      window.localStorage.clear();

      const origGet = fake.api.threads.get;
      fake.api.threads.get = ((id: string) => {
        if (id === "ta") {
          fake.calls.push({ channel: "threads.get", args: [id] });
          return new Promise<ThreadDetail>(() => {});
        }
        return origGet(id);
      }) as typeof fake.api.threads.get;

      await inAct(() => {
        latest.current!.selectThread("ta");
      });
      await m.flush();
      assert.equal(
        m.query("[data-marker]")?.getAttribute("data-marker"),
        "",
        "a streamed update that exceeded the budget must not stay cached",
      );
    } finally {
      m.unmount();
    }
  });

  it("ignores a late threads.get from a previous selection", async () => {
    const a = thread({ id: "ta", title: "alpha" });
    const b = thread({ id: "tb", title: "beta" });
    const fake = createFakeCoder({
      projects: [project()],
      threads: [a, b],
      details: {
        ta: detail({ thread: a, messages: [markerMsg("ta", "marker:ta")] }),
        tb: detail({ thread: b, messages: [markerMsg("tb", "marker:tb")] }),
      },
    });
    let releaseA: ((d: ThreadDetail) => void) | null = null;
    const origGet = fake.api.threads.get.bind(fake.api.threads);
    fake.api.threads.get = ((id: string) => {
      fake.calls.push({ channel: "threads.get", args: [id] });
      if (id === "ta") {
        return new Promise<ThreadDetail>((res) => {
          releaseA = res;
        });
      }
      if (id === "tb") {
        return Promise.resolve(
          detail({ thread: b, messages: [markerMsg("tb", "marker:tb")] }),
        );
      }
      return origGet(id);
    }) as typeof fake.api.threads.get;

    const latest: { current: Coder | null } = { current: null };
    const m = await boot(fake, latest);
    try {
      await waitFor(
        m,
        () => latest.current?.selectedThreadId === "ta",
        "boot selects alpha",
      );
      await inAct(() => {
        latest.current!.selectThread("tb");
      });
      await waitFor(
        m,
        () => m.query("[data-detail]")?.getAttribute("data-detail") === "tb",
        "beta must be showing before alpha's late get",
      );
      await inAct(async () => {
        releaseA!(
          detail({ thread: a, messages: [markerMsg("ta", "late-alpha")] }),
        );
        await Promise.resolve();
      });
      await m.flush();
      assert.equal(
        m.query("[data-marker]")?.getAttribute("data-marker"),
        "marker:tb",
        "a late get must not replace the open thread",
      );
      assert.equal(m.query("[data-detail]")?.getAttribute("data-detail"), "tb");
    } finally {
      m.unmount();
    }
  });
});

function tryExposeGc(): (() => void) | null {
  const existing = (globalThis as { gc?: () => void }).gc;
  if (typeof existing === "function") return existing;
  try {
    setFlagsFromString("--expose_gc");
    const gc = runInNewContext("gc") as () => void;
    return typeof gc === "function" ? gc : null;
  } catch {
    return null;
  }
}

async function forceGc(gc: () => void): Promise<void> {
  for (let i = 0; i < 6; i++) {
    gc();
    await new Promise((r) => setImmediate(r));
  }
}

describe("useCoder detail cache GC fixture (#1225)", () => {
  it(
    "visiting fifty history-heavy threads retains a bounded payload after GC",
    { timeout: 60_000 },
    async () => {
      const gc = tryExposeGc();
      const n = 50;
      const rows: ThreadInfo[] = Array.from({ length: n }, (_, i) =>
        thread({
          id: `h${i}`,
          title: `heavy ${i}`,
          status: "done",
        }),
      );
      const weak = new Map<string, WeakRef<ThreadDetail>>();
      const fake = createFakeCoder({
        projects: [project()],
        threads: rows,
        details: {},
      });
      fake.api.threads.get = ((id: string) => {
        fake.calls.push({ channel: "threads.get", args: [id] });
        const row = rows.find((t) => t.id === id) ?? thread({ id });
        const messages: ChatMessage[] = [];
        for (let i = 0; i < 64; i++) {
          messages.push({
            id: `${id}-m${i}`,
            role: "assistant",
            text: `${id}:${i}:` + "x".repeat(16 * 1024),
            createdAt: i,
          });
        }
        const d = detail({ thread: row, messages });
        weak.set(id, new WeakRef(d));
        return Promise.resolve(d);
      }) as typeof fake.api.threads.get;

      const latest: { current: Coder | null } = { current: null };
      const heapBefore = process.memoryUsage().heapUsed;
      const m = await boot(fake, latest);
      try {
        for (const row of rows) {
          await inAct(() => {
            latest.current!.selectThread(row.id);
          });
          await waitFor(
            m,
            () =>
              m.query("[data-detail]")?.getAttribute("data-detail") === row.id,
            `expected heavy detail ${row.id}`,
          );
        }
        await inAct(() => {
          latest.current!.selectThread(null);
        });
        await waitFor(
          m,
          () => m.query("[data-detail]")?.getAttribute("data-detail") === "",
          "selection cleared",
        );
        window.localStorage.clear();

        if (gc) await forceGc(gc);

        let alive = 0;
        let payload = 0;
        for (const ref of weak.values()) {
          const d = ref.deref();
          if (!d) continue;
          alive += 1;
          payload += estimateThreadDetailBytes(d);
        }
        const heapAfter = process.memoryUsage().heapUsed;
        // Probe DOM never renders transcript bodies (only a 80-char slice /
        // counts). This is renderer JS heap, not Electron RSS / main Store.
        console.log(
          JSON.stringify({
            fixture: "useCoder-detail-cache-gc",
            visited: n,
            aliveAfterGc: alive,
            retainedPayloadBytes: payload,
            heapDeltaBytes: heapAfter - heapBefore,
            policy: {
              maxEntries: DETAIL_CACHE_MAX_ENTRIES,
              maxBytes: DETAIL_CACHE_MAX_BYTES,
            },
            gcAvailable: Boolean(gc),
            note: "payload = estimateThreadDetailBytes of WeakRef-alive details; heapDelta includes jsdom/React, not main-process Store",
          }),
        );
        assert.ok(
          alive <= DETAIL_CACHE_MAX_ENTRIES,
          `cached details must be bounded by LRU count, alive=${alive}`,
        );
        assert.ok(
          payload <= DETAIL_CACHE_MAX_BYTES,
          `cached payload must be bounded by the byte budget, payload=${payload}`,
        );
      } finally {
        m.unmount();
      }
    },
  );
});
