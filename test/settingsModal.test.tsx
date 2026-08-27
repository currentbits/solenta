/**
 * SettingsModal, mounted for real: effects run, clicks fire, state advances.
 *
 * Settings had ZERO render coverage. It is the only UI window onto memory
 * health and which build is running, and two production bugs were previously
 * invisible precisely because nothing surfaced them. A call-site deletion
 * of those sections would leave the suite green.
 *
 * Run: node --import=./test/support/render.mjs --test test/settingsModal.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { SettingsModal, type SettingsPane } from "../src/components/SettingsModal";
import type {
  AppSettings,
  AppStatus,
  ProviderInfo,
  SubagentPool,
  WebhookTestResult,
} from "../src/shared/ipc";

function status(over: {
  spendTodayUsd?: number;
  memory?: Partial<AppStatus["memory"]>;
  build?: Partial<AppStatus["build"]>;
} = {}): AppStatus {
  return {
    spendTodayUsd: over.spendTodayUsd ?? 0,
    memory: {
      running: true,
      adopted: false,
      port: 7421,
      entries: 12,
      vectors: 9,
      lastError: null,
      ...(over.memory ?? {}),
    },
    build: {
      version: "0.1.0",
      sha: "abc1234",
      time: "2026-08-08T12:00:00.000Z",
      ...(over.build ?? {}),
    },
  };
}

const KIMI: ProviderInfo = {
  id: "kimi",
  name: "Kimi",
  available: true,
  supportsResume: true,
  models: ["kimi-code/kimi-for-coding-highspeed"],
  modelInfo: [
    {
      id: "kimi-code/kimi-for-coding-highspeed",
      label: "Highspeed",
      description: "Fast",
      vendor: "Moonshot",
    },
  ],
  efforts: [],
};

interface Stubs {
  settings?: AppSettings | null;
  status?: AppStatus | null;
  providers?: ProviderInfo[];
  initialPane?: SettingsPane;
  onSaveSettings?: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  onCheckUpdate?: () => Promise<void>;
  onTestWebhook?: () => Promise<WebhookTestResult>;
  onClose?: () => void;
}

function modal(stubs: Stubs = {}) {
  return (
    <SettingsModal
      open
      initialPane={stubs.initialPane}
      onClose={stubs.onClose ?? (() => {})}
      settings={stubs.settings ?? { dailyBudgetUsd: 5, autoSettleAfterDays: 3 }}
      providers={stubs.providers}
      status={stubs.status === undefined ? status() : stubs.status}
      onCheckUpdate={stubs.onCheckUpdate}
      onTestWebhook={stubs.onTestWebhook}
      onSaveSettings={
        stubs.onSaveSettings ??
        (async (patch) => ({
          dailyBudgetUsd: patch.dailyBudgetUsd ?? null,
          autoSettleAfterDays:
            patch.autoSettleAfterDays === undefined
              ? 3
              : patch.autoSettleAfterDays,
        }))
      }
    />
  );
}

afterEach(unmountAll);

describe("SettingsModal memory section", () => {
  it("shows the entry and vector counts it was given", async () => {
    const m = await mount(
      modal({
        initialPane: "memory",
        status: status({ memory: { entries: 42, vectors: 17 } }),
      }),
    );
    assert.ok(
      m.text().includes("42 entries"),
      `expected entry count, got: ${m.text()}`,
    );
    assert.ok(
      m.text().includes("17 embedded"),
      `expected vector count, got: ${m.text()}`,
    );
    m.unmount();
  });

  it("renders null counts as unknown, never as zero", async () => {
    // "0 entries" when the server is unreachable is a lie the user would act on.
    const m = await mount(
      modal({
        initialPane: "memory",
        status: status({
          memory: { entries: null, vectors: null, adopted: true },
        }),
      }),
    );
    assert.ok(
      m.text().includes("entries unknown"),
      `null entries must say unknown, got: ${m.text()}`,
    );
    assert.equal(
      m.text().includes("0 entries"),
      false,
      "must never paint null as zero entries",
    );
    m.unmount();
  });

  it("surfaces a janitor error when present", async () => {
    const m = await mount(
      modal({
        initialPane: "memory",
        status: status({
          memory: {
            entries: 1,
            vectors: 0,
            lastError: "orphan sweep failed: NOT EXISTS",
          },
        }),
      }),
    );
    assert.ok(
      m.text().includes("Janitor error: orphan sweep failed"),
      `janitor error must be visible, got: ${m.text()}`,
    );
    const alert = m.query('[role="alert"]');
    assert.ok(alert, "janitor error must use role=alert");
    m.unmount();
  });
});

describe("SettingsModal build section", () => {
  it("shows version, commit sha and build time", async () => {
    const m = await mount(
      modal({
        status: status({
          memory: { running: false, port: null, entries: null, vectors: null },
          build: {
            version: "0.1.0",
            sha: "deadbeef",
            time: "2026-08-08T12:00:00.000Z",
          },
        }),
      }),
    );
    const t = m.text();
    assert.ok(t.includes("0.1.0"), "version must render");
    assert.ok(t.includes("deadbeef"), "sha must render");
    assert.ok(t.includes("2026-08-08T12:00:00.000Z"), "build time must render");
    m.unmount();
  });

  it("degrades honestly when sha/time are absent (dev tree)", async () => {
    const m = await mount(
      modal({
        status: status({
          memory: { running: false, port: null, entries: null, vectors: null },
          build: { version: "0.1.0", sha: null, time: null },
        }),
      }),
    );
    assert.ok(
      m.text().includes("dev tree"),
      `dev tree without sha must say so, got: ${m.text()}`,
    );
    m.unmount();
  });

  it("says unknown when status is null", async () => {
    const m = await mount(modal({ status: null }));
    assert.ok(
      m.text().includes("unknown"),
      `null status must degrade, got: ${m.text()}`,
    );
    m.unmount();
  });

  it("saves the picked update channel and runs a check", async () => {
    const patches: Partial<AppSettings>[] = [];
    let checks = 0;
    const m = await mount(
      modal({
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          mcpServers: [],
          defaultWorktree: false,
          updateChannel: null,
        },
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            mcpServers: [],
            defaultWorktree: false,
            updateChannel: patch.updateChannel ?? null,
          };
        },
        onCheckUpdate: async () => {
          checks += 1;
        },
      }),
    );
    const select = m.query("[data-update-channel]") as HTMLSelectElement;
    assert.ok(select, "channel select must render");
    await m.change(select, "nightly");
    assert.deepEqual(patches, [{ updateChannel: "nightly" }]);
    assert.equal(checks, 1, "changing channel must re-check");

    await m.click(m.query("[data-check-update]"));
    assert.equal(checks, 2, "check button must call onCheckUpdate");
    m.unmount();
  });
});

describe("SettingsModal PR size cap (#402)", () => {
  it("saves a positive integer cap", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "git",
        settings: { dailyBudgetUsd: null, autoSettleAfterDays: 3, prDiffCapLines: 400 },
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            prDiffCapLines: patch.prDiffCapLines ?? null,
          };
        },
      }),
    );
    const input = m.query("#pr-diff-cap");
    assert.ok(input, "PR cap input must render");
    await m.type(input, "250");
    await m.click(m.byText("Save"));
    assert.equal(patches.length, 1, "save must call onSaveSettings once");
    assert.equal(patches[0].prDiffCapLines, 250);
    m.unmount();
  });

  it("empty input saves null (cap disabled)", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "git",
        settings: { dailyBudgetUsd: null, autoSettleAfterDays: 3, prDiffCapLines: 400 },
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            prDiffCapLines: patch.prDiffCapLines ?? null,
          };
        },
      }),
    );
    const input = m.query("#pr-diff-cap") as HTMLInputElement;
    assert.equal(input.value, "400", "prefilled from settings");
    await m.type(input, "");
    await m.click(m.byText("Save"));
    assert.equal(patches[0].prDiffCapLines, null);
    m.unmount();
  });
});

describe("SettingsModal daily budget", () => {
  it("accepts a valid number and reports the saved value", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "spending",
        settings: { dailyBudgetUsd: null , autoSettleAfterDays: 3 },
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: patch.dailyBudgetUsd ?? null,
            autoSettleAfterDays: patch.autoSettleAfterDays ?? 3,
          };
        },
      }),
    );
    const input = m.query("#daily-budget");
    assert.ok(input, "budget input must render");
    await m.type(input, "12.5");
    await m.click(m.byText("Save"));
    assert.equal(patches.length, 1, "save must call onSaveSettings once");
    assert.equal(patches[0].dailyBudgetUsd, 12.5);
    m.unmount();
  });

  it("rejects invalid input visibly (zero, negative, non-numeric)", async () => {
    // The modal passes the raw number through; the backend rejects with a
    // validation string. The load-bearing UI behaviour is that the rejection
    // reaches the user as role=alert, not a silent no-op.
    // Empty is ALLOWED (null = no cap). Zero/negative are not.
    async function assertRejected(value: string, label: string) {
      const m = await mount(
        modal({
          initialPane: "spending",
          settings: { dailyBudgetUsd: 5 , autoSettleAfterDays: 3 },
          onSaveSettings: async (patch) => {
            const n = patch.dailyBudgetUsd;
            if (n == null || !Number.isFinite(n) || n <= 0) {
              throw new Error(
                "Daily budget must be a positive number or null",
              );
            }
            return { dailyBudgetUsd: n , autoSettleAfterDays: 3 };
          },
        }),
      );
      const input = m.query("#daily-budget");
      await m.type(input, value);
      await m.click(m.byText("Save"));
      assert.ok(
        m.text().includes("Daily budget must be a positive number"),
        `${label}: expected validation error, got: ${m.text().slice(-120)}`,
      );
      assert.ok(
        m.query('[role="alert"]'),
        `${label}: error must use role=alert`,
      );
      m.unmount();
    }
    await assertRejected("0", "zero");
    await assertRejected("-3", "negative");

    // Non-numeric: the field is type=number, so pure letters never become
    // budgetText. Prove a backend NaN rejection still paints role=alert when
    // onSaveSettings refuses a non-finite value (the real electron path).
    {
      const m = await mount(
        modal({
          initialPane: "spending",
          settings: { dailyBudgetUsd: 5 , autoSettleAfterDays: 3 },
          onSaveSettings: async () => {
            throw new Error(
              "Daily budget must be a positive number or null",
            );
          },
        }),
      );
      // Any save click with a rejecting backend must surface the string.
      await m.click(m.byText("Save"));
      assert.ok(
        m.query('[role="alert"]'),
        "a rejected save must surface role=alert",
      );
      assert.ok(
        m.text().includes("Daily budget must be a positive number"),
        "non-finite / invalid budget must show the backend validation string",
      );
      m.unmount();
    }
  });

  it("closing does not save", async () => {
    let saves = 0;
    let closes = 0;
    const m = await mount(
      modal({
        initialPane: "spending",
        settings: { dailyBudgetUsd: 5 , autoSettleAfterDays: 3 },
        onSaveSettings: async (patch) => {
          saves += 1;
          return {
            dailyBudgetUsd: patch.dailyBudgetUsd ?? null,
            autoSettleAfterDays: patch.autoSettleAfterDays ?? 3,
          };
        },
        onClose: () => {
          closes += 1;
        },
      }),
    );
    const input = m.query("#daily-budget");
    await m.type(input, "99");
    await m.click(m.query('button[aria-label="Close"]'));
    assert.equal(closes, 1, "close must fire");
    assert.equal(saves, 0, "closing must not save a draft budget");
    m.unmount();
  });
});


describe("SettingsModal per-orchestration budget (issue #67)", () => {
  /** Save buttons in DOM order on the Spending pane: daily, then orchestration. */
  function saveButtons(m: any) {
    return m
      .queryAll("button")
      .filter((b: HTMLElement) => (b.textContent || "").includes("Save"));
  }

  it("accepts a valid number and saves orchestrationBudgetUsd", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "spending",
        settings: { dailyBudgetUsd: null, autoSettleAfterDays: 3 },
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: patch.dailyBudgetUsd ?? null,
            orchestrationBudgetUsd: patch.orchestrationBudgetUsd ?? null,
            autoSettleAfterDays: 3,
          };
        },
      }),
    );
    const input = m.query("#orch-budget");
    assert.ok(input, "per-orchestration budget input must render");
    assert.ok(
      m.text().includes("Per-orchestration budget"),
      "label must match the brief",
    );
    await m.type(input, "4.5");
    const saves = saveButtons(m);
    assert.ok(saves.length >= 2, "daily + orchestration Save buttons");
    await m.click(saves[1]);
    assert.equal(patches.length, 1, "save must call onSaveSettings once");
    assert.equal(patches[0].orchestrationBudgetUsd, 4.5);
    m.unmount();
  });

  it("pre-fills from settings and clearing saves null (no ceiling)", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "spending",
        settings: {
          dailyBudgetUsd: null,
          orchestrationBudgetUsd: 7,
          autoSettleAfterDays: 3,
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            orchestrationBudgetUsd:
              patch.orchestrationBudgetUsd === undefined
                ? null
                : patch.orchestrationBudgetUsd,
            autoSettleAfterDays: 3,
          };
        },
      }),
    );
    const input = m.query("#orch-budget") as HTMLInputElement;
    assert.equal(input.value, "7", "existing ceiling must pre-fill");
    await m.type(input, "");
    await m.click(saveButtons(m)[1]);
    assert.equal(patches[0].orchestrationBudgetUsd, null);
    m.unmount();
  });

  it("surfaces the backend rejection with role=alert", async () => {
    const m = await mount(
      modal({
        initialPane: "spending",
        settings: { dailyBudgetUsd: null, autoSettleAfterDays: 3 },
        onSaveSettings: async (patch) => {
          const n = patch.orchestrationBudgetUsd;
          if (n != null && (!Number.isFinite(n) || n <= 0)) {
            throw new Error(
              "Orchestration budget must be a positive number or null",
            );
          }
          return {
            dailyBudgetUsd: null,
            orchestrationBudgetUsd: n ?? null,
            autoSettleAfterDays: 3,
          };
        },
      }),
    );
    await m.type(m.query("#orch-budget"), "0");
    await m.click(saveButtons(m)[1]);
    assert.ok(m.query('[role="alert"]'), "validation must use role=alert");
    assert.ok(
      m.text().includes("Orchestration budget must be a positive number"),
      `got: ${m.text().slice(-160)}`,
    );
    m.unmount();
  });
});

