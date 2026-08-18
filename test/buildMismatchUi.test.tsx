/**
 * Hard reload-required state on main/renderer SHA mismatch (#184).
 * The check itself lives in src/buildMismatch.ts; this file pins the UX:
 * mismatch must REPLACE the app chrome, not sit on top of it.
 *
 * Run: node --import=./test/support/render.mjs --test test/buildMismatchUi.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import type { AppStatus } from "../src/shared/ipc";

const MAIN_SHA = "main-aaaaaaa";
const RENDERER_SHA = "renderer-bbbbbbb";

function stampedStatus(sha: string | null): AppStatus {
  return {
    spendTodayUsd: 0,
    memory: {
      running: false,
      adopted: false,
      port: null,
      entries: null,
      vectors: null,
      lastError: null,
    },
    build: {
      version: "0.7.0-test",
      sha,
      time: null,
      channel: null,
    },
  };
}

async function boot(fake: FakeCoder, rendererSha?: string | null) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return rendererSha === undefined
    ? mount(<App />)
    : mount(<App rendererSha={rendererSha} />);
}

describe("App build-mismatch blocking state", () => {
  it("replaces the app chrome with a reload-required screen when SHAs differ", async () => {
    const fake = createFakeCoder({ status: stampedStatus(MAIN_SHA) });
    const m = await boot(fake, RENDERER_SHA);

    const screen = m.query("[data-build-mismatch]");
    assert.ok(screen, "mismatch screen must mount");
    assert.equal(
      m.query("[data-layout=app]"),
      null,
      "app chrome must not render under a mismatch — a banner over a live UI is the old bug",
    );
    assert.match(
      m.text(),
      /Reload required/,
      `expected the hard-stop title, got: ${m.text().slice(0, 160)}`,
    );
    assert.match(m.text(), /out of date/);
    assert.ok(
      m.query("[data-build-mismatch-restart]"),
      "Restart must remain the primary action",
    );
    m.unmount();
  });

  it("Restart on the blocking screen calls app.applyUpdate", async () => {
    const fake = createFakeCoder({ status: stampedStatus(MAIN_SHA) });
    const m = await boot(fake, RENDERER_SHA);

    const restart = m.query("[data-build-mismatch-restart]");
    assert.ok(restart, "Restart button missing");
    await m.click(restart);
    assert.equal(
      fake.of("app.applyUpdate").length,
      1,
      "Restart must keep the existing applyUpdate path",
    );
    m.unmount();
  });

  it("still renders the app when both SHAs match", async () => {
    const fake = createFakeCoder({ status: stampedStatus(MAIN_SHA) });
    const m = await boot(fake, MAIN_SHA);
    assert.ok(m.query("[data-layout=app]"), "matching SHAs must show the app");
    assert.equal(m.query("[data-build-mismatch]"), null);
    m.unmount();
  });

  it("does not block when either SHA is missing (dev tree, test fake)", async () => {
    const fake = createFakeCoder({ status: stampedStatus(null) });
    const m = await boot(fake, RENDERER_SHA);
    assert.ok(
      m.query("[data-layout=app]"),
      "unstamped main must not trip the hard stop",
    );
    assert.equal(m.query("[data-build-mismatch]"), null);
    m.unmount();
  });
});
