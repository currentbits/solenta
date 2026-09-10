/**
 * Return-destination helpers for #942.
 * Run: node --experimental-strip-types --test test/viewReturn.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import {
  applyViewRestore,
  isReturnableView,
  originFromRowKey,
  validProjectId,
} from "../src/viewReturn";

function listDom(rowKeys: string[], scrollTop = 0): {
  root: HTMLElement;
  scroller: HTMLElement;
} {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <main>
        <div data-return-scroll="">
          ${rowKeys
            .map(
              (key) =>
                `<div data-return-row="${key}"><button type="button">${key}</button></div>`,
            )
            .join("")}
        </div>
      </main>
    </body></html>`,
  );
  const root = dom.window.document.querySelector("main") as HTMLElement;
  const scroller = root.querySelector(
    "[data-return-scroll]",
  ) as HTMLElement;
  Object.defineProperty(scroller, "clientHeight", {
    value: 240,
    configurable: true,
  });
  for (const [i, row] of Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-return-row]"),
  ).entries()) {
    Object.defineProperty(row, "offsetTop", {
      value: i * 40,
      configurable: true,
    });
    Object.defineProperty(row, "offsetHeight", {
      value: 40,
      configurable: true,
    });
  }
  scroller.scrollTop = scrollTop;
  return { root, scroller };
}

function columnsDom(
  columns: Array<{ key: string; rows: string[] }>,
  captureKey: string,
): { root: HTMLElement; origin: ReturnType<typeof originFromRowKey> } {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <main>
        ${columns
          .map(
            (column) =>
              `<div data-return-scroll="${column.key}">
                ${column.rows
                  .map(
                    (key) =>
                      `<div data-return-row="${key}"><button type="button">${key}</button></div>`,
                  )
                  .join("")}
              </div>`,
          )
          .join("")}
      </main>
    </body></html>`,
  );
  const root = dom.window.document.querySelector("main") as HTMLElement;
  for (const scroller of root.querySelectorAll<HTMLElement>(
    "[data-return-scroll]",
  )) {
    Object.defineProperty(scroller, "clientHeight", {
      value: 240,
      configurable: true,
    });
  }
  const origin = originFromRowKey(root, captureKey);
  return { root, origin };
}

describe("viewReturn", () => {
  it("names only the report/board views that open threads", () => {
    assert.equal(isReturnableView("planboard"), true);
    assert.equal(isReturnableView("kanban"), true);
    assert.equal(isReturnableView("activity"), true);
    assert.equal(isReturnableView("digest"), true);
    assert.equal(isReturnableView("prs"), true);
    assert.equal(isReturnableView("insights"), true);
    assert.equal(isReturnableView("usage"), false);
    assert.equal(isReturnableView("thread"), false);
    assert.equal(isReturnableView("fleet"), false);
  });

  it("drops a deleted project id instead of restoring it", () => {
    const projects = [
      { id: "p1", slug: "acme/ledger", name: "ledger", path: "/tmp/ledger" },
    ];
    assert.equal(validProjectId("p1", projects), "p1");
    assert.equal(validProjectId("gone", projects), null);
    assert.equal(validProjectId(null, projects), null);
  });

  it("captures the clicked row's index and scroller position", () => {
    const { root, scroller } = listDom(["a", "b", "c"], 80);
    const origin = originFromRowKey(root, "c");
    assert.equal(origin.rowKey, "c");
    assert.equal(origin.rowIndex, 2);
    assert.equal(origin.scrollTop, 80);
    assert.equal(scroller.scrollTop, 80);
  });

  it("restores the originating row's focus and scroll", () => {
    const { root, scroller } = listDom(["a", "b", "c"], 0);
    applyViewRestore(root, { rowKey: "c", rowIndex: 2, scrollTop: 80 });
    assert.equal(scroller.scrollTop, 80);
    assert.equal(
      root.ownerDocument.activeElement?.textContent,
      "c",
    );
  });

  it("falls back to the nearest remaining row when the original disappeared", () => {
    const { root, scroller } = listDom(["a", "c"], 0);
    applyViewRestore(root, { rowKey: "b", rowIndex: 1, scrollTop: 40 });
    assert.equal(scroller.scrollTop, 40);
    assert.equal(
      root.ownerDocument.activeElement?.textContent,
      "c",
    );
  });

  it("falls back inside the originating column, not across all rows (#942)", () => {
    const { root, origin } = columnsDom(
      [
        { key: "col-1", rows: ["a", "b"] },
        { key: "col-2", rows: ["c", "d", "e"] },
      ],
      "d",
    );
    assert.equal(origin.scrollKey, "col-2");
    assert.equal(origin.rowIndex, 1);

    root.querySelector('[data-return-row="d"]')?.remove();
    applyViewRestore(root, origin);
    assert.equal(
      root.ownerDocument.activeElement?.textContent,
      "e",
      "rowIndex 1 of [c,e] is e, not b from the other column",
    );
    assert.equal(
      root.ownerDocument.activeElement
        ?.closest("[data-return-scroll]")
        ?.getAttribute("data-return-scroll"),
      "col-2",
    );
  });

  it("lands in a remaining column when the originating scroller is empty", () => {
    const { root, origin } = columnsDom(
      [
        { key: "col-1", rows: ["a", "b"] },
        { key: "col-2", rows: ["c", "d", "e"] },
      ],
      "d",
    );
    for (const key of ["c", "d", "e"]) {
      root.querySelector(`[data-return-row="${key}"]`)?.remove();
    }
    applyViewRestore(root, origin);
    assert.equal(
      root.ownerDocument.activeElement?.textContent,
      "b",
      "empty originating column falls back to the nearest remaining scroller",
    );
    assert.equal(
      root.ownerDocument.activeElement
        ?.closest("[data-return-scroll]")
        ?.getAttribute("data-return-scroll"),
      "col-1",
    );
  });
});
