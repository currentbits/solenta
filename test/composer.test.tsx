/**
 * Composer, mounted for real: typing, menus, and start/stop guards run.
 *
 * Composer had ZERO render coverage. Model pick, permission mode, and the
 * Send/Build start path are the only way the user starts work; a silent break
 * there is a dead app. Pure modules and the rest of the suite cannot catch a
 * wrong value at this call site.
 *
 * Run: node --import=./test/support/render.mjs --test test/composer.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { useState } from "react";
import { mount, unmountAll, inAct } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import { setLastReasoningEffort } from "../src/uiPrefs";
import type {
  AgentProfile,
  PermissionMode,
  ProviderInfo,
  ReasoningEffort,
  ThreadTeach,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

const CLAUDE_WITH_INFO: ProviderInfo = {
  id: "claude",
  name: "Claude Code",
  available: true,
  supportsResume: true,
  models: ["claude-sonnet-4", "claude-opus-4"],
  modelInfo: [
    {
      id: "claude-sonnet-4",
      label: "Sonnet 4",
      description: "Everyday complex work",
      vendor: "Anthropic",
      recommended: true,
    },
    {
      id: "claude-opus-4",
      label: "Opus 4",
      description: "Deepest reasoning",
      vendor: "Anthropic",
    },
  ],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
};

const CODEX: ProviderInfo = {
  id: "codex",
  name: "Codex",
  available: true,
  supportsResume: false,
  models: [],
  modelInfo: [],
  efforts: [],
  supportsSearch: true,
  permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
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
  // Real CLI: low / medium / high only (three segments, not five).
  efforts: ["low", "medium", "high"],
  permissionModes: ["plan", "bypassPermissions"],
};

/**
 * An AVAILABLE provider with a SHORTER effort list than claude. Segment
 * count and the non-contiguous set (no medium) catch meters that assume
 * every harness is low..high or that the highlight's provider owns the bars.
 */
const KIMI_LIKE: ProviderInfo = {
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
  // The SHIPPED kimi set: non-contiguous (no medium). A contiguous fixture
  // here would hide any meter code that assumes low..high runs unbroken —
  // the same fixture hazard that has hidden bugs three times already.
  efforts: ["low", "high", "max"],
  permissionModes: ["bypassPermissions"],
};

const PROVIDERS: ProviderInfo[] = [CLAUDE_WITH_INFO, CODEX, GROK, KIMI_LIKE];

/** Provider with models but no modelInfo and no efforts (label fallback path). */
const BARE_MODELS: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: ["claude-sonnet-4", "claude-opus-4"],
    modelInfo: [],
    efforts: [],
  },
];

const WORKFLOWS: WorkflowTemplateInfo[] = [
  {
    id: "standard",
    name: "Standard",
    builtin: true,
    phases: [
      { name: "seed", agentCount: 1, provider: "claude", model: null },
      { name: "analyze", agentCount: 2, provider: "claude", model: null },
      { name: "synthesize", agentCount: 1, provider: "claude", model: null },
    ],
  },
];

interface Harness {
  sends: string[];
  builds: { prompt: string; templateId: string }[];
  modes: PermissionMode[];
  providerSets: { provider?: string; model?: string | null }[];
  efforts: (ReasoningEffort | null)[];
  webSearches: boolean[];
  /**
   * Ordered log across BOTH callbacks, and the effective effort after
   * emulating the backend rule (setProvider clears effort on a provider
   * change, electron/services.js). Two separate arrays cannot see order, so
   * "switch first, then effort" was asserted by a test that passed with the
   * awaits swapped (round 38 review, M1).
   */
  callOrder: ("setProvider" | "setReasoningEffort" | "setPermissionMode")[];
  effectiveEffort: ReasoningEffort | null;
  harnessProvider: string;
}

function makeHarness(provider = "claude"): Harness {
  return {
    sends: [],
    builds: [],
    modes: [],
    providerSets: [],
    efforts: [],
    webSearches: [],
    callOrder: [],
    effectiveEffort: null,
    harnessProvider: provider,
  };
}

function composer(
  harness: Harness,
  over: {
    threadId?: string;
    permissionMode?: PermissionMode;
    teach?: ThreadTeach | null;
    provider?: string;
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    webSearch?: boolean;
    sessionId?: string | null;
    branch?: string | null;
    hasWorktree?: boolean;
    disabled?: boolean;
    busy?: boolean;
    providers?: ProviderInfo[];
    agentProfiles?: AgentProfile[];
    onListFiles?: (query: string) => Promise<string[]>;
  } = {},
) {
  // Seed the emulation from the thread this element renders with, so the
  // provider-change detection compares against the real starting state.
  harness.harnessProvider = over.provider ?? "claude";
  harness.effectiveEffort =
    over.reasoningEffort === undefined ? null : over.reasoningEffort;
  return (
    <Composer
      threadId={over.threadId ?? "t1"}
      branch={over.branch === undefined ? "agentmux/abc" : over.branch}
      permissionMode={over.permissionMode ?? "default"}
      teach={over.teach}
      onPermissionModeChange={(mode) => {
        harness.modes.push(mode);
        harness.callOrder.push("setPermissionMode");
      }}
      provider={over.provider ?? "claude"}
      model={over.model === undefined ? null : over.model}
      reasoningEffort={
        over.reasoningEffort === undefined ? null : over.reasoningEffort
      }
      webSearch={over.webSearch === true}
      providers={over.providers ?? PROVIDERS}
      agentProfiles={over.agentProfiles}
      workflows={WORKFLOWS}
      onSetProvider={(input) => {
        harness.providerSets.push(input);
        harness.callOrder.push("setProvider");
        // Emulate the backend: a provider CHANGE wipes reasoningEffort
        // (electron/services.js). Without this, effort-set-before-switch and
        // effort-set-after-switch are indistinguishable to any assertion.
        if (input.provider && input.provider !== harness.harnessProvider) {
          harness.harnessProvider = input.provider;
          harness.effectiveEffort = null;
        }
      }}
      onSetReasoningEffort={(effort) => {
        harness.efforts.push(effort);
        harness.callOrder.push("setReasoningEffort");
        harness.effectiveEffort = effort;
      }}
      onSetWebSearch={(enabled) => {
        harness.webSearches.push(enabled);
      }}
      onSaveWorkflow={async (t) => ({
        id: "saved",
        name: t.name,
        builtin: false,
        phases: t.phases,
      })}
      onRemoveWorkflow={async () => {}}
      sessionId={over.sessionId === undefined ? null : over.sessionId}
      hasWorktree={over.hasWorktree ?? true}
      disabled={over.disabled ?? false}
      busy={over.busy ?? false}
      onSend={(prompt) => {
        harness.sends.push(prompt);
      }}
      onBuild={(prompt, templateId) => {
        harness.builds.push({ prompt, templateId });
      }}
      onListFiles={over.onListFiles}
    />
  );
}

afterEach(unmountAll);


/**
 * Open the picker and drill into a provider's models.
 *
 * The picker is now two levels: providers first, then that provider's models.
 * Every test that wants a model row goes through here, so the navigation model
 * lives in one place rather than being re-encoded per test.
 */
async function openProvider(
  m: Awaited<ReturnType<typeof mount>>,
  providerName: string,
) {
  // Only open if it is closed: clicking the trigger toggles, so calling this
  // after a back-navigation would shut the picker instead of drilling.
  if (!m.query('[role="listbox"][aria-label="Provider"]')) {
    await m.click(m.query('button[aria-label^="Model:"]'));
  }
  const providerBtn = m.query(
    `button[aria-label="Provider ${providerName}"]`,
  );
  if (!providerBtn) return null;
  await m.click(providerBtn);
  return m.query('[role="listbox"][aria-label="Model"]') as HTMLElement | null;
}

/** Open the reasoning pill's menu. It is its own pill, not part of the picker. */
async function openEffort(m: Awaited<ReturnType<typeof mount>>) {
  const pill = m.query('button[aria-label^="Reasoning:"]');
  if (!pill) return null;
  await m.click(pill);
  return m.query('[role="listbox"][aria-label="Reasoning effort"]') as
    | HTMLElement
    | null;
}

describe("Composer per-thread draft", () => {
  it("keeps an unsent draft with its thread across a switch", async () => {
    const h = makeHarness();
    // The app mounts ONE Composer and swaps threadId (ThreadView.tsx), so the
    // test must do the same: a remount would hide the shared-state bug.
    function Shell() {
      const [tid, setTid] = useState("t1");
      return (
        <>
          <button onClick={() => setTid((t) => (t === "t1" ? "t2" : "t1"))}>
            swap-thread
          </button>
          {composer(h, { threadId: tid })}
        </>
      );
    }
    const m = await mount(<Shell />);
    const ta = () => m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta(), "draft for thread A");

    await m.click(m.byText("swap-thread"));
    assert.equal(
      ta().value,
      "",
      "thread B must not inherit thread A's unsent draft",
    );

    await m.type(ta(), "draft for thread B");
    await m.click(m.byText("swap-thread"));
    assert.equal(
      ta().value,
      "draft for thread A",
      "switching back must restore thread A's draft",
    );
    m.unmount();
  });
});

