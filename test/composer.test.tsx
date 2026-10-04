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
import { useState, type ReactNode } from "react";
import { mount, unmountAll, inAct } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import {
  setComposerBusyAction,
  setLastReasoningEffort,
  setTranscriptViewMode,
  setVerboseToolCards,
} from "../src/uiPrefs";
import type {
  AgentProfile,
  PermissionMode,
  ProviderInfo,
  ReasoningEffort,
  SpeechStatus,
  ThreadTeach,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";
import {
  createFakeCoder,
  installFakeCoder,
  type FakeCoder,
} from "./support/fakeCoder.ts";

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
  supportsSteer: true,
};

const CODEX: ProviderInfo = {
  id: "codex",
  name: "Codex",
  available: true,
  supportsResume: true,
  supportsSteer: true,
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
  steers: boolean[];
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
    steers: [],
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
    workspaceStrip?: ReactNode;
    disabled?: boolean;
    busy?: boolean;
    ask?: boolean;
    workflows?: WorkflowTemplateInfo[];
    buildError?: string;
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
      ask={over.ask ?? false}
      agentProfiles={over.agentProfiles}
      workflows={over.workflows ?? WORKFLOWS}
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
      workspaceStrip={over.workspaceStrip}
      disabled={over.disabled ?? false}
      busy={over.busy ?? false}
      onSend={(prompt, _attachments, opts) => {
        harness.sends.push(prompt);
        harness.steers.push(opts?.steer === true);
      }}
      onBuild={(prompt, templateId) => {
        harness.builds.push({ prompt, templateId });
        if (over.buildError) throw new Error(over.buildError);
      }}
      onListFiles={over.onListFiles}
    />
  );
}

const SPEECH_READY: SpeechStatus = {
  state: "ready",
  runtimeReady: true,
  modelReady: true,
};

type SpeechMedia = {
  order: string[];
  getUserMediaCalls: number;
  tracksStopped: number;
  contextClosed: number;
  nodesDisconnected: number;
};

let speechMedia: SpeechMedia | null = null;
let speechMediaCleanup: (() => void) | null = null;

function restoreSpeechMedia() {
  speechMediaCleanup?.();
  speechMediaCleanup = null;
  speechMedia = null;
}

/** jsdom has no mic / AudioWorklet; Composer tests opt in through this. */
function installSpeechMedia(): SpeechMedia {
  restoreSpeechMedia();
  const media: SpeechMedia = {
    order: [],
    getUserMediaCalls: 0,
    tracksStopped: 0,
    contextClosed: 0,
    nodesDisconnected: 0,
  };
  const w = window as unknown as {
    AudioContext?: unknown;
    AudioWorkletNode?: unknown;
  };
  const prevCtx = w.AudioContext;
  const prevNode = w.AudioWorkletNode;
  const prevDevices = Object.getOwnPropertyDescriptor(
    navigator,
    "mediaDevices",
  );

  const stream = {
    getTracks() {
      return [
        {
          kind: "audio",
          stop() {
            media.tracksStopped += 1;
          },
        },
      ];
    },
    getAudioTracks() {
      return this.getTracks();
    },
  };

  class FakeSource {
    connect() {
      return this;
    }
    disconnect() {
      media.nodesDisconnected += 1;
    }
  }
  class FakeGain {
    gain = { value: 0 };
    connect() {
      return this;
    }
    disconnect() {
      media.nodesDisconnected += 1;
    }
  }
  class FakeWorkletNode {
    port = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      postMessage(msg: unknown) {
        const data = msg as { type?: string };
        if (data?.type === "flush") {
          this.onmessage?.({ data: { type: "flushed" } });
        }
      },
    };
    connect() {
      return this;
    }
    disconnect() {
      media.nodesDisconnected += 1;
    }
  }
  class FakeAudioContext {
    sampleRate = 48000;
    destination = {};
    state = "running";
    audioWorklet = { addModule: async () => undefined };
    createMediaStreamSource() {
      return new FakeSource();
    }
    createGain() {
      return new FakeGain();
    }
    async close() {
      media.contextClosed += 1;
    }
  }

  w.AudioContext = FakeAudioContext;
  w.AudioWorkletNode = FakeWorkletNode;
  (globalThis as unknown as { AudioContext?: unknown }).AudioContext =
    FakeAudioContext;
  (globalThis as unknown as { AudioWorkletNode?: unknown }).AudioWorkletNode =
    FakeWorkletNode;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        media.getUserMediaCalls += 1;
        media.order.push("mic");
        return stream;
      },
    },
  });

  speechMedia = media;
  speechMediaCleanup = () => {
    w.AudioContext = prevCtx;
    w.AudioWorkletNode = prevNode;
    const g = globalThis as unknown as {
      AudioContext?: unknown;
      AudioWorkletNode?: unknown;
    };
    g.AudioContext = prevCtx;
    g.AudioWorkletNode = prevNode;
    if (prevDevices) {
      Object.defineProperty(navigator, "mediaDevices", prevDevices);
    } else {
      delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
  };
  return media;
}

async function mountSpeechComposer(
  fake: FakeCoder,
  over: Parameters<typeof composer>[1] = {},
) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  const origStart = fake.api.speech.start.bind(fake.api.speech);
  fake.api.speech.start = async () => {
    speechMedia?.order.push("start");
    return origStart();
  };
  shell.unmount();
  const h = makeHarness();
  const m = await mount(composer(h, over));
  return { m, h };
}

function mic(m: Awaited<ReturnType<typeof mount>>) {
  return m.query("[data-speech-mic]") as HTMLButtonElement | null;
}

afterEach(() => {
  unmountAll();
  setTranscriptViewMode("normal");
  setVerboseToolCards(false);
  setComposerBusyAction("queue");
  restoreSpeechMedia();
  delete (window as { coder?: unknown }).coder;
});


/**
 * Open the picker and jump to a provider via its rail button (#1429): the
 * highlight lands on that provider's first row. Returns the model list.
 */
