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
import { mount, unmountAll } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import type {
  PermissionMode,
  ProviderInfo,
  ReasoningEffort,
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
};

const PROVIDERS: ProviderInfo[] = [
  CLAUDE_WITH_INFO,
  {
    id: "codex",
    name: "Codex",
    available: true,
    supportsResume: false,
    models: [],
    modelInfo: [],
    efforts: [],
  },
  {
    id: "grok",
    name: "Grok",
    available: false,
    supportsResume: false,
    models: [],
    modelInfo: [],
    // Real CLI: low / medium / high only (three segments, not five).
    efforts: ["low", "medium", "high"],
  },
];

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
}

function makeHarness(): Harness {
  return { sends: [], builds: [], modes: [], providerSets: [], efforts: [] };
}

function composer(
  harness: Harness,
  over: {
    permissionMode?: PermissionMode;
    provider?: string;
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    sessionId?: string | null;
    branch?: string | null;
    hasWorktree?: boolean;
    disabled?: boolean;
    providers?: ProviderInfo[];
  } = {},
) {
  return (
    <Composer
      threadId="t1"
      branch={over.branch === undefined ? "agentmux/abc" : over.branch}
      permissionMode={over.permissionMode ?? "default"}
      onPermissionModeChange={(mode) => {
        harness.modes.push(mode);
      }}
      provider={over.provider ?? "claude"}
      model={over.model === undefined ? null : over.model}
      reasoningEffort={
        over.reasoningEffort === undefined ? null : over.reasoningEffort
      }
      providers={over.providers ?? PROVIDERS}
      workflows={WORKFLOWS}
      onSetProvider={(input) => {
        harness.providerSets.push(input);
      }}
      onSetReasoningEffort={(effort) => {
        harness.efforts.push(effort);
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
      onSend={(prompt) => {
        harness.sends.push(prompt);
      }}
      onBuild={(prompt, templateId) => {
        harness.builds.push({ prompt, templateId });
      }}
    />
  );
}

afterEach(unmountAll);

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

describe("Composer model and provider pickers", () => {
  it("shows modelInfo labels (not raw ids) and reports the selected model id", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { model: null }));

    // Trigger shows Default when model is null.
    const modelPill = m.query('button[aria-label="Model: Default"]');
    assert.ok(modelPill, "model trigger must expose an accessible label with Default");
    assert.ok(
      !m.text().includes("High · 1M"),
      "the decorative High · 1M pill must be gone",
    );

    await m.click(modelPill);

    // Labels from modelInfo, never the raw ids as the primary row text.
    assert.ok(m.text().includes("Sonnet 4"), "modelInfo label must list");
    assert.ok(m.text().includes("Opus 4"), "second modelInfo label must list");
    assert.ok(m.text().includes("Anthropic"), "vendor line must list");
    // Highlight starts on the selected row (Default); detail follows it.
    assert.ok(
      m.text().includes("Use the provider default model"),
      "detail pane must describe the highlighted Default row",
    );
    // Raw ids must not be the visible row labels when modelInfo is present.
    const modelList = m.query('[role="listbox"][aria-label="Model"]');
    assert.ok(modelList, "model listbox must open");
    assert.equal(
      (modelList.textContent || "").includes("claude-sonnet-4"),
      false,
      "raw model id must not appear in the list when modelInfo supplies labels",
    );

    const sonnet = Array.from(m.queryAll("button")).find(
      (b) => (b.textContent || "").includes("Sonnet 4"),
    );
    assert.ok(sonnet, "Sonnet 4 option must be clickable");
    // Hover moves the highlight so the detail pane tracks it.
    await m.click(sonnet); // selects; detail would have shown on hover in real use

    assert.equal(h.providerSets.length, 1, "selecting a model reports once");
    assert.deepEqual(h.providerSets[0], { model: "claude-sonnet-4" });
    m.unmount();
  });

  it("falls back to raw ids when the provider has no modelInfo", async () => {
    const h = makeHarness();
    const m = await mount(
      composer(h, { model: null, providers: BARE_MODELS }),
    );
    const pill = m.query('button[aria-label="Model: Default"]');
    assert.ok(pill);
    await m.click(pill);
    assert.ok(
      m.text().includes("claude-sonnet-4"),
      "without modelInfo the list must fall back to the raw id",
    );
    m.unmount();
  });

  it("reports the reasoning level when a segment is clicked", async () => {
    const h = makeHarness();
    const m = await mount(
      composer(h, { model: "claude-sonnet-4", reasoningEffort: "low" }),
    );
    const pill = m.query('button[aria-label="Model: Sonnet 4"]');
    assert.ok(pill, "trigger must show the modelInfo label, not the raw id");
    await m.click(pill);

    assert.ok(
      m.text().includes("REASONING"),
      "REASONING header must appear when efforts is non-empty",
    );
    const group = m.query('[role="group"][aria-label="Reasoning effort"]');
    assert.ok(group, "reasoning segment group must render");
    const segs = group.querySelectorAll("button");
    assert.equal(
      segs.length,
      5,
      "one segment per advertised effort (claude has five, not a hardcoded five from the enum alone)",
    );
    // Labels must be human, not raw tokens like "xhigh".
    const labels = Array.from(segs).map((b) => b.getAttribute("aria-label") || "");
    assert.ok(
      labels.some((l) => l.includes("Extra high")),
      `xhigh must display as Extra high, got: ${labels.join(", ")}`,
    );
    assert.equal(
      labels.some((l) => /\bxhigh\b/i.test(l)),
      false,
      "raw xhigh token must not be the aria-label",
    );

    const high = Array.from(segs).find(
      (b) => (b.getAttribute("aria-label") || "") === "Reasoning High",
    );
    assert.ok(high, "High segment must exist");
    await m.click(high);

    assert.deepEqual(
      h.efforts,
      ["high"],
      "clicking a segment must report that level",
    );
    m.unmount();
  });

  it("renders only as many reasoning segments as the provider advertises", async () => {
    // Grok supports three levels; a meter that hardcodes REASONING_EFFORTS
    // would show five and offer unsupported values that claude-style CLIs ignore.
    const h = makeHarness();
    const m = await mount(
      composer(h, {
        provider: "grok",
        model: null,
        providers: PROVIDERS,
      }),
    );
    // grok has empty models → still shows model pill with Custom…
    const pill = m.query('button[aria-label="Model: Default"]');
    assert.ok(pill);
    await m.click(pill);
    const group = m.query('[role="group"][aria-label="Reasoning effort"]');
    assert.ok(group, "grok has efforts so the control must render");
    assert.equal(
      group.querySelectorAll("button").length,
      3,
      "grok meter must have three segments (low/medium/high), not five",
    );
    m.unmount();
  });

  it("hides the reasoning control entirely when efforts is empty", async () => {
    const h = makeHarness();
    const m = await mount(
      composer(h, {
        model: null,
        providers: BARE_MODELS,
      }),
    );
    await m.click(m.query('button[aria-label="Model: Default"]'));

    assert.equal(
      m.query('[role="group"][aria-label="Reasoning effort"]'),
      null,
      "empty efforts must not render a reasoning control",
    );
    assert.equal(
      m.text().includes("REASONING"),
      false,
      "empty efforts must not render a REASONING header either",
    );
    m.unmount();
  });

  it("operates the model list by keyboard: arrows, Enter, Escape", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { model: null }));
    const pill = m.query('button[aria-label="Model: Default"]') as HTMLElement;
    await m.click(pill);

    const list = m.query(
      '[role="listbox"][aria-label="Model"]',
    ) as HTMLElement | null;
    assert.ok(list, "listbox must open");

    // Default is index 0; ArrowDown once lands on Sonnet 4 (index 1).
    await m.press(list, "ArrowDown");
    await m.press(list, "Enter");

    assert.deepEqual(
      h.providerSets,
      [{ model: "claude-sonnet-4" }],
      "Enter on the highlighted row must select that model id",
    );

    // Re-open and Escape must close without selecting.
    await m.click(m.query('button[aria-label="Model: Default"]'));
    const list2 = m.query(
      '[role="listbox"][aria-label="Model"]',
    ) as HTMLElement | null;
    assert.ok(list2, "list must open again");
    const before = h.providerSets.length;
    await m.press(list2, "Escape");
    assert.equal(
      m.query('[role="listbox"][aria-label="Model"]'),
      null,
      "Escape must close the model picker",
    );
    assert.equal(
      h.providerSets.length,
      before,
      "Escape must not report a model selection",
    );
    m.unmount();
  });

  it("does not silently select an unavailable provider", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude" }));

    const providerPill = Array.from(m.queryAll("button")).find((b) =>
      (b.textContent || "").includes("Claude Code"),
    );
    assert.ok(providerPill, "provider pill must show the current provider");
    await m.click(providerPill);

    assert.ok(m.text().includes("Grok"), "unavailable provider still listed");
    assert.ok(
      m.text().includes("not installed"),
      "unavailable provider must be marked, not look selectable",
    );

    const grokBtn = Array.from(m.queryAll("button")).find(
      (b) =>
        (b.textContent || "").includes("Grok") &&
        (b.textContent || "").includes("not installed"),
    ) as HTMLButtonElement | undefined;
    assert.ok(grokBtn, "Grok option must exist");
    assert.equal(
      grokBtn.disabled,
      true,
      "unavailable provider option must be disabled",
    );

    await m.click(grokBtn);
    assert.equal(
      h.providerSets.length,
      0,
      "clicking an unavailable provider must not report a selection",
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
});

