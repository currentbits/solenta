import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { createFakeCoder } from "./support/fakeCoder.ts";
import { CliProxyUsageEditor } from "../src/components/settings/CliProxyUsageEditor";
import { ProvidersPane } from "../src/components/settings/ProvidersPane";
import { ProviderQuota } from "../src/components/ProviderQuota";
import type { AppSettings, ProviderUsage } from "../src/shared/ipc";

describe("CLIProxy usage setup", () => {
  it("is reachable in Providers and saves an opt-in connection with a masked key", async () => {
    const settings = await createFakeCoder().api.settings.get();
    const patches: Partial<AppSettings>[] = [];
    const errors: (string | null)[] = [];
    const m = await mount(<ProvidersPane settings={settings} providers={[]} saving={false} setError={(error) => errors.push(error)} onSaveSettings={async (patch) => { patches.push(patch); }} />);
    assert.ok(m.query("[data-cliproxy-usage-settings]"));
    await m.click(m.query('[data-cliproxy-usage-settings] input[type="checkbox"]'));
    await m.type(m.query('[data-cliproxy-usage-settings] input[type="url"]'), "http://localhost:8317/management.html#/quota");
    await m.type(m.query('[data-cliproxy-usage-settings] input[type="password"]'), "management-fixture");
    await m.click(m.byText("Save CLIProxy usage"));
    assert.deepEqual(patches, [{ cliProxyUsage: { enabled: true, managementUrl: "http://localhost:8317/management.html#/quota", managementKey: "management-fixture" } }]);
    assert.equal((m.query('input[type="password"]') as HTMLInputElement)?.value, "");
    assert.match(m.text(), /Open Usage › Limits and refresh/);
    assert.deepEqual(errors, [null]);
    m.unmount();
  });

  it("preserves the saved key through edits and supports explicitly clearing it", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(<CliProxyUsageEditor settings={{ enabled: true, managementUrl: "http://localhost:8317/v0/management", hasManagementKey: true }} disabled={false} setError={() => {}} onSave={async (patch) => { patches.push(patch); }} />);
    const password = m.query('input[type="password"]') as HTMLInputElement;
    assert.equal(password.value, "");
    assert.match(password.placeholder, /Saved key/);
    await m.click(m.byText("Save CLIProxy usage"));
    assert.ok(!Object.hasOwn(patches[0].cliProxyUsage!, "managementKey"));
    await m.click(m.byText("Clear management key"));
    assert.equal(patches[1].cliProxyUsage?.managementKey, null);
    m.unmount();
  });

  it("shows save failures without claiming settings were saved", async () => {
    const errors: (string | null)[] = [];
    const m = await mount(<CliProxyUsageEditor disabled={false} setError={(error) => errors.push(error)} onSave={async () => { throw new Error("Use HTTPS for a remote CLIProxy server"); }} />);
    await m.click(m.byText("Save CLIProxy usage"));
    assert.equal(errors.at(-1), "Use HTTPS for a remote CLIProxy server");
    assert.ok(!m.query('[role="status"]'));
    m.unmount();
  });

  it("renders independent CLIProxy accounts alongside native quotas and honest failures", async () => {
    const rows: ProviderUsage[] = [
      { provider: "claude", status: "ok", windows: [{ label: "5-hour", usedPercent: 12, windowSeconds: 18000, resetsAt: null }], fetchedAt: 1000 },
      { provider: "cliproxy:server:work", source: "cliproxy", label: "Claude · CLIProxy · Work", status: "ok", windows: [{ label: "5-hour", usedPercent: 75, windowSeconds: 18000, resetsAt: null }, { label: "weekly", usedPercent: 44, windowSeconds: 604800, resetsAt: null }], fetchedAt: 1000 },
      { provider: "cliproxy:server:personal", source: "cliproxy", label: "Claude · CLIProxy · Personal", status: "unavailable", windows: [], fetchedAt: null, message: "CLIProxy account authorization expired" },
    ];
    const m = await mount(<ProviderQuota loadLimits={async () => rows} activeProvider="claude" now={1000} />);
    await m.flush();
    assert.equal(m.queryAll("[data-provider-quota-row]").length, 3);
    assert.equal(m.queryAll('[data-active="true"]').length, 1);
    assert.equal(m.query('[data-active="true"]')?.getAttribute("data-provider-quota-row"), "claude");
    assert.match(m.text(), /Claude · CLIProxy · Work/);
    assert.match(m.text(), /75% used/);
    assert.match(m.text(), /44% used/);
    const unavailable = m.query('[data-provider-quota-row="cliproxy:server:personal"]');
    assert.match(unavailable?.textContent ?? "", /authorization expired/);
    assert.ok(!unavailable?.textContent?.includes("0%"));
    m.unmount();
  });
});