describe("Composer typing lag (#654)", () => {
  it("does not rebuild model-picker chrome after the first letter", async () => {
    const h = makeHarness();
    let modelInfoReads = 0;
    const providers: ProviderInfo[] = [
      {
        ...CLAUDE_WITH_INFO,
        get modelInfo() {
          modelInfoReads += 1;
          return CLAUDE_WITH_INFO.modelInfo;
        },
      },
    ];
    const m = await mount(composer(h, { providers }));
    const ta = m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta, "a");
    const afterFirst = modelInfoReads;
    assert.ok(afterFirst > 0, "first letter may paint Send/Build as enabled");
    await m.type(ta, "abcdefghi more letters");
    assert.equal(
      modelInfoReads,
      afterFirst,
      "further letters must not rebuild the model picker",
    );
    m.unmount();
  });

  it("plain typing does not query @-mention files", async () => {
    const h = makeHarness();
    let lists = 0;
    const m = await mount(
      composer(h, {
        onListFiles: async () => {
          lists += 1;
          return [];
        },
      }),
    );
    const ta = m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta, "hello world this is a prompt");
    assert.equal(lists, 0);
    assert.equal(m.query('[aria-label="Commands"]'), null);
    assert.equal(m.query('[aria-label="Mention a file"]'), null);
    assert.equal(ta.getAttribute("spellcheck"), "false");
    assert.equal(ta.getAttribute("autocomplete"), "off");
    m.unmount();
  });
});

describe("Composer focus on thread open (issue #73)", () => {
  it("focuses the textarea on mount so typing works without a click", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    const ta = m.query("textarea") as HTMLTextAreaElement;
    assert.ok(ta, "composer must render a prompt textarea");
    assert.equal(
      document.activeElement,
      ta,
      "opening a thread must move keyboard focus to the composer",
    );
    m.unmount();
  });

  it("focuses the textarea when ThreadView swaps threadId", async () => {
    const h = makeHarness();
    function Shell() {
      const [tid, setTid] = useState("t1");
      return (
        <>
          <button onClick={() => setTid("t2")}>swap-thread</button>
          {composer(h, { threadId: tid })}
        </>
      );
    }
    const m = await mount(<Shell />);
    const ta = () => m.query("textarea") as HTMLTextAreaElement;
    (document.activeElement as HTMLElement)?.blur();
    assert.notEqual(document.activeElement, ta(), "precondition: blurred");

    await m.click(m.byText("swap-thread"));
    assert.equal(
      document.activeElement,
      ta(),
      "selecting another thread must focus its composer",
    );
    m.unmount();
  });

  it("waits while disabled, then focuses once the composer enables", async () => {
    const h = makeHarness();
    function Shell() {
      const [off, setOff] = useState(true);
      return (
        <>
          <button onClick={() => setOff(false)}>enable</button>
          {composer(h, { disabled: off })}
        </>
      );
    }
    const m = await mount(<Shell />);
    const ta = () => m.query("textarea") as HTMLTextAreaElement;
    assert.notEqual(
      document.activeElement,
      ta(),
      "a disabled composer (running/archived thread) must not take focus",
    );

    await m.click(m.byText("enable"));
    assert.equal(
      document.activeElement,
      ta(),
      "a thread opened mid-run must focus once the input enables",
    );
    m.unmount();
  });

  it("does not re-focus an already-focused thread when a run finishes", async () => {
    const h = makeHarness();
    function Shell() {
      const [off, setOff] = useState(false);
      return (
        <>
          <button onClick={() => setOff((v) => !v)}>toggle-run</button>
          {composer(h, { disabled: off })}
        </>
      );
    }
    const m = await mount(<Shell />);
    const ta = () => m.query("textarea") as HTMLTextAreaElement;
    assert.equal(document.activeElement, ta(), "precondition: focused on open");

    // Blur BEFORE disabling: jsdom keeps a disabled element "focused" and
    // ignores blur() on it (real browsers blur on disable), so blurring after
    // the toggle would silently no-op.
    ta().blur();
    await m.click(m.byText("toggle-run")); // run starts: disabled
    await m.click(m.byText("toggle-run")); // run finishes: enabled again
    assert.notEqual(
      document.activeElement,
      ta(),
      "a background run finishing must not steal focus back",
    );
    m.unmount();
  });

  it("places the caret at the end of a restored draft", async () => {
    const h = makeHarness();
    function Shell() {
      const [tid, setTid] = useState("t1");
      return (
        <>
          <button onClick={() => setTid((t) => (t === "t1" ? "t2" : "t1"))}>
            swap-thread
          </button>
          {composer(h, { threadId: tid })}
        </>
      );
    }
    const m = await mount(<Shell />);
    const ta = () => m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta(), "draft for A");
    await m.click(m.byText("swap-thread")); // to t2
    await m.click(m.byText("swap-thread")); // back to t1

    assert.equal(document.activeElement, ta(), "returning to a thread refocuses");
    assert.equal(
      ta().selectionStart,
      "draft for A".length,
      "caret must sit at the end of the restored draft, not the start",
    );
    m.unmount();
  });
});

describe("Composer send", () => {
  it("types a prompt and submits once with that text", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    const ta = m.query("textarea");
    assert.ok(ta, "composer must render a prompt textarea");
    await m.type(ta, "fix the sidebar chip");

    const send = m.query('button[aria-label="Send"]') as HTMLButtonElement | null;
    assert.ok(send, "Send control must exist");
    assert.equal(send.disabled, false, "Send must enable once there is a prompt");
    await m.click(send);

    assert.deepEqual(
      h.sends,
      ["fix the sidebar chip"],
      "onSend must fire exactly once with the typed text",
    );
    assert.equal(h.builds.length, 0, "Send must not also start a Build");
    m.unmount();
  });

  it("refuses to submit an empty or whitespace-only prompt", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    const send = m.query('button[aria-label="Send"]') as HTMLButtonElement;
    const build = m.byText("Build") as HTMLButtonElement | null;

    assert.equal(send.disabled, true, "empty prompt: Send disabled");
    assert.ok(build, "Build control must exist");
    assert.equal(build.disabled, true, "empty prompt: Build disabled");

    await m.click(send);
    await m.click(build);
    assert.equal(h.sends.length, 0, "empty Send must not call onSend");
    assert.equal(h.builds.length, 0, "empty Build must not call onBuild");

    const ta = m.query("textarea");
    await m.type(ta, "   \n\t  ");
    assert.equal(
      (m.query('button[aria-label="Send"]') as HTMLButtonElement).disabled,
      true,
      "whitespace-only prompt must still disable Send",
    );
    await m.click(m.query('button[aria-label="Send"]'));
    assert.equal(h.sends.length, 0, "whitespace Send must not call onSend");
    m.unmount();
  });
});

