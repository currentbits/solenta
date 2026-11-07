import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount, inAct } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder, type FakeCoder } from "./support/fakeCoder.ts";
import { useCoder, type UseCoderResult } from "../src/useCoder";
import App from "../src/App";
import type { AppSettings } from "../src/shared/ipc";

const saved: AppSettings = {
  dailyBudgetUsd: 17,
  orchestrationBudgetUsd: 9,
  autoSettleAfterDays: 5,
  prDiffCapLines: 725,
  onboardingSeen: true,
  defaultProvider: "claude",
  providerModels: { claude: { favorites: ["sonnet"], custom: ["my-model"] } },
};

async function install(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
}

async function probe(fake: FakeCoder) {
  await install(fake);
  let current: UseCoderResult | null = null;
  function Probe() {
    current = useCoder();
    return null;
  }
  const m = await mount(<Probe />);
  return { m, state: () => {
    assert.ok(current);
    return current;
  } };
}

function pendingSettings() {
  let resolve = (_settings: AppSettings) => {};
  let reject = (_err: Error) => {};
  const promise = new Promise<AppSettings>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("settings load recovery", () => {
  it("shows a bounded boot error, leaves the app usable, and retries into existing settings", async () => {
    const fail = { "settings.get": new Error(`Settings IPC unavailable\n${"x".repeat(400)}`) };
    const fake = createFakeCoder({ settings: saved, fail });
    await install(fake);
    const m = await mount(<App />);
    assert.match(m.text(), /first thread/);
    assert.match(m.query("[data-settings-load]")?.textContent ?? "", /Could not load settings/);
    assert.match(m.text(), /Settings IPC unavailable/);
    assert.ok(!m.text().includes("x".repeat(301)), "backend diagnostics stay bounded");
    assert.equal(fake.of("settings.set").length, 0);
    assert.equal(m.query("[data-onboarding]"), null, "failed load is not first-run defaults");
    await m.click(m.query('button[title="Settings"]'));
    assert.ok(m.query("[data-settings] [data-settings-load]"), "failure and Retry remain visible in Settings");

    const get = fake.api.settings.get;
    const retry = pendingSettings();
    fake.api.settings.get = () => retry.promise;
    await m.click(m.query("[data-settings-load] button"));
    assert.equal(m.query("[data-settings-load] button")?.textContent, "Retrying…");
    assert.equal(m.query("[data-settings-load] button")?.getAttribute("disabled"), "");
    await inAct(() => retry.reject(new Error("Still unavailable")));
    await m.flush();
    assert.match(m.text(), /Still unavailable/);
    assert.equal(m.query("[data-settings-load] button")?.textContent, "Retry");

    delete fail["settings.get"];
    fake.api.settings.get = get;
    await m.click(m.query("[data-settings-load] button"));
    assert.equal(m.query("[data-settings-load]"), null);
    assert.equal(m.query("[data-onboarding]"), null, "saved onboarding value survives retry");
    await m.click(m.query('[data-settings-nav="spending"]'));
    assert.equal((m.query("#daily-budget") as HTMLInputElement)?.value, "17");
    assert.equal((m.query("#orch-budget") as HTMLInputElement)?.value, "9");
    assert.equal(fake.of("settings.set").length, 0, "recovery never writes defaults");
    m.unmount();
  });

  it("rejects writes while loading and after failure, then saves with the recovered values intact", async () => {
    const fake = createFakeCoder({ settings: saved });
    const get = fake.api.settings.get;
    const initial = pendingSettings();
    fake.api.settings.get = () => initial.promise;
    const { m, state } = await probe(fake);
    assert.equal(state().settingsLoading, true);
    await assert.rejects(state().saveSettings({ dailyBudgetUsd: 1 }), /Retry loading settings/);
    await assert.rejects(state().setStayAwakeMode("always"), /Retry loading settings/);
    assert.equal(fake.of("settings.set").length, 0);
    await inAct(() => initial.reject(new Error("No settings")));
    await m.flush();
    assert.equal(state().settings, null);
    assert.equal(state().settingsError, "No settings");
    assert.equal(state().settingsLoading, false);
    await assert.rejects(state().saveSettings({ providerModels: {} }), /Retry loading settings/);
    assert.equal(fake.of("settings.set").length, 0);
    fake.api.settings.get = get;
    await inAct(() => state().retrySettings());
    assert.equal(state().settingsError, null);
    await inAct(() => state().saveSettings({ prDiffCapLines: 900 }));
    assert.equal(state().settings?.dailyBudgetUsd, 17);
    assert.equal(state().settings?.prDiffCapLines, 900);
    assert.deepEqual(state().settings?.providerModels, saved.providerModels);
    m.unmount();
  });

  it("ignores older boot replies and failed refreshes after a successful retry", async () => {
    const fake = createFakeCoder({ settings: saved });
    const get = fake.api.settings.get;
    const initial = pendingSettings();
    fake.api.settings.get = () => initial.promise;
    const { m, state } = await probe(fake);
    fake.api.settings.get = get;
    await inAct(() => fake.emitBootReady());
    await m.flush();
    assert.equal(state().settings?.dailyBudgetUsd, 17);
    await inAct(() => initial.resolve({ ...saved, dailyBudgetUsd: 0 }));
    await m.flush();
    assert.equal(state().settings?.dailyBudgetUsd, 17);
    fake.api.settings.get = () => Promise.reject(new Error("refresh failed"));
    await inAct(() => fake.emitBootReady());
    await m.flush();
    assert.equal(state().settings?.dailyBudgetUsd, 17);
    assert.equal(state().settingsError, null, "known snapshot remains usable");
    m.unmount();
  });

  it("does not let an in-flight refresh replace a newly saved snapshot", async () => {
    const fake = createFakeCoder({ settings: saved });
    const { m, state } = await probe(fake);
    const refresh = pendingSettings();
    fake.api.settings.get = () => refresh.promise;
    await inAct(() => fake.emitBootReady());
    await inAct(() => state().saveSettings({ dailyBudgetUsd: 25 }));
    await inAct(() => refresh.resolve(saved));
    await m.flush();
    assert.equal(state().settings?.dailyBudgetUsd, 25);
    assert.equal(fake.of("settings.set").length, 1);
    m.unmount();
  });

  it("hydrates settings even when another boot list fails", async () => {
    const fake = createFakeCoder({ settings: saved, fail: { "providers.list": new Error("not ready") } });
    const { m, state } = await probe(fake);
    assert.equal(state().settings?.dailyBudgetUsd, 17);
    assert.equal(state().settingsError, null);
    assert.equal(state().settingsLoading, false);
    m.unmount();
  });

  it("retains the saved snapshot after a failed write and ignores an older save reply", async () => {
    const fail: Record<string, Error> = {};
    const fake = createFakeCoder({ settings: saved, fail });
    const { m, state } = await probe(fake);
    fail["settings.set"] = new Error("Settings could not be saved");
    await assert.rejects(state().saveSettings({ dailyBudgetUsd: 1 }), /could not be saved/);
    assert.equal(state().settings?.dailyBudgetUsd, 17);
    assert.equal(state().settingsError, null, "a write failure keeps the known snapshot available");

    delete fail["settings.set"];
    const set = fake.api.settings.set;
    const older = pendingSettings();
    fake.api.settings.set = async (patch) => {
      const next = await set(patch);
      return patch.dailyBudgetUsd === 20 ? older.promise : next;
    };
    let olderSave: Promise<AppSettings> | undefined;
    await inAct(() => { olderSave = state().saveSettings({ dailyBudgetUsd: 20 }); });
    await inAct(() => state().saveSettings({ dailyBudgetUsd: 25 }));
    await inAct(() => older.resolve({ ...saved, dailyBudgetUsd: 20 }));
    await olderSave;
    await m.flush();
    assert.equal(state().settings?.dailyBudgetUsd, 25);
    assert.deepEqual(state().settings?.providerModels, saved.providerModels);
    m.unmount();
  });
});
