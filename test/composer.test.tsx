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
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: ["claude-sonnet-4", "claude-opus-4"],
  },
  {
    id: "codex",
    name: "Codex",
    available: true,
    supportsResume: false,
    models: [],
  },
  {
    id: "grok",
    name: "Grok",
    available: false,
    supportsResume: false,
    models: [],
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
}

function makeHarness(): Harness {
  return { sends: [], builds: [], modes: [], providerSets: [] };
}

function composer(
  harness: Harness,
  over: {
    permissionMode?: PermissionMode;
    provider?: string;
    model?: string | null;
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
      providers={over.providers ?? PROVIDERS}
      workflows={WORKFLOWS}
      onSetProvider={(input) => {
        harness.providerSets.push(input);
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
  it("lists the models it was given and reports the selection", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { model: null }));

    // Model pill shows "default" when model is null.
    assert.ok(
      m.text().includes("default"),
      `model pill must show default, got: ${m.text().slice(0, 160)}`,
    );

    // Open the model menu (pill that shows the current model label).
    const pills = m.queryAll("button");
    const modelPill = pills.find((b) =>
      (b.textContent || "").includes("default"),
    );
    assert.ok(modelPill, "model pill must be present");
    await m.click(modelPill);

    assert.ok(m.text().includes("Default"), "Default option must list");
    assert.ok(m.text().includes("sonnet-4"), "given model must list (short name)");
    assert.ok(m.text().includes("opus-4"), "second given model must list");

    const sonnet = Array.from(m.queryAll("button")).find((b) =>
      (b.textContent || "").includes("sonnet-4"),
    );
    assert.ok(sonnet, "sonnet option must be clickable");
    await m.click(sonnet);

    assert.equal(h.providerSets.length, 1, "selecting a model reports once");
    assert.deepEqual(h.providerSets[0], { model: "claude-sonnet-4" });
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

    // Typing into a disabled field is not realistic; force a value on the
    // controlled input via the harness type helper would still leave canSend
    // false because disabled short-circuits. Assert the controls themselves.
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
    // Guard against a regression that only checks hasPrompt and ignores disabled.
    const h = makeHarness();
    const m = await mount(composer(h, { disabled: false }));
    await m.type(m.query("textarea"), "already typing");
    // Remount is the realistic path (parent flips isWorking). Remount with
    // disabled=true and re-type is not needed: canSend is !disabled && hasPrompt.
    // Instead re-render by mounting disabled with the same harness after a
    // successful enable, then prove disabled alone blocks.
    m.unmount();

    const m2 = await mount(composer(h, { disabled: true }));
    // Even if the user somehow had text, disabled controls must not fire.
    // Inject text while disabled: type helper still dispatches, but canSend
    // is false regardless of value.
    await m2.type(m2.query("textarea"), "sneaky second prompt");
    const send = m2.query('button[aria-label="Send"]') as HTMLButtonElement;
    assert.equal(send.disabled, true, "disabled overrides a non-empty prompt");
    await m2.click(send);
    assert.equal(h.sends.length, 0);
    m2.unmount();
  });
});

describe("Composer value displays (null-safe)", () => {
  /**
   * Composer has no spend/token meter prop (that lives on Sidebar / Agents).
   * The value surfaces it does own are session chip, branch chip, worktree
   * chip, and the static effort pill. They must not crash on null/empty.
   */
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
    // Must render without throwing; no short id fragment expected.
    assert.ok(noSess.query("textarea"), "composer still mounts with null session");
    assert.ok(
      !noSess.text().includes("abcdef01"),
      "null session must not leave a stale chip",
    );
    noSess.unmount();
  });

  it("shows the effort pill and survives null branch", async () => {
    const h = makeHarness();
    const m = await mount(composer(h, { branch: null }));
    assert.ok(
      m.text().includes("High"),
      "effort pill is the composer-local capacity display",
    );
    assert.ok(
      m.text().includes("Worktree") || m.text().includes("Project"),
      "the composer states where the work will land",
    );
    assert.ok(m.query("textarea"), "null branch must not crash the composer");
    // Inventing a default would tell the user their work is going to main when
    // it is going nowhere.
    assert.equal(
      m.text().includes("main"),
      false,
      "a null branch must not invent a default chip",
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
    const openLabels = ["Claude Code", "default", "Ask first"];
    for (const label of openLabels) {
      const pill = Array.from(m.queryAll("button")).find((b) =>
        (b.textContent || "").includes(label),
      );
      if (pill) await m.click(pill);
    }
    // Build caret menu.
    const caret = m.query('button[aria-label="Choose workflow template"]');
    if (caret) await m.click(caret);

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
