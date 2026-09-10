/**
 * Onboarding CLI readiness step (#629). Mixed/zero/all availability,
 * simulate excluded, install hint for a missing claude, Recheck pending /
 * failure / retry with the stale list kept.
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/onboardingCli.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
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

/** Works whether the wizard still starts on welcome or already on cli. */
async function openCli(fake: ReturnType<typeof createFakeCoder>) {
  const m = await boot(fake);
  for (let i = 0; i < 4; i++) {
    if (m.query("[data-onboarding-cli-recheck]")) return m;
    const next = m.query("[data-onboarding-next]");
    if (!next || (next as HTMLButtonElement).disabled) break;
    const before = m
      .query("[data-onboarding-step]")
      ?.getAttribute("data-onboarding-step");
    await m.click(next);
    const after = m
      .query("[data-onboarding-step]")
      ?.getAttribute("data-onboarding-step");
    if (after === before) break;
  }
  assert.ok(
    m.query("[data-onboarding-cli-recheck]"),
    "must land on the CLI step (welcome→cli or cli-first)",
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
    const firstRow = m.query("[data-onboarding-cli-row]");
    assert.ok(firstRow, "at least one CLI row");
    assert.equal(
      firstRow.getAttribute("data-available"),
      "true",
      "installed agents must sort before missing ones",
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
      (warning.textContent || "").toLowerCase().includes("recheck"),
      "warning must point at Recheck as the next action",
    );
    assert.ok(
      !m.query("[data-onboarding-cli-empty]"),
      "a catalog with missing CLIs is not an empty detection result",
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

  it("empty provider list is a missing detection result, not all-missing", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      providers: [prov("simulate", "Simulate", true)],
    });
    const m = await openCli(fake);
    assert.ok(
      m.query("[data-onboarding-cli-empty]"),
      "simulate-only / empty real list must show no-detection copy",
    );
    assert.ok(
      !m.query("[data-onboarding-cli-warning]"),
      "must not claim every agent is missing when none were listed",
    );
    assert.ok(
      !(m.query("[data-onboarding-cli-empty]")?.textContent || "").includes(
        "all",
      ),
      "empty copy must not say all agents are missing",
    );
    m.unmount();
  });

  it("Recheck stays disabled while providers.list is pending", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      providers: [prov("claude", "Claude Code", true)],
    });
    const m = await openCli(fake);
    let resolveList!: (value: ProviderInfo[]) => void;
    const pendingList = new Promise<ProviderInfo[]>((resolve) => {
      resolveList = resolve;
    });
    const orig = fake.api.providers.list.bind(fake.api);
    fake.api.providers.list = () => pendingList;

    const recheck = m.query("[data-onboarding-cli-recheck]");
    assert.ok(recheck, "Recheck control must exist");
    await m.click(recheck);
    assert.equal(
      (m.query("[data-onboarding-cli-recheck]") as HTMLButtonElement).disabled,
      true,
      "Recheck must disable while the list is in flight",
    );
    assert.equal(
      m.query("[data-onboarding-cli-status]")?.getAttribute(
        "data-onboarding-cli-status",
      ),
      "pending",
    );
    assert.match(
      m.query("[data-onboarding-cli-recheck]")?.textContent || "",
      /Checking/,
    );
    assert.ok(
      m.query('[data-onboarding-cli-row="claude"]'),
      "pending Recheck must keep the current rows",
    );

    const rows = await orig();
    await inAct(async () => {
      resolveList(rows);
      await pendingList;
    });
    await m.flush();
    assert.equal(
      (m.query("[data-onboarding-cli-recheck]") as HTMLButtonElement).disabled,
      false,
      "Recheck must re-enable after the list settles",
    );
    m.unmount();
  });

  it("failed providers.list keeps the stale rows and retry clears the error", async () => {
    const fail: Record<string, Error> = {};
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      providers: [
        prov("claude", "Claude Code", true),
        prov("codex", "Codex", false),
        prov("simulate", "Simulate", true),
      ],
      fail,
    });
    const m = await openCli(fake);
    const before = fake.of("providers.list").length;
    assert.ok(before > 0, "boot must have listed providers");

    fail["providers.list"] = new Error("PATH lookup failed");
    const recheck = m.query("[data-onboarding-cli-recheck]");
    assert.ok(recheck, "Recheck control must exist");
    await m.click(recheck);

    const err = m.query("[data-onboarding-cli-error]");
    assert.ok(err, "failed list must render data-onboarding-cli-error");
    assert.match(err.textContent || "", /PATH lookup failed/);
    const claude = m.query('[data-onboarding-cli-row="claude"]');
    assert.ok(claude, "stale claude row must remain");
    assert.equal(
      claude.getAttribute("data-available"),
      "true",
      "failed Recheck must not drop the previous list",
    );
    assert.ok(
      !m.query('[data-onboarding-cli-row="simulate"]'),
      "simulate stays excluded after a failed Recheck",
    );
    assert.ok(
      fake.of("providers.list").length > before,
      "failed Recheck must still call providers.list",
    );

    delete fail["providers.list"];
    await m.click(m.query("[data-onboarding-cli-recheck]"));
    assert.ok(
      !m.query("[data-onboarding-cli-error]"),
      "successful retry must clear the error",
    );
    assert.equal(
      m.query("[data-onboarding-cli-status]")?.getAttribute(
        "data-onboarding-cli-status",
      ),
      "ok",
    );
    assert.match(
      m.query("[data-onboarding-cli-status]")?.textContent || "",
      /PATH/,
    );
    assert.ok(
      !(m.query("[data-onboarding-cli-status]")?.textContent || "")
        .toLowerCase()
        .includes("auth"),
      "success copy must not claim authentication was verified",
    );
    m.unmount();
  });
});
