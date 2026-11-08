"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeManagementUrl, normalizeCliProxyUsage, mergeCliProxyUsage, readCliProxyUsage } = require("../providerUsageCliProxy.js");
const { fetchProviderLimits, pickAccountByQuota } = require("../providerUsage.js");
const { knownProviderIds } = require("../providers.js");
const { Store } = require("../store.js");
const { createSecrets } = require("../secrets.js");
const { redactSettings } = require("../mcp.js");
const { instanceAuthProbes } = require("../services.js");

const KEY = "fixture-management-secret";
const NOW = 1_800_000_000_000;
const CONFIG = { enabled: true, managementUrl: "http://localhost:8317/management.html#/quota", managementKey: KEY };
// Management API's api-call envelope wraps the upstream OAuth payload as text.
const USAGE = { five_hour: { utilization: 37, resets_at: "2027-01-15T10:00:00Z" }, seven_day: { utilization: 82.5, resets_at: "2027-01-20T10:00:00Z" }, seven_day_sonnet: null, extra_usage: { is_enabled: false } };
const ACCOUNT = { id: "claude-user@example.test", auth_index: "a1b2c3d4", provider: "claude", name: "claude-user@example.test.json", label: "Work", status: "ready", disabled: false, unavailable: false };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const envelope = (body = USAGE, status = 200) => ({ status_code: status, header: { "Content-Type": ["application/json"] }, body: JSON.stringify(body) });
const fixture = (files = [ACCOUNT], reply = envelope()) => async (url) => json(/\/(?:auth-files|credentials)$/.test(url) ? { files } : reply);

describe("CLIProxy usage URL", () => {
  it("normalizes roots, dashboard routes, trailing slashes and management API URLs", () => {
    for (const input of ["http://localhost:8317", "http://localhost:8317/", "http://localhost:8317/management.html#/quota", "http://localhost:8317/management.html?view=quota#auth", "http://localhost:8317/v8/management/"]) {
      assert.equal(normalizeManagementUrl(input), "http://localhost:8317/v8/management");
    }
    assert.equal(normalizeManagementUrl("https://proxy.example.test/prefix/management.html#/quota"), "https://proxy.example.test/prefix/v8/management");
    assert.equal(normalizeManagementUrl("http://[::1]:8317/management.html"), "http://[::1]:8317/v8/management");
    assert.equal(normalizeManagementUrl("http://localhost:8317/v0/management/"), "http://localhost:8317/v0/management");
    assert.equal(normalizeManagementUrl("https://proxy.example.test/prefix/v8/management/"), "https://proxy.example.test/prefix/v8/management");
  });

  it("rejects credentials, unsupported schemes and unencrypted remote keys", () => {
    for (const input of ["invalid", "file:///tmp/management.html", "https://user:secret@example.test/", "http://proxy.example.test:8317", "http://localhost.evil.test"]) {
      assert.throws(() => normalizeManagementUrl(input));
    }
    assert.equal(normalizeCliProxyUsage({ ...CONFIG, managementUrl: "invalid" }).enabled, false);
  });

  it("preserves omitted keys across API versions and clears them across origins or prefixes", () => {
    const current = normalizeCliProxyUsage(CONFIG);
    const legacy = mergeCliProxyUsage(current, { managementUrl: "http://localhost:8317/v0/management" });
    assert.equal(legacy.managementKey, KEY);
    assert.equal(mergeCliProxyUsage(legacy, { managementUrl: CONFIG.managementUrl }).managementKey, KEY);
    assert.equal(mergeCliProxyUsage(current, { managementUrl: "http://localhost:8317/another-prefix/management.html" }).managementKey, null);
    assert.equal(mergeCliProxyUsage(current, { managementUrl: "https://other.example.test/management.html" }).managementKey, null);
  });
});

