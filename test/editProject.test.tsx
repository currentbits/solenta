/**
 * Edit-project flow: the sidebar pencil opens EditProjectModal prefilled from
 * the project, and submit records projects.update with the edited fields.
 *
 * Run: node --import=./test/support/render.mjs --test test/editProject.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useState } from "react";
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
import type { ProjectUpdateInput, ProviderInfo } from "../src/shared/ipc";

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
      setupCommand: null,
      waitForSetup: false,
      branchPrefix: null,
      quickActions: [],
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

  it("saves a setup command and a named quick action (#153)", async () => {
    const p1 = project({
      id: "p1",
      name: "ledger",
      path: "/tmp/ledger",
      setupCommand: "npm install",
      quickActions: [{ id: "lint", name: "Lint", command: "npm run lint" }],
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
    const setup = m.query(
      "[data-edit-project-setup]",
    ) as HTMLInputElement | null;
    assert.ok(setup, "setup field");
    assert.equal(setup.value, "npm install");
    const name = m.query(
      "[data-edit-project-action-name]",
    ) as HTMLInputElement | null;
    assert.ok(name, "action name");
    assert.equal(name.value, "Lint");
    await m.type(m.query("[data-edit-project-setup]"), "pnpm i");
    await m.click(m.query("[data-edit-project-action-add]"));
    const names = m.queryAll(
      "[data-edit-project-action-name]",
    ) as HTMLInputElement[];
    const commands = m.queryAll(
      "[data-edit-project-action-command]",
    ) as HTMLInputElement[];
    assert.equal(names.length, 2);
    await m.type(names[1]!, "Reset db");
    await m.type(commands[1]!, "npm run db:reset");
    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();
    const payload = fake.of("projects.update")[0]!.args[0] as ProjectUpdateInput;
    assert.equal(payload.setupCommand, "pnpm i");
    assert.equal(payload.quickActions?.length, 2);
    assert.equal(payload.quickActions?.[0]?.name, "Lint");
    assert.equal(payload.quickActions?.[1]?.name, "Reset db");
    assert.equal(payload.quickActions?.[1]?.command, "npm run db:reset");
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

describe("edit project focus trap", () => {
  it("opening the dialog moves focus inside; Tab stays inside; Escape restores", async () => {
    const p1 = project({ id: "p1", name: "ledger", path: "/tmp/ledger" });
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            data-trap-opener=""
            onClick={() => setOpen(true)}
          >
            Open edit project
          </button>
          {open && (
            <EditProjectModal
              project={p1}
              onClose={() => setOpen(false)}
              onSubmit={async () => ({})}
            />
          )}
        </>
      );
    }
    const m = await mount(<Harness />);
    const opener = m.query("[data-trap-opener]") as HTMLElement;
    opener.focus();
    await m.click(opener);
    const dialog = m.query("[data-edit-project-dialog]") as HTMLElement | null;
    assert.ok(dialog, "edit-project dialog");
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
    const second = document.activeElement as HTMLElement;
    assert.ok(dialog.contains(second), "second Tab stays inside");
    assert.notEqual(second, first);

    await m.pressFocused("Escape");
    assert.equal(m.query("[data-edit-project]"), null);
    assert.equal(document.activeElement, opener, "Escape restores the opener");
    m.unmount();
  });
});

describe("new thread defaults (#1501)", () => {
  const providers = [
    {
      id: "claude",
      name: "Claude Code",
      available: true,
      supportsResume: true,
      models: ["claude-opus-5-5"],
      modelInfo: [{ id: "claude-opus-5-5", label: "Opus 5.5" }],
      efforts: ["low", "high"],
    },
    {
      id: "grok",
      name: "Grok",
      available: false,
      supportsResume: true,
      models: [],
      modelInfo: [],
      efforts: [],
      permissionModes: ["plan", "bypassPermissions"],
    },
  ] as ProviderInfo[];

  function modal(
    p: ReturnType<typeof project>,
    calls: ProjectUpdateInput[],
  ) {
    return mount(
      <EditProjectModal
        project={p}
        providers={providers}
        globalProvider={null}
        onClose={() => {}}
        onSubmit={async (input) => {
          calls.push(input);
          return input;
        }}
      />,
    );
  }

  it("saves provider, model, effort, permission and last used", async () => {
    const calls: ProjectUpdateInput[] = [];
    const m = await modal(project({ id: "p1", path: "/tmp/ledger" }), calls);
    await m.change(m.query("[data-edit-project-default-provider]"), "claude");
    await m.change(m.query("[data-edit-project-default-model]"), "claude-opus-5-5");
    await m.change(m.query("[data-edit-project-default-effort]"), "high");
    await m.change(m.query("[data-edit-project-default-permission]"), "acceptEdits");
    await m.click(m.query("[data-edit-project-last-used]"));
    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();
    assert.deepEqual(calls[0]!.threadDefaults, {
      provider: "claude",
      model: "claude-opus-5-5",
      reasoningEffort: "high",
      permissionMode: "acceptEdits",
      lastUsed: true,
    });
    m.unmount();
  });

  it("leaves threadDefaults off an unrelated save so last-used updates survive", async () => {
    const calls: ProjectUpdateInput[] = [];
    const p1 = project({
      id: "p1",
      path: "/tmp/ledger",
      threadDefaults: { provider: "claude", lastUsed: true },
    });
    const m = await modal(p1, calls);
    assert.equal(
      (m.query("[data-edit-project-default-provider]") as HTMLSelectElement).value,
      "claude",
      "prefills from the project",
    );
    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0], "threadDefaults"), false);
    m.unmount();
  });

  it("shows the global fallback for an uninstalled provider and clears the model on a switch", async () => {
    const calls: ProjectUpdateInput[] = [];
    const p1 = project({
      id: "p1",
      path: "/tmp/ledger",
      threadDefaults: {
        provider: "claude",
        model: "claude-opus-5-5",
        reasoningEffort: "high",
        permissionMode: "acceptEdits",
      },
    });
    const m = await modal(p1, calls);
    assert.equal(m.query("[data-edit-project-default-missing]"), null);
    await m.change(m.query("[data-edit-project-default-provider]"), "grok");
    assert.match(
      m.query("[data-edit-project-default-missing]")?.textContent || "",
      /Grok is not installed\. New threads use Claude Code/,
    );
    // grok lists no efforts, and does not offer "acceptEdits".
    assert.equal(m.query("[data-edit-project-default-effort]"), null);
    const modes = [
      ...(m.query("[data-edit-project-default-permission]") as HTMLSelectElement).options,
    ].map((o) => o.value);
    assert.deepEqual(modes, ["", "plan", "bypassPermissions"]);
    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();
    // acceptEdits snaps to the nearest mode grok honours.
    assert.deepEqual(calls[0]!.threadDefaults, {
      provider: "grok",
      permissionMode: "bypassPermissions",
    });
    m.unmount();
  });

  it("a project default provider stops new threads inheriting the selected thread's provider", async () => {
    for (const withDefault of [false, true]) {
      const p1 = project({
        id: "p1",
        name: "ledger",
        path: "/tmp/ledger",
        ...(withDefault ? { threadDefaults: { provider: "claude" } } : {}),
      });
      const t1 = thread({ id: "t1", projectId: "p1", provider: "codex" });
      const fake = createFakeCoder({
        projects: [p1],
        threads: [t1],
        details: { t1: detail({ thread: t1 }) },
      });
      const m = await boot(fake);
      try {
        await m.click(m.query('[data-thread-card="t1"]'));
        await m.click(m.query("[data-new-thread]"));
        await m.flush();
        assert.equal(fake.of("threads.create").length, 1);
        assert.equal(
          fake.of("threads.setProvider").length,
          withDefault ? 0 : 1,
          withDefault ? "project default wins" : "control: inherits without one",
        );
      } finally {
        m.unmount();
      }
    }
  });
});

describe("worktree setup options (#1506)", () => {
  function modal(over: Partial<Parameters<typeof EditProjectModal>[0]["project"]> = {}) {
    const submitted: ProjectUpdateInput[] = [];
    const el = (
      <EditProjectModal
        project={{
          id: "p1",
          slug: "ledger",
          name: "ledger",
          path: "/tmp/ledger",
          ...over,
        }}
        onClose={() => {}}
        onSubmit={async (input) => {
          submitted.push(input);
          return input;
        }}
      />
    );
    return { el, submitted };
  }

  it("sends the wait flag and branch prefix", async () => {
    const { el, submitted } = modal();
    const m = await mount(el);
    await m.click(m.query("[data-edit-project-wait-setup]"));
    await m.type(m.query("[data-edit-project-branch-prefix]"), "ai/");
    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();
    assert.equal(submitted[0]!.waitForSetup, true);
    assert.equal(submitted[0]!.branchPrefix, "ai/");
    m.unmount();
  });

  it("marks solenta.json commands and says project settings win", async () => {
    const { el, submitted } = modal({
      repoConfig: {
        setupCommand: "npm ci",
        quickActions: [{ id: "repo:0", name: "Test", command: "npm test" }],
        hash: "a".repeat(64),
        trusted: false,
      },
    });
    const m = await mount(el);
    assert.ok(m.query('[data-repo-config-source="setup"]'));
    assert.equal(
      (m.query("[data-edit-project-setup]") as HTMLInputElement).placeholder,
      "npm ci",
    );
    assert.match(m.container.textContent || "", /Leave empty to use the setup in solenta\.json/);
    assert.ok(m.query("[data-repo-config-action]"));
    assert.match(
      m.query("[data-repo-config-trust]")?.textContent || "",
      /ask for your approval/,
    );
    await m.type(m.query("[data-edit-project-setup]"), "make deps");
    assert.equal(m.query('[data-repo-config-source="setup"]'), null);
    assert.match(m.container.textContent || "", /overrides the setup in solenta\.json/);
    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();
    assert.equal(submitted[0]!.setupCommand, "make deps");
    assert.deepEqual(submitted[0]!.quickActions, [], "file actions are never copied into settings");
    m.unmount();
  });

  it("shows an invalid file's error", async () => {
    const { el } = modal({
      repoConfig: { error: "solenta.json: quickActions must be an array", trusted: false },
    });
    const m = await mount(el);
    assert.match(
      m.query("[data-repo-config-error]")?.textContent || "",
      /quickActions must be an array/,
    );
    m.unmount();
  });
});