async function openProvider(
  m: Awaited<ReturnType<typeof mount>>,
  providerName: string,
) {
  // Only open if it is closed: clicking the trigger toggles.
  if (!m.query('[role="dialog"][aria-label="Model picker"]')) {
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


/**
 * Options lives behind `/workflow` now (#1411): prefix the current prompt,
 * send from the prompt, and the picker opens with the verb stripped.
 * `trigger` is the prompt — focus returns there on Escape.
 */
async function openOptions(m: Awaited<ReturnType<typeof mount>>) {
  const ta = m.query("textarea") as HTMLTextAreaElement;
  assert.ok(ta, "composer textarea");
  const prev = ta.value;
  await m.type(ta, `/workflow ${prev}`);
  await inAct(() => ta.focus());
  await m.press(ta, "Enter", { metaKey: true });
  const pop = m.query("[data-composer-options-popover]");
  assert.ok(pop, "/workflow opens the options picker");
  assert.equal(ta.value, prev.trim(), "the verb is stripped; the prompt stays");
  return { trigger: ta as HTMLElement, pop: pop as HTMLElement };
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

    assert.equal(send.disabled, true, "empty prompt: Send disabled");
    await openOptions(m);
    const build = m.query("[data-workflow-run]") as HTMLButtonElement | null;
    assert.ok(build, "Build stays inside Options");
    assert.equal(build.disabled, true, "empty prompt: Build disabled");
    assert.match(build.title, /prompt/i);

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

describe("Composer options", () => {

  it("selects a workflow without running it, then builds that template", async () => {
    const h = makeHarness();
    const workflows: WorkflowTemplateInfo[] = [
      ...WORKFLOWS,
      {
        id: "ship",
        name: "Ship",
        builtin: false,
        phases: [
          { name: "ship", agentCount: 1, provider: "claude", model: null },
        ],
      },
    ];
    const m = await mount(composer(h, { workflows }));
    assert.equal(m.byText("Build"), null, "Build is not a toolbar control");
    assert.equal(m.query('button[aria-label="Best of N"]'), null);
    const opened = await openOptions(m);
    assert.equal(opened.pop.getAttribute("role"), "dialog");
    assert.equal(opened.pop.querySelector('[role="menu"]'), null);
    assert.equal(
      m.query("[data-selected-workflow]")?.getAttribute("data-selected-workflow"),
      "standard",
    );
    await m.click(m.query("[data-workflow-template='ship']"));
    assert.equal(h.builds.length, 0, "picking a template must not run it");
    assert.equal(m.query("[data-composer-options-popover]"), null);
    await openOptions(m);
    assert.equal(
      m.query("[data-selected-workflow]")?.getAttribute("data-selected-workflow"),
      "ship",
    );
    assert.equal(
      (m.query("[data-workflow-run]") as HTMLButtonElement).disabled,
      true,
      "Build stays disabled until there is a prompt",
    );
    await m.type(m.query("textarea"), "ship the chip");
    await m.click(m.query("[data-workflow-run]"));
    assert.deepEqual(h.builds, [
      { prompt: "ship the chip", templateId: "ship" },
    ]);
    m.unmount();
  });

  it("keeps the prompt when a workflow fails to start", async () => {
    const h = makeHarness();
    const m = await mount(
      composer(h, { buildError: "workflow unavailable" }),
    );
    await m.type(m.query("textarea"), "keep me");
    await openOptions(m);
    await m.click(m.query("[data-workflow-run]"));
    assert.match(m.text(), /workflow unavailable/);
    assert.equal(
      (m.query("textarea") as HTMLTextAreaElement).value,
      "keep me",
    );
    assert.equal(m.query("[data-composer-options-popover]"), null);
    m.unmount();
  });

  it("closes Options on outside click and Escape, restoring the prompt", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    const { trigger } = await openOptions(m);
    await inAct(() => {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    await m.flush();
    assert.equal(m.query("[data-composer-options-popover]"), null);
    await openOptions(m);
    assert.ok(
      (m.query("[data-composer-options-popover]") as HTMLElement).contains(
        document.activeElement,
      ),
    );
    await m.pressFocused("Escape");
    assert.equal(m.query("[data-composer-options-popover]"), null);
    assert.equal(document.activeElement, trigger);
    m.unmount();
  });

  it("closes Options when a run starts or the thread changes and keeps the draft", async () => {
    const h = makeHarness();
    function Shell() {
      const [tid, setTid] = useState("t1");
      const [busy, setBusy] = useState(false);
      return (
        <>
          <button onClick={() => setBusy(true)}>start-run</button>
          <button onClick={() => setTid((t) => (t === "t1" ? "t2" : "t1"))}>
            swap-thread
          </button>
          {composer(h, { threadId: tid, busy })}
        </>
      );
    }
    const m = await mount(<Shell />);
    await m.type(m.query("textarea"), "draft A");
    await openOptions(m);
    await m.click(m.byText("start-run"));
    assert.equal(
      m.query("[data-composer-options-popover]"),
      null,
      "a live run closes Options",
    );
    assert.ok(m.query("[data-steer-action='queue']"), "Queue stays on the toolbar");
    assert.equal(
      (m.query("textarea") as HTMLTextAreaElement).value,
      "draft A",
    );
    m.unmount();

    const idle = await mount(<Shell />);
    await idle.type(idle.query("textarea"), "draft A");
    await openOptions(idle);
    await idle.click(idle.byText("swap-thread"));
    assert.equal(idle.query("[data-composer-options-popover]"), null);
    assert.equal(
      (idle.query("textarea") as HTMLTextAreaElement).value,
      "",
      "the other thread keeps its own draft",
    );
    await idle.click(idle.byText("swap-thread"));
    assert.equal(
      (idle.query("textarea") as HTMLTextAreaElement).value,
      "draft A",
    );
    idle.unmount();
  });

  it("opens manage workflows from Options without starting a run", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    const { trigger } = await openOptions(m);
    const manage = m.byText("Manage workflows") as HTMLButtonElement;
    manage.focus();
    await m.click(manage);
    assert.ok(m.query('[aria-label="Manage workflows"]'));
    assert.equal(m.query("[data-composer-options-popover]"), null);
    assert.equal(h.builds.length, 0);
    await m.pressFocused("Escape");
    assert.equal(m.query('[aria-label="Manage workflows"]'), null);
    assert.equal(
      m.query("[data-composer-options-popover]"),
      null,
      "Escape closes the editor and does not leave Options open under it",
    );
    assert.equal(
      document.activeElement,
      trigger,
      "Escape returns to Options after the editor control unmounts",
    );
    m.unmount();
  });

  it("hides Options in Ask mode and leaves model and Send visible", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { ask: true }));
    assert.equal(m.query("[data-composer-options]"), null);
    assert.equal(m.query("[data-workflow-run]"), null);
    assert.ok(m.query('button[aria-label="Send"]'));
    assert.ok(m.query('button[aria-label^="Model:"]'));
    m.unmount();
  });

  it("keeps the Options popover inside a narrow viewport", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    const wrap = m.query("[data-composer-options-anchor]") as HTMLElement;
    wrap.getBoundingClientRect = () =>
      ({
        x: 200,
        y: 240,
        left: 200,
        top: 240,
        right: 268,
        bottom: 268,
        width: 68,
        height: 28,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    const prevW = window.innerWidth;
    const prevH = window.innerHeight;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 280,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 320,
    });
    await openOptions(m);
    const pop = m.query("[data-composer-options-popover]") as HTMLElement;
    const left = 200 + parseFloat(pop.style.left || "0");
    const width = parseFloat(pop.style.width || "0");
    assert.ok(left >= 8, `left ${left}`);
    assert.ok(left + width <= 272, `right ${left + width}`);
    const maxH = parseFloat(pop.style.maxHeight || "0");
    assert.ok(maxH > 0 && maxH <= 232, `maxHeight ${maxH}`);
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: prevW,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: prevH,
    });
    m.unmount();
  });
});

