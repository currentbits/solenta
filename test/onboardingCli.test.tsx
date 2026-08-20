/**
 * Onboarding CLI readiness step (#629). Mixed/zero/all availability,
 * simulate excluded, install hint for a missing claude, Recheck re-lists.
 *
 * Run: node --import=./test/support/render.mjs --test test/onboardingCli.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder } from "./support/fakeCoder.ts";
import App from "../src/App";
import type { ProviderInfo } from "../src/shared/ipc";

function prov(
  id: string,
  name: string,
  available: boolean,
): ProviderInfo {
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

async function openCli(fake: ReturnType<typeof createFakeCoder>) {
  const m = await boot(fake);
  const next = m.query("[data-onboarding-next]");
  assert.ok(next, "Next control must exist");
  await m.click(next);
  assert.equal(
    m.query("[data-onboarding-step]")?.getAttribute("data-onboarding-step"),
    "cli",
    "Next from welcome must land on the cli step",
  );
  return m;
}

const CLAUDE_NPM = "npm install -g @anthropic-ai/claude-code";

describe("Onboarding CLI step (#629)", () => {
  it("renders mixed availability rows with data-available", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      providers: [
        prov("claude", "Claude Code", true),
        prov("codex", "Codex", false),
        prov("grok", "Grok", true),
        prov("simulate", "Simulate", true),
      ],
    });
    const m = await openCli(fake);

    const claude = m.query('[data-onboarding-cli-row="claude"]');
    const codex = m.query('[data-onboarding-cli-row="codex"]');
    const grok = m.query('[data-onboarding-cli-row="grok"]');
    assert.ok(claude, "claude row must render");
    assert.ok(codex, "codex row must render");
    assert.ok(grok, "grok row must render");
    assert.equal(
      claude.getAttribute("data-available"),
      "true",
      "installed claude must have data-available=true",
    );
    assert.equal(
      codex.getAttribute("data-available"),
      "false",
      "missing codex must have data-available=false",
    );
    assert.equal(
      grok.getAttribute("data-available"),
      "true",
      "installed grok must have data-available=true",
    );
    m.unmount();
  });

  it("excludes simulate from the CLI list", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      providers: [
        prov("claude", "Claude Code", true),
        prov("simulate", "Simulate", true),
      ],
    });
    const m = await openCli(fake);
    assert.ok(
      !m.query('[data-onboarding-cli-row="simulate"]'),
      "simulate must not appear as a CLI row",
    );
    assert.ok(
      m.query('[data-onboarding-cli-row="claude"]'),
      "real providers must still render",
    );
    m.unmount();
  });

  it("shows the npm install command on a missing claude row", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      providers: [prov("claude", "Claude Code", false)],
    });
    const m = await openCli(fake);
    const hint = m.query(
      '[data-onboarding-cli-row="claude"] [data-onboarding-cli-hint]',
    );
    assert.ok(hint, "missing claude must show an install hint");
    assert.equal(
      hint.textContent,
      CLAUDE_NPM,
      "missing claude hint must be the npm install command",
    );
    m.unmount();
  });

  it("Recheck calls providers.list again", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      providers: [prov("claude", "Claude Code", true)],
    });
    const m = await openCli(fake);
    const before = fake.of("providers.list").length;
    assert.ok(before > 0, "boot must have listed providers");

    const recheck = m.query("[data-onboarding-cli-recheck]");
    assert.ok(recheck, "Recheck control must exist");
    await m.click(recheck);
    assert.ok(
      fake.of("providers.list").length > before,
      "Recheck must call providers.list again",
    );
    m.unmount();
  });

  it("shows a warning when no provider is available", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      providers: [
        prov("claude", "Claude Code", false),
        prov("codex", "Codex", false),
        prov("simulate", "Simulate", true),
      ],
    });
    const m = await openCli(fake);
    const warning = m.query("[data-onboarding-cli-warning]");
    assert.ok(warning, "zero available CLIs must show the warning");
    assert.ok(
      (warning.textContent || "").includes("fail"),
      "warning must say runs will fail until a CLI is installed",
    );
    m.unmount();
  });

  it("hides the warning when every listed provider is available", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      providers: [
        prov("claude", "Claude Code", true),
        prov("codex", "Codex", true),
      ],
    });
    const m = await openCli(fake);
    assert.ok(
      !m.query("[data-onboarding-cli-warning]"),
      "all-available must hide the zero-CLI warning",
    );
    m.unmount();
  });
});
