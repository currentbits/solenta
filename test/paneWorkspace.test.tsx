/**
 * Pane workspace shell (issue #552): nested splits, focus, close, Cmd+\\,
 * header drag-to-swap.
 *
 * Run: node --import=./test/support/render.mjs --test test/paneWorkspace.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useState } from "react";
import { inAct, mount } from "./support/dom.ts";
import { PaneWorkspace } from "../src/components/PaneWorkspace";
import {
  defaultPaneLayout,
  firstLeafId,
  openPane,
  type LayoutNode,
} from "../src/paneLayout";

function Harness({ initial }: { initial: LayoutNode }) {
  const [layout, setLayout] = useState(initial);
  const [focusedId, setFocusedId] = useState(firstLeafId(initial));
  return (
    <PaneWorkspace
      layout={layout}
      focusedId={focusedId}
      onChange={setLayout}
      onFocus={setFocusedId}
      renderPane={(leaf) => (
        <div data-pane-body-type={leaf.type}>{leaf.type}</div>
      )}
    />
  );
}

describe("PaneWorkspace (issue #552)", () => {
  it("renders a lone chat leaf without a pane header", async () => {
    const m = await mount(<Harness initial={defaultPaneLayout()} />);
    assert.ok(m.query("[data-pane-workspace]"), "workspace root");
    assert.equal(m.queryAll("[data-pane-leaf]").length, 1);
    assert.equal(
      m.query("[data-pane-leaf]")!.getAttribute("data-pane-type"),
      "chat",
    );
    assert.equal(m.query("[data-pane-header]"), null);
    assert.equal(m.query("[data-pane-body-type='chat']")!.textContent, "chat");
    m.unmount();
  });

  it("shows headers and a splitter once a second pane is open", async () => {
    const split = openPane(defaultPaneLayout(), "diff", "pane-1").layout;
    const m = await mount(<Harness initial={split} />);
    assert.equal(m.queryAll("[data-pane-leaf]").length, 2);
    assert.equal(m.queryAll("[data-pane-header]").length, 2);
    assert.ok(m.query("[data-pane-splitter]"), "resize gutter");
    assert.ok(m.query("[data-pane-type='diff']"), "git leaf");
    m.unmount();
  });

  it("closes the focused pane with Cmd+\\ and the header close button", async () => {
    const split = openPane(defaultPaneLayout(), "diff", "pane-1").layout;
    const m = await mount(<Harness initial={split} />);
    const diff = m.query("[data-pane-type='diff']");
    assert.ok(diff);
    await m.click(diff);

    await inAct(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "\\",
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    assert.equal(m.query("[data-pane-type='diff']"), null);
    assert.equal(m.queryAll("[data-pane-leaf]").length, 1);

    const again = openPane(defaultPaneLayout(), "diff", "pane-1").layout;
    const m2 = await mount(<Harness initial={again} />);
    const close = m2.query("[data-pane-type='diff'] [data-pane-close]");
    assert.ok(close, "close on git header");
    await m2.click(close);
    assert.equal(m2.query("[data-pane-type='diff']"), null);
    m.unmount();
    m2.unmount();
  });

  it("does not close the last remaining pane on Cmd+\\", async () => {
    const m = await mount(<Harness initial={defaultPaneLayout()} />);
    await inAct(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "\\",
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    assert.equal(m.queryAll("[data-pane-leaf]").length, 1);
    assert.ok(m.query("[data-pane-type='chat']"));
    m.unmount();
  });

  it("swaps two leaves when a header is dropped on another pane", async () => {
    const split = openPane(defaultPaneLayout(), "diff", "pane-1").layout;
    const m = await mount(<Harness initial={split} />);
    const chatHeader = m.query("[data-pane-type='chat'] [data-pane-header]");
    const diffLeaf = m.query("[data-pane-type='diff']");
    assert.ok(chatHeader && diffLeaf);

    await inAct(() => {
      chatHeader.dispatchEvent(
        new Event("dragstart", { bubbles: true, cancelable: true }),
      );
      diffLeaf.dispatchEvent(
        new Event("drop", { bubbles: true, cancelable: true }),
      );
    });

    const leaves = m.queryAll("[data-pane-leaf]");
    assert.equal(leaves[0]!.getAttribute("data-pane-type"), "diff");
    assert.equal(leaves[1]!.getAttribute("data-pane-type"), "chat");
    m.unmount();
  });
});
