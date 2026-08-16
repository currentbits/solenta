/**
 * A failing update call has to end up on screen (ISSUE #84).
 *
 * checkUpdate/downloadUpdate/applyUpdate used to let the IPC rejection escape:
 * the button's .finally() stopped the spinner, nothing was rendered, and a
 * stale "Up to date." stayed on the Build section while the app never updated.
 *
 * Run: node --import=./test/support/render.mjs --test test/updateCheck.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder, type FakeCoder } from "./support/fakeCoder.ts";
import { useCoder } from "../src/useCoder";

/** Minimal host for the hook: the update state and a way to fire each action. */
function Probe() {
  const { updateStatus, checkUpdate, downloadUpdate, applyUpdate } = useCoder();
  return (
    <div>
      <span data-state="">{updateStatus?.state ?? "none-yet"}</span>
      <span data-error="">{updateStatus?.error ?? ""}</span>
      <button data-check="" onClick={() => void checkUpdate()} />
      <button data-download="" onClick={() => void downloadUpdate()} />
      <button data-apply="" onClick={() => void applyUpdate()} />
    </div>
  );
}

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<Probe />);
}

describe("update actions never reject silently", () => {
  for (const [channel, button] of [
    ["app.checkUpdate", "[data-check]"],
    ["app.downloadUpdate", "[data-download]"],
    ["app.applyUpdate", "[data-apply]"],
  ] as const) {
    it(`${channel} failure lands in update state`, async () => {
      const fake = createFakeCoder({ fail: { [channel]: new Error("offline") } });
      const m = await boot(fake);
      await m.click(m.query(button));
      assert.equal(
        m.query("[data-state]")?.textContent,
        "error",
        `${channel} rejecting must not leave a stale status on screen`,
      );
      assert.equal(m.query("[data-error]")?.textContent, "offline");
      m.unmount();
    });
  }
});
