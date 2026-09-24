/**
 * Sidebar list motion gate.
 *
 * auto-animate reads `ResizeObserver` once, when its module loads. This file
 * is its own `node --test` process, so installing the observer and then
 * importing the sidebar is enough. Other suite files cannot freeze that
 * decision.
 *
 * auto-animate's poll() arms a setTimeout it never stores. destroy() cannot
 * clear it, and the timeout starts a 2s interval that holds the process
 * open. Timers this file arms are cleared after each test.
 */
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { act, createElement } from "react";
import type { ProviderInfo, ThreadInfo } from "../src/shared/ipc";
import { project, thread } from "./support/fakeCoder";
import { mount, type Mounted } from "./support/dom";

const calls: string[] = [];
let reduced = false;
const mqlListeners = new Set<() => void>();
let Sidebar: typeof import("../src/components/Sidebar").Sidebar;

const origSetTimeout = global.setTimeout;
const origSetInterval = global.setInterval;
const origClearTimeout = global.clearTimeout;
const origClearInterval = global.clearInterval;
const armedTimeouts = new Set<ReturnType<typeof setTimeout>>();
const armedIntervals = new Set<ReturnType<typeof setInterval>>();

function armTimerTracking(): void {
  global.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
    const id = origSetTimeout(fn, ms, ...rest);
    armedTimeouts.add(id);
    return id;
  }) as typeof setTimeout;
  global.setInterval = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
    const id = origSetInterval(fn, ms, ...rest);
    armedIntervals.add(id);
    return id;
  }) as typeof setInterval;
  global.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    armedTimeouts.delete(id);
    origClearTimeout(id);
  }) as typeof clearTimeout;
  global.clearInterval = ((id: ReturnType<typeof setInterval>) => {
    armedIntervals.delete(id);
    origClearInterval(id);
  }) as typeof clearInterval;
}

function drainArmedTimers(): void {
  for (const id of armedTimeouts) origClearTimeout(id);
  for (const id of armedIntervals) origClearInterval(id);
  armedTimeouts.clear();
  armedIntervals.clear();
}

afterEach(() => {
  drainArmedTimers();
});

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

const ledger = project({
  id: "p1",
  slug: "acme/ledger",
  name: "ledger",
  path: "/tmp/ledger",
});

const family: ThreadInfo[] = [
  thread({ id: "orch", title: "Orchestrate the fix", projectId: ledger.id }),
  thread({
    id: "w1",
    title: "Review permissions",
    projectId: ledger.id,
    handoffFrom: "orch",
    orchWorker: true,
  }),
];

function view() {
  return createElement(Sidebar, {
    appName: "Solenta",
    searchPlaceholder: "Search threads...",
    projectsHeader: "All projects",
    projects: [ledger],
    threads: family,
    providers,
    activeThreadId: null,
    onSelectThread() {},
    onCreateThread() {},
    onAddProject() {},
    searchThreads: async (): Promise<ThreadInfo[]> => [],
  });
}

function cards(m: Mounted, id: string): number {
  return m.queryAll(`[data-thread-card="${id}"]`).length;
}

function ghosts(m: Mounted): number {
  return [...m.container.querySelectorAll("*")].filter((el) => "__aa_del" in el)
    .length;
}

async function click(m: Mounted, el: Element | null, detail: number) {
  assert.ok(el, "click target");
  await act(async () => {
    el.dispatchEvent(
      new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail,
      }),
    );
  });
  await m.flush();
}

