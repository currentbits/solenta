/**
 * Manual sidebar order (#1769): pure midpoint/renumber math.
 * Run: node --experimental-strip-types --test test/threadOrder.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyManualOrder,
  moveNeighbors,
  reorderSortKeys,
  type Orderable,
} from "../src/threadOrder.ts";

function row(id: string, sortKey: number | null = null): Orderable {
  return { id, sortKey };
}

describe("applyManualOrder", () => {
  it("keeps an all-unkeyed list in its given (today's) order", () => {
    const list = [row("a"), row("b"), row("c")];
    assert.deepEqual(applyManualOrder(list).map((t) => t.id), ["a", "b", "c"]);
  });

  it("sorts keyed threads ascending and puts them ahead of every unkeyed one", () => {
    const list = [row("unkeyed1"), row("b", 20), row("unkeyed2"), row("a", 10)];
    assert.deepEqual(
      applyManualOrder(list).map((t) => t.id),
      ["a", "b", "unkeyed1", "unkeyed2"],
    );
  });

  it("treats null and absent sortKey the same (new threads keep today's order)", () => {
    const list = [{ id: "x" }, row("y", 5), { id: "z" }];
    assert.deepEqual(applyManualOrder(list).map((t) => t.id), ["y", "x", "z"]);
  });
});

describe("reorderSortKeys", () => {
  it("midpoints between two keyed neighbors", () => {
    const section = [row("a", 10), row("drag"), row("b", 20)];
    const patches = reorderSortKeys(section, "drag", "a", "b");
    assert.deepEqual([...patches.keys()], ["drag"]);
    assert.equal(patches.get("drag"), 15);
  });

  it("offsets from the sole real key at the start of the section", () => {
    const section = [row("drag"), row("a", 10)];
    const patches = reorderSortKeys(section, "drag", null, "a");
    assert.equal(patches.size, 1);
    assert.ok(patches.get("drag")! < 10);
  });

  it("offsets from the sole real key at the end of the section", () => {
    const section = [row("a", 10), row("drag")];
    const patches = reorderSortKeys(section, "drag", "a", null);
    assert.equal(patches.size, 1);
    assert.ok(patches.get("drag")! > 10);
  });

  it("renumbers the whole section when the gap has collapsed", () => {
    const section = [row("a", 10), row("drag"), row("b", 10 + 1e-9)];
    const patches = reorderSortKeys(section, "drag", "a", "b");
    assert.equal(patches.size, 3);
    const a = patches.get("a")!;
    const drag = patches.get("drag")!;
    const b = patches.get("b")!;
    assert.ok(a < drag && drag < b, "a < drag < b after renumbering");
  });

  it("renumbers when dropped next to an unkeyed neighbor (mixed keyed/unkeyed)", () => {
    // a(10) keyed, then two unkeyed in today's order: c, d.
    const section = applyManualOrder([row("a", 10), row("c"), row("d")]);
    const patches = reorderSortKeys(section, "d", "c", null);
    // Both touched rows get real keys; the unkeyed boundary can't be
    // midpointed against, so the whole section is renumbered.
    assert.ok(patches.size >= 2);
    const c = patches.get("c")!;
    const d = patches.get("d")!;
    assert.ok(c < d, "c still sorts before d, now explicitly");
  });

  it("gives the only thread in an empty section a real key", () => {
    const patches = reorderSortKeys([row("solo")], "solo", null, null);
    assert.equal(patches.size, 1);
    assert.equal(Number.isFinite(patches.get("solo")), true);
  });
});

describe("moveNeighbors", () => {
  const section = [row("a"), row("b"), row("c")];

  it("moving the first item up is a no-op (already at the top)", () => {
    assert.equal(moveNeighbors(section, "a", "up"), null);
  });

  it("moving the last item down is a no-op (already at the bottom)", () => {
    assert.equal(moveNeighbors(section, "c", "down"), null);
  });

  it("moving the middle item up swaps it with its predecessor", () => {
    assert.deepEqual(moveNeighbors(section, "b", "up"), {
      beforeId: null,
      afterId: "a",
    });
  });

  it("moving the middle item down swaps it with its successor", () => {
    assert.deepEqual(moveNeighbors(section, "b", "down"), {
      beforeId: "c",
      afterId: null,
    });
  });

  it("moving the last item up lands it before its new neighbor's old predecessor", () => {
    assert.deepEqual(moveNeighbors(section, "c", "up"), {
      beforeId: "a",
      afterId: "b",
    });
  });
});

describe("pinned section integration", () => {
  it("a manual drag survives alongside unkeyed pinned threads", () => {
    // Today's (oldest-pin-first) order: p1, p2, p3 — all unkeyed.
    const today = [row("p1"), row("p2"), row("p3")];
    // Drag p3 to the very top.
    const patches = reorderSortKeys(
      applyManualOrder(today),
      "p3",
      null,
      "p1",
    );
    const next = today.map((t) =>
      patches.has(t.id) ? { ...t, sortKey: patches.get(t.id)! } : t,
    );
    assert.deepEqual(applyManualOrder(next).map((t) => t.id), [
      "p3",
      "p1",
      "p2",
    ]);
  });
});