describe("Composer drill-down picker", () => {
  it("opens on providers, not on a flat list of every model", () => {
    // The flat list ran to 26 rows. The first level is five.
    return (async () => {
      const h = makeHarness();
      const m = await mount(composer(h, { provider: "claude", model: null }));
      await m.click(m.query('button[aria-label^="Model:"]'));

      const providerList = m.query('[role="listbox"][aria-label="Provider"]');
      assert.ok(providerList, "the first level must be the provider list");
      assert.equal(
        m.query('[role="listbox"][aria-label="Model"]'),
        null,
        "no model list until a provider is entered",
      );
      const rows = m.queryAll('button[aria-label^="Provider "]');
      assert.equal(rows.length, PROVIDERS.length, "one row per provider");
      assert.equal(
        m.text().includes("Opus 4"),
        false,
        "model names must not appear before drilling in",
      );
      m.unmount();
    })();
  });

  it("summarises how many models each provider offers", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const claude = m.query('button[aria-label="Provider Claude Code"]');
    assert.ok(claude);
    assert.match(
      claude.textContent || "",
      /2 models/,
      "the row must say what is behind it",
    );
    const codex = m.query('button[aria-label="Provider Codex"]');
    assert.match(
      codex?.textContent || "",
      /Default only/,
      "a provider with no list must say so, not '0 models'",
    );
    m.unmount();
  });

  it("entering a provider shows that provider's models only", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    const list = await openProvider(m, "Claude Code");
    assert.ok(list, "entering must open the model list");
    assert.ok(m.text().includes("Opus 4"), "claude's models must show");
    assert.equal(
      m.text().includes("Grok 4"),
      false,
      "another provider's models must not leak into this level",
    );
    m.unmount();
  });

  it("goes back to the providers without closing the picker", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    assert.ok(await openProvider(m, "Claude Code"));
    await m.click(m.byText("CLAUDE CODE"));
    assert.ok(
      m.query('[role="listbox"][aria-label="Provider"]'),
      "back must return to the provider list",
    );
    assert.equal(
      m.query('[role="listbox"][aria-label="Model"]'),
      null,
      "the model level must be gone",
    );
    assert.deepEqual(h.providerSets, [], "navigating must not select anything");
    m.unmount();
  });

  it("selecting a model reports its provider and id together", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    assert.ok(await openProvider(m, "Claude Code"));
    const row = m
      .queryAll("button")
      .find((b) => (b.textContent || "").includes("Sonnet 4"));
    assert.ok(row, "Sonnet must be listed");
    await m.click(row);
    assert.deepEqual(h.providerSets, [
      { provider: "claude", model: "claude-sonnet-4" },
    ]);
    m.unmount();
  });

  it("switches harness when the model belongs to another provider", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    assert.ok(await openProvider(m, "Codex"));
    const row = m
      .queryAll("button")
      .find((b) => (b.textContent || "").trim().startsWith("Default"));
    assert.ok(row, "Codex Default must be listed");
    await m.click(row);
    assert.deepEqual(h.providerSets, [{ provider: "codex", model: null }]);
    m.unmount();
  });

  it("will not enter a provider whose CLI is missing", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const grok = m.query(
      'button[aria-label="Provider Grok"]',
    ) as HTMLButtonElement | null;
    assert.ok(grok, "an unavailable provider must still be listed");
    assert.equal(grok.disabled, true, "but it must not be enterable");
    assert.match(grok.textContent || "", /not installed/);
    await m.click(grok);
    assert.equal(
      m.query('[role="listbox"][aria-label="Model"]'),
      null,
      "clicking it must not drill in",
    );
    m.unmount();
  });

  it("lets a session-bearing thread switch harness, with a warning", async () => {
    // Sessions are not portable across CLIs, so the switch drops the session
    // (backend clears it); the picker warns instead of locking.
    const h = makeHarness();
    const m = await mount(
      composer(h, {
        provider: "claude",
        model: "claude-opus-4",
        sessionId: "sess-1",
      }),
    );
    await m.click(m.query('button[aria-label^="Model:"]'));
    const codex = m.query(
      'button[aria-label="Provider Codex"]',
    ) as HTMLButtonElement;
    assert.equal(codex.disabled, false, "other harnesses stay enterable");
    assert.match(
      codex.title,
      /fresh session/i,
      "the row must say what switching costs",
    );
    // The switch must actually go through: drill in and pick its Default.
    await m.click(codex);
    const def = m
      .queryAll("button")
      .find((b) => (b.textContent || "").includes("Default")) as
      | HTMLButtonElement
      | undefined;
    assert.ok(def, "codex models must be listed after drilling in");
    await m.click(def);
    assert.deepEqual(h.providerSets, [{ provider: "codex", model: null }]);
    m.unmount();
  });

  it("operates both levels by keyboard", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const plist = m.query(
      '[role="listbox"][aria-label="Provider"]',
    ) as HTMLElement;
    assert.ok(plist);

    // Enter drills in; ArrowLeft comes back out.
    await m.press(plist, "Enter");
    const mlist = m.query(
      '[role="listbox"][aria-label="Model"]',
    ) as HTMLElement;
    assert.ok(mlist, "Enter must enter the highlighted provider");
    await m.press(mlist, "ArrowLeft");
    assert.ok(
      m.query('[role="listbox"][aria-label="Provider"]'),
      "ArrowLeft must step back a level",
    );
    m.unmount();
  });

  it("arrow keys never land on a provider that cannot be entered", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const plist = m.query(
      '[role="listbox"][aria-label="Provider"]',
    ) as HTMLElement;
    for (let i = 0; i < 10; i += 1) {
      await m.press(plist, "ArrowDown");
      const hl = m.query('[data-highlighted="true"]');
      assert.ok(hl, "something must stay highlighted");
      assert.equal(
        (hl.textContent || "").includes("not installed"),
        false,
        "arrows must skip a provider whose CLI is missing",
      );
    }
    m.unmount();
  });

  it("falls back to raw model ids when a provider has no modelInfo", async () => {
    // Restored from the pre-drill-down suite: a provider that publishes models
    // but no metadata must still be usable, showing ids rather than nothing.
    const h = makeHarness();
    const bare: ProviderInfo = {
      id: "bare",
      name: "Bare",
      available: true,
      supportsResume: false,
      models: ["raw-model-a"],
      modelInfo: [],
      efforts: [],
    } as ProviderInfo;
    const m = await mount(
      composer(h, { provider: "claude", model: null, providers: [...PROVIDERS, bare] }),
    );
    const list = await openProvider(m, "Bare");
    assert.ok(list, "a provider with no modelInfo must still be enterable");
    assert.ok(
      m.text().includes("raw-model-a"),
      "the raw id must render when there is no label",
    );
    m.unmount();
  });

  it("hides the reasoning pill entirely for a provider with no efforts", async () => {
    // Empty efforts on the THREAD's provider: no pill, not a disabled one.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "codex", model: null }));
    assert.equal(
      m.query('button[aria-label^="Reasoning:"]'),
      null,
      "codex advertises no efforts, so no effort pill may render",
    );
    m.unmount();
  });

  it("hides the pill when the selected model lists no efforts", async () => {
    const claude: ProviderInfo = {
      ...CLAUDE_WITH_INFO,
      efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"],
      models: ["claude-opus-5", "claude-haiku-4-5"],
      modelInfo: [
        {
          id: "claude-opus-5",
          label: "Opus",
          description: "hard work",
          vendor: "Anthropic",
          efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"],
        },
        {
          id: "claude-haiku-4-5",
          label: "Haiku",
          description: "fast",
          vendor: "Anthropic",
          efforts: [],
        },
      ],
    };
    const h = makeHarness();
    const hidden = await mount(
      composer(h, {
        provider: "claude",
        model: "claude-haiku-4-5",
        providers: [claude],
      }),
    );
    assert.equal(
      hidden.query('button[aria-label^="Reasoning:"]'),
      null,
      "haiku is not effort-capable",
    );
    hidden.unmount();

    const shown = await mount(
      composer(h, {
        provider: "claude",
        model: "claude-opus-5",
        providers: [claude],
      }),
    );
    assert.ok(shown.query('button[aria-label^="Reasoning:"]'));
    const menu = await openEffort(shown);
    assert.ok(
      Array.from(menu?.querySelectorAll("button") || []).some((b) =>
        (b.getAttribute("aria-label") || "").includes("Ultracode"),
      ),
    );
    shown.unmount();
  });

  it("lists one row per level the thread's provider advertises", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    const menu = await openEffort(m);
    // Default plus claude's five.
    assert.equal(menu?.querySelectorAll("button").length, 6, "claude has five");
    m.unmount();

    const m2 = await mount(composer(h, { provider: "kimi", model: null }));
    const menu2 = await openEffort(m2);
    assert.equal(
      menu2?.querySelectorAll("button").length,
      4,
      "kimi advertises three, so three rows plus Default",
    );
    m2.unmount();
  });

  it("reports the reasoning level when a row is clicked", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    assert.ok(await openEffort(m));
    const row = m.query('button[aria-label="Reasoning High"]');
    assert.ok(row, "a High row must exist for claude");
    await m.click(row);
    assert.deepEqual(h.efforts, ["high"], "clicking must report that level");
    m.unmount();
  });

  it("labels each row with the human effort name", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    const menu = await openEffort(m);
    const labels = Array.from(menu?.querySelectorAll("button") ?? []).map((el) =>
      (el.textContent || "").trim(),
    );
    assert.deepEqual(
      labels,
      ["Auto", "Low", "Medium", "High", "Extra high", "Max"],
      "rows must read Auto and Low…Max, not tooltip-only",
    );
    m.unmount();
  });

  it("stays keyboard-operable across every level change", async () => {
    // This is the test that would have caught the focus bug. It drives the
    // picker through whatever is ACTUALLY focused, so a level change that
    // drops focus to <body> fails here instead of passing everywhere.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));

    // Drill in with the keyboard.
    await m.pressFocused("Enter");
    assert.ok(
      m.query('[role="listbox"][aria-label="Model"]'),
      "Enter must drill into the highlighted provider",
    );

    // Arrows must still move at the new level.
    const before = m.query('[data-highlighted="true"]')?.textContent;
    await m.pressFocused("ArrowDown");
    const after = m.query('[data-highlighted="true"]')?.textContent;
    assert.notEqual(
      after,
      before,
      "the highlight must move after drilling in, or focus was lost",
    );

    // Escape must step back a level, NOT close the picker. With focus on
    // <body> the keydown never reaches the handler that stops propagation and
    // the document listener closes everything.
    await m.pressFocused("Escape");
    assert.ok(
      m.query('[role="listbox"][aria-label="Provider"]'),
      "Escape must return to the provider list",
    );
    assert.equal(
      m.query('[role="listbox"][aria-label="Model"]'),
      null,
      "and leave the model level",
    );

    // And arrows must work again back at the provider level.
    const pBefore = m.query('[data-highlighted="true"]')?.textContent;
    await m.pressFocused("ArrowDown");
    assert.notEqual(
      m.query('[data-highlighted="true"]')?.textContent,
      pBefore,
      "the provider highlight must move after backing out",
    );
    m.unmount();
  });

  it("drills in highlighting the model the thread is on, not Default", async () => {
    // B3: the comment claimed this while the code sent every drill-in to row 0,
    // so the detail pane described Default while aria-selected sat elsewhere.
    const h = makeHarness();
    const m = await mount(
      composer(h, { provider: "claude", model: "claude-opus-4" }),
    );
    assert.ok(await openProvider(m, "Claude Code"));
    const hl = m.query('[data-highlighted="true"]');
    assert.ok(hl, "a row must be highlighted");
    assert.match(
      hl.textContent || "",
      /Opus 4/,
      "the highlight must start on the selected model",
    );
    m.unmount();
  });

  it("drills in on the selected model for a provider that is not first", async () => {
    // The claude case above cannot fail: claude is PROVIDERS[0], so the flat
    // index and the per-provider index coincide and a drill-in that never
    // re-seeds still lands on the right row. kimi is last, so its flat index
    // is out of range for its own two-row list and clamps to Custom.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "kimi", model: "k3" }));
    assert.ok(await openProvider(m, "Kimi"));
    const hl = m.query('[data-highlighted="true"]');
    assert.ok(hl, "a row must be highlighted");
    assert.match(
      hl.textContent || "",
      /K3/,
      "drilling in must re-seed the highlight from the thread's model",
    );
    m.unmount();
  });

  it("hovering a model row moves the highlight and the detail pane", async () => {
    // The provider level had this pinned and the model level did not, so
    // deleting the model row's onMouseEnter left the suite green.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    assert.ok(await openProvider(m, "Claude Code"));
    const before = m.query('[class*="detailLabel"]')?.textContent;
    const opus = m
      .queryAll('[class*="modelRow"]')
      .find((el) => (el.textContent || "").includes("Opus 4"));
    assert.ok(opus, "the Opus row must render to be hovered");
    await m.hover(opus);
    assert.match(
      m.query('[class*="detailLabel"]')?.textContent || "",
      /Opus 4/,
      "hover must move the detail pane to the hovered model",
    );
    assert.notEqual(before, "Opus 4", "the pane must have started elsewhere");
    assert.match(
      m.query('[data-highlighted="true"]')?.textContent || "",
      /Opus 4/,
      "hover must move the highlight, not just the pane",
    );
    m.unmount();
  });

  it("keyboard-selects a model and reports it", async () => {
    // L2: nothing keyboard-selected an actual model after the rewrite. The
    // custom tests press Enter on Custom..., which takes a different branch.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    await m.pressFocused("Enter");
    await m.pressFocused("ArrowDown");
    const target = m.query('[data-highlighted="true"]')?.textContent || "";
    await m.pressFocused("Enter");
    assert.equal(h.providerSets.length, 1, "Enter must select the highlight");
    assert.equal(h.providerSets[0].provider, "claude");
    assert.ok(
      target.includes("Sonnet 4") || target.includes("Opus 4"),
      `expected a real model row, got ${target}`,
    );
    m.unmount();
  });

  it("the detail pane follows the highlight within a provider", async () => {
    // L3: after the rewrite nothing moved the highlight WITHIN a list, so the
    // detail pane was only ever exercised at index 0.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    const list = await openProvider(m, "Claude Code");
    assert.ok(list);
    const first = m.query('[class*="detailLabel"]')?.textContent;
    await m.press(list, "ArrowDown");
    const second = m.query('[class*="detailLabel"]')?.textContent;
    assert.notEqual(
      second,
      first,
      "the detail pane must follow the highlighted row",
    );
    m.unmount();
  });

  it("a session-locked thread can still change its own model", async () => {
    // B4 / L1: only the provider-level disabled flags survived the rewrite.
    // buildModelRows takes no lock argument, so the day someone threads one in,
    // a locked user silently loses the ability to change model mid-thread.
    const h = makeHarness();
    const m = await mount(
      composer(h, {
        provider: "claude",
        model: "claude-opus-4",
        sessionId: "sess-lock",
      }),
    );
    assert.ok(await openProvider(m, "Claude Code"), "own provider stays open");
    const sonnet = m
      .queryAll("button")
      .find((b) => (b.textContent || "").includes("Sonnet 4")) as
      | HTMLButtonElement
      | undefined;
    assert.ok(sonnet, "its models must be listed");
    assert.equal(sonnet.disabled, false, "and must stay selectable");
    await m.click(sonnet);
    assert.deepEqual(h.providerSets, [
      { provider: "claude", model: "claude-sonnet-4" },
    ]);
    m.unmount();
  });

  it("clicking a provider that cannot be entered reports nothing", async () => {
    // L5: the old suite checked the callback stayed silent; the rewrite only
    // checked the button was disabled.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    await m.click(m.query('button[aria-label="Provider Grok"]'));
    assert.deepEqual(
      h.providerSets,
      [],
      "a disabled provider must not report a selection",
    );
    m.unmount();
  });

  it("shows no group heading once inside a provider", async () => {
    // B6: the whole content of the heading commit had no test.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    assert.ok(await openProvider(m, "Claude Code"));
    assert.equal(
      m.queryAll('[class*="modelGroupHeading"]').length,
      0,
      "the back control already names the provider",
    );
    m.unmount();
  });

  it("opens on, drills into, and returns to the HIGHLIGHTED provider", async () => {
    // B5: with the thread on claude (which is PROVIDERS[0]), "highlighted",
    // "current" and "index 0" are indistinguishable, so four separate bugs
    // could survive. Kimi is not index 0.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "kimi", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));

    const opened = m.query('[data-highlighted="true"]')?.textContent || "";
    assert.match(opened, /Kimi/, "must open on the thread's provider, not row 0");

    // ArrowRight must drill into the HIGHLIGHTED provider.
    await m.pressFocused("ArrowUp");
    const target = m.query('[data-highlighted="true"]')?.textContent || "";
    assert.equal(
      /Kimi/.test(target),
      false,
      "ArrowUp must move off Kimi for this to prove anything",
    );
    // Two assertions below, each catching a different bug, so do not delete
    // either as redundant: the negative catches drilling into the CURRENT
    // provider, the round-trip catches drilling into a FIXED one (whose name
    // the negative would happily accept).
    await m.pressFocused("ArrowRight");
    const back = m.byText("‹ ") ?? m.query('[class*="modelBackHeader"]');
    assert.ok(back, "ArrowRight must drill in");
    const heading = (back.textContent || "").replace(/[‹\s]/g, "");
    assert.equal(
      heading.toLowerCase().includes("kimi"),
      false,
      `ArrowRight must enter the highlighted provider, not the current one (got ${heading})`,
    );

    // Backing out must return to the provider we came from, not row 0.
    await m.pressFocused("Escape");
    const returned = m.query('[data-highlighted="true"]')?.textContent || "";
    assert.equal(
      returned.replace(/\s+/g, " ").trim(),
      target.replace(/\s+/g, " ").trim(),
      "backing out must land on the provider that was entered",
    );
    m.unmount();
  });

  it("describes the highlighted PROVIDER, not some unrelated model", async () => {
    // Shipped bug: the pane indexed the flat model list with the model-level
    // highlight, so a Grok thread opened showing "Fable / Anthropic". A pane
    // that confidently describes something the user is not pointing at is
    // worse than an empty one.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "kimi", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));

    const label = m.query('[class*="detailLabel"]')?.textContent || "";
    assert.equal(
      label,
      "Kimi",
      `the pane must name the highlighted provider, got ${label}`,
    );
    const pane = m.query('[class*="modelPopoverRight"]')?.textContent || "";
    assert.equal(
      /Fable|Opus|Sonnet|Haiku/.test(pane),
      false,
      `no model name may appear at the provider level, got: ${pane}`,
    );
    m.unmount();
  });

  it("shows a catalogNote for the highlighted provider, not as a toast", async () => {
    const h = makeHarness();
    const note =
      "Codex CLI lists gpt-5.6-sol; snapshot does not. Use Custom... for unlisted ids.";
    const m = await mount(
      composer(h, {
        provider: "codex",
        model: null,
        providers: [{ ...CODEX, catalogNote: note }],
      }),
    );
    assert.equal(m.query("[data-catalog-note]"), null);
    await m.click(m.query('button[aria-label^="Model:"]'));
    const shown = m.query("[data-catalog-note]");
    assert.ok(shown, "picker must show the harness note");
    assert.equal(shown.textContent, note);
    m.unmount();
  });

  it("the provider pane follows the highlight as you arrow", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const first = m.query('[class*="detailLabel"]')?.textContent;
    await m.pressFocused("ArrowDown");
    const second = m.query('[class*="detailLabel"]')?.textContent;
    assert.notEqual(second, first, "the pane must track the highlighted row");
    const names = PROVIDERS.map((p) => p.name);
    assert.ok(
      names.includes(String(second)),
      `the pane must name a provider, got ${second}`,
    );
    m.unmount();
  });

  it("hovering a provider moves the highlight and the pane", async () => {
    // Hover-to-highlight had no coverage: removing onMouseEnter from the row
    // passed the whole suite. A disabled row is deliberately NOT hoverable,
    // since React does not deliver mouse events to disabled buttons and you
    // cannot highlight what you cannot enter; its row text carries the reason.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    assert.equal(m.query('[class*="detailLabel"]')?.textContent, "Claude Code");

    await m.hover(m.query('button[aria-label="Provider Kimi"]'));
    assert.equal(
      m.query('[class*="detailLabel"]')?.textContent,
      "Kimi",
      "hovering a provider must move the highlight and the pane with it",
    );
    m.unmount();
  });

  it("keeps the effort pill on the thread while the picker is open", async () => {
    // The meter used to live in the picker's detail pane, so hovering another
    // harness or a profile made it describe something the thread was not on.
    // Its own pill cannot: it only ever reads the thread's provider.
    const h = makeHarness();
    const m = await mount(
      composer(h, { provider: "kimi", model: "k3", reasoningEffort: "high" }),
    );
    assert.ok(await openProvider(m, "Claude Code"), "drill into a foreign provider");
    assert.equal(
      m.query('button[aria-label^="Reasoning:"]')?.getAttribute("aria-label"),
      "Reasoning: High",
      "the pill must not follow the harness under the cursor",
    );
    const menu = await openEffort(m);
    assert.equal(
      menu?.querySelectorAll("button").length,
      4,
      "kimi's three plus Default, not claude's five",
    );
    await m.click(m.query('button[aria-label="Reasoning Max"]'));
    assert.deepEqual(
      h.providerSets,
      [],
      "picking a level must never switch the harness",
    );
    assert.equal(h.effectiveEffort, "max");
    m.unmount();
  });

  it("keeps the pill inert when the thread's OWN provider is not installed", async () => {
    // Both halves of the inertness (disabled + the pickEffort early-return)
    // could be removed with the suite green (round 38 M3): every effort test
    // used an installed provider.
    const h = makeHarness();
    const m = await mount(
      composer(h, {
        provider: "grok",
        model: null,
        reasoningEffort: "high",
        providers: [GROK],
      }),
    );
    const pill = m.query('button[aria-label^="Reasoning:"]');
    assert.ok(pill, "grok advertises efforts, so the pill renders");
    assert.equal(
      (pill as HTMLButtonElement).disabled,
      true,
      "an uninstalled CLI cannot honour a level; the pill must refuse",
    );
    await m.click(pill);
    assert.equal(
      m.query('[role="listbox"][aria-label="Reasoning effort"]'),
      null,
      "and it must not open",
    );
    assert.deepEqual(h.efforts, [], "and report nothing");
    m.unmount();
  });

  it("restores a level a harness switch had dropped", async () => {
    // claude/Extra high -> kimi cannot keep the level (kimi lists low/high/max
    // only), so services.js clears it. Switching back used to land on Default,
    // silently forgetting a level the user had picked.
    const h = makeHarness("kimi");
    setLastReasoningEffort("xhigh");
    const m = await mount(
      composer(h, { provider: "kimi", model: null, reasoningEffort: null }),
    );
    assert.ok(await openProvider(m, "Claude Code"));
    await m.click(m.query('[role="listbox"][aria-label="Model"] button'));
    assert.deepEqual(
      h.callOrder,
      ["setProvider", "setReasoningEffort"],
      "the restore must follow the switch, not race it",
    );
    assert.equal(h.effectiveEffort, "xhigh");
    m.unmount();
  });

  it("does not resurrect a level over a deliberate Default", async () => {
    // Same remembered level, but this harness CAN honour it: Auto here is the
    // user's own choice on this thread and must survive the switch.
    const h = makeHarness("claude");
    setLastReasoningEffort("xhigh");
    const m = await mount(
      composer(h, { provider: "claude", model: null, reasoningEffort: null }),
    );
    assert.ok(await openProvider(m, "Kimi"));
    await m.click(m.query('[role="listbox"][aria-label="Model"] button'));
    assert.deepEqual(h.efforts, [], "no effort call at all");
    setLastReasoningEffort(null);
    m.unmount();
  });

  it("reopens on the provider list after drilling in", async () => {
    // Same class as the custom-target leak: level state must reset on OPEN, or
    // the picker reopens somewhere the user did not leave it.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    const mlist = await openProvider(m, "Claude Code");
    assert.ok(mlist, "must drill in first");
    // Close WHILE STILL DRILLED. Stepping back first would clear the level as a
    // side effect and this would pass with the reset removed.
    await m.click(m.query('button[aria-label^="Model:"]'));
    assert.equal(
      m.query('[role="listbox"][aria-label="Model"]'),
      null,
      "the picker must be closed",
    );
    await m.click(m.query('button[aria-label^="Model:"]'));
    assert.ok(
      m.query('[role="listbox"][aria-label="Provider"]'),
      "reopening must start at the provider list",
    );
    m.unmount();
  });
});

