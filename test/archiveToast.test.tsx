/**
 * ArchiveToast component unit tests (Synara-style, round 39).
 * App-level archive→Undo wiring lives in test/appWiring.test.tsx against the
 * real App + fakeCoder recording (not a reimplemented Host harness).
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { inAct, mount } from "./support/dom";
import {
  ArchiveToast,
  ARCHIVE_TOAST_MS,
} from "../src/components/ArchiveToast";

describe("ArchiveToast", () => {
  it("shows Archived + Undo and fires onUndo", async () => {
    let undone = false;
    let dismissed = false;
    const m = await mount(
      <ArchiveToast
        onUndo={() => {
          undone = true;
        }}
        onDismiss={() => {
          dismissed = true;
        }}
      />,
    );
    // byText only matches button/a/label; "Archived" is a span.
    assert.ok(
      m.text().includes("Archived"),
      "toast must say Archived",
    );
    const undo = m.byText("Undo");
    assert.ok(undo, "Undo control must be present");
    await m.click(undo!);
    assert.equal(undone, true, "Undo must call onUndo");
    assert.equal(dismissed, false, "Undo alone does not dismiss via onDismiss");
    m.unmount();
  });

  it("auto-dismisses after ARCHIVE_TOAST_MS", async () => {
    let dismissed = false;
    const m = await mount(
      <ArchiveToast
        onUndo={() => {}}
        onDismiss={() => {
          dismissed = true;
        }}
      />,
    );
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, ARCHIVE_TOAST_MS + 50));
    });
    assert.equal(dismissed, true, "toast must dismiss after the window");
    m.unmount();
  });
});