describe("Composer model picker (#1429)", () => {
  /** Text of the highlighted row, whitespace-collapsed. */
  const hlText = (m: Awaited<ReturnType<typeof mount>>) =>
    (m.query('[data-highlighted="true"]')?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();

  it("opens on one flat list of every installed provider's models, grouped", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    assert.ok(m.query('[role="listbox"][aria-label="Model"]'), "one list");
    assert.equal(
      m.query('[role="listbox"][aria-label="Provider"]'),
      null,
      "no provider level to drill through any more",
    );
    const text = m.text();
    for (const name of ["Sonnet 4", "Opus 4", "K3"]) {
      assert.ok(text.includes(name), `${name} must be listed up front`);
    }
    const headings = m
      .queryAll('[class*="modelGroupHeading"]')
      .map((el) => el.textContent);
    assert.deepEqual(
      headings,
      ["Claude Code", "Codex", "Grok", "Kimi"],
      "one group label per provider, in registry order",
    );
    assert.equal(
      text.includes("Grok 4"),
      false,
      "a missing CLI's models are not listed, only its setup row",
    );
    m.unmount();
  });

  it("shows each model's id in mono under its name", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const ids = m.queryAll('[class*="modelRowId"]').map((el) => el.textContent);
    assert.ok(ids.includes("claude-opus-4"), `got ${ids.join(", ")}`);
    assert.ok(ids.includes("provider default"), "Default names what it is");
    m.unmount();
  });

  it("rail: Favourites first, then one mark per provider, missing ones dimmed", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const rail = m.query('[role="group"][aria-label="Providers"]') as HTMLElement;
    assert.ok(rail, "provider rail");
    const labels = Array.from(rail.querySelectorAll("button")).map((b) =>
      b.getAttribute("aria-label"),
    );
    assert.deepEqual(labels, [
      "Favourites",
      "Provider Claude Code",
      "Provider Codex",
      "Provider Grok",
      "Provider Kimi",
    ]);
    const claude = m.query('button[aria-label="Provider Claude Code"]');
    const mark = claude!.querySelector('[data-provider-mark="claude"]');
    assert.ok(mark?.querySelector("svg"), "rail reuses ProviderMark");
    assert.equal(mark!.getAttribute("aria-hidden"), "true");
    assert.equal(
      m.query('button[aria-label="Provider Grok"]')?.getAttribute("data-unavailable"),
      "true",
    );
    assert.equal(
      claude!.getAttribute("data-active"),
      "true",
      "the diamond sits on the thread's provider at open",
    );
    m.unmount();
  });

  it("a rail click jumps the highlight to that provider and moves the diamond", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    await m.click(m.query('button[aria-label="Provider Kimi"]'));
    assert.match(hlText(m), /^Default/, "lands on Kimi's first row");
    assert.equal(
      m.query('button[aria-label="Provider Kimi"]')?.getAttribute("data-active"),
      "true",
    );
    assert.equal(
      m.query('button[aria-label="Provider Claude Code"]')?.getAttribute("data-active"),
      null,
    );
    await m.pressFocused("ArrowDown");
    assert.match(hlText(m), /K3/);
    assert.deepEqual(h.providerSets, [], "navigating selects nothing");
    m.unmount();
  });

  it("a rail jump out of the favourites view keeps its own highlight", async () => {
    // Shipped in the first cut: the filter-change reseed ran after the jump
    // and snapped the highlight back to the thread's model.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    await m.click(m.query('button[aria-label="Favourites"]'));
    await m.click(m.query('button[aria-label="Provider Kimi"]'));
    assert.equal(
      m.query('button[aria-label="Favourites"]')?.getAttribute("aria-pressed"),
      "false",
      "the jump leaves the favourites view",
    );
    await m.pressFocused("ArrowDown");
    assert.match(hlText(m), /^K3/, "and stays on Kimi's group");
    m.unmount();
  });

  it("selecting a model reports its provider and id together", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const row = m
      .queryAll("button")
      .find((b) => (b.textContent || "").startsWith("Sonnet 4"));
    assert.ok(row, "Sonnet must be listed");
    await m.click(row);
    assert.deepEqual(h.providerSets, [
      { provider: "claude", model: "claude-sonnet-4" },
    ]);
    assert.equal(m.query('[aria-label="Model picker"]'), null, "picking closes");
    m.unmount();
  });

  it("switches harness when the model belongs to another provider", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const k3 = m
      .queryAll("button")
      .find((b) => (b.textContent || "").startsWith("K3"));
    assert.ok(k3);
    await m.click(k3);
    assert.deepEqual(h.providerSets, [{ provider: "kimi", model: "k3" }]);
    m.unmount();
  });

  it("a missing CLI offers Set up with its install hint, and selects nothing", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const setup = m.query('button[aria-label="Set up Grok"]');
    assert.ok(setup, "Grok collapses to one setup row");
    assert.match(setup!.textContent || "", /not installed · set up/);
    await m.click(setup);
    const panel = m.query('[data-provider-setup="grok"]');
    assert.ok(panel, "clicking it shows the setup hint");
    assert.match(panel!.textContent || "", /grok/);
    assert.equal(
      panel!.querySelector("a")?.getAttribute("href"),
      "https://x.ai/cli",
      "the docs link from the onboarding install hints",
    );
    assert.deepEqual(h.providerSets, [], "setup is not a selection");
    assert.ok(m.query('[aria-label="Model picker"]'), "the picker stays open");
    m.unmount();
  });

  it("the rail entry for a missing CLI opens its setup hint", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    await m.click(m.query('button[aria-label="Provider Grok"]'));
    assert.ok(m.query('[data-provider-setup="grok"]'));
    assert.match(hlText(m), /^Grok/);
    m.unmount();
  });

  it("lets a session-bearing thread switch harness, with a warning", async () => {
    // Sessions are not portable across CLIs, so the switch drops the session
    // (backend clears it); the picker warns instead of locking.
    const h = makeHarness();
    const m = await mount(
      composer(h, { provider: "claude", model: "claude-opus-4", sessionId: "sess-1" }),
    );
    await m.click(m.query('button[aria-label^="Model:"]'));
    const k3 = m
      .queryAll("button")
      .find((b) => (b.textContent || "").startsWith("K3")) as HTMLButtonElement;
    assert.equal(k3.disabled, false, "other harnesses stay selectable");
    assert.match(k3.title, /fresh session/i, "the row says what switching costs");
    await m.click(k3);
    assert.deepEqual(h.providerSets, [{ provider: "kimi", model: "k3" }]);
    m.unmount();
  });

  it("a session-locked thread can still change its own model", async () => {
    const h = makeHarness();
    const m = await mount(
      composer(h, { provider: "claude", model: "claude-opus-4", sessionId: "sess-lock" }),
    );
    await m.click(m.query('button[aria-label^="Model:"]'));
    const sonnet = m
      .queryAll("button")
      .find((b) => (b.textContent || "").startsWith("Sonnet 4")) as HTMLButtonElement;
    assert.equal(sonnet.disabled, false);
    assert.equal(sonnet.title.includes("fresh session"), false);
    await m.click(sonnet);
    assert.deepEqual(h.providerSets, [{ provider: "claude", model: "claude-sonnet-4" }]);
    m.unmount();
  });

  it("opens highlighting the model the thread is on", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: "claude-opus-4" }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    assert.match(hlText(m), /^Opus 4/);
    m.unmount();

    // Kimi is last in the registry: a flat-index bug cannot pass here.
    const m2 = await mount(composer(h, { provider: "kimi", model: "k3" }));
    await m2.click(m2.query('button[aria-label^="Model:"]'));
    assert.match(hlText(m2), /^K3/);
    m2.unmount();
  });

  it("arrows move through rows, Enter selects, Escape closes and restores focus", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    const trigger = m.query('button[aria-label^="Model:"]') as HTMLButtonElement;
    await m.click(trigger);
    const dialog = m.query('[role="dialog"][aria-label="Model picker"]') as HTMLElement;
    assert.equal(
      document.activeElement,
      m.query('input[aria-label="Search models"]'),
      "search takes focus on open so typing filters",
    );
    assert.ok(dialog.contains(document.activeElement));
    assert.match(hlText(m), /^Default/);
    await m.pressFocused("ArrowDown");
    assert.match(hlText(m), /^Sonnet 4/, "arrows work straight from search");
    await m.pressFocused("Escape");
    assert.equal(m.query('[aria-label="Model picker"]'), null, "Escape closes");
    assert.equal(document.activeElement, trigger, "and restores the trigger");

    await m.click(trigger);
    await m.pressFocused("ArrowDown");
    await m.pressFocused("ArrowDown");
    await m.pressFocused("Enter");
    assert.deepEqual(h.providerSets, [{ provider: "claude", model: "claude-opus-4" }]);
    m.unmount();
  });

  it("typing while the list has focus goes to search", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const list = m.query('[role="listbox"][aria-label="Model"]') as HTMLElement;
    await inAct(() => list.focus());
    await m.press(list, "k");
    const search = m.query('input[aria-label="Search models"]') as HTMLInputElement;
    assert.equal(search.value, "k");
    assert.equal(document.activeElement, search);
    m.unmount();
  });

  it("Tab stays inside the picker; row buttons are not tab stops", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    const opener = m.query('button[aria-label^="Model:"]') as HTMLElement;
    await inAct(() => opener.focus());
    await m.click(opener);
    const dialog = m.query('[aria-label="Model picker"]') as HTMLElement;
    const rows = [
      ...dialog.querySelectorAll<HTMLButtonElement>('[role="option"] [class*="modelRow"]'),
    ].filter((el) => el.tagName === "BUTTON");
    assert.ok(rows.length > 0);
    assert.ok(rows.every((el) => el.tabIndex === -1), "arrows own the rows");
    for (let i = 0; i < 4; i += 1) {
      await m.pressFocused("Tab");
      assert.ok(dialog.contains(document.activeElement), `Tab ${i + 1} stays inside`);
      assert.notEqual(document.activeElement?.tagName, "TEXTAREA");
    }
    m.unmount();
  });

  it("hovering a row moves the highlight", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const opus = m
      .queryAll("button")
      .find((b) => (b.textContent || "").startsWith("Opus 4"));
    await m.hover(opus!);
    assert.match(hlText(m), /^Opus 4/);
    m.unmount();
  });

  it("shows a provider's catalogNote under its group label, not as a toast", async () => {
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

  it("falls back to raw model ids when a provider has no modelInfo", async () => {
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
    await m.click(m.query('button[aria-label^="Model:"]'));
    assert.ok(m.text().includes("raw-model-a"));
    m.unmount();
  });

  it("reopens with the search and the favourites filter cleared", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    await m.type(m.query('input[aria-label="Search models"]'), "opus");
    await m.click(m.query('button[aria-label="Favourites"]'));
    await m.click(m.query('button[aria-label^="Model:"]'));
    assert.equal(m.query('[aria-label="Model picker"]'), null);
    await m.click(m.query('button[aria-label^="Model:"]'));
    assert.equal(
      (m.query('input[aria-label="Search models"]') as HTMLInputElement).value,
      "",
    );
    assert.equal(
      m.query('button[aria-label="Favourites"]')?.getAttribute("aria-pressed"),
      "false",
    );
    assert.ok(m.text().includes("Sonnet 4"), "the full list is back");
    m.unmount();
  });

  it("restores a level a harness switch had dropped", async () => {
    // claude/Extra high -> kimi cannot keep the level (kimi lists low/high/max
    // only), so services.js clears it. Switching back used to land on Default.
    const h = makeHarness("kimi");
    setLastReasoningEffort("xhigh");
    const m = await mount(
      composer(h, { provider: "kimi", model: null, reasoningEffort: null }),
    );
    assert.ok(await openProvider(m, "Claude Code"));
    await m.click(m.query('[data-highlighted="true"]'));
    assert.deepEqual(h.providerSets, [{ provider: "claude", model: null }]);
    assert.deepEqual(
      h.callOrder,
      ["setProvider", "setReasoningEffort"],
      "the restore must follow the switch, not race it",
    );
    assert.equal(h.effectiveEffort, "xhigh");
    m.unmount();
  });

  it("does not resurrect a level over a deliberate Default", async () => {
    const h = makeHarness("claude");
    setLastReasoningEffort("xhigh");
    const m = await mount(
      composer(h, { provider: "claude", model: null, reasoningEffort: null }),
    );
    assert.ok(await openProvider(m, "Kimi"));
    await m.click(m.query('[data-highlighted="true"]'));
    assert.deepEqual(h.providerSets, [{ provider: "kimi", model: null }]);
    assert.deepEqual(h.efforts, [], "no effort call at all");
    setLastReasoningEffort(null);
    m.unmount();
  });
});