describe("SettingsModal auto-settle window", () => {
  it("sets a positive day count and reports it", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "threads",
        settings: { dailyBudgetUsd: null, autoSettleAfterDays: 3 },
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: patch.dailyBudgetUsd ?? null,
            autoSettleAfterDays:
              patch.autoSettleAfterDays === undefined
                ? 3
                : patch.autoSettleAfterDays,
          };
        },
      }),
    );
    const input = m.query("#auto-settle-days");
    assert.ok(input, "auto-settle input must render");
    assert.ok(
      m.text().includes("Auto-settle quiet threads after"),
      "label must match the brief",
    );
    await m.type(input, "7");
    const saves = m
      .queryAll("button")
      .filter((b) => (b.textContent || "").includes("Save"));
    assert.ok(saves.length >= 1, "settle row has Save");
    await m.click(saves[saves.length - 1]!);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].autoSettleAfterDays, 7);
    m.unmount();
  });

  it("clearing the field saves null (Never)", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "threads",
        settings: { dailyBudgetUsd: null, autoSettleAfterDays: 3 },
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays:
              patch.autoSettleAfterDays === undefined
                ? null
                : patch.autoSettleAfterDays,
          };
        },
      }),
    );
    const input = m.query("#auto-settle-days") as HTMLInputElement;
    await m.type(input, "");
    const saves = m
      .queryAll("button")
      .filter((b) => (b.textContent || "").includes("Save"));
    await m.click(saves[saves.length - 1]!);
    assert.equal(patches[0].autoSettleAfterDays, null);
    m.unmount();
  });

  it("toggles settle-on-merge immediately", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "threads",
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          autoSettleOnMerge: true,
        },
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            autoSettleOnMerge: patch.autoSettleOnMerge ?? true,
          };
        },
      }),
    );
    const box = m.query("[data-auto-settle-on-merge]") as HTMLInputElement;
    assert.ok(box, "settle-on-merge checkbox");
    assert.equal(box.checked, true);
    assert.ok(
      m.text().includes("Settle a thread when its pull request merges"),
    );
    await m.click(box);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].autoSettleOnMerge, false);
    m.unmount();
  });

  it("rejects invalid settle days with role=alert (mirrors budget)", async () => {
    const m = await mount(
      modal({
        initialPane: "threads",
        settings: { dailyBudgetUsd: null, autoSettleAfterDays: 3 },
        onSaveSettings: async (patch) => {
          const n = patch.autoSettleAfterDays;
          if (n == null) return { dailyBudgetUsd: null, autoSettleAfterDays: null };
          if (
            typeof n !== "number" ||
            !Number.isInteger(n) ||
            !(n > 0)
          ) {
            throw new Error(
              `Auto-settle days must be a positive integer or null (got ${n})`,
            );
          }
          return { dailyBudgetUsd: null, autoSettleAfterDays: n };
        },
      }),
    );
    const input = m.query("#auto-settle-days");
    await m.type(input, "0");
    const saves = m
      .queryAll("button")
      .filter((b) => (b.textContent || "").includes("Save"));
    await m.click(saves[saves.length - 1]!);
    assert.ok(m.query('[role="alert"]'), "validation must use role=alert");
    assert.ok(
      m.text().includes("Auto-settle days must be a positive integer"),
      `got: ${m.text().slice(-160)}`,
    );
    m.unmount();
  });
});

