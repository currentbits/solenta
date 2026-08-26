/**
 * Nested split-tree layout for the pane workspace (issue #552).
 *
 * Pure model: open / close / resize / swap / dock, parse, persist.
 * Run: node --import=./test/support/render.mjs --test test/paneLayout.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PANE_REGISTRY,
  PANE_TYPES,
  closePane,
  defaultPaneLayout,
  firstLeafId,
  hasPaneType,
  hydratePaneLayout,
  leafByType,
  loadPaneLayout,
  movePane,
  openPane,
  parsePaneLayout,
  resizeSplit,
  savePaneLayout,
  serializePaneLayout,
  type LayoutNode,
} from "../src/paneLayout";

describe("pane registry (issue #552)", () => {
  it("names every pane type the shell will host", () => {
    assert.deepEqual(PANE_TYPES, [
      "chat",
      "diff",
      "terminal",
      "browser",
      "simulator",
      "files",
      "tasks",
      "subagent",
    ]);
  });

  it("ships chat, git, terminal, browser, and simulator", () => {
    assert.equal(PANE_REGISTRY.chat.shipped, true);
    assert.equal(PANE_REGISTRY.diff.shipped, true);
    assert.equal(PANE_REGISTRY.browser.shipped, true);
    assert.equal(PANE_REGISTRY.terminal.shipped, true);
    assert.equal(PANE_REGISTRY.simulator.shipped, true);
    assert.equal(PANE_REGISTRY.simulator.title, "iOS Simulator");
    assert.equal(PANE_REGISTRY.simulator.split, "horizontal");
  });
});

describe("default layout", () => {
  it("is a single chat leaf", () => {
    const layout = defaultPaneLayout();
    assert.equal(layout.kind, "leaf");
    if (layout.kind !== "leaf") return;
    assert.equal(layout.type, "chat");
    assert.equal(hasPaneType(layout, "chat"), true);
    assert.equal(hasPaneType(layout, "diff"), false);
  });
});

describe("parsePaneLayout", () => {
  it("falls back to default on null, garbage, or a tree with no chat-or-any leaf", () => {
    assert.equal(parsePaneLayout(null).kind, "leaf");
    assert.equal(parsePaneLayout("nope").kind, "leaf");
    assert.equal(parsePaneLayout("{}").kind, "leaf");
    assert.equal(parsePaneLayout(JSON.stringify({ kind: "leaf" })).kind, "leaf");
  });

  it("round-trips a nested split", () => {
    const layout: LayoutNode = {
      kind: "split",
      id: "split-1",
      orientation: "horizontal",
      ratio: 0.4,
      children: [
        { kind: "leaf", id: "pane-1", type: "chat" },
        {
          kind: "split",
          id: "split-2",
          orientation: "vertical",
          ratio: 0.6,
          children: [
            { kind: "leaf", id: "pane-2", type: "diff" },
            { kind: "leaf", id: "pane-3", type: "terminal" },
          ],
        },
      ],
    };
    const parsed = parsePaneLayout(serializePaneLayout(layout));
    assert.deepEqual(parsed, layout);
  });
});

describe("openPane", () => {
  it("is a no-op (besides focus) when the type is already in the tree", () => {
    const layout = defaultPaneLayout();
    const next = openPane(layout, "chat", firstLeafId(layout));
    assert.deepEqual(next.layout, layout);
    assert.equal(next.focusId, firstLeafId(layout));
  });

  it("splits the focused leaf horizontally for Git", () => {
    const layout = defaultPaneLayout();
    const { layout: next, focusId } = openPane(layout, "diff", firstLeafId(layout));
    assert.equal(next.kind, "split");
    if (next.kind !== "split") return;
    assert.equal(next.orientation, "horizontal");
    assert.equal(next.ratio, 0.5);
    assert.equal(next.children[0]!.kind, "leaf");
    assert.equal(next.children[1]!.kind, "leaf");
    if (next.children[0]!.kind !== "leaf" || next.children[1]!.kind !== "leaf") {
      return;
    }
    assert.equal(next.children[0]!.type, "chat");
    assert.equal(next.children[1]!.type, "diff");
    assert.equal(leafByType(next, "diff")?.id, focusId);
  });

  it("opens Terminal beside the focused pane, like Git", () => {
    const layout = defaultPaneLayout();
    const { layout: next } = openPane(layout, "terminal", firstLeafId(layout));
    assert.equal(next.kind, "split");
    if (next.kind !== "split") return;
    assert.equal(next.orientation, "horizontal");
    if (next.children[1]!.kind === "leaf") {
      assert.equal(next.children[1]!.type, "terminal");
    }
  });
});

describe("closePane", () => {
  it("refuses to close the last remaining pane", () => {
    const layout = defaultPaneLayout();
    const id = firstLeafId(layout);
    const next = closePane(layout, id);
    assert.deepEqual(next.layout, layout);
    assert.equal(next.closed, false);
  });

  it("collapses a split so the sibling takes the space", () => {
    const opened = openPane(defaultPaneLayout(), "diff", "pane-1");
    const diffId = leafByType(opened.layout, "diff")!.id;
    const next = closePane(opened.layout, diffId);
    assert.equal(next.closed, true);
    assert.equal(next.layout.kind, "leaf");
    if (next.layout.kind === "leaf") assert.equal(next.layout.type, "chat");
  });
});

describe("resizeSplit", () => {
  it("clamps the ratio so a pane cannot be squeezed to nothing", () => {
    const opened = openPane(defaultPaneLayout(), "diff", "pane-1");
    assert.equal(opened.layout.kind, "split");
    if (opened.layout.kind !== "split") return;
    const tooSmall = resizeSplit(opened.layout, opened.layout.id, 0);
    const tooBig = resizeSplit(opened.layout, opened.layout.id, 1);
    if (tooSmall.kind === "split") assert.equal(tooSmall.ratio, 0.18);
    if (tooBig.kind === "split") assert.equal(tooBig.ratio, 0.82);
  });
});

describe("movePane", () => {
  it("swaps types on a center drop", () => {
    const opened = openPane(defaultPaneLayout(), "diff", "pane-1");
    const chatId = leafByType(opened.layout, "chat")!.id;
    const diffId = leafByType(opened.layout, "diff")!.id;
    const next = movePane(opened.layout, diffId, chatId, "center");
    assert.equal(leafByType(next, "chat")?.id, diffId);
    assert.equal(leafByType(next, "diff")?.id, chatId);
  });

  it("docks a pane against an edge of another leaf", () => {
    let layout: LayoutNode = defaultPaneLayout();
    layout = openPane(layout, "diff", firstLeafId(layout)).layout;
    layout = openPane(layout, "terminal", leafByType(layout, "chat")!.id).layout;
    const termId = leafByType(layout, "terminal")!.id;
    const diffId = leafByType(layout, "diff")!.id;
    const next = movePane(layout, termId, diffId, "bottom");
    const diff = leafByType(next, "diff");
    assert.ok(diff, "diff still present");
    assert.ok(leafByType(next, "terminal"), "terminal still present");
    assert.ok(leafByType(next, "chat"), "chat still present");
    assert.equal(hasPaneType(next, "terminal"), true);
  });

  it("is a no-op when dropped on itself", () => {
    const opened = openPane(defaultPaneLayout(), "diff", "pane-1");
    const diffId = leafByType(opened.layout, "diff")!.id;
    const next = movePane(opened.layout, diffId, diffId, "right");
    assert.deepEqual(next, opened.layout);
  });
});

describe("persistence", () => {
  it("round-trips through a Storage-like map per thread", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    const opened = openPane(defaultPaneLayout(), "diff", "pane-1").layout;
    savePaneLayout("t1", opened, storage);
    savePaneLayout("t2", defaultPaneLayout(), storage);
    assert.deepEqual(loadPaneLayout("t1", storage), opened);
    assert.equal(loadPaneLayout("t2", storage).kind, "leaf");
    assert.equal(loadPaneLayout("missing", storage).kind, "leaf");
  });

  it("hydratePaneLayout opens Git on request without dropping chat", () => {
    const { layout, focusId } = hydratePaneLayout(null, { openDiff: true });
    assert.equal(hasPaneType(layout, "chat"), true);
    assert.equal(hasPaneType(layout, "diff"), true);
    assert.equal(leafByType(layout, "diff")?.id, focusId);
  });
});
