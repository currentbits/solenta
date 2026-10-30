/**
 * turn.prev/turn.next and PageUp/PageDown transcript navigation (#1770).
 *
 * useTurnNavigation is tested standalone against a small fixture rather
 * than the full ThreadView: jsdom has no layout (every real element's
 * getBoundingClientRect is {0,0,0,0}), so the fixture supplies its own
 * mocked geometry to make "current turn" deterministic.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useRef } from "react";
import { inAct, mount } from "./support/dom.ts";
import {
  useTurnNavigation,
} from "../src/components/thread/useTurnNavigation";
import type { RailTurn } from "../src/components/thread/TurnRail";

const TURNS: RailTurn[] = [
  { id: "u0", index: 0, label: "first" },
  { id: "u1", index: 2, label: "second" },
  { id: "u2", index: 4, label: "third" },
  { id: "u3", index: 6, label: "fourth" },
];

function Host({ onJump }: { onJump: (id: string) => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useTurnNavigation({ turns: TURNS, bodyRef, start: 0, onJump });
  return (
    <div>
      <textarea data-composer-input="" />
      <div data-thread-body="" ref={bodyRef}>
        {TURNS.map((t, i) => (
          <div key={t.id} data-message-id={t.id} data-index={i} />
        ))}
      </div>
    </div>
  );
}

/** u0..u3 tops at 0/100/200/300; line sits at 100, so u1 is "current". */
function mockGeometry(body: HTMLElement) {
  let scrollTop = 250;
  Object.defineProperty(body, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  Object.defineProperty(body, "clientHeight", { configurable: true, value: 300 });
  Object.defineProperty(body, "scrollHeight", { configurable: true, value: 1000 });
  body.getBoundingClientRect = () =>
    ({ top: 0, bottom: 300, height: 300 }) as DOMRect;
  for (const el of body.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const i = Number(el.dataset.index);
    el.getBoundingClientRect = () => ({ top: i * 100 }) as DOMRect;
  }
}

function press(
  target: EventTarget,
  key: string,
  mods: { altKey?: boolean } = {},
) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
  );
}

describe("turn.prev / turn.next", () => {
  it("alt+ArrowUp jumps to the previous prompt relative to scroll position", async () => {
    const jumped: string[] = [];
    const m = await mount(<Host onJump={(id) => jumped.push(id)} />);
    try {
      mockGeometry(m.query("[data-thread-body]") as HTMLElement);
      await inAct(() => press(document.body, "ArrowUp", { altKey: true }));
      assert.deepEqual(jumped, ["u0"], "current is u1, prev is u0");
    } finally {
      m.unmount();
    }
  });

  it("alt+ArrowDown jumps to the next prompt relative to scroll position", async () => {
    const jumped: string[] = [];
    const m = await mount(<Host onJump={(id) => jumped.push(id)} />);
    try {
      mockGeometry(m.query("[data-thread-body]") as HTMLElement);
      await inAct(() => press(document.body, "ArrowDown", { altKey: true }));
      assert.deepEqual(jumped, ["u2"], "current is u1, next is u2");
    } finally {
      m.unmount();
    }
  });

  it("yields to the composer's alt+ArrowUp (edit last queued) while it is focused", async () => {
    const jumped: string[] = [];
    const m = await mount(<Host onJump={(id) => jumped.push(id)} />);
    try {
      mockGeometry(m.query("[data-thread-body]") as HTMLElement);
      const composer = m.query("[data-composer-input]") as HTMLElement;
      await inAct(() => press(composer, "ArrowUp", { altKey: true }));
      assert.deepEqual(jumped, [], "the rail backs off; composer owns the key");
    } finally {
      m.unmount();
    }
  });

  it("does nothing with no turns", async () => {
    const jumped: string[] = [];
    function Empty() {
      const bodyRef = useRef<HTMLDivElement>(null);
      useTurnNavigation({
        turns: [],
        bodyRef,
        start: 0,
        onJump: (id) => jumped.push(id),
      });
      return <div data-thread-body="" ref={bodyRef} />;
    }
    const m = await mount(<Empty />);
    try {
      await inAct(() => press(document.body, "ArrowUp", { altKey: true }));
      assert.deepEqual(jumped, []);
    } finally {
      m.unmount();
    }
  });
});

describe("PageUp / PageDown", () => {
  it("PageDown scrolls the transcript body by ~90% of its height", async () => {
    const m = await mount(<Host onJump={() => {}} />);
    try {
      const body = m.query("[data-thread-body]") as HTMLElement;
      Object.defineProperty(body, "clientHeight", { configurable: true, value: 300 });
      const calls: Array<{ top?: number }> = [];
      body.scrollBy = (opts: { top?: number }) => calls.push(opts);
      await inAct(() => press(document.body, "PageDown"));
      assert.deepEqual(calls, [{ top: 270 }]);
    } finally {
      m.unmount();
    }
  });

  it("PageUp scrolls the transcript body upward by ~90% of its height", async () => {
    const m = await mount(<Host onJump={() => {}} />);
    try {
      const body = m.query("[data-thread-body]") as HTMLElement;
      Object.defineProperty(body, "clientHeight", { configurable: true, value: 300 });
      const calls: Array<{ top?: number }> = [];
      body.scrollBy = (opts: { top?: number }) => calls.push(opts);
      await inAct(() => press(document.body, "PageUp"));
      assert.deepEqual(calls, [{ top: -270 }]);
    } finally {
      m.unmount();
    }
  });

  it("leaves the composer textarea's native paging alone", async () => {
    const m = await mount(<Host onJump={() => {}} />);
    try {
      const body = m.query("[data-thread-body]") as HTMLElement;
      const calls: Array<{ top?: number }> = [];
      body.scrollBy = (opts: { top?: number }) => calls.push(opts);
      const composer = m.query("[data-composer-input]") as HTMLElement;
      await inAct(() => press(composer, "PageDown"));
      assert.deepEqual(calls, [], "the composer textarea keeps native paging");
    } finally {
      m.unmount();
    }
  });
});
