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

  it("per-host GitHub account and saved token (#1528)", async () => {
    const withAccounts: SourceControlDiscovery = {
      probedAt: 1,
      sourceControlProviders: [
        {
          ...discovery.sourceControlProviders[0],
          accounts: [
            { host: "github.com", login: "currentbits", active: true },
            { host: "github.com", login: "work", active: false },
          ],
        },
      ],
    };
    const patches: Array<Partial<AppSettings>> = [];
    const m = await mount(
      <SettingsModal
        open
        initialPane="git"
        onClose={() => {}}
        settings={
          {
            dailyBudgetUsd: 5,
            autoSettleAfterDays: 3,
            githubHosts: [{ host: "ghe.corp.example", account: null, hasToken: true }],
          } as AppSettings
        }
        status={status()}
        onSaveSettings={async (p) => {
          patches.push(p);
          return { dailyBudgetUsd: 5, autoSettleAfterDays: 3 } as AppSettings;
        }}
        onDiscoverSourceControl={async () => withAccounts}
      />,
    );
    await m.flush();

    const select = m.query('[data-github-account="github.com"]');
    assert.ok(select, "account picker for github.com");
    assert.match(select!.textContent || "", /gh active account \(currentbits\)/);
    // GHE row exists from settings alone (token, no gh login) and shows it is saved.
    const gheToken = m.query('[data-github-token="ghe.corp.example"]') as HTMLInputElement | null;
    assert.equal(gheToken?.getAttribute("placeholder"), "Token saved");
    assert.ok(m.query('[data-github-token-clear="ghe.corp.example"]'));

    await m.change(select, "work");
    // Saved GHE row is echoed WITHOUT a token key, so its token is kept.
    assert.deepEqual(patches[0], {
      githubHosts: [
        { host: "ghe.corp.example", account: null },
        { host: "github.com", account: "work" },
      ],
    });

    await m.type(m.query('[data-github-token="github.com"]'), "ghp_new");
    await m.click(m.query('[data-github-token-save="github.com"]'));
    assert.deepEqual(patches[1].githubHosts?.[1], {
      host: "github.com",
      account: null,
      token: "ghp_new",
    });
    m.unmount();
  });
});
