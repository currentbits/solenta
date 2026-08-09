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
  // Real CLI: low / medium / high only (three segments, not five).
  efforts: ["low", "medium", "high"],
};

/**
 * An AVAILABLE provider with a SHORTER effort list than claude. Without one,
 * the only multi-effort non-current provider was unavailable, so its rows were
 * skipped by arrow navigation and the "meter follows the highlighted row's
 * provider" case could not be reached by any test.
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
  efforts: ["low", "medium", "high"],
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

describe("Composer unified model picker", () => {
  it("lists every provider's models in one popover (not only the current harness)", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { model: null }));

    // Single model pill; no separate provider pill that hides other models.
    const modelPill = m.query('button[aria-label="Model: Default"]');
    assert.ok(modelPill, "model trigger must expose an accessible label with Default");
    assert.equal(
      Array.from(m.queryAll("button")).filter((b) =>
        (b.textContent || "").includes("Claude Code"),
      ).length,
      0,
      "the separate provider pill must be gone",
    );
    assert.ok(
      !m.text().includes("High · 1M"),
      "the decorative High · 1M pill must be gone",
    );

    await m.click(modelPill);

    const modelList = m.query('[role="listbox"][aria-label="Model"]');
    assert.ok(modelList, "model listbox must open");
    const listText = modelList.textContent || "";

    assert.ok(listText.includes("Sonnet 4"), "claude modelInfo label must list");
    assert.ok(listText.includes("Opus 4"), "second claude modelInfo label must list");
    assert.ok(listText.includes("Anthropic"), "vendor line must list");
    assert.ok(
      listText.includes("Codex"),
      "other providers must appear in the same list",
    );
    assert.ok(
      listText.includes("Grok"),
      "unavailable providers still list so the user can see them",
    );
    assert.ok(
      listText.includes("Grok 4"),
      "models of other providers must be visible without switching first",
    );
    // Raw ids must not be the visible row labels when modelInfo is present.
    assert.equal(
      listText.includes("claude-sonnet-4"),
      false,
      "raw model id must not appear in the list when modelInfo supplies labels",
    );
    // Highlight starts on the selected row (Default); detail follows it.
    assert.ok(
      m.text().includes("Use the provider default model"),
      "detail pane must describe the highlighted Default row",
    );
    m.unmount();
  });

  it("selecting a row from a different provider reports both provider and model", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label="Model: Default"]'));

    // Codex only has Default (empty models). Find the Codex Default button
    // by vendor/group text, not the Claude Default already selected.
    const codexDefault = Array.from(m.queryAll("button")).find((b) => {
      const t = b.textContent || "";
      return (
        t.includes("Default") &&
        t.includes("Codex") &&
        !(b as HTMLButtonElement).disabled
      );
    });
    assert.ok(codexDefault, "Codex Default row must be clickable");
    await m.click(codexDefault);

    assert.equal(h.providerSets.length, 1, "selecting a row reports once");
    assert.deepEqual(
      h.providerSets[0],
      { provider: "codex", model: null },
      "cross-provider pick must set provider AND model together",
    );
    m.unmount();
  });

  it("selecting a model on the current provider still reports provider and model", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { model: null }));
    await m.click(m.query('button[aria-label="Model: Default"]'));

    const sonnet = Array.from(m.queryAll("button")).find(
      (b) => (b.textContent || "").includes("Sonnet 4"),
    );
    assert.ok(sonnet, "Sonnet 4 option must be clickable");
    await m.click(sonnet);

    assert.equal(h.providerSets.length, 1);
    assert.deepEqual(h.providerSets[0], {
      provider: "claude",
      model: "claude-sonnet-4",
    });
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

  it("does not silently select an unavailable provider's rows", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude" }));
    await m.click(m.query('button[aria-label="Model: Default"]'));

    assert.ok(
      m.query('[role="listbox"][aria-label="Model"]'),
      "popover must be open before we assert on options",
    );
    assert.ok(m.text().includes("Grok"), "unavailable provider still listed");
    assert.ok(
      m.text().includes("not installed"),
      "unavailable provider must be marked, not look selectable",
    );

    const grokBtns = Array.from(m.queryAll("button")).filter((b) => {
      const t = b.textContent || "";
      return t.includes("Grok") || t.includes("not installed");
    }) as HTMLButtonElement[];
    const disabledGrok = grokBtns.filter((b) => b.disabled);
    assert.ok(
      disabledGrok.length >= 1,
      "at least one Grok row must be disabled",
    );
    for (const btn of disabledGrok) {
      await m.click(btn);
    }
    assert.equal(
      h.providerSets.length,
      0,
      "clicking unavailable rows must not report a selection",
    );
    m.unmount();
  });

  it("with a sessionId, other providers' rows are disabled and current stay open", async () => {
    const h = makeHarness();
    const m = await mount(
      composer(h, {
        provider: "claude",
        model: null,
        sessionId: "sess-abc-12345678",
      }),
    );
    await m.click(m.query('button[aria-label="Model: Default"]'));
    assert.ok(
      m.query('[role="listbox"][aria-label="Model"]'),
      "popover must open even when session-locked",
    );

    const sonnet = Array.from(m.queryAll("button")).find(
      (b) => (b.textContent || "").includes("Sonnet 4"),
    ) as HTMLButtonElement | undefined;
    assert.ok(sonnet, "current provider model must still list");
    assert.equal(
      sonnet.disabled,
      false,
      "current provider rows stay selectable with a session",
    );

    const codexDefault = Array.from(m.queryAll("button")).find((b) => {
      const t = b.textContent || "";
      return t.includes("Default") && t.includes("Codex");
    }) as HTMLButtonElement | undefined;
    assert.ok(codexDefault, "other provider rows still list");
    assert.equal(
      codexDefault.disabled,
      true,
      "other providers must be disabled once a session exists",
    );
    const lockTitle = codexDefault.getAttribute("title") || "";
    assert.ok(
      /Session started with/i.test(lockTitle),
      `locked row must explain why: got title=${JSON.stringify(lockTitle)}`,
    );

    await m.click(codexDefault);
    assert.equal(
      h.providerSets.length,
      0,
      "session-locked other provider must not report a selection",
    );

    await m.click(sonnet);
    assert.deepEqual(
      h.providerSets,
      [{ provider: "claude", model: "claude-sonnet-4" }],
      "same-provider model change must still work with a session",
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

  it("meter follows the highlighted model's provider (segment count)", async () => {
    // Claude has 5 efforts; Codex has 0. ArrowDown past the claude rows lands
    // on Codex Default and the meter must disappear with the highlight.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    await m.click(m.query('button[aria-label="Model: Default"]'));
    const list = m.query(
      '[role="listbox"][aria-label="Model"]',
    ) as HTMLElement;
    assert.ok(list, "list must open");

    // Start on Claude Default: five segments.
    let group = m.query('[role="group"][aria-label="Reasoning effort"]');
    assert.ok(group, "claude highlight shows the meter");
    assert.equal(group.querySelectorAll("button").length, 5);

    // Arrow down until the highlight leaves Claude, rather than hardcoding a
    // count: the row list grows (each provider ends with a Custom row), and a
    // magic number silently starts asserting about the wrong row.
    let hops = 0;
    while (
      m.query('[role="group"][aria-label="Reasoning effort"]') &&
      hops < 20
    ) {
      await m.press(list, "ArrowDown");
      hops += 1;
    }
    assert.ok(hops < 20, "expected to reach a provider with no efforts");

    group = m.query('[role="group"][aria-label="Reasoning effort"]');
    assert.equal(
      group,
      null,
      "highlighting a no-effort provider must hide the meter entirely",
    );
    assert.equal(
      m.text().includes("REASONING"),
      false,
      "REASONING header must leave with the meter",
    );
    m.unmount();
  });

  it("renders only as many reasoning segments as the highlighted provider advertises", async () => {
    // Mount with grok as current so its Default is selected and highlighted.
    // Grok is unavailable as a CLI but still the current provider of the thread.
    const h = makeHarness();
    const m = await mount(
      composer(h, {
        provider: "grok",
        model: null,
        providers: PROVIDERS,
      }),
    );
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
      [{ provider: "claude", model: "claude-sonnet-4" }],
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

  it("keyboard arrow navigation skips disabled rows", async () => {
    const h = makeHarness();
    // Session lock: only claude rows selectable. From last claude model,
    // ArrowDown must not land on locked codex; ArrowUp then Enter picks Sonnet.
    const m = await mount(
      composer(h, {
        provider: "claude",
        model: "claude-opus-4",
        sessionId: "sess-lock-test",
      }),
    );
    await m.click(m.query('button[aria-label="Model: Opus 4"]'));
    const list = m.query(
      '[role="listbox"][aria-label="Model"]',
    ) as HTMLElement;
    assert.ok(list, "list must be open before keyboard nav asserts");

    // Assert the RULE, not positions: arrowing anywhere in the list must never
    // highlight a locked provider's row. The old form hardcoded "ArrowDown
    // twice then ArrowUp lands on Sonnet", which silently started asserting
    // about a different row the moment the list grew.
    for (let i = 0; i < 12; i += 1) {
      await m.press(list, "ArrowDown");
      const hl = m.query('[data-highlighted="true"]');
      assert.ok(hl, "some row must stay highlighted");
      assert.equal(
        (hl.textContent || "").includes("Codex"),
        false,
        "arrow navigation must never land on a locked provider's row",
      );
    }

    // Home is the first selectable row (claude Default); one step down is the
    // first real model, whichever it is.
    await m.press(list, "Home");
    await m.press(list, "ArrowDown");
    await m.press(list, "Enter");
    assert.equal(h.providerSets.length, 1, "Enter must report one selection");
    assert.equal(
      h.providerSets[0].provider,
      "claude",
      "a locked thread must only ever report its own provider",
    );
    assert.ok(
      String(h.providerSets[0].model).startsWith("claude-"),
      `expected a claude model, got ${h.providerSets[0].model}`,
    );

    // Re-open and try to keyboard-select a locked codex row: End stays on
    // last selectable (Opus), never reports codex.
    await m.click(m.query('button[aria-label="Model: Opus 4"]'));
    const list2 = m.query(
      '[role="listbox"][aria-label="Model"]',
    ) as HTMLElement;
    assert.ok(list2, "list must reopen");
    const before = h.providerSets.length;
    await m.press(list2, "End");
    await m.press(list2, "Enter");
    assert.equal(
      h.providerSets.length,
      before,
      "End+Enter must not select a session-locked other provider",
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

    const modelPill = m.query('button[aria-label="Model: Default"]');
    assert.ok(modelPill, "the model trigger must be present");
    await m.click(modelPill);
    assert.ok(
      m.queryAll('[role="option"]').length > 0,
      "the model popover must be OPEN when this asserts, or it checks nothing",
    );
    // Cardinality: every provider contributes rows (claude 3 + codex 1 + grok 2).
    assert.ok(
      m.queryAll('[role="option"]').length >= 5,
      "unified list must expose multiple providers' options while open",
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

describe("Composer reasoning belongs to the current provider", () => {
  /** Arrow down until the highlighted row belongs to `providerLabel`. */
  async function highlightProvider(m: Awaited<ReturnType<typeof mount>>, list: HTMLElement, label: string) {
    for (let i = 0; i < 20; i += 1) {
      const hl = m.query('[data-highlighted="true"]');
      if (hl && (hl.textContent || "").includes(label)) return hl;
      await m.press(list, "ArrowDown");
    }
    return null;
  }

  it("shows no level and no clickable segments for a foreign provider", async () => {
    // Round 30 shipped a stranded effort: a level displayed for a provider that
    // could not honour it. Highlighting a foreign row must not borrow the
    // current provider's level.
    const h = makeHarness();
    const m = await mount(
      composer(h, {
        provider: "claude",
        model: null,
        reasoningEffort: "high",
      }),
    );
    await m.click(m.query('button[aria-label="Model: Default"]'));
    const list = m.query('[role="listbox"][aria-label="Model"]') as HTMLElement;
    const hl = await highlightProvider(m, list, "Moonshot");
    assert.ok(hl, "must be able to highlight the Kimi model row");

    const group = m.query('[role="group"][aria-label="Reasoning effort"]');
    assert.ok(group, "kimi advertises efforts, so a meter must render");
    const segments = Array.from(group.querySelectorAll("button"));
    assert.equal(segments.length, 3, "one segment per kimi level, not claude's five");
    assert.equal(
      segments.filter((b) => b.getAttribute("data-filled") === "true").length,
      0,
      "claude's High must not fill a foreign provider's meter",
    );
    assert.equal(
      segments.every((b) => (b as HTMLButtonElement).disabled),
      true,
      "a foreign provider's segments must not be clickable",
    );
    assert.equal(
      m.text().includes("REASONINGHigh") || m.text().includes("REASONING High"),
      false,
      "the header must not claim High for a provider that is not set to it",
    );
    m.unmount();
  });

  it("clicking a foreign provider's segment reports nothing", async () => {
    const h = makeHarness();
    const m = await mount(
      composer(h, { provider: "claude", model: null, reasoningEffort: "high" }),
    );
    await m.click(m.query('button[aria-label="Model: Default"]'));
    const list = m.query('[role="listbox"][aria-label="Model"]') as HTMLElement;
    assert.ok(await highlightProvider(m, list, "Moonshot"), "kimi row must be reachable");

    const group = m.query('[role="group"][aria-label="Reasoning effort"]');
    const seg = group?.querySelector("button");
    if (seg) await m.click(seg);
    assert.deepEqual(
      h.efforts,
      [],
      "a click on a foreign meter must not rewrite the current provider's effort",
    );
    m.unmount();
  });
});

describe("Composer custom model", () => {
  /** Open the picker and highlight a provider's Custom row via the keyboard. */
  async function openTo(m: Awaited<ReturnType<typeof mount>>, vendorOrName: string) {
    await m.click(m.query('button[aria-label^="Model:"]'));
    const list = m.query('[role="listbox"][aria-label="Model"]') as HTMLElement;
    for (let i = 0; i < 24; i += 1) {
      const hl = m.query('[data-highlighted="true"]');
      const t = hl?.textContent || "";
      if (t.includes("Custom") && t.includes(vendorOrName)) return list;
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

    // Close WITHOUT using the field's own Cancel or Escape.
    await m.press(
      m.query('[role="listbox"][aria-label="Model"]') ?? list,
      "Escape",
    );
    await m.click(m.query('button[aria-label^="Model:"]'));

    assert.equal(
      m.query('input[aria-label="Custom model id"]'),
      null,
      "reopening must show the model list, not a stale custom field",
    );
    assert.ok(
      m.query('[role="listbox"][aria-label="Model"]'),
      "the list must be back",
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
    await m.click(m.query('button[aria-label^="Model:"]'));
    const list = m.query('[role="listbox"][aria-label="Model"]') as HTMLElement;
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