describe("Composer permission mode", () => {
  it("shows the current mode and reports a change", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { permissionMode: "default" }));

    assert.ok(
      m.text().includes("Ask first"),
      "current permission mode label must be visible",
    );

    const modePill = Array.from(m.queryAll("button")).find((b) =>
      (b.textContent || "").includes("Ask first"),
    );
    assert.ok(modePill, "permission mode pill must exist");
    await m.click(modePill);

    // Safety-relevant options must be listed, not only the current one.
    assert.ok(m.text().includes("Full access"), "Full access must be offered");
    assert.ok(m.text().includes("Plan mode"), "Plan mode must be offered");
    assert.ok(m.text().includes("Accept edits"), "Accept edits must be offered");

    const full = Array.from(m.queryAll("button")).find((b) =>
      (b.textContent || "").trim() === "Full access",
    );
    assert.ok(full, "Full access option must be clickable");
    await m.click(full);

    assert.deepEqual(
      h.modes,
      ["bypassPermissions"],
      "changing permission mode must report the new mode",
    );
    m.unmount();
  });

  it("Teach mode at hint disables Full access and Accept edits", async () => {
    const h = makeHarness();
    const m = await mount(
      composer(h, {
        permissionMode: "default",
        teach: { autonomy: "hint", reviewsPassed: 0 },
      }),
    );
    const modePill = Array.from(m.queryAll("button")).find((b) =>
      (b.textContent || "").includes("Ask first"),
    );
    assert.ok(modePill);
    await m.click(modePill);
    const full = Array.from(m.queryAll("button")).find(
      (b) => (b.textContent || "").trim() === "Full access",
    );
    const accept = Array.from(m.queryAll("button")).find(
      (b) => (b.textContent || "").trim() === "Accept edits",
    );
    const plan = Array.from(m.queryAll("button")).find(
      (b) => (b.textContent || "").trim() === "Plan mode",
    );
    assert.ok(full);
    assert.ok(accept);
    assert.ok(plan);
    assert.equal((full as HTMLButtonElement).disabled, true);
    assert.equal((accept as HTMLButtonElement).disabled, true);
    assert.equal((plan as HTMLButtonElement).disabled, false);
    assert.equal(full.getAttribute("data-teach-gated"), "true");
    await m.click(full);
    assert.deepEqual(h.modes, [], "a gated mode must not fire onPermissionModeChange");
    m.unmount();
  });

  it("Grok only offers Plan and Full access; leftover Ask first is annotated", async () => {
    const h = makeHarness("grok");
    const m = await mount(
      composer(h, { provider: "grok", permissionMode: "default" }),
    );
    const modePill = Array.from(m.queryAll("button")).find((b) =>
      (b.textContent || "").includes("Ask first"),
    ) as HTMLButtonElement | undefined;
    assert.ok(modePill, "leftover Ask first must stay visible");
    assert.equal(modePill.disabled, false, "user must be able to pick a real mode");
    assert.match(modePill.title, /cannot honor Ask first/i);
    await m.click(modePill);
    const labels = Array.from(m.queryAll("[data-permission-mode]")).map(
      (el) => el.textContent?.trim(),
    );
    assert.deepEqual(labels, ["Ask first", "Plan mode", "Full access"]);
    const ask = m.query(
      '[data-permission-mode="default"]',
    ) as HTMLButtonElement | null;
    const accept = m.query('[data-permission-mode="acceptEdits"]');
    const plan = m.query(
      '[data-permission-mode="plan"]',
    ) as HTMLButtonElement | null;
    assert.ok(ask);
    assert.equal(ask.disabled, true);
    assert.equal(ask.getAttribute("data-unhonoured"), "true");
    assert.equal(accept, null, "Accept edits is the same lie as Ask first");
    assert.ok(plan);
    assert.equal(plan.disabled, false);
    await m.click(plan);
    assert.deepEqual(h.modes, ["plan"]);
    m.unmount();
  });

  it("Kimi Full access is the only honoured mode and the pill is locked", async () => {
    const h = makeHarness("kimi");
    const m = await mount(
      composer(h, {
        provider: "kimi",
        permissionMode: "bypassPermissions",
      }),
    );
    const modePill = Array.from(m.queryAll("button")).find((b) =>
      (b.getAttribute("aria-label") || "").startsWith("Permission:"),
    ) as HTMLButtonElement | undefined;
    assert.ok(modePill);
    assert.equal(modePill.disabled, true);
    assert.match(modePill.title, /unprompted/i);
    assert.ok((modePill.textContent || "").includes("Full access"));
    await m.click(modePill);
    assert.equal(m.query('[aria-label="Permission mode"]'), null);
    m.unmount();
  });

  it("Cursor leftover Ask first is annotated; only Plan and Full access are offered", async () => {
    const CURSOR: ProviderInfo = {
      id: "cursor",
      name: "Cursor",
      available: true,
      supportsResume: true,
      models: ["auto"],
      modelInfo: [
        {
          id: "auto",
          label: "Auto",
          description: "Cursor default",
          vendor: "Cursor",
        },
      ],
      efforts: [],
      permissionModes: ["plan", "bypassPermissions"],
    };
    const h = makeHarness("cursor");
    const m = await mount(
      composer(h, {
        provider: "cursor",
        permissionMode: "default",
        providers: [CURSOR],
      }),
    );
    const modePill = Array.from(m.queryAll("button")).find((b) =>
      (b.textContent || "").includes("Ask first"),
    ) as HTMLButtonElement | undefined;
    assert.ok(modePill);
    assert.match(modePill.title, /cannot honor Ask first/i);
    await m.click(modePill);
    const labels = Array.from(m.queryAll("[data-permission-mode]")).map(
      (el) => el.textContent?.trim(),
    );
    assert.deepEqual(labels, ["Ask first", "Plan mode", "Full access"]);
    const ask = m.query(
      '[data-permission-mode="default"]',
    ) as HTMLButtonElement | null;
    assert.ok(ask);
    assert.equal(ask.disabled, true);
    m.unmount();
  });

  it("OpenCode offers Ask first and Full access, not Plan or Accept edits", async () => {
    const h = makeHarness("opencode");
    const OPENCODE: ProviderInfo = {
      id: "opencode",
      name: "OpenCode",
      available: true,
      supportsResume: true,
      models: ["opencode/laguna-s-2.1-free"],
      modelInfo: [
        {
          id: "opencode/laguna-s-2.1-free",
          label: "Laguna S 2.1 Free",
          description: "free",
          vendor: "Poolside",
        },
      ],
      efforts: [],
      permissionModes: ["default", "bypassPermissions"],
    };
    const m = await mount(
      composer(h, {
        provider: "opencode",
        permissionMode: "default",
        providers: [OPENCODE],
      }),
    );
    const modePill = Array.from(m.queryAll("button")).find((b) =>
      (b.textContent || "").includes("Ask first"),
    );
    assert.ok(modePill);
    await m.click(modePill);
    const labels = Array.from(m.queryAll("[data-permission-mode]")).map(
      (el) => el.textContent?.trim(),
    );
    assert.deepEqual(labels, ["Ask first", "Full access"]);
    m.unmount();
  });
});