describe("SettingsModal structure", () => {
  it("never nests interactive elements", async () => {
    const m = await mount(modal());
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
        `interactive element nested inside <${el.tagName.toLowerCase()}>`,
      );
    }
    m.unmount();
  });

  it("renders nothing when closed", async () => {
    const m = await mount(
      <SettingsModal
        open={false}
        onClose={() => {}}
        settings={{ dailyBudgetUsd: 1 , autoSettleAfterDays: 3 }}
        status={status()}
        onSaveSettings={async (p) => ({
          dailyBudgetUsd: p.dailyBudgetUsd ?? null,
          autoSettleAfterDays: p.autoSettleAfterDays ?? 3,
        })}
      />,
    );
    assert.equal(m.html().trim(), "", "closed modal must render null");
    m.unmount();
  });
});

describe("SettingsModal OpenTelemetry (issue #280)", () => {
  it("renders the export fields and says empty means off", async () => {
    const m = await mount(
      modal({
        initialPane: "advanced",
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          otel: { endpoint: null, headers: {}, claudeMetrics: false },
        } as AppSettings,
      }),
    );
    assert.ok(m.query("[data-otel-settings]"), "otel section");
    assert.ok(m.query("[data-otel-endpoint]"), "endpoint input");
    assert.ok(m.query("[data-otel-headers]"), "headers textarea");
    assert.ok(m.query("[data-otel-claude-metrics]"), "claude metrics toggle");
    assert.ok(
      m.text().includes("Empty turns export off"),
      "copy must say empty endpoint turns export off",
    );
    assert.ok(
      m.text().includes("Does nothing unless an endpoint is set"),
      "copy must say the Claude toggle needs an endpoint",
    );
    m.unmount();
  });

  it("saves a URL endpoint and a null when cleared", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "advanced",
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          otel: { endpoint: null, headers: {}, claudeMetrics: false },
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            otel: patch.otel ?? {
              endpoint: null,
              headers: {},
              claudeMetrics: false,
            },
          } as AppSettings;
        },
      }),
    );
    const input = m.query("[data-otel-endpoint]");
    assert.ok(input, "endpoint input");
    await m.type(input, "http://127.0.0.1:4318");
    await m.press(input, "Enter");
    assert.equal(patches.length, 1);
    assert.equal(patches[0].otel?.endpoint, "http://127.0.0.1:4318");
    assert.equal(patches[0].otel?.claudeMetrics, false);

    await m.type(input, "");
    await m.press(input, "Enter");
    assert.equal(patches[1].otel?.endpoint, null);
    m.unmount();
  });

  it("surfaces a rejected endpoint with role=alert", async () => {
    const m = await mount(
      modal({
        initialPane: "advanced",
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          otel: { endpoint: null, headers: {}, claudeMetrics: false },
        } as AppSettings,
        onSaveSettings: async () => {
          throw new Error("OTLP endpoint must be an http(s) URL or null");
        },
      }),
    );
    const input = m.query("[data-otel-endpoint]");
    await m.type(input, "not-a-url");
    await m.press(input, "Enter");
    assert.ok(m.query('[role="alert"]'), "validation must use role=alert");
    assert.ok(
      m.text().includes("OTLP endpoint must be an http(s) URL or null"),
      `got: ${m.text().slice(-160)}`,
    );
    m.unmount();
  });

  it("parses one key: value per line into headers", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "advanced",
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          otel: { endpoint: "http://127.0.0.1:4318", headers: {}, claudeMetrics: false },
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            otel: patch.otel ?? {
              endpoint: "http://127.0.0.1:4318",
              headers: {},
              claudeMetrics: false,
            },
          } as AppSettings;
        },
      }),
    );
    const area = m.query("[data-otel-headers]");
    assert.ok(area, "headers textarea");
    await m.type(area, "Authorization: Bearer secret\nx-foo: bar");
    // Checkbox persist sends the whole otel draft, including parsed headers.
    await m.click(m.query("[data-otel-claude-metrics]"));
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].otel?.headers, {
      Authorization: "Bearer secret",
      "x-foo": "bar",
    });
    m.unmount();
  });

  it("saves the Claude metrics toggle immediately", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "advanced",
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          otel: { endpoint: "http://127.0.0.1:4318", headers: {}, claudeMetrics: false },
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            otel: patch.otel ?? {
              endpoint: "http://127.0.0.1:4318",
              headers: {},
              claudeMetrics: false,
            },
          } as AppSettings;
        },
      }),
    );
    const box = m.query("[data-otel-claude-metrics]") as HTMLInputElement;
    assert.ok(box, "claude metrics checkbox");
    assert.equal(box.checked, false);
    await m.click(box);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].otel?.claudeMetrics, true);
    assert.equal(patches[0].otel?.endpoint, "http://127.0.0.1:4318");
    m.unmount();
  });
});

