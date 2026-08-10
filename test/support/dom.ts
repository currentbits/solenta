/**
 * A real DOM for component tests, so effects and event handlers actually run.
 *
 * renderToStaticMarkup (test/support/render.mjs) proves MARKUP but runs no
 * effects and no handlers. Several components in this app populate themselves
 * from effects, so statically they render only their empty state: a reviewer
 * showed you could delete a whole feature at a call site with the suite green.
 * This module closes that by mounting into jsdom with React's real client
 * renderer.
 *
 * Use `mount()` for anything driven by effects, state or clicks. Prefer the
 * static harness when plain markup is enough: it is far cheaper.
 */
import { JSDOM } from "jsdom";
import { afterEach } from "node:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ReactElement } from "react";

// React checks this to enable act() semantics.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  html(): string;
  /** All rendered text, whitespace-collapsed. Handy for "is X on screen". */
  text(): string;
  /** First element matching the selector, or null. */
  query(selector: string): Element | null;
  /** All elements matching the selector. */
  queryAll(selector: string): Element[];
  /** Find a button/link whose visible text contains `label`. */
  byText(label: string): Element | null;
  /** Click an element and flush the resulting React work. */
  click(el: Element | null): Promise<void>;
  /** Type into an input/textarea the way React's onChange expects. */
  type(el: Element | null, value: string): Promise<void>;
  /**
   * Press a key on whatever is ACTUALLY focused, failing if nothing is.
   *
   * press(el, key) dispatches on the element it is handed, so it passes with
   * focus on <body>. That is why a picker whose every level change dropped
   * focus shipped with a green suite: no test had ever read activeElement.
   * Use this for anything that claims keyboard operability.
   */
  /** Move the pointer onto an element, firing React's onMouseEnter. */
  hover(el: Element | null): Promise<void>;
  pressFocused(
    key: string,
    mods?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  ): Promise<void>;
  /** Press a key on an element, e.g. press(el, "Enter", { metaKey: true }). */
  press(
    el: Element | null,
    key: string,
    mods?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  ): Promise<void>;
  /** Let pending promises and effects settle. */
  flush(): Promise<void>;
  unmount(): void;
}

/** console.error output captured while a component is mounted. */
const consoleErrors: string[] = [];
let patchedConsole = false;

/**
 * ONE jsdom for the process, installed before react-dom is ever imported.
 *
 * Both parts matter. ES imports are hoisted, so a static `import "react-dom/client"`
 * evaluates before any setup in this module body: react-dom then binds to a
 * world with no document, and its event system never delivers input events (a
 * controlled input updates in the DOM while onChange never fires, so state goes
 * stale silently). Hence the dynamic import in mount(). And react-dom keys
 * internals off the document, so a fresh jsdom per mount would strand them.
 */
let domSingleton: JSDOM | null = null;

function installDom(): JSDOM {
  if (domSingleton) return domSingleton;
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  // node 26 defines navigator as a getter-only global; redefine rather than assign.
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  g.Event = dom.window.Event;
  g.MouseEvent = dom.window.MouseEvent;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  g.InputEvent = dom.window.InputEvent;
  g.HTMLInputElement = dom.window.HTMLInputElement;
  g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  g.getComputedStyle = dom.window.getComputedStyle;
  // jsdom has no layout, so it ships no scrollIntoView. Stub it rather than
  // guarding the call site: the component should be able to call it plainly,
  // and a test should exercise the real path.
  if (!dom.window.Element.prototype.scrollIntoView) {
    dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  }
  g.requestAnimationFrame = (cb: FrameRequestCallback) =>
    dom.window.setTimeout(() => cb(Date.now()), 0) as unknown as number;
  g.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id);
  domSingleton = dom;
  return dom;
}

/**
 * Live mounts. A failing assertion skips the test's own unmount(), and the app
 * keeps a 60s interval running, so node never exits and the whole suite hangs on
 * a RED test, so cleanup is registered by this module (see below).
 */
const live: Array<() => void> = [];

export function unmountAll(): void {
  while (live.length) {
    const dispose = live.pop();
    try {
      dispose?.();
    } catch {
      // already torn down
    }
  }
  const noise = consoleErrors.splice(0);
  if (noise.length) {
    // React reports key warnings, act warnings and controlled/uncontrolled
    // switches through console.error. Those are correctness signals, and a
    // suite that prints them keeps passing while the app misbehaves.
    throw new Error(
      `React logged ${noise.length} console error(s):\n${noise.join("\n")}`,
    );
  }
}

