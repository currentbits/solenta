/**
 * HTML fallback is a position:fixed portal on document.body — never inside
 * a scroll container.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { showContextMenuFallback } from "../src/contextMenuFallback";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  g.Event = dom.window.Event;
  g.MouseEvent = dom.window.MouseEvent;
  g.PointerEvent = dom.window.PointerEvent || dom.window.MouseEvent;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  return dom;
}

describe("showContextMenuFallback", () => {
  it("portals onto document.body with position:fixed", async () => {
    installDom();
    const pending = showContextMenuFallback(
      [{ id: "fork", label: "Fork", attrs: { "data-fork-btn": "t1" } }],
      { x: 40, y: 80 },
    );
    const menu = document.querySelector("[data-context-menu]") as HTMLElement | null;
    assert.ok(menu, "menu must exist");
    assert.equal(menu.parentElement, document.body);
    assert.equal(menu.style.position, "fixed");
    const fork = menu.querySelector("[data-fork-btn]") as HTMLElement | null;
    assert.ok(fork);
    fork.click();
    assert.equal(await pending, "fork");
    assert.ok(!document.querySelector("[data-context-menu]"));
  });

  it("opens Snooze children as a sibling submenu, not a drill-in replacement", async () => {
    installDom();
    const pending = showContextMenuFallback(
      [
        {
          id: "snooze",
          label: "Snooze",
          attrs: { "data-snooze-item": "" },
          children: [
            {
              id: "snooze:hour",
              label: "In 1 hour",
              whenLabel: "3pm",
              attrs: { "data-snooze-preset": "hour" },
            },
          ],
        },
      ],
      { x: 10, y: 10 },
    );
    const snooze = document.querySelector("[data-snooze-item]") as HTMLElement;
    snooze.click();
    const sub = document.querySelector("[data-context-submenu]");
    assert.ok(sub, "submenu flyout");
    assert.ok(document.querySelector("[data-context-menu]"), "parent stays");
    const hour = document.querySelector('[data-snooze-preset="hour"]') as HTMLElement;
    hour.click();
    assert.equal(await pending, "snooze:hour");
  });
});