describe("SettingsModal webhook (issue #167)", () => {
  it("renders the URL and event toggles on General", async () => {
    const m = await mount(
      modal({
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          webhook: {
            url: "https://ntfy.sh/solenta",
            onDone: true,
            onFailed: true,
            onWaiting: false,
          },
        } as AppSettings,
      }),
    );
    assert.ok(m.query("[data-webhook-settings]"), "webhook section");
    const input = m.query("[data-webhook-url]") as HTMLInputElement;
    assert.ok(input, "url input");
    assert.equal(input.value, "https://ntfy.sh/solenta");
    assert.equal(
      (m.query("[data-webhook-on-done]") as HTMLInputElement).checked,
      true,
    );
    assert.equal(
      (m.query("[data-webhook-on-waiting]") as HTMLInputElement).checked,
      false,
    );
    assert.ok(
      m.text().includes("Fires even while this window is focused"),
      "copy must say webhooks fire while focused",
    );
    m.unmount();
  });

  it("saves a URL on Enter and a cleared URL as null", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          webhook: {
            url: null,
            onDone: true,
            onFailed: true,
            onWaiting: true,
          },
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            webhook: patch.webhook ?? {
              url: null,
              onDone: true,
              onFailed: true,
              onWaiting: true,
            },
          } as AppSettings;
        },
      }),
    );
    const input = m.query("[data-webhook-url]");
    assert.ok(input, "url input");
    await m.type(input, "https://hooks.slack.com/services/T/B/X");
    await m.press(input, "Enter");
    assert.equal(patches.length, 1);
    assert.equal(
      patches[0].webhook?.url,
      "https://hooks.slack.com/services/T/B/X",
    );

    await m.type(input, "");
    await m.press(input, "Enter");
    assert.equal(patches[1].webhook?.url, null);
    m.unmount();
  });

  it("saves an event toggle without dropping the URL", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          webhook: {
            url: "https://example.com/hook",
            onDone: true,
            onFailed: true,
            onWaiting: true,
          },
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            webhook: patch.webhook ?? {
              url: "https://example.com/hook",
              onDone: true,
              onFailed: true,
              onWaiting: true,
            },
          } as AppSettings;
        },
      }),
    );
    await m.click(m.query("[data-webhook-on-waiting]"));
    assert.equal(patches.length, 1);
    assert.equal(patches[0].webhook?.onWaiting, false);
    assert.equal(patches[0].webhook?.url, "https://example.com/hook");
    m.unmount();
  });

  it("Send test reports the HTTP status, and the failure reason on a bad URL", async () => {
    let calls = 0;
    const results: WebhookTestResult[] = [
      { ok: true, status: 204 },
      { ok: false, status: 404, error: "HTTP 404" },
    ];
    const m = await mount(
      modal({
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          webhook: {
            url: "https://example.com/hook",
            onDone: true,
            onFailed: true,
            onWaiting: true,
          },
        } as AppSettings,
        onTestWebhook: async () => results[calls++],
      }),
    );
    const button = m.query("[data-webhook-test]") as HTMLButtonElement;
    assert.ok(button, "Send test button");

    await m.click(button);
    assert.equal(calls, 1);
    assert.equal(
      m.query("[data-webhook-test-result]")?.getAttribute(
        "data-webhook-test-result",
      ),
      "ok",
    );
    assert.ok(m.text().includes("Sent (HTTP 204)"), m.text());

    // A revoked URL is the whole point of the button: the reason must show.
    await m.click(button);
    assert.equal(calls, 2);
    assert.equal(
      m.query("[data-webhook-test-result]")?.getAttribute(
        "data-webhook-test-result",
      ),
      "fail",
    );
    assert.ok(m.text().includes("HTTP 404"), m.text());
    m.unmount();
  });

  it("saves a freshly typed URL before testing it", async () => {
    const patches: Partial<AppSettings>[] = [];
    let tested = 0;
    const m = await mount(
      modal({
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          webhook: {
            url: null,
            onDone: true,
            onFailed: true,
            onWaiting: true,
          },
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            webhook: patch.webhook ?? {
              url: null,
              onDone: true,
              onFailed: true,
              onWaiting: true,
            },
          } as AppSettings;
        },
        onTestWebhook: async () => {
          // The main process POSTs to the SAVED url; testing before the save
          // lands would probe the old (here: absent) one.
          assert.equal(patches.length, 1, "URL must be saved before the POST");
          tested += 1;
          return { ok: true, status: 200 };
        },
      }),
    );
    await m.type(m.query("[data-webhook-url]"), "https://ntfy.sh/solenta");
    await m.click(m.query("[data-webhook-test]"));
    assert.equal(tested, 1);
    assert.equal(patches[0].webhook?.url, "https://ntfy.sh/solenta");
    m.unmount();
  });

  it("Find a setting matches slack on General", async () => {
    const m = await mount(modal());
    const search = m.query("[data-settings-search]") as HTMLInputElement;
    await m.type(search, "slack");
    assert.ok(
      m.query('[data-settings-nav="general"]'),
      "General matches slack",
    );
    m.unmount();
  });
});