before(async () => {
  const shell = await mount(createElement("div"));
  shell.unmount();

  class FakeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver;
  globalThis.ResizeObserver = window.ResizeObserver;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLBodyElement = window.HTMLBodyElement;
  globalThis.SVGElement = window.SVGElement;
  globalThis.Node = window.Node;
  globalThis.getComputedStyle = window.getComputedStyle;
  if (typeof window.IntersectionObserver !== "function") {
    window.IntersectionObserver =
      FakeObserver as unknown as typeof IntersectionObserver;
  }
  globalThis.IntersectionObserver = window.IntersectionObserver;

  window.Element.prototype.animate = function animate(this: Element): Animation {
    const anim = {
      playState: "running",
      finished: new Promise<Animation>(() => {}),
      cancel() {
        this.playState = "idle";
      },
      finish() {
        this.playState = "finished";
      },
      addEventListener() {},
      removeEventListener() {},
    };
    calls.push(
      this.getAttribute("data-thread-card") ||
        this.getAttribute("data-sidebar-list") ||
        "?",
    );
    return anim as unknown as Animation;
  };

  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes("prefers-reduced-motion") ? reduced : false;
    },
    media: query,
    onchange: null,
    addEventListener(type: string, cb: () => void) {
      if (type === "change") mqlListeners.add(cb);
    },
    removeEventListener(type: string, cb: () => void) {
      if (type === "change") mqlListeners.delete(cb);
    },
    addListener(cb: () => void) {
      mqlListeners.add(cb);
    },
    removeListener(cb: () => void) {
      mqlListeners.delete(cb);
    },
    dispatchEvent() {
      return false;
    },
  })) as typeof window.matchMedia;

  armTimerTracking();
  ({ Sidebar } = await import("../src/components/Sidebar"));
});

describe("sidebar list motion gate", () => {
  it("animates a pointer disclosure and snaps the keyboard", async () => {
    window.localStorage.removeItem("sidebar:workerOpen");
    reduced = false;
    const m = await mount(view());
    try {
      calls.length = 0;
      await click(m, m.query('[data-family-toggle="orch"]'), 1);
      assert.equal(cards(m, "w1"), 1, "pointer open shows the worker");
      assert.ok(calls.includes("w1"), "pointer open animates the worker row");
      assert.equal(ghosts(m), 0);
    } finally {
      m.unmount();
    }

    window.localStorage.removeItem("sidebar:workerOpen");
    const closed = await mount(view());
    try {
      calls.length = 0;
      await click(closed, closed.query('[data-family-toggle="orch"]'), 0);
      assert.equal(cards(closed, "w1"), 1, "keyboard open shows the worker");
      assert.equal(calls.length, 0, "keyboard open does not animate");
      assert.equal(ghosts(closed), 0);
    } finally {
      closed.unmount();
    }
  });

  it("drops the exit placeholder when keyboard interrupts a close", async () => {
    window.localStorage.removeItem("sidebar:workerOpen");
    reduced = false;
    const m = await mount(view());
    try {
      await click(m, m.query('[data-family-toggle="orch"]'), 1);
      calls.length = 0;
      await click(m, m.query('[data-family-toggle="orch"]'), 1);
      assert.equal(ghosts(m), 1, "a pointer close parks the removed row");
      assert.ok(calls.includes("w1"), "a pointer close animates");

      calls.length = 0;
      await click(m, m.query('[data-family-toggle="orch"]'), 0);
      assert.equal(
        cards(m, "w1"),
        1,
        "reopening during the exit must not leave a second worker row",
      );
      assert.equal(ghosts(m), 0, "the aborted placeholder must leave the list");
      assert.equal(
        (m.html().match(/position:\s*absolute/g) || []).length,
        0,
        "the aborted placeholder must not stay position:absolute",
      );
      assert.equal(calls.length, 0, "the keyboard reopen snaps");
    } finally {
      m.unmount();
    }
  });

  it("stays still under reduced motion and animates again after it is lifted", async () => {
    window.localStorage.removeItem("sidebar:workerOpen");
    reduced = true;
    const m = await mount(view());
    try {
      calls.length = 0;
      await click(m, m.query('[data-family-toggle="orch"]'), 1);
      assert.equal(cards(m, "w1"), 1, "reduced motion still opens the family");
      assert.equal(calls.length, 0, "reduced motion does not animate");
      assert.ok(mqlListeners.size > 0, "the preference listener is attached");

      reduced = false;
      await act(async () => {
        for (const cb of mqlListeners) cb();
      });
      await m.flush();
      calls.length = 0;
      await click(m, m.query('[data-family-toggle="orch"]'), 1);
      assert.ok(
        calls.includes("w1"),
        "turning motion back on animates the next disclosure",
      );
    } finally {
      reduced = false;
      m.unmount();
    }
  });
});