describe("Composer while hard-disabled (archived thread)", () => {
  it("disables start actions and cannot start a run", async () => {
    const h = makeHarness();
    // Parent passes disabled while isArchived (see ThreadView).
    const m = await mount(composer(h, { disabled: true }));

    const ta = m.query("textarea") as HTMLTextAreaElement;
    assert.equal(ta.disabled, true, "prompt must be locked on an archived thread");

    const send = m.query('button[aria-label="Send"]') as HTMLButtonElement;
    const build = m.byText("Build") as HTMLButtonElement;
    assert.equal(send.disabled, true, "Send disabled while archived");
    assert.equal(build.disabled, true, "Build disabled while archived");

    await m.click(send);
    await m.click(build);
    assert.equal(h.sends.length, 0, "archived thread must block onSend");
    assert.equal(h.builds.length, 0, "archived thread must block onBuild");
    m.unmount();
  });

  it("with a prompt still refuses Send and Build when disabled", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { disabled: false }));
    await m.type(m.query("textarea"), "already typing");
    m.unmount();

    const m2 = await mount(composer(h, { disabled: true }));
    await m2.type(m2.query("textarea"), "sneaky second prompt");
    const send = m2.query('button[aria-label="Send"]') as HTMLButtonElement;
    assert.equal(send.disabled, true, "disabled overrides a non-empty prompt");
    await m2.click(send);
    assert.equal(h.sends.length, 0);
    m2.unmount();
  });
});

