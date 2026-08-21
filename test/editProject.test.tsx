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
import { EditProjectModal } from "../src/components/EditProjectModal";
import type { ProjectUpdateInput } from "../src/shared/ipc";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

    await m.click(m.query("[data-scope-trigger]"));
    const editBtn = m.query('[data-scope-edit="p1"]');
    assert.ok(editBtn, "scope menu must expose an edit control");
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
      worktreeRetention: 10,
      autoDispatch: false,
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

    await m.click(m.query("[data-scope-trigger]"));
    await m.click(m.query('[data-scope-edit="p1"]'));
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

  it("prefills autoDispatch and submit sends the flag", async () => {
    const p1 = project({
      id: "p1",
      name: "ledger",
      path: "/tmp/ledger",
      autoDispatch: true,
    });
    const t1 = thread({ id: "t1", projectId: "p1" });
    const fake = createFakeCoder({
      projects: [p1],
      threads: [t1],
      details: { t1: detail({ thread: t1 }) },
    });
    const m = await boot(fake);

    await m.click(m.query("[data-scope-trigger]"));
    await m.click(m.query('[data-scope-edit="p1"]'));
    const box = m.query(
      "[data-edit-project-auto-dispatch]",
    ) as HTMLInputElement | null;
    assert.ok(box, "auto-dispatch checkbox must exist");
    assert.equal(box.checked, true, "checkbox prefills from the project");
    assert.equal(box.disabled, false);

    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();

    const calls = fake.of("projects.update");
    assert.equal(calls.length, 1, "submit records exactly one update");
    assert.equal(
      (calls[0]!.args[0] as { autoDispatch?: boolean }).autoDispatch,
      true,
      "submit sends autoDispatch",
    );
    m.unmount();
  });

  it("opens the appearance controls from the sidebar pencil (#610)", async () => {
    const fake = seed();
    const m = await boot(fake);
    await m.click(m.query("[data-scope-trigger]"));
    await m.click(m.query('[data-scope-edit="p1"]'));
    assert.ok(m.query("[data-edit-project-pick-icon]"), "choose-file control");
    assert.ok(m.query("[data-edit-project-icon-auto]"), "Automatic control");
    assert.ok(
      m.query("[data-edit-project-icon-fallback]"),
      "no-icon fallback when the project has none",
    );
    m.unmount();
  });

  it("shows a jj unsupported note on the local path field (#521)", async () => {
    const p1 = project({
      id: "p1",
      name: "ledger",
      path: "/tmp/ledger",
      scm: {
        kind: "jj",
        colocated: true,
        support: "unsupported",
        detail: "Jujutsu colocated repo. Worktrees and diffs use git.",
      },
    });
    const t1 = thread({ id: "t1", projectId: "p1" });
    const fake = createFakeCoder({
      projects: [p1],
      threads: [t1],
      details: { t1: detail({ thread: t1 }) },
    });
    const m = await boot(fake);
    await m.click(m.query("[data-scope-trigger]"));
    await m.click(m.query('[data-scope-edit="p1"]'));
    const note = m.query("[data-scm-detail]");
    assert.ok(note, "jj note under the path");
    assert.match(note!.textContent || "", /Jujutsu colocated/);
    m.unmount();
  });
});

describe("edit project icon (#610)", () => {
  it("saves a picked iconPath and leaves it off a name-only save", async () => {
    const calls: ProjectUpdateInput[] = [];
    const p1 = project({ id: "p1", name: "ledger", path: "/tmp/ledger" });
    const m = await mount(
      <EditProjectModal
        project={p1}
        onClose={() => {}}
        onSubmit={async (input) => {
          calls.push(input);
          return input;
        }}
        onPickIcon={async () => ({
          iconPath: "brand/logo.svg",
          iconUrl: TINY_PNG,
        })}
      />,
    );

    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();
    assert.equal(
      Object.prototype.hasOwnProperty.call(calls[0], "iconPath"),
      false,
      "unchanged icon is omitted",
    );

    const m2 = await mount(
      <EditProjectModal
        project={p1}
        onClose={() => {}}
        onSubmit={async (input) => {
          calls.push(input);
          return input;
        }}
        onPickIcon={async () => ({
          iconPath: "brand/logo.svg",
          iconUrl: TINY_PNG,
        })}
      />,
    );
    await m2.click(m2.query("[data-edit-project-pick-icon]"));
    await m2.flush();
    assert.ok(m2.query("[data-edit-project-icon]"), "preview after pick");
    assert.match(
      m2.query("[data-edit-project-icon-path]")?.textContent || "",
      /brand\/logo\.svg/,
    );
    await m2.click(m2.query("[data-edit-project-submit]"));
    await m2.flush();
    assert.equal(calls[1]!.iconPath, "brand/logo.svg");
    m.unmount();
    m2.unmount();
  });

  it("Automatic sends iconPath null and previews the detected icon", async () => {
    const calls: ProjectUpdateInput[] = [];
    let previewed: Array<string | null> = [];
    const p1 = project({
      id: "p1",
      name: "ledger",
      path: "/tmp/ledger",
      iconPath: "custom/pick.svg",
      iconUrl: TINY_PNG,
    });
    const m = await mount(
      <EditProjectModal
        project={p1}
        onClose={() => {}}
        onSubmit={async (input) => {
          calls.push(input);
          return input;
        }}
        onPreviewIcon={async (iconPath) => {
          previewed.push(iconPath);
          return TINY_PNG;
        }}
      />,
    );
    const auto = m.query(
      "[data-edit-project-icon-auto]",
    ) as HTMLButtonElement | null;
    assert.ok(auto);
    assert.equal(auto!.disabled, false);
    await m.click(auto!);
    await m.flush();
    assert.deepEqual(previewed, [null]);
    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();
    assert.equal(calls[0]!.iconPath, null);
    m.unmount();
  });
});