describe("CLIProxy Claude quotas", () => {
  it("retains monthly money on the matching proxy account for either response format", async () => {
    for (const budget of [
      { spend: { enabled: true, used: { amount_minor: 4631, currency: "USD", exponent: 2 }, limit: { amount_minor: 50000, currency: "USD", exponent: 2 } } },
      { spend: { enabled: false } },
      { extra_usage: { is_enabled: true, used_credits: 4631, monthly_limit: 50000 } },
      { extra_usage: { is_enabled: false, used_credits: 4631, monthly_limit: 50000 } },
    ]) {
      const rows = await readCliProxyUsage(CONFIG, { nowMs: () => NOW, fetch: async (url, init) => {
        if (url.endsWith("/credentials")) return json({ files: [ACCOUNT, { ...ACCOUNT, auth_index: "personal", label: "Personal" }] });
        return json(envelope(JSON.parse(init.body).auth_index === ACCOUNT.auth_index ? { ...USAGE, ...budget } : USAGE));
      } });
      assert.equal(rows[0].label, "Claude · CLIProxy · Work");
      assert.notEqual(rows[0].provider, rows[1].provider);
      assert.equal(rows[0].status, "ok");
      assert.equal(rows[0].fetchedAt, NOW);
      assert.equal(rows[0].windows.length, 2);
      const enabled = budget.spend?.enabled ?? budget.extra_usage.is_enabled;
      assert.equal(rows[0].monthlySpend.enabled, enabled);
      if (enabled) assert.ok(Math.abs(rows[0].monthlySpend.usedPercent - 9.262) < 1e-9);
      else assert.equal(rows[0].monthlySpend.usedPercent, null);
      assert.equal(rows[0].monthlySpend.used?.amountMinor ?? null, enabled ? 4631 : null);
      assert.equal(rows[0].monthlySpend.resetsAt, null);
      assert.equal(rows[1].monthlySpend.enabled, false);
      assert.equal(rows[1].monthlySpend.used, null);
      const [moneyOnly] = await readCliProxyUsage(CONFIG, { fetch: fixture([ACCOUNT], envelope(budget)) });
      assert.equal(moneyOnly.status, "ok");
      assert.deepEqual(moneyOnly.windows, []);
    }
  });

  it("does not turn malformed or zero-limit proxy money into quota recovery or percentages", async () => {
    for (const monthly_limit of [0, null, "bad"]) {
      const [row] = await readCliProxyUsage(CONFIG, { fetch: fixture([ACCOUNT], envelope({
        five_hour: { utilization: 36 },
        extra_usage: { is_enabled: true, used_credits: 4631, monthly_limit, utilization: 99 },
      })) });
      assert.equal(row.monthlySpend.usedPercent, null);
      assert.equal(row.monthlySpend.resetsAt, null);
      assert.deepEqual(row.windows, [{ label: "5-hour", usedPercent: 36, resetsAt: null, windowSeconds: 18000 }]);
      const picked = pickAccountByQuota(["claude"], [{ ...row, provider: "claude", monthlySpend: { ...row.monthlySpend, usedPercent: 100 } }]);
      assert.equal(picked.ref, "claude");
    }
  });

  it("does nothing until explicitly enabled and does not request without a key", async () => {
    const fetch = () => { throw new Error("unexpected network"); };
    assert.deepEqual(await readCliProxyUsage(null, { fetch }), []);
    assert.deepEqual(await readCliProxyUsage({ ...CONFIG, enabled: false }, { fetch }), []);
    const [row] = await readCliProxyUsage({ ...CONFIG, managementKey: null }, { fetch });
    assert.equal(row.status, "unavailable");
    assert.deepEqual(row.windows, []);
  });

  it("reads session and weekly percentages with account-bound token substitution", async () => {
    const requests = [];
    const [row] = await readCliProxyUsage(CONFIG, { nowMs: () => NOW, fetch: async (url, init) => {
      requests.push({ url, ...init });
      return fixture()(url);
    } });
    assert.equal(row.status, "ok");
    assert.equal(row.source, "cliproxy");
    assert.equal(row.label, "Claude · CLIProxy · Work");
    assert.match(row.provider, /^cliproxy:[a-f0-9]{16}:[a-f0-9]{16}$/);
    assert.equal(row.fetchedAt, NOW);
    assert.deepEqual(row.windows, [
      { label: "5-hour", usedPercent: 37, resetsAt: Date.parse(USAGE.five_hour.resets_at), windowSeconds: 18000 },
      { label: "weekly", usedPercent: 82.5, resetsAt: Date.parse(USAGE.seven_day.resets_at), windowSeconds: 604800 },
    ]);
    assert.equal(requests[0].url, "http://localhost:8317/v8/management/credentials");
    assert.equal(requests[1].url, "http://localhost:8317/v8/management/requests/api-call");
    assert.equal(requests[0].redirect, "error");
    assert.equal(requests[1].headers.Authorization, `Bearer ${KEY}`);
    const payload = JSON.parse(requests[1].body);
    assert.equal(payload.auth_index, ACCOUNT.auth_index);
    assert.equal(payload.method, "GET");
    assert.equal(payload.url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(payload.header.Authorization, "Bearer $TOKEN$");
    assert.equal(payload.header["anthropic-beta"], "oauth-2025-04-20");
    assert.ok(!JSON.stringify(row).includes(KEY));
    assert.ok(!JSON.stringify(row).includes(ACCOUNT.auth_index));
  });

  it("isolates accounts and server identities, ignores other providers and duplicate IDs", async () => {
    const calls = [];
    const files = [ACCOUNT, { ...ACCOUNT }, { ...ACCOUNT, auth_index: "other", label: "Personal" }, { ...ACCOUNT, auth_index: "not-claude", provider: "codex" }];
    const rows = await readCliProxyUsage(CONFIG, { fetch: async (url, init) => {
      if (/\/(?:auth-files|credentials)$/.test(url)) return json({ files });
      const id = JSON.parse(init.body).auth_index;
      calls.push(id);
      return json(id === "other" ? envelope({}, 401) : envelope());
    } });
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].provider, rows[1].provider);
    assert.equal(rows[0].status, "ok");
    assert.equal(rows[1].status, "unavailable");
    assert.deepEqual(rows[1].windows, []);
    assert.deepEqual(calls, [ACCOUNT.auth_index, "other"]);
    const [otherServer] = await readCliProxyUsage({ ...CONFIG, managementUrl: "https://another.example.test" }, { fetch: fixture() });
    assert.notEqual(otherServer.provider, rows[0].provider);
  });

  it("honors an explicit legacy URL and keeps source/account IDs stable across API versions", async () => {
    const requests = [];
    const [legacy] = await readCliProxyUsage({ ...CONFIG, managementUrl: "http://localhost:8317/v0/management" }, { fetch: async (url) => {
      requests.push(url);
      return fixture()(url);
    } });
    assert.equal(legacy.status, "ok");
    assert.deepEqual(requests, ["http://localhost:8317/v0/management/auth-files", "http://localhost:8317/v0/management/api-call"]);
    const [modern] = await readCliProxyUsage(CONFIG, { fetch: fixture() });
    assert.equal(legacy.provider, modern.provider);
  });

  it("falls back once to legacy only when the v8 credential endpoint is missing", async () => {
    const requests = [];
    const [fallback] = await readCliProxyUsage(CONFIG, { fetch: async (url, init) => {
      requests.push(url);
      assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
      return url.endsWith("/credentials") ? json({ error: "not found" }, 404) : fixture()(url);
    } });
    assert.equal(fallback.status, "ok");
    assert.deepEqual(requests, [
      "http://localhost:8317/v8/management/credentials",
      "http://localhost:8317/v0/management/auth-files",
      "http://localhost:8317/v0/management/api-call",
    ]);
    const [modern] = await readCliProxyUsage(CONFIG, { fetch: fixture() });
    assert.equal(fallback.provider, modern.provider);
  });

  it("never falls back on rejected keys, rate errors, malformed listings or an explicit legacy failure", async () => {
    for (const reply of [
      () => json({ error: KEY }, 401), () => json({ error: KEY }, 403),
      () => json({ error: KEY }, 429), () => json({ error: KEY }, 500),
      () => json({ files: null }), () => new Response("malformed json"),
    ]) {
      const requests = [];
      const [row] = await readCliProxyUsage(CONFIG, { fetch: async (url) => { requests.push(url); return reply(); } });
      assert.notEqual(row.status, "ok");
      assert.deepEqual(requests, ["http://localhost:8317/v8/management/credentials"]);
      assert.ok(!JSON.stringify(row).includes(KEY));
    }
    const requests = [];
    await readCliProxyUsage({ ...CONFIG, managementUrl: "http://localhost:8317/v0/management" }, { fetch: async (url) => { requests.push(url); return json({}, 404); } });
    assert.deepEqual(requests, ["http://localhost:8317/v0/management/auth-files"]);
  });

  it("does not retry or fall back after a v8 account usage request fails", async () => {
    for (const status of [401, 403, 404, 429]) {
      const requests = [];
      const [row] = await readCliProxyUsage(CONFIG, { fetch: async (url) => {
        requests.push(url);
        return url.endsWith("/credentials") ? json({ files: [ACCOUNT] }) : json({}, status);
      } });
      assert.notEqual(row.status, "ok");
      assert.deepEqual(requests, ["http://localhost:8317/v8/management/credentials", "http://localhost:8317/v8/management/requests/api-call"]);
    }
  });

  it("does not turn unavailable or invalid utilization into zero", async () => {
    for (const body of [{}, { five_hour: { utilization: null } }, { five_hour: { utilization: -1 } }, { five_hour: { utilization: "NaN" }, seven_day: null }]) {
      const [row] = await readCliProxyUsage(CONFIG, { fetch: fixture([ACCOUNT], envelope(body)) });
      assert.equal(row.status, "unavailable");
      assert.deepEqual(row.windows, []);
      assert.equal(row.fetchedAt, null);
    }
    const [zero] = await readCliProxyUsage(CONFIG, { fetch: fixture([ACCOUNT], envelope({ five_hour: { utilization: 0 } })) });
    assert.equal(zero.windows[0].usedPercent, 0, "an explicit zero remains valid");
  });

  it("shows empty, disabled and missing-index accounts without requesting their quotas", async () => {
    const [empty] = await readCliProxyUsage(CONFIG, { fetch: fixture([]) });
    assert.match(empty.message, /No Claude accounts/);
    const rows = await readCliProxyUsage(CONFIG, { fetch: async (url) => {
      assert.ok(/\/(?:auth-files|credentials)$/.test(url));
      return json({ files: [{ ...ACCOUNT, disabled: true }, { ...ACCOUNT, id: "missing", name: "missing.json", auth_index: null }] });
    } });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.status === "unavailable" && row.windows.length === 0));
  });

  it("maps management and upstream auth, missing endpoints and rate errors without leaking bodies", async () => {
    for (const management of [true, false]) {
      for (const status of [401, 403, 404, 429, 500]) {
        const fetch = management ? async () => json({ error: KEY }, status) : fixture([ACCOUNT], envelope({ error: KEY }, status));
        const [row] = await readCliProxyUsage(CONFIG, { fetch });
        assert.equal(row.status, [401, 403, 404].includes(status) ? "unavailable" : "error");
        assert.deepEqual(row.windows, []);
        assert.equal(row.fetchedAt, null);
        assert.ok(!JSON.stringify(row).includes(KEY));
        if (status === 429) assert.match(row.message, /rate limited/);
        if (status === 401) assert.match(row.message, management ? /management key rejected/ : /authorization expired/);
      }
    }
  });

  it("bounds stalled requests and handles malformed JSON, unexpected redirects and network errors", async () => {
    for (const fetch of [
      async () => new Response("bad json"),
      async () => json({ files: null }),
      async () => { throw new Error(`network ${KEY}`); },
      async () => ({ status: 200, url: "https://elsewhere.example.test", text: async () => "{}" }),
    ]) {
      const [row] = await readCliProxyUsage(CONFIG, { fetch });
      assert.equal(row.status, "error");
      assert.ok(!JSON.stringify(row).includes(KEY));
    }
    const [timeout] = await readCliProxyUsage(CONFIG, { timeoutMs: 5, fetch: () => new Promise(() => {}) });
    assert.match(timeout.message, /timed out/);
  });

  it("appends source rows alongside native accounts and keeps auto account selection native", async () => {
    const native = (id) => ({ provider: id, status: "ok", windows: [{ label: "5-hour", usedPercent: 50, windowSeconds: 18000, resetsAt: NOW }], fetchedAt: NOW });
    const fetchers = Object.fromEntries(knownProviderIds().map((id) => [id, async () => native(id)]));
    const options = { fetchers, cliProxyUsage: CONFIG, cliProxyOptions: { fetch: fixture(), nowMs: () => NOW }, instances: [{ provider: "claude", ref: "claude:work", env: {} }] };
    const rows = await fetchProviderLimits(options);
    assert.deepEqual(rows.find((row) => row.provider === "claude"), native("claude"));
    assert.equal(rows.find((row) => row.provider === "claude:work").status, "ok");
    assert.equal(rows.filter((row) => row.source === "cliproxy").length, 1);
    assert.equal(pickAccountByQuota(["claude", "claude:work"], rows).ref, "claude");
    const only = await fetchProviderLimits({ ...options, only: "claude", cliProxyOptions: { fetch: () => { throw new Error("no proxy during account selection"); } } });
    assert.ok(only.every((row) => !row.source));
    assert.ok(!JSON.stringify(only).includes(KEY));
  });
});

