/**
 * Solenta Web connection banner and token gate return (#1660).
 * Run: npm run test:renderer -- --test-name-pattern="ConnectionBanner"
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { mount } from "./support/dom.ts";
import { WEB_TOKEN_KEY } from "../src/coderApi";
import { ConnectionBanner } from "../src/components/ConnectionBanner";
import { setWireStatus } from "../src/wireStatus";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ConnectionBanner", () => {
  it("stays quiet for short drops, then says it is reconnecting and that a message waits", async () => {
    setWireStatus({ state: "connected", queuedSend: false });
    const m = await mount(<ConnectionBanner />);
    assert.equal(m.query("[data-connection-banner]"), null);
    await act(async () => setWireStatus({ state: "reconnecting" }));
    assert.equal(m.query("[data-connection-banner]"), null, "no flash for a blip");
    await act(() => settle(1600));
    const banner = m.query("[data-connection-banner]");
    assert.equal(banner?.getAttribute("data-connection-banner"), "reconnecting");
    assert.match(banner!.textContent || "", /Reconnecting/);
    await act(async () => setWireStatus({ queuedSend: true }));
    assert.match(m.query("[data-connection-banner]")!.textContent || "", /message is waiting/);
    await act(async () => setWireStatus({ state: "connected", queuedSend: false }));
    assert.equal(m.query("[data-connection-banner]"), null);
    m.unmount();
  });

  it("a rejected token clears the saved one and brings the gate back with the reason", async () => {
    setWireStatus({ state: "connected", queuedSend: false });
    window.localStorage.setItem(WEB_TOKEN_KEY, "revoked-tok");
    const m = await mount(<ConnectionBanner />);
    await act(async () => setWireStatus({ state: "rejected" }));
    assert.ok(m.query("[data-web-token-gate-dialog]"), "token gate");
    assert.match(m.query("[data-web-token-reason]")!.textContent || "", /signed out/);
    assert.equal(window.localStorage.getItem(WEB_TOKEN_KEY), null);
    m.unmount();
    setWireStatus({ state: "connected" });
  });
});