// Registered here, not per file. Relying on each test file to remember
// afterEach(unmountAll) meant one forgotten line wedged the WHOLE run forever:
// the component's interval stays armed, --test-timeout does not bound it, and
// there is no output to debug. Importing mount() is now enough.
afterEach(() => unmountAll());

/**
 * Run something that triggers React state from OUTSIDE the tree, e.g. pushing
 * an IPC event through a fake. Without act() React logs a warning, which the
 * console gate turns into a failure, and the update may not be flushed.
 */
export async function inAct(fn: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await fn();
  });
}

export async function mount(element: ReactElement): Promise<Mounted> {
  const dom = installDom();
  if (!patchedConsole) {
    patchedConsole = true;
    const original = console.error;
    console.error = (...args: unknown[]) => {
      const text = args.map((a) => String(a)).join(" ");
      // node routes its own warnings here too, and they all start with
      // "(node:NNN)". Anchored deliberately: an unanchored /DeprecationWarning/
      // also swallows a real React warning whose text happens to contain it.
      if (!/^\(node:\d+\)/.test(text)) {
        consoleErrors.push(text);
      }
      original(...args);
    };
  }
  // Imported AFTER the globals exist. A static import would be hoisted above
  // installDom() and bind react-dom to a documentless world.
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);

  let root: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });

  const flush = async () => {
    // Two ticks: one for pending promises (IPC stubs resolve as microtasks),
    // one for the state updates they schedule.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  await flush();

  const api: Mounted = {
    container: container as unknown as HTMLElement,
    html: () => container.innerHTML,
    text: () => (container.textContent || "").replace(/\s+/g, " ").trim(),
    query: (sel) => container.querySelector(sel),
    queryAll: (sel) => Array.from(container.querySelectorAll(sel)),
    byText: (label) =>
      Array.from(container.querySelectorAll("button, a, label, summary")).find(
        (el) => (el.textContent || "").includes(label),
      ) ?? null,
    click: async (el) => {
      if (!el) throw new Error("click: element not found");
      await act(async () => {
        el.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      await flush();
    },
    type: async (el, value) => {
      if (!el) throw new Error("type: element not found");
      const node = el as HTMLInputElement | HTMLTextAreaElement;
      // React installs its own value setter; bypass it so onChange fires.
      const proto =
        node.tagName === "TEXTAREA"
          ? dom.window.HTMLTextAreaElement.prototype
          : dom.window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      // React caches the last value on the node and skips onChange when it
      // sees no change. The native setter alone is not enough: clear the
      // tracker's cached value first, or a value set here looks unchanged.
      const tracked = node as unknown as {
        _valueTracker?: { setValue(v: string): void };
      };
      tracked._valueTracker?.setValue("");
      await act(async () => {
        setter?.call(node, value);
        // React tracks the last value on the node and only fires onChange when
        // it sees a change, so the native setter must be used. Dispatch both
        // events: React maps onChange to "input" for text fields, but some
        // paths only observe "change".
        node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        node.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
      await flush();
    },
    hover: async (el) => {
      if (!el) throw new Error("hover: element not found");
      await act(async () => {
        // React derives onMouseEnter from the top-level mouseover; it does not
        // listen for raw mouseenter, so dispatching one as well is dead code.
        el.dispatchEvent(
          new dom.window.MouseEvent("mouseover", { bubbles: true }),
        );

      });
      await flush();
    },
    pressFocused: async (key, mods = {}) => {
      const active = dom.window.document.activeElement;
      if (!active || active === dom.window.document.body) {
        throw new Error(
          `pressFocused(${key}): nothing is focused (activeElement is ${
            active ? active.tagName : "null"
          }). A keyboard affordance that loses focus is broken.`,
        );
      }
      if (!container.contains(active)) {
        throw new Error(
          `pressFocused(${key}): focus escaped the mounted tree (${active.tagName})`,
        );
      }
      await api.press(active, key, mods);
    },
    press: async (el, key, mods = {}) => {
      if (!el) throw new Error("press: element not found");
      await act(async () => {
        el.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
            ...mods,
          }),
        );
      });
      await flush();
    },
    flush,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
  live.push(api.unmount);
  return api;
}
