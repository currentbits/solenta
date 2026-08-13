/**
 * Add project: "Create new" mode. The modal collects a folder name and a
 * parent location and calls projects.create; the created project lands in
 * the sidebar and the modal closes. The Create button stays disabled until
 * both fields are filled.
 *
 * Run: node --import=./test/support/render.mjs --test test/addProjectCreate.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder } from "./support/fakeCoder.ts";
import App from "../src/App";

describe("Add project: create new", () => {
  it("creates a folder project from the modal and lists it", async () => {
    const fake = createFakeCoder({ projects: [], threads: [] });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const m = await mount(<App />);

    const add = m.byText("Add project");
    assert.ok(add, "empty-state Add project must be on screen");
    await m.click(add);

    const modeCreate = m.query("[data-add-project-mode-create]");
    assert.ok(modeCreate, "modal must expose a Create new mode");
    await m.click(modeCreate);

    const name = m.query("[data-add-project-create-input]");
    const location = m.query("[data-add-project-create-location]");
    assert.ok(name, "create mode must expose a name input");
    assert.ok(location, "create mode must expose a location input");
    await m.type(name, "fresh-app");
    await m.type(location, "/Users/demo/code");

    const submit = m.query("[data-add-project-path-submit]");
    assert.ok(submit, "create mode must expose a submit control");
    await m.click(submit);

    const creates = fake.of("projects.create");
    assert.equal(
      creates.length,
      1,
      "submit must call projects.create exactly once",
    );
    assert.deepEqual(creates[0].args[0], {
      name: "fresh-app",
      parentDir: "/Users/demo/code",
    });
    assert.equal(
      fake.of("projects.add").length,
      0,
      "create mode must not fall through to projects.add",
    );
    assert.equal(
      m.query("[data-add-project-path]"),
      null,
      "modal must close after a successful create",
    );
    assert.ok(
      m.byText("fresh-app"),
      "created project must appear in the sidebar",
    );
    m.unmount();
  });

  it("keeps Create disabled until name and location are both filled", async () => {
    const fake = createFakeCoder({ projects: [], threads: [] });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const m = await mount(<App />);

    await m.click(m.byText("Add project"));
    await m.click(m.query("[data-add-project-mode-create]"));

    const submit = m.query("[data-add-project-path-submit]") as
      | HTMLButtonElement
      | null;
    assert.ok(submit, "create mode must expose a submit control");
    assert.equal(submit.disabled, true, "empty form must keep Create disabled");

    await m.type(m.query("[data-add-project-create-input]"), "fresh-app");
    assert.equal(
      submit.disabled,
      true,
      "name alone must keep Create disabled",
    );

    await m.type(
      m.query("[data-add-project-create-location]"),
      "/Users/demo/code",
    );
    assert.equal(
      submit.disabled,
      false,
      "name + location must enable Create",
    );
    assert.equal(
      fake.of("projects.create").length,
      0,
      "nothing must be created before submit",
    );
    m.unmount();
  });
});
