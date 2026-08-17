/**
 * Edit-project flow: the sidebar pencil opens EditProjectModal prefilled from
 * the project, and submit records projects.update with the edited fields.
 *
 * Run: node --import=./test/support/render.mjs --test test/editProject.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
  detail,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

function seed() {
  const p1 = project({ id: "p1", name: "ledger", path: "/tmp/ledger" });
  const t1 = thread({ id: "t1", projectId: "p1" });
  return createFakeCoder({
    projects: [p1],
    threads: [t1],
    details: { t1: detail({ thread: t1 }) },
  });
}

describe("edit project", () => {
  it("opens prefilled from the sidebar pencil and records projects.update", async () => {
    const fake = seed();
    const m = await boot(fake);

    const editBtn = m.query('[data-project-edit="p1"]');
    assert.ok(editBtn, "project row must expose an edit control");
    await m.click(editBtn);

    assert.ok(m.query("[data-edit-project]"), "edit click must open the modal");
    const nameInput = m.query(
      "[data-edit-project-name]",
    ) as HTMLInputElement | null;
    assert.ok(nameInput, "name input must exist");
    assert.equal(nameInput.value, "ledger", "name prefills from the project");

    await m.type(m.query("[data-edit-project-remote-host]"), "dev@box");
    await m.type(m.query("[data-edit-project-remote-path]"), "/srv/app");
    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();

    const calls = fake.of("projects.update");
    assert.equal(calls.length, 1, "submit records exactly one update");
    assert.deepEqual(calls[0]!.args[0], {
      projectId: "p1",
      name: "ledger",
      remoteHost: "dev@box",
      remotePath: "/srv/app",
      worktreeRetention: 0,
    });
    assert.equal(
      m.query("[data-edit-project]"),
      null,
      "modal closes on success",
    );
    m.unmount();
  });

  it("rejects a remote host with a relative path before any IPC call", async () => {
    const fake = seed();
    const m = await boot(fake);

    await m.click(m.query('[data-project-edit="p1"]'));
    await m.type(m.query("[data-edit-project-remote-host]"), "dev@box");
    await m.type(m.query("[data-edit-project-remote-path]"), "srv/app");
    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();

    assert.equal(
      fake.of("projects.update").length,
      0,
      "client-side validation must block the update",
    );
    assert.ok(
      m.query("[data-edit-project]"),
      "modal stays open on validation error",
    );
    m.unmount();
  });
});