describe("Composer model search (#1429)", () => {
  it("filters across every installed provider", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "kimi", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    await m.type(m.query('input[aria-label="Search models"]'), "opus");
    const text = m.text();
    assert.ok(text.includes("Opus 4"), "another provider's model is found");
    assert.equal(text.includes("Sonnet 4"), false, "non-matches leave");
    assert.equal(text.includes("K3"), false);
    assert.equal(text.includes("not installed"), false, "setup rows hide");
    assert.match(
      (m.query('[data-highlighted="true"]')?.textContent || ""),
      /^Opus 4/,
      "the highlight lands on the first hit",
    );
    await m.pressFocused("Enter");
    assert.deepEqual(h.providerSets, [{ provider: "claude", model: "claude-opus-4" }]);
    m.unmount();
  });

  it("matches model ids as well as names", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    await m.type(m.query('input[aria-label="Search models"]'), "k3");
    assert.ok(m.text().includes("K3"));
    assert.equal(m.text().includes("Opus 4"), false);
    m.unmount();
  });

  it("keeps the thread provider's Custom row so a miss still has a path", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    await m.type(m.query('input[aria-label="Search models"]'), "zzz-unknown");
    const customs = m
      .queryAll("button")
      .filter((b) => (b.textContent || "").startsWith("Custom..."));
    assert.equal(customs.length, 1, "only the thread's own provider keeps Custom");
    m.unmount();
  });

  it("Escape clears the query first, then closes", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const search = m.query('input[aria-label="Search models"]') as HTMLInputElement;
    await m.type(search, "opus");
    await m.press(search, "Escape");
    assert.equal(search.value, "", "first Escape clears");
    assert.ok(m.query('[aria-label="Model picker"]'), "and keeps the picker open");
    await m.press(search, "Escape");
    assert.equal(m.query('[aria-label="Model picker"]'), null);
    m.unmount();
  });
});