describe("SettingsModal Appearance (#652)", () => {
  it("renders UI scale on General and saves on change", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          uiScale: 1,
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            uiScale: patch.uiScale ?? 1,
          } as AppSettings;
        },
      }),
    );
    // The redesigned modal panes settings, so Appearance and Budget no longer
    // share a scroll column: assert the pane, not the vertical order.
    assert.equal(
      m.query("[data-settings-pane]")?.getAttribute("data-settings-pane"),
      "general",
    );
    const slider = m.query("[data-ui-scale]") as HTMLInputElement;
    assert.ok(slider, "UI scale slider");
    assert.equal(slider.value, "1");
    assert.equal(m.query("[data-ui-scale-value]")!.textContent, "100%");
    await m.type(slider, "1.3");
    assert.ok(patches.length >= 1, "changing the slider saves immediately");
    assert.equal(patches[0].uiScale, 1.3);
    assert.equal(m.query("[data-ui-scale-value]")!.textContent, "130%");
    m.unmount();
  });
});

describe("SettingsModal Linear API key (issue #169)", () => {
  it("saves the key from the Git pane without sending budget fields", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "git",
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          linearApiKey: null,
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            linearApiKey: patch.linearApiKey ?? null,
          } as AppSettings;
        },
      }),
    );
    const input = m.query("[data-linear-api-key]") as HTMLInputElement | null;
    assert.ok(input, "Linear API key field on Git pane");
    await m.type(input!, "lin_api_test");
    const save = m.query("[data-linear-api-key-save]");
    assert.ok(save, "Linear save button");
    assert.equal(save!.textContent, "Save key");
    await m.click(save!);
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0], { linearApiKey: "lin_api_test" });
    m.unmount();
  });
});

