/**
 * Settings → Source Control (issue #608).
 *
 * Run: node --import=./test/support/render.mjs --test test/sourceControlSettings.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { SettingsModal } from "../src/components/SettingsModal";
import type {
  AppSettings,
  AppStatus,
  SourceControlDiscovery,
} from "../src/shared/ipc";

function status(): AppStatus {
  return {
    spendTodayUsd: 0,
    memory: {
      running: true,
      adopted: false,
      port: 7421,
      entries: 12,
      vectors: 9,
      lastError: null,
    },
    build: {
      version: "0.1.0",
      sha: "abc1234",
      time: "2026-08-08T12:00:00.000Z",
    },
  };
}

const discovery: SourceControlDiscovery = {
  probedAt: 1,
  sourceControlProviders: [
    {
      kind: "github",
      label: "GitHub",
      status: "available",
      installHint: "gh auth login",
      version: "2.97.0",
      auth: { status: "authenticated", detail: "currentbits" },
    },
    {
      kind: "gitlab",
      label: "GitLab",
      status: "missing",
      installHint: "brew install glab",
      version: null,
      auth: {
        status: "unauthenticated",
        detail: "GitLab CLI (glab) is not installed.",
      },
    },
    {
      kind: "bitbucket",
      label: "Bitbucket",
      status: "available",
      installHint: 'export SOLENTA_BITBUCKET_ACCESS_TOKEN="your-access-token"',
      version: null,
      auth: {
        status: "unauthenticated",
        detail: "Set SOLENTA_BITBUCKET_ACCESS_TOKEN.",
      },
    },
    {
      kind: "azure-devops",
      label: "Azure DevOps",
      status: "missing",
      installHint: "brew install azure-cli",
      version: null,
      auth: {
        status: "unauthenticated",
        detail: "Azure CLI (az) is not installed.",
      },
    },
  ],
};

afterEach(unmountAll);

describe("Settings Source Control (#608)", () => {
  it("lists each forge with status, account, and a copyable fix", async () => {
    const calls: Array<{ rescan?: boolean } | undefined> = [];
    const m = await mount(
      <SettingsModal
        open
        initialPane="git"
        onClose={() => {}}
        settings={{ dailyBudgetUsd: 5, autoSettleAfterDays: 3 } as AppSettings}
        status={status()}
        onSaveSettings={async (p) => ({
          dailyBudgetUsd: p.dailyBudgetUsd ?? null,
          autoSettleAfterDays: p.autoSettleAfterDays ?? 3,
        })}
        onDiscoverSourceControl={async (input) => {
          calls.push(input);
          return discovery;
        }}
      />,
    );
    await m.flush();

    const section = m.query("[data-source-control]");
    assert.ok(section, "Source Control section");
    const github = m.query('[data-source-control-kind="github"]');
    assert.ok(github);
    assert.match(github!.textContent || "", /Signed in as currentbits/);
    assert.equal(github!.getAttribute("data-source-control-auth"), "authenticated");
    assert.ok(!github!.querySelector("[data-source-control-hint]"));

    const gitlab = m.query('[data-source-control-kind="gitlab"]');
    assert.ok(gitlab);
    assert.match(gitlab!.textContent || "", /Not installed/);
    const hint = gitlab!.querySelector("[data-source-control-hint]");
    assert.equal(hint && hint.textContent, "brew install glab");
    assert.ok(m.query("[data-source-control-copy='gitlab']"));

    assert.equal(calls.length, 1);
    assert.equal(calls[0], undefined);
    m.unmount();
  });

  it("Rescan passes rescan: true", async () => {
    const calls: Array<{ rescan?: boolean } | undefined> = [];
    const m = await mount(
      <SettingsModal
        open
        initialPane="git"
        onClose={() => {}}
        settings={{ dailyBudgetUsd: 5, autoSettleAfterDays: 3 } as AppSettings}
        status={status()}
        onSaveSettings={async (p) => ({
          dailyBudgetUsd: p.dailyBudgetUsd ?? null,
          autoSettleAfterDays: p.autoSettleAfterDays ?? 3,
        })}
        onDiscoverSourceControl={async (input) => {
          calls.push(input);
          return discovery;
        }}
      />,
    );
    await m.flush();
    const btn = m.query("[data-source-control-rescan]");
    assert.ok(btn);
    await m.click(btn);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { rescan: true });
    m.unmount();
  });
});