/**
 * Issue #92: the composer used to be dead while a run was active, so the next
 * instruction had to wait on the spinner. Busy keeps the prompt and Send live
 * (the parent queues the send); only what cannot be queued stays locked.
 */
describe("Composer while a run is active (busy)", () => {
  it("takes type-ahead and sends it for queueing", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { busy: true }));

    const ta = m.query("textarea") as HTMLTextAreaElement;
    assert.equal(ta.disabled, false, "type-ahead must be allowed mid-run");

    await m.type(ta, "then run the tests");
    const send = m.query('button[aria-label="Send"]') as HTMLButtonElement;
    assert.equal(send.disabled, false, "Send must stay live to queue");
    await m.click(send);
    assert.deepEqual(
      h.sends,
      ["then run the tests"],
      "the follow-up must reach the parent, which queues it",
    );
    m.unmount();
  });

  it("still locks what cannot be queued", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { busy: true }));
    await m.type(m.query("textarea"), "a prompt");

    const build = m.byText("Build") as HTMLButtonElement;
    assert.equal(build.disabled, true, "Build cannot start during a run");
    await m.click(build);
    assert.equal(h.builds.length, 0, "active run must block onBuild");

    const model = m.query(
      'button[aria-haspopup="dialog"][aria-label^="Model:"]',
    ) as HTMLButtonElement;
    assert.equal(model.disabled, true, "model cannot change mid-run");
    m.unmount();
  });
});

describe("Composer value displays (null-safe)", () => {
  it("renders session short form and omits the chip when session is null", async () => {
    const h = makeHarness();
    const withSess = await mount(
      composer(h, { sessionId: "abcdef0123456789" }),
    );
    assert.ok(
      withSess.text().includes("abcdef01"),
      "session chip must show the short id",
    );
    assert.ok(
      !withSess.text().includes("abcdef0123456789"),
      "full session id must not dump into the meta row",
    );
    withSess.unmount();

    const noSess = await mount(composer(h, { sessionId: null }));
    assert.ok(noSess.query("textarea"), "composer still mounts with null session");
    assert.ok(
      !noSess.text().includes("abcdef01"),
      "null session must not leave a stale chip",
    );
    noSess.unmount();
  });

  it("survives null branch and never invents a main chip", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { branch: null }));
    assert.ok(
      !m.text().includes("High · 1M"),
      "decorative effort pill must not reappear",
    );
    assert.ok(
      m.text().includes("Worktree") || m.text().includes("Project"),
      "the composer states where the work will land",
    );
    assert.ok(m.query("textarea"), "null branch must not crash the composer");
    assert.equal(
      m.text().includes("main"),
      false,
      "a null branch must not invent a default chip",
    );
    m.unmount();
  });
});

describe("Composer reasoning trigger pill", () => {
  it("shows the level on its own pill, never on the model pill", async () => {
    const h = makeHarness();
    const m = await mount(
      composer(h, { provider: "claude", model: null, reasoningEffort: "high" }),
    );
    const model = m.query('button[aria-label^="Model:"]');
    assert.ok(model);
    assert.equal(
      model.getAttribute("aria-label"),
      "Model: Default",
      "the model pill names a model and nothing else",
    );
    const effort = m.query('button[aria-label^="Reasoning:"]');
    assert.ok(effort, "the effort pill must exist next to it");
    assert.equal(effort.getAttribute("aria-label"), "Reasoning: High");
    assert.match(effort.textContent || "", /High/);
    m.unmount();
  });

  it("reads Auto when the thread is on the provider default", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    assert.equal(
      m.query('button[aria-label^="Reasoning:"]')?.getAttribute("aria-label"),
      "Reasoning: Auto",
      "the model pill already says Default; the effort pill must not echo it",
    );
    m.unmount();
  });
});