describe("SettingsModal quota-wait auto-resume (#462)", () => {
  it("saves the continue-at-usage-limit toggle", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "threads",
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          quotaWaitAutoResume: true,
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            quotaWaitAutoResume: patch.quotaWaitAutoResume !== false,
          } as AppSettings;
        },
      }),
    );
    const box = m.query("[data-quota-wait-auto-resume]") as HTMLInputElement;
    assert.ok(box, "quota-wait checkbox");
    assert.equal(box.checked, true);
    await m.click(box);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].quotaWaitAutoResume, false);
    m.unmount();
  });
});

describe("SettingsModal worker model pool (issue #467)", () => {
  const namedPool: SubagentPool = {
    defaultAlias: "fast",
    force: false,
    entries: [
      {
        alias: "fast",
        provider: "kimi",
        model: "kimi-code/kimi-for-coding-highspeed",
        description: "Fast and cheap. Good for small edits.",
      },
    ],
  };

  it("shows the empty state and the add control", async () => {
    const m = await mount(modal({ initialPane: "agents", providers: [KIMI] }));
    assert.ok(m.query("[data-subagent-pool]"), "pool section must render");
    assert.ok(
      m.text().includes("Workers inherit the lead"),
      `empty copy, got: ${m.text()}`,
    );
    assert.ok(m.query("[data-add-pool-entry]"), "add candidate");
    m.unmount();
  });

  it("lists a saved candidate and can pin the default", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "agents",
        providers: [KIMI],
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          subagentPool: namedPool,
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            subagentPool: patch.subagentPool ?? namedPool,
          } as AppSettings;
        },
      }),
    );
    assert.ok(m.query('[data-pool-entry="fast"]'), "fast entry");
    assert.ok(m.text().includes("fast (default)"));
    assert.ok(m.text().includes("Fast and cheap"));
    const box = m.query("[data-pool-force]") as HTMLInputElement;
    assert.ok(box, "force checkbox");
    assert.equal(box.checked, false);
    await m.click(box);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].subagentPool?.force, true);
    assert.equal(patches[0].subagentPool?.defaultAlias, "fast");
    m.unmount();
  });

  it("saves a new candidate from the form", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "agents",
        providers: [KIMI],
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          subagentPool: {
            defaultAlias: null,
            force: false,
            entries: [],
          },
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            subagentPool: patch.subagentPool,
          } as AppSettings;
        },
      }),
    );
    await m.click(m.query("[data-add-pool-entry]"));
    await m.type(m.query("#pool-alias"), "fast");
    await m.type(
      m.query("#pool-description"),
      "Fast and cheap. Good for small edits.",
    );
    await m.click(m.query("[data-submit-pool]"));
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].subagentPool, {
      defaultAlias: "fast",
      force: false,
      entries: [
        {
          alias: "fast",
          provider: "kimi",
          model: null,
          description: "Fast and cheap. Good for small edits.",
        },
      ],
    });
    m.unmount();
  });
});

