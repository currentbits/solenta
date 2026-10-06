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
import {
  defaultPaneLayout,
  openPane,
  serializePaneLayout,
} from "../src/paneLayout";

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

describe("cached thread detail write (#1475)", () => {
  it("writes on idle, coalescing saves into one write of the latest detail", async () => {
    const shell = await mount(<div />);
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
    };
    const prevIdle = w.requestIdleCallback;
    const idle: Array<{ cb: () => void; timeout?: number }> = [];
    w.requestIdleCallback = (cb, opts) => idle.push({ cb, timeout: opts?.timeout });
    // Assigning onto the Storage instance would just store an item.
    const store = Object.getPrototypeOf(window.localStorage) as Storage;
    const prevSet = store.setItem;
    const writes: string[] = [];
    store.setItem = function (key: string, value: string) {
      if (key === DETAIL_KEY) writes.push(value);
      return prevSet.call(this, key, value);
    };
    try {
      const { saveCachedThreadDetail, loadCachedThreadDetail } = await import(
        "../src/bootSnapshot"
      );
      const first = detail({ thread: thread({ id: "t-idle" }), messages: [marker("FIRST")] });
      const second = detail({ thread: thread({ id: "t-idle" }), messages: [marker("SECOND")] });
      saveCachedThreadDetail(first);
      saveCachedThreadDetail(second);
      assert.equal(writes.length, 0, "no synchronous setItem on the save path");
      assert.equal(idle.length, 1, "saves before the idle slot share one callback");
      assert.ok(idle[0]!.timeout! > 0, "the idle write has a timeout fallback");
      assert.equal(
        loadCachedThreadDetail("t-idle")?.messages[0]?.text,
        "SECOND",
        "a load before the write sees the pending detail",
      );
      idle[0]!.cb();
      assert.equal(writes.length, 1);
      assert.ok(writes[0]!.includes("SECOND") && !writes[0]!.includes("FIRST"));
    } finally {
      store.setItem = prevSet;
      if (prevIdle) w.requestIdleCallback = prevIdle;
      else delete w.requestIdleCallback;
      shell.unmount();
    }
  });
});

describe("boot snapshot without archived threads (#1475)", () => {
  it("drops archived rows but keeps the selection and live rows' handoff chain", async () => {
    const shell = await mount(<div />);
    try {
      const { saveBootSnapshot, loadBootSnapshot } = await import(
        "../src/bootSnapshot"
      );
      const threads = [
        thread({ id: "live" }),
        thread({ id: "old", archived: true }),
        thread({ id: "picked", archived: true }),
        // live grandchild → archived worker → archived lead
        thread({ id: "lead", archived: true }),
        thread({ id: "mid", archived: true, handoffFrom: "lead", orchWorker: true }),
        thread({ id: "kid", handoffFrom: "mid", orchWorker: true }),
      ];
      saveBootSnapshot({ projects: [], threads, selectedThreadId: "picked" });
      assert.deepEqual(
        loadBootSnapshot()?.threads.map((t) => t.id),
        ["live", "picked", "lead", "mid", "kid"],
      );
    } finally {
      shell.unmount();
    }
  });

  it("boots with the Settled shelf filled in once the list loads", async () => {
    const live = thread({ id: "t1", title: "live title" });
    const gone = thread({ id: "t2", title: "archived title", archived: true });
    const fake = createFakeCoder({
      threads: [live, gone],
      details: { t1: detail({ thread: live }) },
    });
    const m = await boot(fake, () => {
      seedSnapshot({ threads: [live], selectedThreadId: "t1" });
    });
    try {
      await m.flush();
      assert.match(m.text(), /Settled · 1/);
    } finally {
      m.unmount();
    }
  });
});

describe("pane layout pruning at boot (#1475)", () => {
  it("drops layouts of threads missing from the loaded list", async () => {
    const t1 = thread({ id: "t1", title: "live" });
    const fake = createFakeCoder({
      threads: [t1],
      details: { t1: detail({ thread: t1 }) },
    });
    const split = serializePaneLayout(
      openPane(defaultPaneLayout(), "diff", "pane-1").layout,
    );
    const m = await boot(fake, () => {
      window.localStorage.setItem("coder.paneLayout.gone", split);
      window.localStorage.setItem("coder.paneLayout.t1", split);
    });
    try {
      await m.flush();
      assert.equal(window.localStorage.getItem("coder.paneLayout.gone"), null);
      assert.ok(
        window.localStorage.getItem("coder.paneLayout.t1")?.includes('"diff"'),
        "the open thread keeps its split",
      );
    } finally {
      m.unmount();
    }
  });
});