describe("Composer reasoning default", () => {
  it("offers the provider default (Auto) as a row of its own", async () => {
    // ReasoningEffort | null is handled at every layer, but it used to be
    // reachable only by re-clicking the active segment, which nobody found.
    const h = makeHarness();
    const m = await mount(composer(h, { reasoningEffort: "high" }));
    const menu = await openEffort(m);
    assert.ok(menu, "the effort pill must open a menu");
    const def = m.query('button[aria-label="Reasoning Auto"]');
    assert.ok(def, "the provider default must be a row, not a hidden toggle");
    await m.click(def);
    assert.deepEqual(h.efforts, [null], "picking Auto must report null");
    m.unmount();
  });

  it("marks the active level and closes on pick", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { reasoningEffort: "high" }));
    assert.ok(await openEffort(m));
    assert.equal(
      m.query('button[aria-label="Reasoning High"]')?.getAttribute("data-active"),
      "true",
    );
    await m.click(m.query('button[aria-label="Reasoning Low"]'));
    assert.deepEqual(h.efforts, ["low"]);
    assert.equal(
      m.query('[role="listbox"][aria-label="Reasoning effort"]'),
      null,
      "the menu must close behind the pick",
    );
    m.unmount();
  });
});

describe("Composer structure", () => {
  it("never nests interactive elements", async () => {
    // A button inside a button is invalid HTML and drops clicks. This project
    // shipped that bug twice in other components.
    const h = makeHarness();
    const m = await mount(composer(h));

    // Open every menu so option buttons are in the tree too.
    //
    // The model popover MUST be opened LAST. Opening any other menu closes it,
    // so with the model pill first the two-pane picker (model rows and the
    // reasoning segments, the largest interactive surface here) was already
    // gone by the time this asserted, and nesting inside it went unnoticed.
    // The effort menu is a sibling pill and every other pill closes it, so it
    // is checked on its own before the loop rather than left half-open.
    for (const btn of (await openEffort(m))?.querySelectorAll("button") ?? []) {
      assert.equal(btn.querySelector("button, a"), null);
    }
    const openLabels = ["Ask first"];
    for (const label of openLabels) {
      const pill = Array.from(m.queryAll("button")).find((b) =>
        (b.textContent || "").includes(label),
      );
      if (pill) await m.click(pill);
    }
    // Build caret menu.
    const caret = m.query('button[aria-label="Choose workflow template"]');
    if (caret) await m.click(caret);

    const mlist = await openProvider(m, "Claude Code");
    assert.ok(mlist, "drill into a provider: level one has no model rows");
    assert.ok(
      m.queryAll('[role="option"]').length > 0,
      "the model popover must be OPEN when this asserts, or it checks nothing",
    );
    // Cardinality: one provider's models (Default + 2 + Custom), not the flat
    // list. Without a floor the loop below can pass by checking nothing.
    assert.ok(
      m.queryAll('[role="option"]').length >= 4,
      "the drilled provider's rows must be present while this asserts",
    );

    const interactives = m.queryAll("button, a");
    // Cardinality guard: a for-loop over an empty collection asserts nothing,
    // so without this the test passes hardest when the component renders null.
    assert.ok(
      interactives.length >= 2,
      `expected interactive elements to check, got ${interactives.length}`,
    );
    for (const el of interactives) {
      assert.equal(
        el.querySelector("button, a, input, textarea, select"),
        null,
        `interactive element nested inside <${el.tagName.toLowerCase()}>: ${
          (el.textContent || "").slice(0, 40)
        }`,
      );
    }
    m.unmount();
  });
});

describe("Composer keyboard send", () => {
  // Cmd+Enter is the primary way runs actually get started in this app, and it
  // had zero coverage: nothing in the suite dispatched a keydown.
  it("starts a run on Cmd+Enter with a typed prompt", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    await m.type(m.query("textarea"), "ship it");
    await m.press(m.query("textarea"), "Enter", { metaKey: true });
    assert.deepEqual(h.sends, ["ship it"], "Cmd+Enter must send the prompt");
    m.unmount();
  });

  it("starts a run on Ctrl+Enter too", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    await m.type(m.query("textarea"), "ship it");
    await m.press(m.query("textarea"), "Enter", { ctrlKey: true });
    assert.deepEqual(h.sends, ["ship it"]);
    m.unmount();
  });

  it("does nothing on Cmd+Enter with an empty prompt", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    await m.press(m.query("textarea"), "Enter", { metaKey: true });
    assert.deepEqual(h.sends, [], "an empty prompt must not start a run");
    m.unmount();
  });

  it("does not send on a bare Enter", async () => {
    // Bare Enter is a newline in a multi-line composer; sending on it would
    // fire runs at people mid-sentence.
    const h = makeHarness();
    const m = await mount(composer(h));
    await m.type(m.query("textarea"), "still typing");
    await m.press(m.query("textarea"), "Enter");
    assert.deepEqual(h.sends, []);
    m.unmount();
  });

  it("sends /btw on Alt+Enter (issue #471)", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    await m.type(m.query("textarea"), "where is createThread");
    await m.press(m.query("textarea"), "Enter", { altKey: true });
    assert.deepEqual(h.sends, ["/btw where is createThread"]);
    m.unmount();
  });

  it("does not double-prefix an already-/btw draft on Alt+Enter", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    await m.type(m.query("textarea"), "/btw which file owns parseBtw");
    await m.press(m.query("textarea"), "Enter", { altKey: true });
    assert.deepEqual(h.sends, ["/btw which file owns parseBtw"]);
    m.unmount();
  });
});

