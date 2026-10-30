/**
 * Manual sidebar order (#1769): drag-and-drop and keyboard reorder wiring.
 * The ordering math itself (midpoint/renumber) is covered by
 * test/threadOrder.test.ts; this file is the UI seam — dispatching real
 * drag events and a keyboard chord, and checking onSetSortKey is called
 * (or, for a refused cross-section drop, is NOT called).
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount } from "./support/dom";
import { FRESH, sidebar, thread } from "./support/sidebarFixtures";

/** A DragEvent-shaped Event: jsdom's own DragEvent has no dataTransfer. */
function dragEvent(type: string, clientY = 0): Event {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: { setData() {}, effectAllowed: "", dropEffect: "" },
  });
  Object.defineProperty(ev, "clientY", { value: clientY });
  return ev;
}

/** Give a row a real rect so the before/after edge split is deterministic. */
function stubRowRect(row: Element): void {
  (row as HTMLElement).getBoundingClientRect = () =>
    ({ top: 0, height: 40, bottom: 40, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

describe("sidebar drag/keyboard reorder (#1769)", () => {
  it("drags a thread to a new slot within the active section", async () => {
    const threads = [
      thread({ id: "a", createdAt: FRESH + 30, updatedAt: FRESH + 30 }),
      thread({ id: "b", createdAt: FRESH + 20, updatedAt: FRESH + 20 }),
      thread({ id: "c", createdAt: FRESH + 10, updatedAt: FRESH + 10 }),
    ];
    const calls: [string, number | null][] = [];
    const m = await mount(
      sidebar(threads, {
        onSetSortKey: (id, sortKey) => calls.push([id, sortKey]),
      }),
    );

    const rowB = m.query('[data-thread-card="b"]')!;
    stubRowRect(rowB);
    const dragBtnA = m.query('[data-thread-card="a"] button')!;

    // Today's order is a, b, c (all unkeyed, createdAt desc). Drag "a" to
    // just after "b" (clientY near the row's bottom half → edge "after").
    // Each event gets its own act/flush: dragThreadId is read through a
    // ref kept in sync by render, so dragover needs dragstart's state
    // update committed first — exactly like three separate browser events.
    await inAct(() => dragBtnA.dispatchEvent(dragEvent("dragstart")));
    await m.flush();
    await inAct(() => rowB.dispatchEvent(dragEvent("dragover", 35)));
    await m.flush();
    await inAct(() => rowB.dispatchEvent(dragEvent("drop", 35)));

    assert.ok(calls.length >= 2, "at least the moved threads got a key");
    const byId = new Map(calls);
    assert.ok(byId.get("b")! < byId.get("a")!, "b still sorts before a");
    assert.ok(byId.get("a")! < byId.get("c")!, "a now sorts before c");
    m.unmount();
  });

  it("refuses a drop across sections: no patch, no indicator", async () => {
    const threads = [
      thread({ id: "pin1", pinnedAt: FRESH }),
      thread({ id: "act1", createdAt: FRESH + 10, updatedAt: FRESH + 10 }),
    ];
    const calls: unknown[] = [];
    const m = await mount(
      sidebar(threads, {
        onSetSortKey: (...args) => calls.push(args),
      }),
    );

    const rowAct1 = m.query('[data-thread-card="act1"]')!;
    stubRowRect(rowAct1);
    const dragBtnPin1 = m.query('[data-thread-card="pin1"] button')!;

    await inAct(() => dragBtnPin1.dispatchEvent(dragEvent("dragstart")));
    await m.flush();
    await inAct(() => rowAct1.dispatchEvent(dragEvent("dragover", 10)));
    assert.equal(
      rowAct1.getAttribute("data-drop-indicator"),
      null,
      "no indicator across sections",
    );

    await inAct(() => {
      rowAct1.dispatchEvent(dragEvent("drop", 10));
    });
    assert.equal(calls.length, 0, "cross-section drop is a no-op");
    m.unmount();
  });

  it("Alt+Shift+ArrowDown moves the selected thread down within its section", async () => {
    const threads = [
      thread({ id: "a", createdAt: FRESH + 30, updatedAt: FRESH + 30 }),
      thread({ id: "b", createdAt: FRESH + 20, updatedAt: FRESH + 20 }),
      thread({ id: "c", createdAt: FRESH + 10, updatedAt: FRESH + 10 }),
    ];
    const calls: [string, number | null][] = [];
    const m = await mount(
      sidebar(threads, {
        activeThreadId: "a",
        onSetSortKey: (id, sortKey) => calls.push([id, sortKey]),
      }),
    );

    await inAct(() => {
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          altKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    assert.ok(calls.length >= 2, "moving one thread past another renumbers both");
    const byId = new Map(calls);
    assert.ok(byId.get("b")! < byId.get("a")!, "b still sorts before a");
    assert.ok(byId.get("a")! < byId.get("c")!, "a now sorts before c");
    m.unmount();
  });

  it("does not start a drag while renaming", async () => {
    const threads = [thread({ id: "a" })];
    const m = await mount(
      sidebar(threads, { onRenameThread: () => {} }),
    );
    const button = m.query('[data-thread-card="a"] button')!;
    assert.equal(button.getAttribute("draggable"), "true");
    await inAct(() => {
      button.dispatchEvent(
        new window.MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
    });
    assert.equal(
      button.getAttribute("draggable"),
      "false",
      "renaming disarms the drag",
    );
    m.unmount();
  });
});
