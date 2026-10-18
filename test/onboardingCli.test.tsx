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
  // The sign-in terminal mounts real xterm; jsdom has no canvas and logs
  // "Not implemented", which the console gate fails. A null context is quiet.
  shell.container.ownerDocument.defaultView!.HTMLCanvasElement.prototype.getContext =
    (() => null) as never;
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

/** Cli is the first screen. Do not click Next to reach it (that would skip to setup). */
async function openCli(fake: ReturnType<typeof createFakeCoder>) {
  const m = await boot(fake);
  if (!m.query("[data-onboarding-cli-recheck]")) {
    const next = m.query("[data-onboarding-next]");
    assert.ok(next, "legacy welcome shell only: one Next reaches cli");
    await m.click(next);
  }
  assert.ok(
    m.query("[data-onboarding-cli-recheck]"),
    "first-run must show the CLI step without skipping past it",
  );
  const step = m
    .query("[data-onboarding-step]")
    ?.getAttribute("data-onboarding-step");
  if (step) {
    assert.equal(step, "cli", "data-onboarding-step must be cli");
  }
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
    assert.match(
      m.query("[data-onboarding-step]")?.textContent || "",
      /One coding agent is enough/,
    );
    assert.ok(
      !m.queryAll("[data-onboarding-cli-row]").some((r) => /Ready/.test(r.textContent || "")),
      "Ready only on a verified sign-in, never on bare installs",
    );

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
    assert.equal(
      (warning.textContent || "").trim(),
      "Install one agent using its instructions, then Recheck.",
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
      !/all agents/i.test(
        m.query("[data-onboarding-cli-empty]")?.textContent || "",
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
    const ok = m.query("[data-onboarding-cli-status]")?.textContent || "";
    assert.match(ok, /Rechecked/);
    assert.match(ok, /machine running Solenta/);
    assert.ok(
      !/ready|auth/i.test(ok),
      "success copy must not claim Ready or that authentication was verified",
    );
    m.unmount();
  });

  it("Copy without a clipboard tells the user to select the command", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      providers: [prov("claude", "Claude Code", false)],
    });
    const m = await openCli(fake);
    const copy = Array.from(
      m.query('[data-onboarding-cli-row="claude"]')?.querySelectorAll("button") ??
        [],
    ).find((el) => (el.textContent || "").includes("Copy"));
    assert.ok(copy, "missing claude must offer Copy");
    await m.click(copy);
    assert.equal(
      (m.query("[data-onboarding-cli-copy-error]")?.textContent || "").trim(),
      "Could not copy. Select and copy the command.",
    );
    assert.equal(
      m.query(
        '[data-onboarding-cli-row="claude"] [data-onboarding-cli-hint]',
      )?.textContent,
      CLAUDE_NPM,
      "verified install command must stay unchanged",
    );
    m.unmount();
  });

  it("a signed-out row offers Sign in in the dedicated shell, not a thread terminal", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      providers: [{ ...prov("codex", "Codex", true), auth: "signedOut" }],
    });
    const m = await openCli(fake);
    const row = m.query('[data-onboarding-cli-row="codex"]');
    assert.equal(row?.getAttribute("data-auth-state"), "signedOut");
    assert.match(row?.textContent || "", /Signed out/);
    await m.click(m.query('[data-onboarding-cli-signin="codex"]'));
    assert.deepEqual(fake.of("terminal.signIn").at(-1)?.args, [
      { provider: "codex", threadId: null },
    ]);
    assert.ok(m.query("[data-signin-terminal]"), "sign-in terminal opens");
    assert.ok(
      m.query("[data-onboarding-suspended]"),
      "onboarding steps aside while the terminal is up",
    );
    m.unmount();
  });

  it("Install types the install command for a missing claude", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      providers: [prov("claude", "Claude Code", false), prov("grok", "Grok", false)],
    });
    const m = await openCli(fake);
    assert.equal(
      m.query('[data-onboarding-cli-install="grok"]'),
      null,
      "no verified install command: copy hint only",
    );
    await m.click(m.query('[data-onboarding-cli-install="claude"]'));
    assert.deepEqual(fake.of("terminal.signIn").at(-1)?.args, [
      { provider: "claude", threadId: null, install: true },
    ]);
    assert.match(m.query("[data-signin-terminal]")?.textContent || "", /Install Claude Code/);
    m.unmount();
  });

  it("a signed-in row is Ready with the account, and connects another ChatGPT account", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      providers: [
        {
          ...prov("codex", "Codex", true),
          auth: "signedIn",
          account: { email: "dev@example.com", plan: "plus" },
        },
      ],
    });
    const m = await openCli(fake);
    const row = m.query('[data-onboarding-cli-row="codex"]');
    assert.match(row?.textContent || "", /✓ Ready/);
    assert.equal(
      row?.querySelector("[data-onboarding-cli-account]")?.textContent,
      "Signed in as dev@example.com · Plus",
    );
    await m.click(m.query("[data-onboarding-connect-chatgpt]"));
    const patch = fake.of("settings.set").at(-1)?.args[0] as {
      providerInstances?: Array<{ id: string; name: string; provider: string; configDir: string }>;
    };
    const inst = patch.providerInstances?.[0];
    assert.ok(inst, "saves a new codex instance");
    assert.equal(inst.provider, "codex");
    assert.equal(inst.name, "ChatGPT 2");
    assert.equal(inst.configDir, `~/.codex-${inst.id}`, "own CODEX_HOME, never the default");
    assert.deepEqual(fake.of("terminal.signIn").at(-1)?.args, [
      { provider: `codex:${inst.id}`, threadId: null },
    ]);
    assert.match(
      m.query("[data-signin-terminal]")?.textContent || "",
      /Sign in to Codex \(ChatGPT 2\)/,
    );
    m.unmount();
  });
});