describe("Composer model favourites (#1429)", () => {
  afterEach(() => window.localStorage.removeItem("solenta.modelFavourites"));

  it("a star persists to localStorage and survives a remount", async () => {
    window.localStorage.removeItem("solenta.modelFavourites");
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const star = m.query(
      'button[aria-label="Favourite Claude Code Opus 4"]',
    ) as HTMLButtonElement;
    assert.ok(star, "each model row has a star");
    assert.equal(star.getAttribute("aria-pressed"), "false");
    await m.click(star);
    assert.equal(star.getAttribute("aria-pressed"), "true");
    assert.deepEqual(
      JSON.parse(window.localStorage.getItem("solenta.modelFavourites") ?? "null"),
      ["claude:claude-opus-4"],
    );
    assert.deepEqual(h.providerSets, [], "starring is not selecting");
    assert.ok(m.query('[aria-label="Model picker"]'), "and keeps the picker open");
    m.unmount();

    const m2 = await mount(composer(h, { provider: "claude", model: null }));
    await m2.click(m2.query('button[aria-label^="Model:"]'));
    assert.equal(
      m2
        .query('button[aria-label="Favourite Claude Code Opus 4"]')
        ?.getAttribute("aria-pressed"),
      "true",
      "read back from localStorage",
    );
    await m2.click(m2.query('button[aria-label="Favourite Claude Code Opus 4"]'));
    assert.deepEqual(
      JSON.parse(window.localStorage.getItem("solenta.modelFavourites") ?? "null"),
      [],
      "un-starring writes too",
    );
    m2.unmount();
  });

  it("the rail's ★ shows only starred models, across providers", async () => {
    window.localStorage.setItem(
      "solenta.modelFavourites",
      JSON.stringify(["claude:claude-opus-4", "kimi:k3"]),
    );
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    await m.click(m.query('button[aria-label="Favourites"]'));
    const rows = m
      .queryAll('[role="option"] button[class*="modelRow"]')
      .map((b) => (b.textContent || "").replace(/\s+/g, " ").trim());
    assert.deepEqual(rows, ["Opus 4claude-opus-4", "K3k3"]);
    assert.equal(
      m.query('button[aria-label="Favourites"]')?.getAttribute("data-active"),
      "true",
    );
    await m.pressFocused("Enter");
    assert.deepEqual(h.providerSets, [{ provider: "claude", model: "claude-opus-4" }]);
    m.unmount();
  });

  it("an empty favourites view says how to add one", async () => {
    window.localStorage.removeItem("solenta.modelFavourites");
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    await m.click(m.query('button[aria-label="Favourites"]'));
    assert.match(m.text(), /No favourites yet/);
    m.unmount();
  });

  it("ignores a corrupt stored value", async () => {
    window.localStorage.setItem("solenta.modelFavourites", "{not json");
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    assert.equal(
      m.query('button[aria-label="Favourite Claude Code Opus 4"]')?.getAttribute("aria-pressed"),
      "false",
    );
    m.unmount();
  });
});

describe("Composer picker effort row (#1429)", () => {
  const chips = (m: Awaited<ReturnType<typeof mount>>) =>
    m
      .queryAll('[data-picker-effort] button')
      .map((b) => (b.textContent || "").trim());

  it("offers only the levels the thread's provider honours", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "kimi", model: "k3", reasoningEffort: "high" }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    assert.deepEqual(chips(m), ["Auto", "Low", "High", "Max"]);
    const pressed = m.query('[data-picker-effort] button[aria-pressed="true"]');
    assert.equal(pressed?.textContent, "High", "the chosen level is marked");
    m.unmount();
  });

  it("picks a level without closing the picker or switching harness", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    await m.click(m.query('[data-effort-chip="max"]'));
    assert.deepEqual(h.efforts, ["max"]);
    assert.deepEqual(h.providerSets, []);
    assert.ok(m.query('[aria-label="Model picker"]'), "the picker stays open");
    m.unmount();
  });

  it("is absent when the provider has no efforts, inert when its CLI is missing", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "codex", model: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    assert.equal(m.query("[data-picker-effort]"), null);
    m.unmount();

    const m2 = await mount(
      composer(h, { provider: "grok", model: null, providers: [GROK] }),
    );
    await m2.click(m2.query('button[aria-label^="Model:"]'));
    const chip = m2.query('[data-effort-chip="high"]') as HTMLButtonElement;
    assert.equal(chip.disabled, true);
    m2.unmount();
  });
});

