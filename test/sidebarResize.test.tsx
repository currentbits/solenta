/**
 * Desktop sidebar resize: persistence, keyboard, pointer, and the narrow drawer.
 *
 * Run: node --import=./test/support/render.mjs --test test/sidebarResize.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { inAct, mount, type Mounted } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  thread,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App.tsx";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STEP,
  SIDEBAR_WIDTH_STEP_COARSE,
} from "../src/sidebarWidth.ts";

async function boot(opts?: {
  fake?: FakeCoder;
  width?: number;
  stored?: string | null;
}) {
  const shell = await mount(<div />);
  installFakeCoder(opts?.fake ?? createFakeCoder());
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: opts?.width ?? 1280,
  });
  if (opts && "stored" in opts) {
    if (opts.stored == null) window.localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    else window.localStorage.setItem(SIDEBAR_WIDTH_KEY, opts.stored);
  }
  shell.unmount();
  return mount(<App />);
}

function separator(m: Mounted): HTMLElement {
  const handle = m.query("[data-sidebar-resize]");
  assert.ok(handle, "sidebar resize handle");
  return handle as HTMLElement;
}

function appliedWidth(m: Mounted): string {
  const app = m.query('[data-layout="app"]') as HTMLElement | null;
  assert.ok(app, "app layout");
  return app.style.getPropertyValue("--sidebar-width").trim();
}

function pointer(
  type: string,
  clientX: number,
  pointerId = 1,
): PointerEvent {
  return new window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId,
    button: 0,
    clientX,
  });
}

async function focusHandle(handle: HTMLElement) {
  await inAct(() => {
    handle.focus();
  });
}

let restoreMatchMedia: (() => void) | null = null;

afterEach(() => {
  restoreMatchMedia?.();
  restoreMatchMedia = null;
  try {
    window.localStorage?.removeItem(SIDEBAR_WIDTH_KEY);
    document.documentElement.style.cursor = "";
    document.documentElement.style.userSelect = "";
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  } catch {
    // jsdom not installed
  }
});

describe("desktop sidebar resize", () => {
  it("exposes a vertical separator at the default width", async () => {
    const m = await boot({ stored: null });
    try {
      const handle = separator(m);
      assert.equal(handle.getAttribute("role"), "separator");
      assert.equal(handle.getAttribute("aria-orientation"), "vertical");
      assert.equal(handle.getAttribute("aria-label"), "Resize sidebar");
      assert.equal(
        handle.getAttribute("title"),
        "Arrow keys resize. Shift is a coarse step. Enter or double-click resets.",
      );
      assert.equal(handle.getAttribute("aria-valuemin"), String(SIDEBAR_WIDTH_MIN));
      assert.equal(handle.getAttribute("aria-valuemax"), String(SIDEBAR_WIDTH_MAX));
      assert.equal(handle.getAttribute("aria-valuenow"), String(SIDEBAR_WIDTH_DEFAULT));
      assert.equal(handle.tabIndex, 0);
      assert.equal(appliedWidth(m), `${SIDEBAR_WIDTH_DEFAULT}px`);
    } finally {
      m.unmount();
    }
  });

  it("steps, jumps, and resets from the keyboard and a double-click", async () => {
    const m = await boot({ stored: null });
    try {
      const handle = separator(m);
      await focusHandle(handle);
      await m.pressFocused("ArrowRight");
      assert.equal(
        handle.getAttribute("aria-valuenow"),
        String(SIDEBAR_WIDTH_DEFAULT + SIDEBAR_WIDTH_STEP),
      );
      assert.equal(
        window.localStorage.getItem(SIDEBAR_WIDTH_KEY),
        String(SIDEBAR_WIDTH_DEFAULT + SIDEBAR_WIDTH_STEP),
      );

      await m.pressFocused("ArrowRight", { shiftKey: true });
      const coarse =
        SIDEBAR_WIDTH_DEFAULT + SIDEBAR_WIDTH_STEP + SIDEBAR_WIDTH_STEP_COARSE;
      assert.equal(handle.getAttribute("aria-valuenow"), String(coarse));
      assert.equal(appliedWidth(m), `${coarse}px`);

      await m.pressFocused("Enter");
      assert.equal(handle.getAttribute("aria-valuenow"), String(SIDEBAR_WIDTH_DEFAULT));
      assert.equal(
        window.localStorage.getItem(SIDEBAR_WIDTH_KEY),
        String(SIDEBAR_WIDTH_DEFAULT),
      );

      await m.pressFocused("ArrowRight");
      await inAct(() => {
        handle.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
      });
      assert.equal(handle.getAttribute("aria-valuenow"), String(SIDEBAR_WIDTH_DEFAULT));
    } finally {
      m.unmount();
    }
  });

  it("stops at the min and max", async () => {
    const low = await boot({ stored: String(SIDEBAR_WIDTH_MIN) });
    try {
      const handle = separator(low);
      await focusHandle(handle);
      await low.pressFocused("ArrowLeft");
      await low.pressFocused("ArrowLeft", { shiftKey: true });
      assert.equal(handle.getAttribute("aria-valuenow"), String(SIDEBAR_WIDTH_MIN));
      assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), String(SIDEBAR_WIDTH_MIN));
    } finally {
      low.unmount();
    }

    const high = await boot({ stored: String(SIDEBAR_WIDTH_MAX) });
    try {
      const handle = separator(high);
      await focusHandle(handle);
      await high.pressFocused("ArrowRight", { shiftKey: true });
      assert.equal(handle.getAttribute("aria-valuenow"), String(SIDEBAR_WIDTH_MAX));
      assert.equal(
        window.localStorage.getItem(SIDEBAR_WIDTH_KEY),
        String(SIDEBAR_WIDTH_MAX),
      );
    } finally {
      high.unmount();
    }
  });

  it("restores a saved width after remount and ignores invalid storage", async () => {
    const first = await boot({ stored: "360" });
    try {
      assert.equal(separator(first).getAttribute("aria-valuenow"), "360");
      assert.equal(appliedWidth(first), "360px");
    } finally {
      first.unmount();
    }

    const again = await boot();
    try {
      assert.equal(separator(again).getAttribute("aria-valuenow"), "360");
    } finally {
      again.unmount();
    }

    for (const bad of ["wide", "999", "279", "300.5", ""]) {
      const m = await boot({ stored: bad });
      try {
        assert.equal(
          separator(m).getAttribute("aria-valuenow"),
          String(SIDEBAR_WIDTH_DEFAULT),
          `invalid stored width ${JSON.stringify(bad)}`,
        );
      } finally {
        m.unmount();
      }
    }
  });

  it("still resizes when storage throws", async () => {
    const shell = await mount(<div />);
    installFakeCoder(createFakeCoder());
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    const storage = window.localStorage;
    const getItem = storage.getItem.bind(storage);
    const setItem = storage.setItem.bind(storage);
    storage.getItem = ((key: string) => {
      if (key === SIDEBAR_WIDTH_KEY) throw new Error("denied");
      return getItem(key);
    }) as typeof storage.getItem;
    shell.unmount();
    const m = await mount(<App />);
    try {
      const handle = separator(m);
      assert.equal(handle.getAttribute("aria-valuenow"), String(SIDEBAR_WIDTH_DEFAULT));
      storage.setItem = (() => {
        throw new Error("quota");
      }) as typeof storage.setItem;
      await focusHandle(handle);
      await m.pressFocused("ArrowRight");
      assert.equal(
        handle.getAttribute("aria-valuenow"),
        String(SIDEBAR_WIDTH_DEFAULT + SIDEBAR_WIDTH_STEP),
      );
    } finally {
      storage.getItem = getItem;
      storage.setItem = setItem;
      m.unmount();
    }
  });

  it("commits a pointer drag and cancels on escape, cancel, blur, and lost capture", async () => {
    const m = await boot({ stored: "320" });
    try {
      const handle = separator(m);
      await inAct(() => {
        handle.dispatchEvent(pointer("pointerdown", 320));
      });
      assert.equal(document.body.style.cursor, "col-resize");
      assert.equal(document.body.style.userSelect, "none");

      await inAct(() => {
        window.dispatchEvent(pointer("pointermove", 400));
      });
      assert.equal(handle.getAttribute("aria-valuenow"), "400");
      assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), "320");

      await inAct(() => {
        window.dispatchEvent(new window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }));
      });
      assert.equal(handle.getAttribute("aria-valuenow"), "320");
      assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), "320");
      assert.equal(document.body.style.cursor, "");
      assert.equal(document.body.style.userSelect, "");
      await inAct(() => {
        window.dispatchEvent(pointer("pointermove", 450));
      });
      assert.equal(handle.getAttribute("aria-valuenow"), "320");

      await inAct(() => {
        handle.dispatchEvent(pointer("pointerdown", 320));
        window.dispatchEvent(pointer("pointermove", 440));
        window.dispatchEvent(pointer("pointerup", 440));
      });
      assert.equal(handle.getAttribute("aria-valuenow"), "440");
      assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), "440");
      assert.equal(document.body.style.cursor, "");

      await inAct(() => {
        handle.dispatchEvent(pointer("pointerdown", 440));
        window.dispatchEvent(pointer("pointermove", 460));
        window.dispatchEvent(pointer("pointercancel", 460));
      });
      assert.equal(handle.getAttribute("aria-valuenow"), "440");
      assert.equal(document.body.style.userSelect, "");

      await inAct(() => {
        handle.dispatchEvent(pointer("pointerdown", 440));
        window.dispatchEvent(pointer("pointermove", 420));
        window.dispatchEvent(new window.Event("blur"));
      });
      assert.equal(handle.getAttribute("aria-valuenow"), "440");
      assert.equal(document.documentElement.style.cursor, "");

      await inAct(() => {
        handle.dispatchEvent(pointer("pointerdown", 440));
        window.dispatchEvent(pointer("pointermove", 400));
        handle.dispatchEvent(pointer("lostpointercapture", 400));
      });
      assert.equal(handle.getAttribute("aria-valuenow"), "440");
      assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), "440");
      assert.equal(document.body.style.cursor, "");
    } finally {
      m.unmount();
    }
  });

  it("clears the drag cursor if the app unmounts mid-drag", async () => {
    const m = await boot({ stored: null });
    try {
      const handle = separator(m);
      await inAct(() => {
        handle.dispatchEvent(pointer("pointerdown", 300));
        window.dispatchEvent(pointer("pointermove", 360));
      });
      assert.equal(document.body.style.cursor, "col-resize");
    } finally {
      m.unmount();
    }
    assert.equal(document.body.style.cursor, "");
    assert.equal(document.body.style.userSelect, "");
    assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), null);
  });

  it("shrinks the column for the agents panel without storing the squeeze", async () => {
    const fake = createFakeCoder({
      settings: { agentsPanelDefault: "open" },
    });
    const m = await boot({ fake, width: 1400, stored: "480" });
    try {
      const handle = separator(m);
      assert.equal(handle.getAttribute("aria-valuenow"), "480");
      await inAct(() => {
        Object.defineProperty(window, "innerWidth", {
          configurable: true,
          value: 1100,
        });
        window.dispatchEvent(new Event("resize"));
      });
      assert.equal(handle.getAttribute("aria-valuenow"), "360");
      assert.equal(handle.getAttribute("aria-valuemax"), "360");
      assert.equal(appliedWidth(m), "360px");
      assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), "480");

      await inAct(() => {
        Object.defineProperty(window, "innerWidth", {
          configurable: true,
          value: 1400,
        });
        window.dispatchEvent(new Event("resize"));
      });
      assert.equal(handle.getAttribute("aria-valuenow"), "480");
      assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), "480");
    } finally {
      m.unmount();
    }
  });

  it("drops the handle in a narrow window and cancels an in-progress drag", async () => {
    let narrow = false;
    const listeners = new Set<() => void>();
    const previous = window.matchMedia;
    window.matchMedia = ((query: string) => {
      const isNarrow = query.includes("max-width: 900px");
      return {
        matches: isNarrow ? narrow : false,
        media: query,
        onchange: null,
        addEventListener(_type: string, cb: () => void) {
          if (isNarrow) listeners.add(cb);
        },
        removeEventListener(_type: string, cb: () => void) {
          listeners.delete(cb);
        },
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false;
        },
      };
    }) as typeof window.matchMedia;
    restoreMatchMedia = () => {
      window.matchMedia = previous;
    };

    const m = await boot({ stored: "340" });
    try {
      const handle = separator(m);
      await inAct(() => {
        handle.dispatchEvent(pointer("pointerdown", 340));
        window.dispatchEvent(pointer("pointermove", 420));
      });
      assert.equal(handle.getAttribute("aria-valuenow"), "420");
      await inAct(() => {
        narrow = true;
        for (const listener of listeners) listener();
      });
      assert.equal(m.query("[data-sidebar-resize]"), null);
      assert.equal(appliedWidth(m), "");
      assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), "340");
      assert.equal(document.body.style.cursor, "");
      const threads = m.query('[data-drawer-open="sidebar"]');
      assert.ok(threads, "narrow drawer trigger");
      await m.click(threads);
      assert.equal(threads.getAttribute("aria-expanded"), "true");
      assert.equal(
        m.query('[data-pane="sidebar"]')?.hasAttribute("inert"),
        false,
      );
    } finally {
      m.unmount();
    }
  });

  it("does not change the selected thread or open a worker family", async () => {
    const fake = createFakeCoder({
      threads: [
        thread({ id: "orch", title: "Orchestrate the fix", status: "idle" }),
        thread({
          id: "w1",
          title: "Fork: Review permissions",
          handoffFrom: "orch",
          orchWorker: true,
          status: "idle",
        }),
      ],
    });
    const m = await boot({ fake, stored: null });
    try {
      assert.equal(
        m.query('[data-thread-card][data-active="true"]')?.getAttribute("data-thread-card"),
        "orch",
      );
      assert.equal(m.query('[data-thread-card="w1"]'), null);
      assert.equal(
        m.query('[data-family-toggle="orch"]')?.getAttribute("aria-expanded"),
        "false",
      );
      const handle = separator(m);
      await focusHandle(handle);
      await m.pressFocused("ArrowRight");
      await inAct(() => {
        handle.dispatchEvent(pointer("pointerdown", 308));
        window.dispatchEvent(pointer("pointermove", 360));
        window.dispatchEvent(pointer("pointerup", 360));
      });
      assert.equal(
        m.query('[data-thread-card][data-active="true"]')?.getAttribute("data-thread-card"),
        "orch",
      );
      assert.equal(m.query('[data-thread-card="w1"]'), null);
      assert.equal(
        m.query('[data-family-toggle="orch"]')?.getAttribute("aria-expanded"),
        "false",
      );
    } finally {
      m.unmount();
    }
  });

  it("resizes immediately when reduced motion is requested", async () => {
    const previous = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    })) as typeof window.matchMedia;
    restoreMatchMedia = () => {
      window.matchMedia = previous;
    };
    const m = await boot({ stored: null });
    try {
      const handle = separator(m);
      await focusHandle(handle);
      await m.pressFocused("ArrowRight");
      assert.equal(
        handle.getAttribute("aria-valuenow"),
        String(SIDEBAR_WIDTH_DEFAULT + SIDEBAR_WIDTH_STEP),
      );
      assert.equal(
        appliedWidth(m),
        `${SIDEBAR_WIDTH_DEFAULT + SIDEBAR_WIDTH_STEP}px`,
      );
    } finally {
      m.unmount();
    }
  });
});
