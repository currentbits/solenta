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

  it("locks other providers once the thread has a session", async () => {
    const h = makeHarness();
    const m = await mount(
      composer(h, {
        provider: "claude",
        model: "claude-opus-4",
        sessionId: "sess-1",
      }),
    );
    await m.click(m.query('button[aria-label^="Model:"]'));
    const claude = m.query(
      'button[aria-label="Provider Claude Code"]',
    ) as HTMLButtonElement;
    const codex = m.query(
      'button[aria-label="Provider Codex"]',
    ) as HTMLButtonElement;
    assert.equal(claude.disabled, false, "its own provider stays enterable");
    assert.equal(codex.disabled, true, "switching harness would break resume");
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

  it("hides the reasoning control entirely for a provider with no efforts", async () => {
    // Restored: an empty efforts list must render NO control, not an empty one.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    assert.ok(await openProvider(m, "Codex"), "codex must be enterable");
    assert.equal(
      m.query('[role="group"][aria-label="Reasoning effort"]'),
      null,
      "codex advertises no efforts, so no meter may render",
    );
    assert.equal(
      m.text().includes("REASONING"),
      false,
      "the header must leave with the meter",
    );
    m.unmount();
  });

  it("renders one segment per level the drilled provider advertises", async () => {
    // Restored: the count must follow the provider, not a hardcoded five.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    assert.ok(await openProvider(m, "Claude Code"));
    let group = m.query('[role="group"][aria-label="Reasoning effort"]');
    assert.equal(group?.querySelectorAll("button").length, 5, "claude has five");

    await m.click(m.byText("CLAUDE CODE"));
    assert.ok(await openProvider(m, "Kimi"));
    group = m.query('[role="group"][aria-label="Reasoning effort"]');
    assert.equal(
      group?.querySelectorAll("button").length,
      3,
      "kimi advertises three, so three segments",
    );
    m.unmount();
  });

  it("reports the reasoning level when a segment is clicked", async () => {
    // Restored: this is the whole point of the meter and it had no coverage
    // left after the rewrite.
    const h = makeHarness();
    const m = await mount(composer(h, { provider: "claude", model: null }));
    assert.ok(await openProvider(m, "Claude Code"));
    const seg = m
      .queryAll('[aria-label^="Reasoning "]')
      .find((el) => (el.getAttribute("aria-label") || "") === "Reasoning High");
    assert.ok(seg, "a High segment must exist for claude");
    await m.click(seg);
    assert.deepEqual(h.efforts, ["high"], "clicking must report that level");
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
    const list = await openProvider(m, "Kimi");
    assert.ok(list, "must be able to enter a provider the thread is not on");
    const hl = m.query('[data-highlighted="true"]');
    assert.ok(hl, "a row must be highlighted on entry");

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
    assert.ok(await openProvider(m, "Kimi"), "kimi must be enterable");

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
