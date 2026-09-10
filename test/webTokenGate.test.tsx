/**
 * WebTokenGate focus trap (#916 leftover).
 * Run: npm run test:renderer -- --test-name-pattern="WebTokenGate"
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { WEB_TOKEN_KEY } from "../src/coderApi";
import { WebTokenGate } from "../src/components/WebTokenGate";

describe("WebTokenGate focus trap (#916)", () => {
  it("opening the gate moves focus inside; Tab stays inside", async () => {
    const shell = await mount(<div />);
    window.localStorage.removeItem(WEB_TOKEN_KEY);
    window.history.replaceState(null, "", "/");
    shell.unmount();
    const m = await mount(<WebTokenGate />);
    const dialog = m.query('[role="dialog"]') as HTMLElement | null;
    assert.ok(dialog, "token gate dialog");
    assert.ok(
      dialog.contains(document.activeElement),
      "opening the dialog must move focus inside it",
    );
    await m.pressFocused("Tab");
    const first = document.activeElement as HTMLElement;
    assert.ok(dialog.contains(first), "Tab stays inside");
    assert.notEqual(first, dialog, "Tab moves to a focusable inside the dialog");
    await m.pressFocused("Tab");
    assert.ok(
      dialog.contains(document.activeElement),
      "second Tab stays inside",
    );
    m.unmount();
  });
});
