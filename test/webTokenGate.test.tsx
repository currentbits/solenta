/**
 * WebTokenGate focus trap (#916 leftover).
 * Run: npm run test:renderer -- --test-name-pattern="WebTokenGate"
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { WEB_TOKEN_KEY, devBuild } from "../src/coderApi";
import { WebTokenGate } from "../src/components/WebTokenGate";

describe("WebTokenGate focus trap (#916)", () => {
  it("opening the gate moves focus inside; Tab stays inside; Escape restores", async () => {
    const shell = await mount(<div />);
    window.localStorage.removeItem(WEB_TOKEN_KEY);
    window.history.replaceState(null, "", "/");
    shell.unmount();
    const prev = devBuild.isDev;
    devBuild.isDev = () => false;
    function Harness({ show }: { show: boolean }) {
      return (
        <>
          <button type="button" data-trap-opener="">
            Opener
          </button>
          {show ? <WebTokenGate /> : null}
        </>
      );
    }
    try {
      const m = await mount(<Harness show={false} />);
      const opener = m.query("[data-trap-opener]") as HTMLElement;
      opener.focus();
      await m.rerender(<Harness show={true} />);
      const dialog = m.query("[data-web-token-gate-dialog]") as HTMLElement | null;
      assert.ok(dialog, "token gate dialog");
      assert.ok(
        dialog.contains(document.activeElement),
        "opening the dialog must move focus inside it",
      );
      assert.notEqual(document.activeElement, opener);
      await m.pressFocused("Tab");
      const first = document.activeElement as HTMLElement;
      assert.ok(dialog.contains(first), "Tab stays inside");
      assert.notEqual(first, dialog, "Tab moves to a focusable inside the dialog");
      await m.pressFocused("Tab");
      assert.equal(document.activeElement, first, "Tab wraps inside the dialog");
      await m.pressFocused("Escape");
      assert.equal(m.query("[data-web-token-gate]"), null);
      assert.equal(document.activeElement, opener, "Escape restores the opener");
      m.unmount();
    } finally {
      devBuild.isDev = prev;
    }
  });

  it("stays closed in a DEV build even when mounted with no token", async () => {
    const prev = devBuild.isDev;
    const shell = await mount(<div />);
    window.localStorage.removeItem(WEB_TOKEN_KEY);
    window.history.replaceState(null, "", "/");
    shell.unmount();
    devBuild.isDev = () => true;
    try {
      const m = await mount(<WebTokenGate />);
      assert.equal(
        m.query("[data-web-token-gate]"),
        null,
        "WebTokenGate must not open itself during npm run dev:browser",
      );
      m.unmount();
    } finally {
      devBuild.isDev = prev;
    }
  });
});