describe("CLIProxy settings credential boundary", () => {
  it("persists encrypted, redacts IPC, preserves omitted keys and clears keys on destination changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-cliproxy-settings-"));
    const file = path.join(dir, "store.json");
    const secrets = createSecrets({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() }, inElectron: true, log: () => {} });
    const store = new Store(file, { secrets });
    try {
      store.setSettings({ cliProxyUsage: CONFIG });
      store.saveNow();
      const disk = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.match(disk.settings.cliProxyUsage.managementKey, /^enc:v1:/);
      assert.ok(!JSON.stringify(disk).includes(KEY));
      const reloaded = new Store(file, { secrets });
      assert.equal(reloaded.getSettings().cliProxyUsage.managementKey, KEY);
      const publicSettings = redactSettings(reloaded.getSettings());
      assert.equal(publicSettings.cliProxyUsage.hasManagementKey, true);
      assert.ok(!("managementKey" in publicSettings.cliProxyUsage));
      const diagnostics = require("../diagnostics.js").redactSettings(reloaded.getSettings(), String);
      assert.equal(diagnostics.cliProxyUsage.managementKey, "[redacted]");
      assert.deepEqual(instanceAuthProbes(reloaded, dir), [], "usage source never becomes a CLI account or environment");
      const handlers = require("../ipc-app.js");
      const ipc = await handlers["settings:get"]({ store: reloaded });
      assert.ok(!JSON.stringify(ipc).includes(KEY));
      reloaded.setSettings({ cliProxyUsage: { ...ipc.cliProxyUsage, enabled: false } });
      assert.equal(reloaded.getSettings().cliProxyUsage.managementKey, KEY);
      reloaded.setSettings({ cliProxyUsage: { managementUrl: "https://other.example.test/management.html" } });
      assert.equal(reloaded.getSettings().cliProxyUsage.managementKey, null);
      reloaded.setSettings({ cliProxyUsage: { managementKey: "replacement" } });
      reloaded.setSettings({ cliProxyUsage: { managementKey: null } });
      assert.equal(reloaded.getSettings().cliProxyUsage.managementKey, null);
      assert.throws(() => reloaded.setSettings({ cliProxyUsage: { enabled: "yes" } }));
      assert.throws(() => reloaded.setSettings({ cliProxyUsage: { managementKey: "bad\r\nkey" } }));
      reloaded.saveNow();
    } finally { store.saveNow(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("wires the saved source through the quota IPC without offering it as a native account", async () => {
    const usage = require("../providerUsage.js");
    const original = usage.fetchProviderLimits;
    const native = { provider: "claude", status: "unavailable", windows: [], fetchedAt: null };
    const external = { ...native, provider: "cliproxy:server:work", source: "cliproxy" };
    const menuRows = [];
    const store = { getSettings: () => ({ cliProxyUsage: CONFIG, providerInstances: [] }) };
    usage.fetchProviderLimits = async (opts) => {
      assert.deepEqual(opts.cliProxyUsage, CONFIG);
      assert.deepEqual(opts.instances, []);
      return [native, external];
    };
    try {
      const handler = require("../ipc-insights.js")["usage:providerLimits"];
      const rows = await handler({ store, userDataPath: "/unused-fixture", usageMenu: { setUsage: (rows) => menuRows.push(...rows) } });
      assert.deepEqual(rows, [native, external]);
      assert.deepEqual(menuRows, [native]);
      assert.ok(!JSON.stringify(rows).includes(KEY));
    } finally { usage.fetchProviderLimits = original; }
  });
});