describe("Composer custom model", () => {
  /** Open the picker and highlight a provider's Custom row via the keyboard. */
  /** Drill into a provider and highlight its Custom row (always the last one). */
  async function openTo(
    m: Awaited<ReturnType<typeof mount>>,
    providerName: string,
  ) {
    const list = await openProvider(m, providerName);
    if (!list) return null;
    for (let i = 0; i < 24; i += 1) {
      const hl = m.query('[data-highlighted="true"]');
      if ((hl?.textContent || "").includes("Custom")) return list;
      await m.press(list, "ArrowDown");
    }
    return null;
  }

  it("commits a custom id to the provider whose Custom row was picked", async () => {
    // The dangerous shape: picking Codex's Custom row while the thread is on
    // Claude must set the id on CODEX, not on the current harness.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    const list = await openTo(m, "Codex");
    assert.ok(list, "Codex's Custom row must be reachable by keyboard");
    await m.press(list, "Enter");

    const input = m.query('input[aria-label="Custom model id"]');
    assert.ok(input, "Enter on Custom must open the free-text field");
    await m.type(input, "gpt-6-preview");
    await m.click(m.byText("Use model"));

    assert.deepEqual(
      h.providerSets,
      [{ provider: "codex", model: "gpt-6-preview" }],
      "the custom id must go to the provider whose row was picked",
    );
    m.unmount();
  });

  it("commits on Enter and closes the picker", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    const list = await openTo(m, "Claude Code");
    assert.ok(list, "Claude's Custom row must be reachable");
    await m.press(list, "Enter");
    const input = m.query('input[aria-label="Custom model id"]');
    assert.ok(input);
    await m.type(input, "claude-brand-new-5");
    await m.press(input, "Enter");

    assert.deepEqual(h.providerSets, [
      { provider: "claude", model: "claude-brand-new-5" },
    ]);
    assert.equal(
      m.query('[role="listbox"][aria-label="Model"]'),
      null,
      "committing must close the picker",
    );
    m.unmount();
  });

  it("cannot commit an empty id, and Cancel returns focus to the list", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    const list = await openTo(m, "Claude Code");
    assert.ok(list);
    await m.press(list, "Enter");
    const useBtn = m.byText("Use model") as HTMLButtonElement | null;
    assert.ok(useBtn, "the commit button must render");
    assert.equal(useBtn.disabled, true, "an empty id must not be committable");

    await m.click(m.byText("Cancel"));
    assert.equal(
      m.query('input[aria-label="Custom model id"]'),
      null,
      "Cancel must close the field",
    );
    assert.ok(
      m.query('[role="listbox"][aria-label="Model"]'),
      "Cancel must leave the picker open",
    );
    // Focus itself must return to the list. Asserting "arrows still work" is
    // not enough: press() dispatches on the element it is given, so it passes
    // whether or not anything is focused. Cancel unmounts the focused input,
    // and the arrow handler lives on the <ul>, so focus landing on <body>
    // leaves the open popover unnavigable for a keyboard user.
    const afterList = m.query('[role="listbox"][aria-label="Model"]') as HTMLElement;
    assert.equal(
      m.container.ownerDocument.activeElement,
      afterList,
      "Cancel must return focus to the model list",
    );
    assert.deepEqual(h.providerSets, [], "Cancel must report nothing");
    m.unmount();
  });

  it("reopens showing the model list, not a stale custom field", async () => {
    // customFor survived any close except commit/Cancel, so reopening showed a
    // text box with no sign of its target, and a commit went to the provider
    // highlighted minutes earlier, on a different thread even.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    const list = await openTo(m, "Codex");
    assert.ok(list, "Codex's Custom row must be reachable");
    await m.press(list, "Enter");
    assert.ok(m.query('input[aria-label="Custom model id"]'), "field opens");

    // Close WITHOUT using the field's own Cancel or Escape: step back to the
    // provider level, then close from there, then reopen.
    await m.press(
      m.query('[role="listbox"][aria-label="Model"]') ?? list,
      "Escape",
    );
    const plist = m.query('[role="listbox"][aria-label="Provider"]');
    assert.ok(plist, "Escape at the model level steps back to providers");
    await m.press(plist, "Escape");
    await m.click(m.query('button[aria-label^="Model:"]'));

    assert.equal(
      m.query('input[aria-label="Custom model id"]'),
      null,
      "reopening must show the model list, not a stale custom field",
    );
    // Reopening starts at the PROVIDER level now, which is itself the proof
    // that neither the custom target nor the drill level survived the close.
    assert.ok(
      m.query('[role="listbox"][aria-label="Provider"]'),
      "reopening must land on the provider list",
    );
    m.unmount();
  });

  it("Escape in the custom field backs out without closing the picker", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    const list = await openTo(m, "Claude Code");
    assert.ok(list);
    await m.press(list, "Enter");
    const input = m.query('input[aria-label="Custom model id"]');
    assert.ok(input, "field opens");

    await m.press(input, "Escape");
    assert.equal(
      m.query('input[aria-label="Custom model id"]'),
      null,
      "Escape must close the field",
    );
    assert.ok(
      m.query('[role="listbox"][aria-label="Model"]'),
      "Escape in the field must NOT close the whole picker",
    );
    m.unmount();
  });

  it("keeps the highlighted row scrolled into view", async () => {
    // 26 rows in a 240px box that opens focused: without this the highlight
    // walks off-screen past row six while the list looks frozen.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    const list = (await openProvider(m, "Claude Code")) as HTMLElement;
    const seen: Element[] = [];
    const proto = (m.query('[data-highlighted="true"]') as HTMLElement)
      .constructor.prototype as { scrollIntoView: () => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function patched(this: Element) {
      seen.push(this);
    };
    try {
      await m.press(list, "ArrowDown");
      await m.press(list, "ArrowDown");
    } finally {
      proto.scrollIntoView = original;
    }
    assert.ok(
      seen.length > 0,
      "the highlighted row must be scrolled into view as it moves",
    );
    m.unmount();
  });
});

describe("Composer agent profiles", () => {
  const scout: AgentProfile = {
    id: "p1",
    name: "Cheap scout",
    provider: "claude",
    model: "claude-sonnet-4",
    reasoningEffort: "low",
    permissionMode: "plan",
  };
  const missing: AgentProfile = {
    id: "p2",
    name: "Grok worker",
    provider: "grok",
    model: "grok-4",
    reasoningEffort: "high",
    permissionMode: "acceptEdits",
  };

  it("hides the Profiles section when none are saved", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    await m.click(m.query('button[aria-label^="Model:"]'));
    assert.equal(m.query('button[aria-label^="Profile "]'), null);
    m.unmount();
  });

  it("applies provider, then effort, then permission", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { agentProfiles: [scout] }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const btn = m.query('button[aria-label="Profile Cheap scout"]');
    assert.ok(btn, "the saved profile must be in the picker");
    await m.click(btn);
    assert.deepEqual(h.providerSets, [
      { provider: "claude", model: "claude-sonnet-4" },
    ]);
    assert.deepEqual(h.efforts, ["low"]);
    assert.deepEqual(h.modes, ["plan"]);
    assert.deepEqual(h.callOrder, [
      "setProvider",
      "setReasoningEffort",
      "setPermissionMode",
    ]);
    m.unmount();
  });

  it("activates a highlighted profile with Enter", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { agentProfiles: [scout] }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const list = m.query('[role="listbox"][aria-label="Provider"]');
    assert.ok(list);
    // Opens on the current provider (after the profile row). Arrow up reaches it.
    await m.press(list, "ArrowUp");
    await m.press(list, "Enter");
    assert.deepEqual(h.callOrder, [
      "setProvider",
      "setReasoningEffort",
      "setPermissionMode",
    ]);
    m.unmount();
  });

  it("snaps a leftover Grok profile mode to Full access instead of sending Accept edits", async () => {
    const grokOk: ProviderInfo = { ...GROK, available: true };
    const leftover: AgentProfile = {
      id: "p3",
      name: "Grok leftover",
      provider: "grok",
      model: "grok-4",
      reasoningEffort: "high",
      permissionMode: "acceptEdits",
    };
    const h = makeHarness();
    const m = await mount(
      composer(h, {
        providers: [CLAUDE_WITH_INFO, grokOk],
        agentProfiles: [leftover],
      }),
    );
    await m.click(m.query('button[aria-label^="Model:"]'));
    const btn = m.query('button[aria-label="Profile Grok leftover"]');
    assert.ok(btn);
    await m.click(btn);
    assert.deepEqual(h.providerSets, [{ provider: "grok", model: "grok-4" }]);
    assert.deepEqual(h.modes, ["bypassPermissions"]);
    m.unmount();
  });

  it("disables a profile whose provider is not installed", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { agentProfiles: [missing] }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const btn = m.query(
      'button[aria-label="Profile Grok worker"]',
    ) as HTMLButtonElement | null;
    assert.ok(btn);
    assert.equal(btn.disabled, true);
    assert.match(btn.title, /not installed/);
    assert.deepEqual(h.providerSets, []);
    m.unmount();
  });
});

describe("Composer web-search pill (issue #174)", () => {
  it("hides the search pill when the thread provider does not advertise it", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    assert.equal(
      m.query('button[aria-label^="Web search:"]'),
      null,
      "claude has no --search flag, so no search pill may render",
    );
    m.unmount();
  });

  it("shows the search pill on Codex and reports a toggle", async () => {
    const h = makeHarness();
    const m = await mount(
      composer(h, { provider: "codex", model: null, webSearch: false }),
    );
    const pill = m.query('button[aria-label="Web search: off"]');
    assert.ok(pill, "codex must show a Search pill next to the other controls");
    await m.click(pill);
    assert.deepEqual(h.webSearches, [true]);
    m.unmount();
  });

  it("labels the pill on when search is already enabled", async () => {
    const h = makeHarness();
    const m = await mount(
      composer(h, { provider: "codex", model: null, webSearch: true }),
    );
    const pill = m.query('button[aria-label="Web search: on"]');
    assert.ok(pill, "an enabled thread must render the on state");
    await m.click(pill);
    assert.deepEqual(h.webSearches, [false]);
    m.unmount();
  });
});

describe("Composer keyboard hints (issue #364)", () => {
  it("shows the hint row only while the textarea is focused", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    const ta = m.query("textarea") as HTMLTextAreaElement;
    const hints = () => m.query("[data-kbd-hints]") as HTMLElement | null;
    // The row is always in the DOM and toggled by attribute, not state:
    // a focus setState would re-render the picker chrome on the typing hot
    // path (#654). The composer auto-focuses on thread open (#73), so the
    // row starts visible.
    assert.equal(
      hints()?.hasAttribute("hidden"),
      false,
      "hints show while the composer is focused",
    );
    assert.match(hints()!.textContent || "", /⌘Enter send/);
    assert.match(hints()!.textContent || "", /⌥Enter side question/);
    assert.ok(!/Esc stop/.test(hints()!.textContent || ""), "idle has no stop");
    await inAct(() => ta.blur());
    assert.equal(
      hints()?.hasAttribute("hidden"),
      true,
      "hints hide when the composer loses focus",
    );
    await inAct(() => ta.focus());
    assert.equal(
      hints()?.hasAttribute("hidden"),
      false,
      "hints return with the focus",
    );
    m.unmount();
  });

  it("busy hints mention queueing and Esc stop", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { busy: true }));
    const ta = m.query("textarea") as HTMLTextAreaElement;
    await inAct(() => ta.focus());
    const hints = m.query("[data-kbd-hints]");
    assert.ok(hints);
    assert.match(hints!.textContent || "", /⌘Enter queue/);
    assert.match(hints!.textContent || "", /Esc stop/);
    m.unmount();
  });
});
