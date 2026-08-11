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
import { SettingsModal } from "../src/components/SettingsModal";
import type { AppSettings, AppStatus } from "../src/shared/ipc";

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

interface Stubs {
  settings?: AppSettings | null;
  status?: AppStatus | null;
  onSaveSettings?: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  onClose?: () => void;
}

function modal(stubs: Stubs = {}) {
  return (
    <SettingsModal
      open
      onClose={stubs.onClose ?? (() => {})}
      settings={stubs.settings ?? { dailyBudgetUsd: 5, autoSettleAfterDays: 3 }}
      status={stubs.status === undefined ? status() : stubs.status}
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
      modal({ status: status({ memory: { entries: 42, vectors: 17 } }) }),
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
});

describe("SettingsModal daily budget", () => {
  it("accepts a valid number and reports the saved value", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
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


describe("SettingsModal auto-settle window", () => {
  it("sets a positive day count and reports it", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
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
    // Second Save is the settle row's (order: budget Save, settle Save).
    const saves = m
      .queryAll("button")
      .filter((b) => (b.textContent || "").includes("Save"));
    assert.ok(saves.length >= 2, "budget + settle each have Save");
    await m.click(saves[saves.length - 1]!);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].autoSettleAfterDays, 7);
    m.unmount();
  });

  it("clearing the field saves null (Never)", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
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

  it("rejects invalid settle days with role=alert (mirrors budget)", async () => {
    const m = await mount(
      modal({
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