describe("SettingsModal panes", () => {
  it("opens on General and switches when a nav item is clicked", async () => {
    const m = await mount(modal());
    assert.equal(
      m.query("[data-settings-pane]")?.getAttribute("data-settings-pane"),
      "general",
    );
    assert.ok(m.text().includes("0.1.0"), "build version on General");
    assert.equal(m.query("#daily-budget"), null, "budget is not on General");

    await m.click(m.query('[data-settings-nav="spending"]'));
    assert.ok(m.query("#daily-budget"), "Spending shows the daily budget");
    assert.ok(m.query("[data-spend-today]"), "spend today is on Spending");
    assert.equal(m.query("[data-otel-settings]"), null);
    m.unmount();
  });

  it("filters the sidebar from Find a setting", async () => {
    const m = await mount(modal());
    const search = m.query("[data-settings-search]") as HTMLInputElement;
    assert.ok(search, "search field");
    await m.type(search, "otel");
    assert.ok(m.query('[data-settings-nav="advanced"]'), "Advanced matches otel");
    assert.equal(
      m.query('[data-settings-nav="spending"]'),
      null,
      "Spending is hidden for an otel query",
    );
    m.unmount();
  });
});

describe("SettingsModal Appearance (#651)", () => {
  it("puts the theme control on General and saves the pick", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          theme: "dark",
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            theme: "light",
          } as AppSettings;
        },
      }),
    );
    // The redesigned modal panes settings, so Appearance and Budget no longer
    // share a scroll column: assert the pane, not the vertical order.
    assert.equal(
      m.query("[data-settings-pane]")?.getAttribute("data-settings-pane"),
      "general",
    );
    const select = m.query("[data-theme-setting]") as HTMLSelectElement;
    assert.ok(select, "theme select must render");
    assert.equal(select.value, "dark");
    await m.change(select, "light");
    assert.deepEqual(patches, [{ theme: "light" }]);
    m.unmount();
  });

  it("defaults the control to dark when settings.theme is absent", async () => {
    const m = await mount(
      modal({ settings: { dailyBudgetUsd: 5, autoSettleAfterDays: 3 } }),
    );
    const select = m.query("[data-theme-setting]") as HTMLSelectElement;
    assert.ok(select, "theme select must render");
    assert.equal(select.value, "dark");
    m.unmount();
  });
});

