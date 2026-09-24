/**
 * Best of N popover: checkboxes, Run enablement, and the fork-then-run sequence.
 *
 * Run: node --import=./test/support/render.mjs --test test/bestOfNComposer.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import { ThreadView } from "../src/components/ThreadView";
import type {
  AgentProfile,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

const CLAUDE: ProviderInfo = {
  id: "claude",
  name: "Claude Code",
  available: true,
  supportsResume: true,
  models: ["claude-sonnet-4"],
  modelInfo: [
    {
      id: "claude-sonnet-4",
      label: "Sonnet 4",
      description: "Everyday complex work",
      vendor: "Anthropic",
    },
  ],
  efforts: [],
};

const CODEX: ProviderInfo = {
  id: "codex",
  name: "Codex",
  available: true,
  supportsResume: false,
  models: [],
  modelInfo: [],
  efforts: [],
};

const GROK: ProviderInfo = {
  id: "grok",
  name: "Grok",
  available: false,
  supportsResume: false,
  models: ["grok-4"],
  modelInfo: [
    {
      id: "grok-4",
      label: "Grok 4",
      description: "xAI flagship",
      vendor: "xAI",
    },
  ],
  efforts: ["low", "medium", "high"],
};

const KIMI: ProviderInfo = {
  id: "kimi",
  name: "Kimi",
  available: true,
  supportsResume: true,
  models: ["k3"],
  modelInfo: [
    {
      id: "k3",
      label: "K3",
      description: "Moonshot flagship",
      vendor: "Moonshot",
    },
  ],
  efforts: [],
};

const PROVIDERS: ProviderInfo[] = [CLAUDE, CODEX, GROK, KIMI];

const WORKFLOWS: WorkflowTemplateInfo[] = [];

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t-source",
    projectId: "p1",
    title: "source thread",
    branch: "coder/best-of-n",
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: "/tmp/wt",
    handoffFrom: null,
    ...over,
  };
}

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    thread: over.thread ?? thread(),
    messages: over.messages ?? [],
    workLog: over.workLog ?? [],
    workflow: over.workflow ?? null,
    usage: over.usage ?? null,
  };
}

const noopSave = async () =>
  ({ id: "wf", name: "standard", phases: [] }) as WorkflowTemplateInfo;

const SCOUT: AgentProfile = {
  id: "prof-scout",
  name: "Cheap scout",
  provider: "claude",
  model: "haiku",
  reasoningEffort: "low",
  permissionMode: "plan",
};

const GROK_SCOUT: AgentProfile = {
  id: "prof-gone",
  name: "Grok scout",
  provider: "grok",
  model: "grok-4",
  reasoningEffort: null,
  permissionMode: "default",
};

function composer(over: {
  disabled?: boolean;
  busy?: boolean;
  agentProfiles?: AgentProfile[];
  onBestOfN?: (ids: string[], prompt: string) => void | Promise<void>;
} = {}) {
  return (
    <Composer
      threadId="t1"
      branch="coder/best-of-n"
      permissionMode="default"
      onPermissionModeChange={() => {}}
      provider="claude"
      model={null}
      reasoningEffort={null}
      providers={PROVIDERS}
      agentProfiles={over.agentProfiles}
      workflows={WORKFLOWS}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSaveWorkflow={noopSave}
      onRemoveWorkflow={async () => {}}
      sessionId={null}
      hasWorktree={true}
      disabled={over.disabled ?? false}
      busy={over.busy ?? false}
      onSend={() => {}}
      onBuild={() => {}}
      onBestOfN={over.onBestOfN ?? (async () => {})}
    />
  );
}

async function openBestOfN(
  m: Awaited<ReturnType<typeof mount>>,
  prompt = "compare this",
) {
  const ta = m.query("textarea");
  assert.ok(ta, "composer textarea");
  await m.type(ta, prompt);
  const trigger = m.query("[data-composer-options]") as HTMLButtonElement | null;
  assert.ok(trigger, "Options");
  assert.equal(trigger.disabled, false, "Options opens without a separate Best of N trigger");
  trigger.focus();
  await m.click(trigger);
  const pop = m.query("[data-best-of-n-popover]");
  assert.ok(pop, "Best of N stays inside Options");
  return pop;
}

describe("Best of N popover", () => {
  it("opening Best of N moves focus inside; Tab stays inside; Escape restores", async () => {
    const m = await mount(composer());
    const trigger = m.query("[data-composer-options]") as HTMLButtonElement;
    const ta = m.query("textarea");
    assert.ok(ta, "composer textarea");
    await m.type(ta, "compare this");
    // jsdom click does not focus; a real click would. Seed the trigger so
    // useModalFocus restores it the way a pointer open does.
    trigger.focus();
    await m.click(trigger);
    const dialog = m.query("[data-best-of-n-popover]") as HTMLElement | null;
    assert.ok(dialog, "popover");
    assert.ok(
      dialog.contains(document.activeElement),
      "opening the dialog must move focus inside it",
    );
    assert.notEqual(document.activeElement, trigger);

    let sawInput = false;
    const first = document.activeElement as HTMLElement;
    for (let i = 0; i < 8; i++) {
      await m.pressFocused("Tab");
      const current = document.activeElement as HTMLElement;
      assert.ok(dialog.contains(current), "Tab stays inside");
      if (current.tagName === "INPUT") sawInput = true;
      if (i > 0 && current === first) break;
    }
    assert.equal(sawInput, true, "Tab reaches the Best of N checkboxes");

    await m.pressFocused("Escape");
    assert.equal(m.query("[data-best-of-n-popover]"), null);
    assert.ok(
      document.activeElement === trigger,
      `Escape restores the Options trigger (got ${document.activeElement?.tagName})`,
    );
    m.unmount();
  });

  it("opens without a prompt and stays shut while archived or a run is active", async () => {
    const empty = await mount(composer());
    const emptyOptions = empty.query(
      "[data-composer-options]",
    ) as HTMLButtonElement;
    assert.ok(emptyOptions, "Options must exist");
    assert.equal(emptyOptions.disabled, false, "empty prompt still opens Options");
    emptyOptions.focus();
    await empty.click(emptyOptions);
    const run = empty.query("[data-best-of-n-run]") as HTMLButtonElement;
    assert.equal(run.disabled, true, "empty prompt disables Best of N run");
    assert.match(run.title, /prompt/i);
    await empty.click(empty.query('input[data-best-of-n-provider="claude"]'));
    await empty.click(empty.query('input[data-best-of-n-provider="codex"]'));
    assert.equal(
      (empty.query("[data-best-of-n-run]") as HTMLButtonElement).disabled,
      true,
      "two picks still do not run without a prompt",
    );
    empty.unmount();

    const archived = await mount(composer({ disabled: true }));
    const archivedOptions = archived.query(
      "[data-composer-options]",
    ) as HTMLButtonElement;
    assert.equal(archivedOptions.disabled, true, "archived thread disables Options");
    archived.unmount();

    const busy = await mount(composer({ busy: true }));
    const busyOptions = busy.query(
      "[data-composer-options]",
    ) as HTMLButtonElement;
    assert.equal(busyOptions.disabled, true, "active run disables Options");
    assert.match(busyOptions.title, /wait/i);
    busy.unmount();
  });

  it("lists installed providers with name and vendor; Run needs two", async () => {
    const m = await mount(composer());
    await openBestOfN(m);

    const boxes = m.queryAll("input[data-best-of-n-provider]");
    const ids = boxes.map((el) => el.getAttribute("data-best-of-n-provider"));
    assert.deepEqual(ids, ["claude", "codex", "kimi"]);
    assert.equal(
      m.query('input[data-best-of-n-provider="grok"]'),
      null,
      "unavailable providers stay off the list",
    );

    const text = m.text();
    assert.match(text, /Claude Code/);
    assert.match(text, /Anthropic/);
    assert.match(text, /Codex/);
    assert.match(text, /Kimi/);
    assert.match(text, /Moonshot/);
    assert.match(text, /Each selection forks a new thread/);
    const sectionLabels = m
      .queryAll("[data-composer-options-popover] p")
      .map((el) => el.textContent);
    assert.ok(
      sectionLabels.includes("Workflow"),
      "workflow section keeps its heading",
    );
    assert.ok(
      sectionLabels.includes("Best of N"),
      "Best of N keeps a section heading like Workflow",
    );
    assert.ok(
      sectionLabels.includes("Each selection forks a new thread"),
      "Best of N keeps the explanatory sentence",
    );

    const run = m.query("[data-best-of-n-run]") as HTMLButtonElement;
    assert.ok(run, "Run control");
    assert.equal(run.disabled, true, "Run starts disabled");

    await m.click(m.query('input[data-best-of-n-provider="claude"]'));
    assert.equal(
      (m.query("[data-best-of-n-run]") as HTMLButtonElement).disabled,
      true,
      "one selection is not enough",
    );

    await m.click(m.query('input[data-best-of-n-provider="codex"]'));
    assert.equal(
      (m.query("[data-best-of-n-run]") as HTMLButtonElement).disabled,
      false,
      "two selections enable Run",
    );
    assert.equal(
      m.query("[data-best-of-n-profile]"),
      null,
      "no profiles saved → no profile rows",
    );
    assert.doesNotMatch(m.text(), /Profiles/);
    m.unmount();
  });

  it("provider rows show a harness logo next to the name", async () => {
    const m = await mount(composer());
    await openBestOfN(m);

    const claude = m
      .query('input[data-best-of-n-provider="claude"]')
      ?.closest("label");
    assert.ok(claude, "claude row");
    const mark = claude!.querySelector('[data-provider-mark="claude"]');
    assert.ok(mark, "row reuses ProviderMark");
    assert.ok(mark!.querySelector("svg"), "known harness is a logo");
    assert.match(
      claude!.textContent || "",
      /Claude Code/,
      "the display name stays on the row",
    );
    assert.equal(
      mark!.getAttribute("aria-hidden"),
      "true",
      "visible name is the accessible name; the mark is decorative",
    );

    const codex = m
      .query('input[data-best-of-n-provider="codex"]')
      ?.closest("label");
    assert.ok(
      codex?.querySelector('[data-provider-mark="codex"] svg'),
      "every installed provider gets a logo",
    );
    const kimi = m
      .query('input[data-best-of-n-provider="kimi"]')
      ?.closest("label");
    assert.ok(
      kimi?.querySelector('[data-provider-mark="kimi"] svg'),
      "kimi row also gets a logo",
    );
    m.unmount();
  });

  it("lists saved profiles above providers; uninstalled ones stay disabled", async () => {
    const m = await mount(
      composer({ agentProfiles: [SCOUT, GROK_SCOUT] }),
    );
    await openBestOfN(m);
    assert.match(m.text(), /Profiles/);
    assert.match(m.text(), /Cheap scout/);
    const scout = m.query(
      'input[data-best-of-n-profile="prof-scout"]',
    ) as HTMLInputElement | null;
    const gone = m.query(
      'input[data-best-of-n-profile="prof-gone"]',
    ) as HTMLInputElement | null;
    assert.ok(scout, "installed profile is listed");
    assert.equal(scout.disabled, false);
    assert.ok(gone, "uninstalled profile is still listed");
    assert.equal(gone.disabled, true);
    assert.equal(gone.closest("label")?.getAttribute("title"), "not installed");
    m.unmount();
  });

  it("profile rows show a harness logo keyed on the profile's provider", async () => {
    const m = await mount(
      composer({ agentProfiles: [SCOUT, GROK_SCOUT] }),
    );
    await openBestOfN(m);

    const scout = m
      .query('input[data-best-of-n-profile="prof-scout"]')
      ?.closest("label");
    assert.ok(scout, "scout row");
    const mark = scout!.querySelector('[data-provider-mark="claude"]');
    assert.ok(mark, "mark uses the profile's provider id, not the profile id");
    assert.ok(mark!.querySelector("svg"), "known harness is a logo");
    assert.match(
      scout!.textContent || "",
      /Cheap scout/,
      "the profile name stays on the row",
    );
    assert.equal(
      mark!.getAttribute("aria-hidden"),
      "true",
      "visible name is the accessible name; the mark is decorative",
    );

    const gone = m
      .query('input[data-best-of-n-profile="prof-gone"]')
      ?.closest("label");
    assert.ok(
      gone?.querySelector('[data-provider-mark="grok"] svg'),
      "uninstalled profile still shows its harness mark",
    );
    m.unmount();
  });

  it("moves focus out of the composer; Tab stays inside; Escape restores", async () => {
    const m = await mount(composer());
    const ta = m.query("textarea");
    assert.ok(ta, "composer textarea");
    await m.type(ta, "compare this");
    const opener = m.query("[data-composer-options]") as HTMLButtonElement | null;
    assert.ok(opener, "Options trigger");
    await inAct(() => opener.focus());
    await m.click(opener);
    const dialog = m.query("[data-best-of-n-popover]") as HTMLElement | null;
    assert.ok(dialog, "Best of N popover");
    assert.ok(
      dialog.contains(document.activeElement),
      "opening the dialog must move focus inside it",
    );

    await m.pressFocused("Tab");
    const first = document.activeElement as HTMLElement;
    assert.ok(dialog.contains(first), "Tab stays inside");

    await m.pressFocused("Tab");
    const second = document.activeElement as HTMLElement;
    assert.ok(dialog.contains(second), "second Tab stays inside");
    assert.notEqual(second, first);

    let guard = 0;
    while (document.activeElement !== first && guard < 20) {
      await m.pressFocused("Tab");
      assert.ok(
        dialog.contains(document.activeElement),
        "Tab stays inside while wrapping",
      );
      guard += 1;
    }
    assert.equal(document.activeElement, first, "Tab wraps inside the dialog");

    await m.pressFocused("Escape");
    assert.equal(m.query("[data-best-of-n-popover]"), null);
    assert.equal(
      document.activeElement,
      opener,
      "Escape restores the Options trigger",
    );
    m.unmount();
  });
});

describe("Best of N submit sequence", () => {
  it("forks each pick, starts the prompt on that fork, then selects the first", async () => {
    const calls: string[] = [];
    const m = await mount(
      <ThreadView
        detail={detail()}
        project={project}
        providers={PROVIDERS}
        workflows={WORKFLOWS}
        hasProjects={true}
        onAddProject={() => {}}
        onStartRun={async (prompt, threadId) => {
          calls.push(`run:${threadId}:${prompt}`);
        }}
        onStartWorkflow={() => {}}
        onSaveWorkflow={noopSave}
        onRemoveWorkflow={async () => {}}
        onStopRun={() => {}}
        onSetPermissionMode={() => {}}
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
        onFork={async (opts) => {
          calls.push(`fork:${opts?.provider ?? ""}`);
          return { id: `fork-${opts?.provider}` } as ThreadInfo;
        }}
        onSelectThread={(id) => {
          calls.push(`select:${id}`);
        }}
      />,
    );

    await openBestOfN(m, "compare this");
    await m.click(m.query('input[data-best-of-n-provider="kimi"]'));
    await m.click(m.query('input[data-best-of-n-provider="codex"]'));
    await m.click(m.query("[data-best-of-n-run]"));

    assert.deepEqual(calls, [
      "fork:kimi",
      "run:fork-kimi:compare this",
      "fork:codex",
      "run:fork-codex:compare this",
      "select:fork-kimi",
    ]);
    assert.equal(
      (m.query("textarea") as HTMLTextAreaElement).value,
      "",
      "success clears the composer",
    );
    assert.equal(
      m.query("[data-best-of-n-popover]"),
      null,
      "success closes the popover",
    );
    m.unmount();
  });

  it("surfaces a fork failure and leaves the prompt in place", async () => {
    const runs: string[] = [];
    const m = await mount(
      <ThreadView
        detail={detail()}
        project={project}
        providers={PROVIDERS}
        workflows={WORKFLOWS}
        hasProjects={true}
        onAddProject={() => {}}
        onStartRun={async (prompt) => {
          runs.push(prompt);
        }}
        onStartWorkflow={() => {}}
        onSaveWorkflow={noopSave}
        onRemoveWorkflow={async () => {}}
        onStopRun={() => {}}
        onSetPermissionMode={() => {}}
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
        onFork={async () => null}
      />,
    );

    await openBestOfN(m, "keep this prompt");
    await m.click(m.query('input[data-best-of-n-provider="claude"]'));
    await m.click(m.query('input[data-best-of-n-provider="codex"]'));
    await m.click(m.query("[data-best-of-n-run]"));

    assert.equal(runs.length, 0, "no run starts when fork fails");
    assert.match(m.text(), /Failed to fork thread/);
    assert.equal(
      (m.query("textarea") as HTMLTextAreaElement).value,
      "keep this prompt",
      "failure must not clear the composer",
    );
    m.unmount();
  });

  it("profile pick forks with model then sets effort and permission on the fork", async () => {
    const calls: string[] = [];
    const m = await mount(
      <ThreadView
        detail={detail()}
        project={project}
        providers={PROVIDERS}
        agentProfiles={[SCOUT]}
        workflows={WORKFLOWS}
        hasProjects={true}
        onAddProject={() => {}}
        onStartRun={async (prompt, threadId) => {
          calls.push(`run:${threadId}:${prompt}`);
        }}
        onStartWorkflow={() => {}}
        onSaveWorkflow={noopSave}
        onRemoveWorkflow={async () => {}}
        onStopRun={() => {}}
        onSetPermissionMode={(mode, threadId) => {
          calls.push(`perm:${threadId ?? ""}:${mode}`);
        }}
        onSetProvider={() => {}}
        onSetReasoningEffort={(effort, threadId) => {
          calls.push(`effort:${threadId ?? ""}:${effort}`);
        }}
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
        onFork={async (opts) => {
          calls.push(
            `fork:${opts?.provider ?? ""}:${opts?.model === undefined ? "-" : opts.model}`,
          );
          return {
            id: `fork-${opts?.provider}`,
          } as ThreadInfo;
        }}
        onSelectThread={(id) => {
          calls.push(`select:${id}`);
        }}
      />,
    );

    await openBestOfN(m, "compare this");
    await m.click(m.query('input[data-best-of-n-profile="prof-scout"]'));
    await m.click(m.query('input[data-best-of-n-provider="kimi"]'));
    await m.click(m.query("[data-best-of-n-run]"));

    assert.deepEqual(calls, [
      "fork:claude:haiku",
      "effort:fork-claude:low",
      "perm:fork-claude:plan",
      "run:fork-claude:compare this",
      "fork:kimi:-",
      "run:fork-kimi:compare this",
      "select:fork-claude",
    ]);
    m.unmount();
  });
});
