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

  it("error variant shows the title with no Undo control", async () => {
    let dismissed = false;
    const m = await mount(
      <ArchiveToast
        variant="error"
        title={'Failed to remove "acme/drop"'}
        onDismiss={() => {
          dismissed = true;
        }}
      />,
    );
    assert.ok(
      m.text().includes('Failed to remove "acme/drop"'),
      "error toast must show the titled failure",
    );
    assert.equal(m.byText("Undo"), null, "error variant has no Undo");
    assert.ok(m.query('[data-toast="error"]'), "data-toast=error for tests");
    await m.click(m.query('[aria-label="Dismiss"]'));
    assert.equal(dismissed, true);
    m.unmount();
  });
});
