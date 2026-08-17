/**
 * Best of N popover: checkboxes, Run enablement, and the fork-then-run sequence.
 *
 * Run: node --import=./test/support/render.mjs --test test/bestOfNComposer.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
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
  const trigger = m.query("[data-best-of-n]") as HTMLButtonElement | null;
  assert.ok(trigger, "Best of N trigger");
  assert.equal(trigger.disabled, false, "trigger enables once there is a prompt");
  await m.click(trigger);
  const pop = m.query("[data-best-of-n-popover]");
  assert.ok(pop, "popover must open above the composer");
  return pop;
}

describe("Best of N popover", () => {
  it("stays disabled when the composer is empty or a run is active", async () => {
    const empty = await mount(composer());
    const emptyBtn = empty.query("[data-best-of-n]") as HTMLButtonElement;
    assert.ok(emptyBtn, "Best of N control must exist");
    assert.equal(emptyBtn.disabled, true, "empty prompt disables Best of N");
    assert.equal(
      emptyBtn.getAttribute("title"),
      "Run this prompt on multiple providers at once",
    );
    empty.unmount();

    const busy = await mount(composer({ disabled: true }));
    const ta = busy.query("textarea");
    await mTypeSafe(busy, ta, "still typed");
    const busyBtn = busy.query("[data-best-of-n]") as HTMLButtonElement;
    assert.equal(busyBtn.disabled, true, "active run disables Best of N");
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

async function mTypeSafe(
  m: Awaited<ReturnType<typeof mount>>,
  el: Element | null,
  value: string,
) {
  if (!el) return;
  await m.type(el, value);
}
