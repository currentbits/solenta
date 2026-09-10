/**
 * Onboarding first-thread step: create via createThread + setProvider,
 * no runs.start, nested Escape, retry without duplicate threads.
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/onboardingTour.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import { ThreadView } from "../src/components/ThreadView";
import type {
  ProjectInfo,
  ProviderInfo,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

const DOCS = "https://solenta.app/docs.html";

const defaultProject: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

const noopAsync = async () => {};
const noopSave = async () =>
  ({ id: "wf", name: "standard", phases: [] }) as WorkflowTemplateInfo;

function emptyView(over: { hasProjects?: boolean } = {}) {
  return (
    <ThreadView
      detail={null}
      project={over.hasProjects === false ? null : defaultProject}
      providers={providers}
      workflows={[]}
      hasProjects={over.hasProjects ?? true}
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={noopSave}
      onRemoveWorkflow={noopAsync}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onRespondPermission={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
      changesOpen={false}
      changesNonce={0}
      onCloseChanges={() => {}}
      onFetchDiff={async () => ({ files: [], patch: "", truncated: false })}
      onCommitChanges={async () => ({ subject: "x" })}
      onRevertFile={async (path) => ({ path })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={async () => ({ remote: "origin", branch: "main" })}
    />
  );
}

function prov(id: string, name: string, available: boolean): ProviderInfo {
  return {
    id,
    name,
    available,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  };
}

async function boot(
  fake: ReturnType<typeof createFakeCoder>,
): Promise<Awaited<ReturnType<typeof mount>>> {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

async function gotoTour(
  m: Awaited<ReturnType<typeof mount>>,
): Promise<void> {
  const next = m.query("[data-onboarding-next]");
  assert.ok(next, "Next control must exist");
  await m.click(next);
  await m.click(next);
  assert.equal(
    m.query("[data-onboarding-step]")?.getAttribute("data-onboarding-step"),
    "tour",
    "two Next clicks must land on the first-thread step",
  );
}

afterEach(unmountAll);

describe("Onboarding first-thread step", () => {
  it("creates a thread for the selected project and provider without starting a run", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      projects: [project({ id: "p1", name: "repo" })],
      providers: [
        prov("claude", "Claude Code", true),
        prov("simulate", "Simulate", true),
      ],
    });
    const m = await boot(fake);
    await gotoTour(m);

    assert.ok(m.query("[data-onboarding-tour]"), "tour step must render");
    assert.equal(
      m.query("[data-onboarding-project]")?.getAttribute("data-onboarding-project"),
      "p1",
    );
    assert.equal(
      m.query("[data-onboarding-provider]")?.getAttribute(
        "data-onboarding-provider",
      ),
      "claude",
    );
    assert.ok(
      !m.query("[data-onboarding-provider-select]"),
      "a single real provider is not a select",
    );
    assert.match(
      m.query("[data-onboarding-example]")?.textContent ?? "",
      /Look at this project/,
      "example prompt must be visible",
    );
    assert.match(
      m.text(),
      /press Send when you are ready/,
      "copy must not claim that writing alone sends",
    );
    const docs = m.query("[data-onboarding-docs]");
    assert.ok(docs, "one docs link");
    assert.equal(docs.getAttribute("href"), DOCS);
    assert.equal(docs.getAttribute("target"), "_blank");
    assert.equal(docs.getAttribute("rel"), "noreferrer");

    const create = m.query("[data-onboarding-create-thread]");
    assert.ok(create, "Create first thread must exist");
    await m.click(create);

    const created = fake.of("threads.create");
    assert.equal(created.length, 1, "exactly one thread must be created");
    const createInput = created[0]!.args[0] as {
      projectId?: string;
      title?: string;
    };
    assert.equal(createInput.projectId, "p1");
    const setCalls = fake.of("threads.setProvider");
    assert.equal(setCalls.length, 1, "setProvider once with the new thread id");
    const setInput = setCalls[0]!.args[0] as {
      threadId?: string;
      provider?: string;
    };
    assert.equal(setInput.threadId, "t-new");
    assert.equal(setInput.provider, "claude");
    assert.equal(
      fake.of("runs.start").length,
      0,
      "first-thread handoff must not call runs.start",
    );
    assert.ok(
      !m.query("[data-onboarding]"),
      "successful create must close onboarding",
    );
    const card = m.query('[data-thread-card="t-new"]');
    assert.ok(card, "new thread must appear in the sidebar");
    assert.ok(
      card.hasAttribute("data-active"),
      "new thread must be selected",
    );
    m.unmount();
  });

  it("uses native selects when several projects and providers are available", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      projects: [
        project({ id: "p1", name: "repo" }),
        project({ id: "p2", name: "other", slug: "owner/other", path: "/tmp/other" }),
      ],
      providers: [
        prov("claude", "Claude Code", true),
        prov("grok", "Grok", true),
        prov("simulate", "Simulate", true),
        prov("codex", "Codex", false),
      ],
    });
    const m = await boot(fake);
    await gotoTour(m);

    const projectSelect = m.query(
      "[data-onboarding-project-select]",
    ) as HTMLSelectElement | null;
    const providerSelect = m.query(
      "[data-onboarding-provider-select]",
    ) as HTMLSelectElement | null;
    assert.ok(projectSelect, "multiple projects must use a native select");
    assert.ok(providerSelect, "multiple available providers must use a native select");
    const providerValues = [...providerSelect.options].map((o) => o.value);
    assert.deepEqual(providerValues, ["claude", "grok"]);
    assert.ok(
      !providerValues.includes("simulate"),
      "simulate must not be selectable",
    );
    assert.ok(
      !providerValues.includes("codex"),
      "unavailable providers must not be selectable",
    );

    await m.change(projectSelect, "p2");
    await m.change(providerSelect, "grok");
    await m.click(m.query("[data-onboarding-create-thread]"));

    const createInput = fake.of("threads.create")[0]!.args[0] as {
      projectId?: string;
    };
    assert.equal(createInput.projectId, "p2");
    const setInput = fake.of("threads.setProvider")[0]!.args[0] as {
      threadId?: string;
      provider?: string;
    };
    assert.equal(setInput.threadId, "t-new");
    assert.equal(setInput.provider, "grok");
    assert.equal(fake.of("runs.start").length, 0);
    m.unmount();
  });

  it("missing prereqs link back to setup and cli without creating", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      projects: [],
      providers: [
        prov("claude", "Claude Code", false),
        prov("simulate", "Simulate", true),
      ],
    });
    const m = await boot(fake);
    await gotoTour(m);

    const create = m.query(
      "[data-onboarding-create-thread]",
    ) as HTMLButtonElement | null;
    assert.ok(create, "Create first thread still renders");
    assert.equal(create.disabled, true, "Create is disabled without prereqs");

    const toSetup = m.query("[data-onboarding-goto-setup]");
    const toCli = m.query("[data-onboarding-goto-cli]");
    assert.ok(toSetup, "missing project links to setup");
    assert.ok(toCli, "missing real agent links to cli");

    await m.click(toSetup);
    assert.equal(
      m.query("[data-onboarding-step]")?.getAttribute("data-onboarding-step"),
      "setup",
    );
    await m.click(m.query("[data-onboarding-next]"));
    await m.click(m.query("[data-onboarding-goto-cli]"));
    assert.equal(
      m.query("[data-onboarding-step]")?.getAttribute("data-onboarding-step"),
      "cli",
    );
    assert.equal(fake.of("threads.create").length, 0);
    assert.equal(fake.of("runs.start").length, 0);
    m.unmount();
  });

  it("retries setProvider on the same thread when provider save fails", async () => {
    const fail: Record<string, Error> = {
      "threads.setProvider": new Error("provider save failed"),
    };
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      fail,
    });
    const m = await boot(fake);
    await gotoTour(m);

    await m.click(m.query("[data-onboarding-create-thread]"));
    assert.equal(fake.of("threads.create").length, 1);
    assert.equal(fake.of("threads.setProvider").length, 1);
    assert.ok(
      m.query("[data-onboarding]"),
      "provider-save failure must keep the wizard open",
    );
    const err = m.query("[data-onboarding-first-error]");
    assert.ok(err, "provider-save failure must show an error");
    assert.ok(
      (err.textContent || "").includes("provider save failed"),
      `error must show the backend message, got: ${err.textContent}`,
    );

    delete fail["threads.setProvider"];
    await m.click(m.query("[data-onboarding-create-thread]"));
    assert.equal(
      fake.of("threads.create").length,
      1,
      "retry must not create a second empty thread",
    );
    assert.equal(fake.of("threads.setProvider").length, 2);
    const second = fake.of("threads.setProvider")[1]!.args[0] as {
      threadId?: string;
      provider?: string;
    };
    assert.equal(second.threadId, "t-new");
    assert.equal(second.provider, "claude");
    assert.equal(fake.of("runs.start").length, 0);
    assert.ok(!m.query("[data-onboarding]"), "successful retry must close");
    m.unmount();
  });

  it("does not inherit the selected thread provider; retry creates once", async () => {
    const fail: Record<string, Error> = {
      "threads.setProvider": new Error("provider save failed"),
    };
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      threads: [thread({ id: "t1", provider: "grok" })],
      providers: [
        prov("claude", "Claude Code", true),
        prov("grok", "Grok", true),
      ],
      fail,
    });
    const m = await boot(fake);
    await gotoTour(m);

    await m.click(m.query("[data-onboarding-create-thread]"));
    assert.equal(fake.of("threads.create").length, 1);
    const setCalls = fake.of("threads.setProvider");
    assert.equal(setCalls.length, 1, "no inherit setProvider before onboarding");
    const firstSet = setCalls[0]!.args[0] as {
      threadId?: string;
      provider?: string;
    };
    assert.equal(firstSet.threadId, "t-new");
    assert.equal(firstSet.provider, "claude");
    assert.ok(
      m.query("[data-onboarding-first-error]"),
      "failed onboarding setProvider must stay on the wizard",
    );

    delete fail["threads.setProvider"];
    await m.click(m.query("[data-onboarding-create-thread]"));
    assert.equal(
      fake.of("threads.create").length,
      1,
      "retry after setProvider fail must not create a second thread",
    );
    assert.equal(fake.of("threads.setProvider").length, 2);
    for (const call of fake.of("threads.setProvider")) {
      const input = call.args[0] as { provider?: string };
      assert.equal(
        input.provider,
        "claude",
        "must not inherit grok from the selected thread",
      );
    }
    assert.equal(fake.of("runs.start").length, 0);
    const card = m.query('[data-thread-card="t-new"]');
    assert.ok(card, "reused thread must be selected after retry");
    assert.ok(card.hasAttribute("data-active"));
    m.unmount();
  });

  it("retries the same thread when onboardingSeen save fails after create", async () => {
    const fail: Record<string, Error> = {
      "settings.set": new Error("disk full"),
    };
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      fail,
    });
    const m = await boot(fake);
    await gotoTour(m);

    await m.click(m.query("[data-onboarding-create-thread]"));
    assert.equal(fake.of("threads.create").length, 1);
    assert.ok(
      m.query("[data-onboarding-persist-error]"),
      "failed onboardingSeen save must keep the wizard open",
    );

    await m.click(m.query("[data-onboarding-create-thread]"));
    assert.equal(
      fake.of("threads.create").length,
      1,
      "Create after persist fail must reuse the thread",
    );
    assert.equal(fake.of("runs.start").length, 0);
    m.unmount();
  });

  it("creates in the newly selected project after a provider-save fail", async () => {
    const fail: Record<string, Error> = {
      "threads.setProvider": new Error("provider save failed"),
    };
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      projects: [
        project({ id: "p1", name: "repo" }),
        project({
          id: "p2",
          name: "other",
          slug: "owner/other",
          path: "/tmp/other",
        }),
      ],
      fail,
    });
    const m = await boot(fake);
    await gotoTour(m);

    await m.click(m.query("[data-onboarding-create-thread]"));
    assert.equal(fake.of("threads.create").length, 1);
    const firstCreate = fake.of("threads.create")[0]!.args[0] as {
      projectId?: string;
    };
    assert.equal(firstCreate.projectId, "p1");
    assert.ok(m.query("[data-onboarding-first-error]"));

    const projectSelect = m.query(
      "[data-onboarding-project-select]",
    ) as HTMLSelectElement | null;
    assert.ok(projectSelect, "multiple projects must use a native select");
    await m.change(projectSelect, "p2");
    delete fail["threads.setProvider"];
    await m.click(m.query("[data-onboarding-create-thread]"));

    const creates = fake.of("threads.create");
    assert.equal(
      creates.length,
      2,
      "changing project after provider-save fail must create a new thread",
    );
    const secondCreate = creates[1]!.args[0] as { projectId?: string };
    assert.equal(secondCreate.projectId, "p2");
    assert.equal(fake.of("runs.start").length, 0);
    m.unmount();
  });

  it("pending create blocks skip, back, and a second create", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const origCreate = fake.api.threads.create.bind(fake.api.threads);
    let release: (() => void) | null = null;
    fake.api.threads.create = (input) =>
      new Promise((resolve, reject) => {
        release = () => {
          Promise.resolve(origCreate(input)).then(resolve, reject);
        };
      });

    const m = await boot(fake);
    await gotoTour(m);
    const create = m.query(
      "[data-onboarding-create-thread]",
    ) as HTMLButtonElement;
    const skip = m.query("[data-onboarding-skip]") as HTMLButtonElement;
    const back = m.query("[data-onboarding-back]") as HTMLButtonElement;
    const next = m.query("[data-onboarding-next]") as HTMLButtonElement;

    await m.click(create);
    assert.equal(create.disabled, true, "Create disables while pending");
    assert.equal(skip.disabled, true, "Skip disables while pending");
    assert.equal(back.disabled, true, "Back disables while pending");
    assert.equal(next.disabled, true, "Do this later disables while pending");
    await m.click(create);
    assert.ok(release, "create must have started");
    release();
    for (let i = 0; i < 8; i++) {
      await m.flush();
      if (fake.of("threads.create").length > 0) break;
    }
    assert.equal(
      fake.of("threads.create").length,
      1,
      "double-click must not start a second create",
    );
    assert.equal(fake.of("runs.start").length, 0);
    m.unmount();
  });

  it("Escape in the add-project dialog does not finish onboarding", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      projects: [],
    });
    const m = await boot(fake);
    await m.click(m.query("[data-onboarding-next]"));
    assert.equal(
      m.query("[data-onboarding-step]")?.getAttribute("data-onboarding-step"),
      "setup",
    );
    const add = m.query("[data-onboarding-add-project]");
    assert.ok(add, "Add project must exist when there are no projects");
    await m.click(add);

    const addDialog = m.query("[data-add-project-path] [role='dialog']") as
      | HTMLElement
      | null;
    assert.ok(addDialog, "add-project dialog must open");
    const backdrop = m.query(
      "[data-onboarding-backdrop]",
    ) as HTMLElement | null;
    assert.ok(backdrop, "onboarding backdrop stays mounted while suspended");
    assert.ok(
      backdrop.hasAttribute("data-onboarding-suspended"),
      "onboarding must suspend while add-project is open",
    );
    assert.equal(
      getComputedStyle(backdrop).display,
      "none",
      "display:grid must not override hidden while add-project is open",
    );
    addDialog.focus();
    await m.pressFocused("Escape");

    assert.ok(
      !m.query("[data-add-project-path]"),
      "Escape must close the add-project dialog",
    );
    assert.ok(
      m.query("[data-onboarding]"),
      "Escape must not finish onboarding",
    );
    assert.equal(
      m.query("[data-onboarding-step]")?.getAttribute("data-onboarding-step"),
      "setup",
      "returning from add-project must keep the Project step",
    );
    assert.equal(
      fake.of("settings.set").filter((c) => {
        const patch = c.args[0] as { onboardingSeen?: boolean };
        return patch.onboardingSeen === true;
      }).length,
      0,
      "nested Escape must not persist onboardingSeen",
    );
    m.unmount();
  });
});

describe("ThreadView empty-state starters (#631)", () => {
  it("shows three Try asking chips when a project exists and no thread is selected", async () => {
    const m = await mount(emptyView());
    const starters = m.query("[data-empty-starters]");
    assert.ok(
      starters,
      "no-thread empty state with a project must show data-empty-starters",
    );
    const items = starters.querySelectorAll("li");
    assert.equal(
      items.length,
      3,
      `starter list must have 3 items, got ${items.length}`,
    );
    m.unmount();
  });

  it("does not show starter prompts when no project is registered", async () => {
    const m = await mount(emptyView({ hasProjects: false }));
    assert.ok(
      !m.query("[data-empty-starters]"),
      "no-projects empty state must not show starter prompts",
    );
    m.unmount();
  });
});
