/**
 * Settings > Connections > Solenta Web (#1512 I2): switch, devices with a
 * locally rendered pairing QR, revoke, and the Tailscale Serve helper.
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { createFakeCoder } from "./support/fakeCoder.ts";
import {
  WebAccessSection,
  pairingBases,
  pairingLink,
} from "../src/components/WebAccessSection";
import type { WebAccessStatus } from "../src/shared/ipc";

/** The jsdom window exists only after the first mount. */
async function install(webAccess?: WebAccessStatus) {
  (await mount(<div />)).unmount();
  const fake = createFakeCoder({ webAccess });
  (window as unknown as { coder: unknown }).coder = fake.api;
  return fake;
}

const TS_READY = { installed: true, loggedIn: true, host: "mac.tail1.ts.net", serving: false, url: null };

describe("WebAccessSection", () => {
  afterEach(() => {
    unmountAll();
    if (typeof window !== "undefined") delete (window as unknown as { coder?: unknown }).coder;
  });

  it("starts off and loopback-only; the switch turns it on and shows the URL", async () => {
    const fake = await install();
    const m = await mount(<WebAccessSection active />);
    await m.flush();
    assert.equal(m.query("[data-web-state]")?.getAttribute("data-web-state"), "off");
    assert.equal((m.query("[data-web-lan]") as HTMLInputElement).checked, false);

    await m.click(m.query("[data-web-enabled]"));
    await m.flush();
    assert.deepEqual(
      fake.calls.find((c) => c.channel === "web.setEnabled")?.args,
      [{ enabled: true, lan: false }],
    );
    assert.equal(m.query("[data-web-url=local]")?.textContent, "http://127.0.0.1:4620");
  });

  it("adds a device, shows its link and a local QR once, and revokes it", async () => {
    const fake = await install();
    const m = await mount(<WebAccessSection active />);
    await m.flush();
    await m.click(m.query("[data-web-enabled]"));
    await m.flush();

    await m.type(m.query("[data-web-device-name]"), "Phone");
    await m.click(m.query("[data-web-add-device]"));
    for (let i = 0; i < 5 && !m.query("[data-web-qr]"); i++) await m.flush();

    const link = m.query("[data-web-pair-link]")?.textContent ?? "";
    assert.equal(link, `http://127.0.0.1:4620/?token=${"t".repeat(43)}`);
    const qr = m.query("[data-web-qr]") as HTMLImageElement | null;
    assert.ok(qr, "QR rendered");
    assert.match(qr.getAttribute("src") ?? "", /^data:image\/svg\+xml/, "no network image");

    const row = m.query("[data-web-devices] [data-web-revoke]") as HTMLElement;
    assert.ok(m.text().includes("Not used yet"));
    await m.click(row);
    await m.flush();
    assert.ok(fake.calls.some((c) => c.channel === "web.revokeDevice"));
    assert.equal(m.query("[data-web-reveal]"), null, "revoking hides its one-time token");
    assert.equal(m.query("[data-web-devices]"), null);
  });

  it("Tailscale: offered only once Web is on, explains the tailnet exposure, and stops", async () => {
    const fake = await install({
      running: false,
      lan: false,
      port: 4620,
      urls: [],
      devices: [],
      tailscale: TS_READY,
    });
    const m = await mount(<WebAccessSection active />);
    await m.flush();
    const start = () => m.query("[data-web-tailscale-start]") as HTMLButtonElement;
    assert.equal(start().disabled, true);
    assert.ok(m.text().includes("every device on your tailnet at mac.tail1.ts.net"));

    await m.click(m.query("[data-web-enabled]"));
    await m.flush();
    await m.click(start());
    await m.flush();
    assert.deepEqual(fake.calls.find((c) => c.channel === "web.setTailscale")?.args, [{ on: true }]);
    assert.equal(m.query("[data-web-tailscale-url]")?.textContent, "https://mac.tail1.ts.net");

    await m.click(m.query("[data-web-tailscale-stop]"));
    await m.flush();
    assert.ok(start(), "back to the start action");
  });

  it("hides Tailscale when it is not installed, and uses no em-dashes", async () => {
    await install();
    const m = await mount(<WebAccessSection active />);
    await m.flush();
    assert.equal(m.query("[data-web-tailscale]"), null);
    assert.ok(!m.text().includes("—"));
  });

  it("pairs over tailnet HTTPS first, then LAN, then this computer", () => {
    const st: WebAccessStatus = {
      running: true,
      lan: true,
      port: 4620,
      urls: [
        { kind: "local", url: "http://127.0.0.1:4620" },
        { kind: "lan", url: "http://192.168.1.20:4620" },
      ],
      devices: [],
      tailscale: { ...TS_READY, serving: true, url: "https://mac.tail1.ts.net" },
    };
    assert.deepEqual(pairingBases(st), [
      "https://mac.tail1.ts.net",
      "http://192.168.1.20:4620",
      "http://127.0.0.1:4620",
    ]);
    assert.equal(pairingLink("https://x/", "a+b"), "https://x/?token=a%2Bb");
  });
});