describe("Composer while a run is active", () => {
  it("disables start actions and cannot start a second run", async () => {
    const h = makeHarness();
    // Parent passes disabled while isWorking (see ThreadView).
    const m = await mount(composer(h, { disabled: true }));

    const ta = m.query("textarea") as HTMLTextAreaElement;
    assert.equal(ta.disabled, true, "prompt must be locked while a run is active");

    const send = m.query('button[aria-label="Send"]') as HTMLButtonElement;
    const build = m.byText("Build") as HTMLButtonElement;
    assert.equal(send.disabled, true, "Send disabled during active run");
    assert.equal(build.disabled, true, "Build disabled during active run");

    await m.click(send);
    await m.click(build);
    assert.equal(h.sends.length, 0, "active run must block onSend");
    assert.equal(h.builds.length, 0, "active run must block onBuild");
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

describe("Composer reasoning default", () => {
  it("clicking the current level clears back to the provider default", async () => {
    // ReasoningEffort | null is handled at every layer, but before this the UI
    // could only move between levels, never restore the provider's default.
    const h = makeHarness();
    const m = await mount(composer(h, { reasoningEffort: "high" }));
    const trigger = m.query('button[aria-label^="Model:"]');
    assert.ok(trigger, "model trigger must exist");
    await m.click(trigger);
    const current = m
      .queryAll('[aria-label^="Reasoning "]')
      .find((el) =>
        (el.getAttribute("aria-label") || "") === "Reasoning High",
      );
    assert.ok(current, "a High segment must exist");
    await m.click(current);
    assert.deepEqual(
      h.efforts,
      [null],
      "re-clicking the active level must report null, not the same level again",
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
    const openLabels = ["Claude Code", "Ask first"];
    for (const label of openLabels) {
      const pill = Array.from(m.queryAll("button")).find((b) =>
        (b.textContent || "").includes(label),
      );
      if (pill) await m.click(pill);
    }
    // Build caret menu.
    const caret = m.query('button[aria-label="Choose workflow template"]');
    if (caret) await m.click(caret);

    const modelPill = m.query('button[aria-label="Model: Default"]');
    assert.ok(modelPill, "the model trigger must be present");
    await m.click(modelPill);
    assert.ok(
      m.queryAll('[role="option"]').length > 0,
      "the model popover must be OPEN when this asserts, or it checks nothing",
    );
    // The reasoning meter is the other new interactive surface. Without this
    // the guard silently skipped it whenever the fixture had no effort levels.
    assert.ok(
      m.queryAll('[aria-label^="Reasoning "]').length > 0,
      "the reasoning segments must be rendered when this asserts",
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
});