describe("Composer reasoning pill", () => {
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

  it("keeps the effort pill on the thread while the picker is open", async () => {
    // The meter used to live in the picker's detail pane, so hovering another
    // harness or a profile made it describe something the thread was not on.
    // Its own pill cannot: it only ever reads the thread's provider.
    const h = makeHarness();
    const m = await mount(
      composer(h, { provider: "kimi", model: "k3", reasoningEffort: "high" }),
    );
    assert.ok(await openProvider(m, "Claude Code"), "highlight a foreign provider");
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
    assert.equal(send.disabled, true, "Send disabled while archived");
    assert.equal(m.query("[data-composer-options]"), null, "no Options button to reach");

    await m.click(send);
    assert.equal(m.query("[data-workflow-run]"), null);
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

  it("offers Queue or Steer on a steer-capable provider", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { busy: true }));
    const queue = m.query('[data-steer-action="queue"]') as HTMLButtonElement;
    const steer = m.query('[data-steer-action="steer"]') as HTMLButtonElement;
    assert.ok(queue, "Queue must be offered mid-run");
    assert.ok(steer, "Steer must be offered on Claude");
    assert.equal(queue.getAttribute("aria-pressed"), "true");
    assert.equal(steer.getAttribute("aria-pressed"), "false");

    await m.type(m.query("textarea"), "keep going that way");
    await m.click(m.query('button[aria-label="Send"]'));
    assert.deepEqual(h.sends, ["keep going that way"]);
    assert.deepEqual(h.steers, [false], "Queue is the default send");

    await m.type(m.query("textarea"), "no, do X instead");
    await m.click(steer);
    assert.equal(steer.getAttribute("aria-pressed"), "true");
    await m.click(m.query('button[aria-label="Send"]'));
    assert.deepEqual(h.sends, ["keep going that way", "no, do X instead"]);
    assert.deepEqual(h.steers, [false, true]);
    m.unmount();
  });

  it("shows Steer for Codex while a run is live (#1170)", async () => {
    const h = makeHarness("codex");
    const m = await mount(composer(h, { busy: true, provider: "codex" }));
    const queue = m.query('[data-steer-action="queue"]') as HTMLButtonElement;
    const steer = m.query('[data-steer-action="steer"]') as HTMLButtonElement;
    assert.ok(queue, "Queue stays the idle follow-up");
    assert.ok(steer, "Steer must be offered on a live Codex turn");
    await m.type(m.query("textarea"), "no, do X instead");
    await m.click(steer);
    await m.click(m.query('button[aria-label="Send"]'));
    assert.deepEqual(h.sends, ["no, do X instead"]);
    assert.deepEqual(h.steers, [true]);
    m.unmount();
  });

  it("hides Steer when the provider cannot take stdin mid-turn", async () => {
    const h = makeHarness("kimi");
    const m = await mount(composer(h, { busy: true, provider: "kimi" }));
    assert.equal(m.query("[data-steer-toggle]"), null);
    await m.type(m.query("textarea"), "follow up");
    await m.click(m.query('button[aria-label="Send"]'));
    assert.deepEqual(h.sends, ["follow up"]);
    assert.deepEqual(h.steers, [false]);
    m.unmount();
  });

  it("⌘⇧Enter always steers when the provider can", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { busy: true }));
    const ta = m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta, "redirect now");
    await inAct(() => {
      ta.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await m.flush();
    assert.deepEqual(h.sends, ["redirect now"]);
    assert.deepEqual(h.steers, [true]);
    m.unmount();
  });

  it("still locks what cannot be queued", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { busy: true }));
    await m.type(m.query("textarea"), "a prompt");

    const ta = m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta, "/workflow a prompt");
    await inAct(() => ta.focus());
    await m.press(ta, "Enter", { metaKey: true });
    assert.equal(m.query("[data-composer-options-popover]"), null, "the picker cannot open during a run");
    assert.match(m.text(), /wait for this run/i);
    await m.type(ta, "a prompt");
    assert.ok(m.query("[data-steer-toggle]"), "Queue versus Steer stays visible");
    assert.equal(m.query("[data-workflow-run]"), null);
    assert.equal(h.builds.length, 0, "active run must block onBuild");

    const model = m.query(
      'button[aria-haspopup="dialog"][aria-label^="Model:"]',
    ) as HTMLButtonElement;
    assert.equal(model.disabled, true, "model cannot change mid-run");
    m.unmount();
  });
});

describe("Composer value displays (null-safe)", () => {
  it("drops the session / Project / branch chips; branch lives in Thread details", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { sessionId: "abcdef0123456789" }));
    assert.ok(m.query("textarea"));
    assert.ok(!m.text().includes("abcdef01"), "no session chip");
    assert.ok(!m.text().includes("Worktree") && !m.text().includes("Project"), "no workspace chip");
    assert.equal(m.query("[data-composer-workspace]"), null, "no footer without a strip");
    m.unmount();
  });

  it("renders the draft workspace strip slot when one is passed", async () => {
    const h = makeHarness();
    const m = await mount(
      composer(h, { workspaceStrip: <span data-test-strip="">strip</span> }),
    );
    const slot = m.query("[data-composer-workspace]");
    assert.ok(slot, "footer slot renders");
    assert.ok(slot!.querySelector("[data-test-strip]"));
    m.unmount();
  });
});

