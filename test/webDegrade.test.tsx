/**
 * Round 51 Worker D: web degradation + narrow layout.
 *
 * Native Electron still uses projects.addViaDialog. On the web, isWebMode()
 * is true (no window.coder) and Add project must open a path-input modal that
 * calls projects.add(path). The three-pane shell must expose drawer/stack
 * hooks so a ~900px container is usable.
 *
 * Run: node --import=./test/support/render.mjs --test test/webDegrade.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  thread,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import { isWebMode } from "../src/shared/wire";

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

function dropCoder(): void {
  delete (window as unknown as { coder?: unknown }).coder;
}

describe("Add project: native vs web", () => {
  it("isWebMode() false: Add project calls addViaDialog and does not open the path modal", async () => {
    const fake = createFakeCoder({ projects: [], threads: [] });
    const m = await boot(fake);
    assert.equal(isWebMode(), false, "window.coder must keep isWebMode() false");

    const add = m.byText("Add project");
    assert.ok(add, "empty-state Add project must be on screen");
    await m.click(add);

    assert.ok(
      fake.of("projects.addViaDialog").length > 0,
      "native Add project must call addViaDialog",
    );
    assert.equal(
      fake.of("projects.add").length,
      0,
      "native Add project must not call projects.add",
    );
    assert.equal(
      m.query("[data-add-project-path]"),
      null,
      "native Add project must not open the path-input modal",
    );
    m.unmount();
  });

  it("isWebMode() true: Add project opens the path modal and never calls addViaDialog", async () => {
    const fake = createFakeCoder({ projects: [], threads: [] });
    const m = await boot(fake);
    // useCoder already closed over the fake. Dropping window.coder flips the
    // contract flag without swapping the recording API.
    dropCoder();
    assert.equal(isWebMode(), true, "deleting window.coder must flip isWebMode()");

    const add = m.byText("Add project");
    assert.ok(add, "empty-state Add project must be on screen");
    await m.click(add);

    assert.equal(
      fake.of("projects.addViaDialog").length,
      0,
      "web Add project must not call addViaDialog",
    );
    const modal = m.query("[data-add-project-path]");
    assert.ok(modal, "web Add project must open the path-input modal");

    const input = m.query("[data-add-project-path-input]");
    assert.ok(input, "path modal must expose a text input");
    await m.type(input, "/Users/demo/web-added-repo");
    const submit = m.query("[data-add-project-path-submit]");
    assert.ok(submit, "path modal must expose a submit control");
    await m.click(submit);

    assert.equal(
      fake.of("projects.addViaDialog").length,
      0,
      "submitting the path modal must still skip addViaDialog",
    );
    const adds = fake.of("projects.add");
    assert.ok(adds.length > 0, "path modal submit must call projects.add");
    assert.equal(
      adds[adds.length - 1].args[0],
      "/Users/demo/web-added-repo",
      "projects.add must receive the typed path",
    );
    m.unmount();
  });
});

describe("narrow three-pane layout hooks", () => {
  it("exposes drawer/stack markup at a narrow container width", async () => {
    const fake = createFakeCoder({
      threads: [
        thread({
          id: "t-narrow-layout",
          title: "narrow layout thread",
        }),
      ],
    });
    const m = await boot(fake);
    m.container.style.width = "800px";
    m.container.style.maxWidth = "800px";

    assert.ok(m.query('[data-layout="app"]'), "app shell hook missing");
    assert.ok(m.query('[data-pane="sidebar"]'), "sidebar pane hook missing");
    assert.ok(m.query('[data-pane="thread"]'), "thread pane hook missing");
    assert.ok(m.query('[data-pane="agents"]'), "agents pane hook missing");
    assert.ok(
      m.query('[data-drawer="sidebar"]'),
      "sidebar drawer toggle hook missing",
    );
    assert.ok(
      m.query('[data-drawer="agents"]'),
      "agents drawer toggle hook missing",
    );
    assert.ok(
      m.query('[data-drawer-open="sidebar"]'),
      "sidebar open control hook missing",
    );
    assert.ok(
      m.query('[data-drawer-open="agents"]'),
      "agents open control hook missing",
    );
    assert.ok(m.query("[data-narrow-chrome]"), "narrow chrome bar hook missing");

    const card = m.query(
      'button[aria-label="Select thread: narrow layout thread"]',
    );
    assert.ok(card, "narrow-layout fixture thread must render");
    await m.click(card);
    const threadPane = m.query('[data-pane="thread"]');
    assert.ok(
      threadPane?.querySelector("textarea"),
      "composer must stay inside the thread pane so it stays reachable when side panes collapse",
    );
    m.unmount();
  });
});