describe("SettingsModal agent profile permission modes (issue #177)", () => {
  const grok: ProviderInfo = {
    id: "grok",
    name: "Grok",
    available: true,
    supportsResume: true,
    models: ["grok-4"],
    modelInfo: [
      {
        id: "grok-4",
        label: "Grok 4",
        description: "xAI",
        vendor: "xAI",
      },
    ],
    efforts: [],
    permissionModes: ["plan", "bypassPermissions"],
  };

  it("opens a leftover Grok Ask first profile on Full access, not the first listed mode", async () => {
    const m = await mount(
      modal({
        initialPane: "agents",
        providers: [grok],
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          agentProfiles: [
            {
              id: "p1",
              name: "Grok leftover",
              provider: "grok",
              model: "grok-4",
              reasoningEffort: null,
              permissionMode: "default",
            },
          ],
        } as AppSettings,
      }),
    );
    const edit = Array.from(m.queryAll("button")).find(
      (b) => (b.textContent || "").trim() === "Edit",
    );
    assert.ok(edit, "Edit must open the leftover profile");
    await m.click(edit);
    const select = m.query("#profile-permission") as HTMLSelectElement | null;
    assert.ok(select, "permission select");
    assert.equal(select.value, "bypassPermissions");
    assert.deepEqual(
      Array.from(select.options).map((o) => o.textContent),
      ["Plan mode", "Full access"],
    );
    m.unmount();
  });

  it("a new profile on a Grok-only catalogue starts on Full access", async () => {
    const m = await mount(
      modal({
        initialPane: "agents",
        providers: [grok],
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          agentProfiles: [],
        } as AppSettings,
      }),
    );
    const add = m.query("[data-add-profile]");
    assert.ok(add, "Add profile");
    await m.click(add);
    const select = m.query("#profile-permission") as HTMLSelectElement | null;
    assert.ok(select);
    assert.equal(select.value, "bypassPermissions");
    m.unmount();
  });
});

describe("SettingsModal default orchestrator profile (#725)", () => {
  const scout = {
    id: "p-scout",
    name: "Cheap scout",
    provider: "kimi",
    model: "kimi-code/kimi-for-coding-highspeed",
    reasoningEffort: null,
    permissionMode: "default" as const,
  };

  it("shows a disabled default field until a profile exists", async () => {
    const m = await mount(
      modal({ initialPane: "agents", providers: [KIMI] }),
    );
    const select = m.query(
      "[data-orch-default-profile]",
    ) as HTMLSelectElement | null;
    assert.ok(select, "default orchestrator field");
    assert.equal(select.disabled, true);
    assert.ok(
      m.text().includes("Add a profile above"),
      `empty copy, got: ${m.text()}`,
    );
    m.unmount();
  });

  it("pins a saved profile as the default orchestrator", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "agents",
        providers: [KIMI],
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          agentProfiles: [scout],
          defaultOrchestratorProfileId: null,
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            agentProfiles: [scout],
            defaultOrchestratorProfileId:
              patch.defaultOrchestratorProfileId ?? null,
          } as AppSettings;
        },
      }),
    );
    const select = m.query(
      "[data-orch-default-profile]",
    ) as HTMLSelectElement | null;
    assert.ok(select, "default orchestrator field");
    assert.equal(select.value, "");
    await m.change(select, "p-scout");
    assert.equal(patches.length, 1);
    assert.equal(patches[0].defaultOrchestratorProfileId, "p-scout");
    m.unmount();
  });

  it("clears the default when its profile is deleted", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "agents",
        providers: [KIMI],
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          agentProfiles: [scout],
          defaultOrchestratorProfileId: "p-scout",
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            agentProfiles: patch.agentProfiles ?? [scout],
            defaultOrchestratorProfileId:
              patch.defaultOrchestratorProfileId === undefined
                ? "p-scout"
                : patch.defaultOrchestratorProfileId,
          } as AppSettings;
        },
      }),
    );
    const del = Array.from(m.queryAll("button")).find(
      (b) => (b.textContent || "").trim() === "Delete",
    );
    assert.ok(del, "Delete");
    await m.click(del);
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].agentProfiles, []);
    assert.equal(patches[0].defaultOrchestratorProfileId, null);
    m.unmount();
  });
});