describe("Composer transcript view (issue #461)", () => {
  it("keeps the view control off the toolbar and mirrors the mode (#1411)", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    assert.equal(m.query("[data-transcript-view-trigger]"), null, "no toolbar control");
    const mirror = m.query("[data-transcript-view-mode]");
    assert.ok(mirror, "mode mirrored on the controls row");
    assert.equal(mirror!.getAttribute("data-transcript-view-mode"), "normal");
    m.unmount();
  });

  it("cycles modes with Ctrl+O and toggles Summary with Ctrl+Alt+F", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    const mirror = () => m.query("[data-transcript-view-mode]")!.getAttribute("data-transcript-view-mode");
    assert.equal(mirror(), "normal");
    await inAct(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "o",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await m.flush();
    assert.equal(mirror(), "verbose");
    await inAct(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await m.flush();
    assert.equal(mirror(), "summary");
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
    {
      await openOptions(m);
      for (const el of m.queryAll("[data-composer-options-popover] button")) {
        assert.equal(
          el.querySelector("button, a, input, textarea, select"),
          null,
          "Options must not nest interactive elements",
        );
      }
    }

    const mlist = await openProvider(m, "Claude Code");
    assert.ok(mlist, "the model list must be open");
    assert.ok(
      m.queryAll('[role="option"]').length > 0,
      "the model popover must be OPEN when this asserts, or it checks nothing",
    );
    // Cardinality: the flat list's rows (and their stars) must be present.
    // Without a floor the loop below can pass by checking nothing.
    assert.ok(
      m.queryAll('[role="option"]').length >= 4,
      "the picker's rows must be present while this asserts",
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

    // Close WITHOUT using the field's own Cancel or Escape: Escape on the
    // list closes the picker, then reopen.
    await m.press(
      m.query('[role="listbox"][aria-label="Model"]') ?? list,
      "Escape",
    );
    assert.equal(m.query('[aria-label="Model picker"]'), null, "closed");
    await m.click(m.query('button[aria-label^="Model:"]'));

    assert.equal(
      m.query('input[aria-label="Custom model id"]'),
      null,
      "reopening must show the model list, not a stale custom field",
    );
    assert.ok(
      m.query('[role="listbox"][aria-label="Model"]'),
      "reopening must land on the model list",
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

  it("scrolls the OpenCode list without moving ancestor scrollports (#762)", async () => {
    // OpenCode descriptions vary in length. scrollIntoView({block:nearest})
    // walks up to .chatSlot { overflow:hidden } and lifts the composer,
    // leaving a gap under the picker. Scroll only the 240px list.
    const models = Array.from({ length: 12 }, (_, i) => `opencode/model-${i}`);
    const OPENCODE: ProviderInfo = {
      id: "opencode",
      name: "OpenCode",
      available: true,
      supportsResume: true,
      models,
      modelInfo: models.map((id, i) => ({
        id,
        label: `OpenCode model ${i}`,
        description:
          i % 2 === 0
            ? "Short"
            : "Long description that used to grow the bottom-anchored popover and jump the menu",
        vendor: "OpenCode",
      })),
      efforts: [],
      permissionModes: ["default", "bypassPermissions"],
    };
    const h = makeHarness("opencode");
    const m = await mount(
      composer(h, {
        provider: "opencode",
        model: null,
        providers: [OPENCODE],
      }),
    );
    const list = (await openProvider(m, "OpenCode")) as HTMLElement;
    assert.ok(list, "OpenCode model list must open");

    Object.defineProperty(list, "clientHeight", {
      configurable: true,
      value: 240,
    });
    const rows = list.querySelectorAll<HTMLElement>("button");
    rows.forEach((row, i) => {
      Object.defineProperty(row, "offsetTop", {
        configurable: true,
        value: i * 40,
      });
      Object.defineProperty(row, "offsetHeight", {
        configurable: true,
        value: 40,
      });
    });

    let intoView = 0;
    const proto = (m.query('[data-highlighted="true"]') as HTMLElement)
      .constructor.prototype as { scrollIntoView: () => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function patched() {
      intoView += 1;
    };
    try {
      for (let i = 0; i < 8; i++) await m.press(list, "ArrowDown");
    } finally {
      proto.scrollIntoView = original;
    }
    assert.equal(
      intoView,
      0,
      "scrollIntoView scrolls chatSlot and lifts the composer",
    );
    assert.ok(
      list.scrollTop > 0,
      "the 240px list itself must bring the highlight into view",
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
    const list = m.query('[role="listbox"][aria-label="Model"]');
    assert.ok(list);
    // Opens on the current model (after the profile row). Arrow up reaches it.
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

  it("profile rows show a harness logo keyed on the profile's provider", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { agentProfiles: [scout, missing] }));
    await m.click(m.query('button[aria-label^="Model:"]'));

    const cheap = m.query('button[aria-label="Profile Cheap scout"]');
    assert.ok(cheap, "scout row");
    const mark = cheap!.querySelector('[data-provider-mark="claude"]');
    assert.ok(mark, "mark uses the profile's provider id, not the profile id");
    assert.ok(mark!.querySelector("svg"), "known harness is a logo");
    assert.match(
      cheap!.textContent || "",
      /Cheap scout/,
      "the profile name stays on the row",
    );
    assert.equal(
      cheap!.getAttribute("aria-label"),
      "Profile Cheap scout",
      "the row keeps its accessible name",
    );
    assert.equal(
      mark!.getAttribute("aria-hidden"),
      "true",
      "visible name is the accessible name; the mark is decorative",
    );

    const gone = m.query('button[aria-label="Profile Grok worker"]');
    assert.ok(
      gone?.querySelector('[data-provider-mark="grok"] svg'),
      "uninstalled profile still shows its harness mark",
    );
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
  it("drops the always-on hint row; Send's title carries the shortcuts", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    // #1429: the hint row is gone; the shortcuts stay discoverable on Send
    // and in the keyboard sheet.
    assert.equal(m.query("[data-kbd-hints]"), null);
    const send = m.query('button[aria-label="Send"]') as HTMLElement;
    assert.match(send.title, /⌘Enter/);
    assert.match(send.title, /⌥Enter asks a side question/);
    assert.match(send.title, /⌘S stashes/);
    assert.ok(!/Esc stops/.test(send.title), "idle has no stop");
    m.unmount();
  });

  it("busy Send title mentions queueing, steering and Esc stop", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { busy: true }));
    const send = m.query('button[aria-label="Send"]') as HTMLElement;
    assert.match(send.title, /Queue for when this run lands \(⌘Enter\)/);
    assert.match(send.title, /⌘⇧Enter steers/);
    assert.match(send.title, /Esc stops the run/);
    m.unmount();
  });
});

describe("Composer live dictation (#845)", () => {
  it("hides the mic when window.coder.speech is missing", async () => {
    const h = makeHarness();
    const m = await mount(composer(h));
    assert.equal(mic(m), null);
    m.unmount();
  });

  it("shows a download control with accessible labels when the model is missing", async () => {
    const fake = createFakeCoder();
    const { m } = await mountSpeechComposer(fake);
    const btn = mic(m);
    assert.ok(btn, "mic pill");
    assert.equal(btn.getAttribute("aria-label"), "Download speech model");
    assert.equal(btn.getAttribute("aria-pressed"), "false");
    m.unmount();
  });

  it("first click while missing asks for confirmation and does not open the mic", async () => {
    const fake = createFakeCoder();
    const media = installSpeechMedia();
    const { m } = await mountSpeechComposer(fake);
    await m.click(mic(m));
    const confirm = m.query("[data-speech-confirm]");
    assert.ok(confirm, "inline confirmation");
    assert.match(confirm!.textContent || "", /700 MB/);
    assert.match(confirm!.textContent || "", /699,872,960/);
    assert.equal(media.getUserMediaCalls, 0, "confirmation must not open the mic");
    assert.equal(fake.of("speech.download").length, 0);
    assert.equal(fake.of("speech.start").length, 0);
    m.unmount();
  });

  it("confirmation calls download and still does not open the mic", async () => {
    const fake = createFakeCoder();
    const media = installSpeechMedia();
    const { m } = await mountSpeechComposer(fake);
    await m.click(mic(m));
    const go = m.query('[data-speech-confirm] button[aria-label="Confirm download"]');
    assert.ok(go);
    await m.click(go);
    assert.equal(fake.of("speech.download").length, 1);
    assert.equal(media.getUserMediaCalls, 0);
    assert.equal(fake.of("speech.start").length, 0);
    m.unmount();
  });

  it("shows download progress from speech:changed", async () => {
    const fake = createFakeCoder();
    installSpeechMedia();
    const { m } = await mountSpeechComposer(fake);
    await m.click(mic(m));
    await m.click(
      m.query('[data-speech-confirm] button[aria-label="Confirm download"]'),
    );
    await inAct(() => {
      fake.emitSpeech({
        state: "downloading",
        runtimeReady: true,
        modelReady: false,
        download: { bytesReceived: 349936480, bytesTotal: 699872960 },
      });
    });
    const btn = mic(m);
    assert.ok(btn);
    assert.match(btn.getAttribute("aria-label") || "", /Downloading speech model/);
    assert.match(m.text(), /50%/);
    m.unmount();
  });

  it("ready click captures audio then starts the session", async () => {
    const fake = createFakeCoder({ speechStatus: SPEECH_READY });
    const media = installSpeechMedia();
    const { m } = await mountSpeechComposer(fake);
    const btn = mic(m);
    assert.ok(btn);
    assert.equal(btn.getAttribute("aria-label"), "Start dictation");
    await m.click(btn);
    assert.deepEqual(media.order, ["mic", "start"]);
    assert.equal(fake.of("speech.start").length, 1);
    assert.equal(mic(m)?.getAttribute("aria-label"), "Stop dictation");
    assert.equal(mic(m)?.getAttribute("aria-pressed"), "true");
    const ta = m.query("textarea") as HTMLTextAreaElement;
    assert.equal(ta.readOnly, true);
    await m.click(mic(m));
    assert.equal(fake.of("speech.stop").length, 1);
    assert.equal(
      (fake.only("speech.stop").args[0] as { sessionId: string }).sessionId,
      "speech-session",
    );
    m.unmount();
  });

  it("concatenates incremental deltas and replaces the range on transcript", async () => {
    const fake = createFakeCoder({ speechStatus: SPEECH_READY });
    installSpeechMedia();
    const { m } = await mountSpeechComposer(fake);
    const ta = m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta, "Hello ");
    await m.click(mic(m));
    await inAct(() => {
      fake.emitSpeech({
        state: "recording",
        runtimeReady: true,
        modelReady: true,
        sessionId: "speech-session",
        delta: "Quick",
      });
    });
    assert.equal(ta.value, "Hello Quick");
    await inAct(() => {
      fake.emitSpeech({
        state: "recording",
        runtimeReady: true,
        modelReady: true,
        sessionId: "speech-session",
        delta: " brown",
      });
    });
    assert.equal(ta.value, "Hello Quick brown", "delta is a suffix, not a snapshot");
    await inAct(() => {
      fake.emitSpeech({
        state: "ready",
        runtimeReady: true,
        modelReady: true,
        sessionId: "speech-session",
        transcript: "Quick brown fox",
      });
    });
    assert.equal(ta.value, "Hello Quick brown fox");
    m.unmount();
  });

  it("empty final transcript restores the original draft", async () => {
    const fake = createFakeCoder({ speechStatus: SPEECH_READY });
    installSpeechMedia();
    const { m } = await mountSpeechComposer(fake);
    const ta = m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta, "keep me");
    await m.click(mic(m));
    await inAct(() => {
      fake.emitSpeech({
        state: "recording",
        runtimeReady: true,
        modelReady: true,
        delta: " nope",
      });
    });
    assert.equal(ta.value, "keep me nope");
    await inAct(() => {
      fake.emitSpeech({
        state: "ready",
        runtimeReady: true,
        modelReady: true,
        transcript: "",
      });
    });
    assert.equal(ta.value, "keep me");
    m.unmount();
  });

  it("Escape cancels, restores the original draft, and does not steal from a dialog", async () => {
    const fake = createFakeCoder({ speechStatus: SPEECH_READY });
    const media = installSpeechMedia();
    const { m } = await mountSpeechComposer(fake);
    const ta = m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta, "original");
    await m.click(mic(m));
    await inAct(() => {
      fake.emitSpeech({
        state: "recording",
        runtimeReady: true,
        modelReady: true,
        delta: " spoken",
      });
    });
    await inAct(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await m.flush();
    assert.equal(fake.of("speech.cancel").length, 1);
    assert.equal(ta.value, "original");
    assert.equal(ta.readOnly, false);
    assert.ok(media.tracksStopped >= 1);
    assert.ok(media.contextClosed >= 1);

    await m.click(mic(m));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    const cancels = fake.of("speech.cancel").length;
    await inAct(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await m.flush();
    assert.equal(
      fake.of("speech.cancel").length,
      cancels,
      "Escape must not steal from modal chrome",
    );
    dialog.remove();
    m.unmount();
  });

  it("thread switch cancels and restores the snapshot on the original thread", async () => {
    const fake = createFakeCoder({ speechStatus: SPEECH_READY });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    installSpeechMedia();
    shell.unmount();
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
    await m.type(ta(), "draft A");
    await m.click(mic(m));
    await inAct(() => {
      fake.emitSpeech({
        state: "recording",
        runtimeReady: true,
        modelReady: true,
        delta: " spoken",
      });
    });
    assert.equal(ta().value, "draft A spoken");
    await m.click(m.byText("swap-thread"));
    assert.equal(fake.of("speech.cancel").length, 1);
    assert.equal(ta().value, "", "t2 starts empty");
    await m.click(m.byText("swap-thread"));
    assert.equal(ta().value, "draft A", "t1 restored without the partial");
    m.unmount();
  });

  it("restores an unsent draft after the composer unmounts", async () => {
    const h = makeHarness();
    const first = await mount(composer(h, { threadId: "t-kept-draft" }));
    await first.type(first.query("textarea"), "keep this prompt");
    first.unmount();
    const second = await mount(composer(h, { threadId: "t-kept-draft" }));
    assert.equal(
      (second.query("textarea") as HTMLTextAreaElement).value,
      "keep this prompt",
    );
    const other = await mount(composer(h, { threadId: "t-other-draft" }));
    assert.equal(
      (other.query("textarea") as HTMLTextAreaElement).value,
      "",
      "another thread does not inherit the draft",
    );
    second.unmount();
    other.unmount();
  });

  it("archiving cancels and restores the original draft", async () => {
    const fake = createFakeCoder({ speechStatus: SPEECH_READY });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    installSpeechMedia();
    shell.unmount();
    const h = makeHarness();
    function Shell() {
      const [disabled, setDisabled] = useState(false);
      return (
        <>
          <button onClick={() => setDisabled(true)}>archive</button>
          {composer(h, { disabled })}
        </>
      );
    }
    const m = await mount(<Shell />);
    const ta = m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta, "keep");
    await m.click(mic(m));
    await inAct(() => {
      fake.emitSpeech({
        state: "recording",
        runtimeReady: true,
        modelReady: true,
        delta: " gone",
      });
    });
    await m.click(m.byText("archive"));
    assert.equal(fake.of("speech.cancel").length, 1);
    assert.equal(ta.value, "keep");
    m.unmount();
  });

  it("unmount cancels and closes capture", async () => {
    const fake = createFakeCoder({ speechStatus: SPEECH_READY });
    const media = installSpeechMedia();
    const { m } = await mountSpeechComposer(fake);
    await m.click(mic(m));
    m.unmount();
    assert.equal(fake.of("speech.cancel").length, 1);
    assert.ok(media.tracksStopped >= 1);
    assert.ok(media.contextClosed >= 1);
  });
});
