"use strict";

/**
 * Usage in the menu bar (#1859). usageMenuItems/usageTitle are pure;
 * createUsageMenu runs with an injected fake Tray/Menu, so these tests never
 * see the real macOS menu bar.
 * Run: node --test electron/test/tray-usage.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  usageMenuItems,
  usageTitle,
  defaultAccountPatch,
  selectedAccountRef,
  createUsageMenu,
  trayMenuTemplate,
} = require("../tray.js");

const NOW = Date.parse("2026-11-05T12:00:00Z");
const NAMES = { claude: "Claude Code", codex: "Codex", grok: "Grok" };
const providerName = (id) => NAMES[id] || id;
const win = (label, usedPercent, resetsAt = null) => ({ label, usedPercent, resetsAt, windowSeconds: null });

const instances = [
  { id: "personal", name: "Personal", provider: "claude", configDir: "/tmp/p", env: {} },
  { id: "team", name: "Team", provider: "claude", configDir: "/tmp/t", env: {} },
  { id: "work", name: "Work", provider: "codex", configDir: "/tmp/cw", env: { SECRET: "x" } },
];

const usage = [
  { provider: "claude", status: "ok", windows: [win("5-hour", 40), win("weekly", 10)], fetchedAt: NOW },
  { provider: "codex", status: "ok", windows: [win("weekly", 55.4, NOW + 20 * 60000)], fetchedAt: NOW },
  { provider: "grok", status: "unavailable", windows: [], fetchedAt: null, message: "not signed in" },
  { provider: "cursor", status: "unavailable", windows: [], fetchedAt: null },
  { provider: "claude:personal", status: "ok", windows: [win("5-hour", 2.4, NOW + 30 * 60000), win("weekly", 0)], fetchedAt: NOW },
  { provider: "claude:team", status: "error", windows: [], fetchedAt: null, message: "request timed out" },
  { provider: "codex:work", status: "ok", windows: [win("weekly", 12)], fetchedAt: NOW },
  // A removed instance's stale row is not an account.
  { provider: "claude:gone", status: "ok", windows: [win("5-hour", 9)], fetchedAt: NOW },
];

const SETTINGS = { providerInstances: instances, defaultProvider: null, defaultAccounts: { claude: "personal" } };

function items(over = {}) {
  return usageMenuItems({
    usage,
    instances,
    providerName,
    accountOf: (ref) => (ref === "claude:personal" ? { email: "me@example.com", plan: "max" } : undefined),
    settings: SETTINGS,
    now: NOW,
    onPick: () => {},
    onRefresh: () => {},
    ...over,
  });
}

describe("usageMenuItems (#1859)", () => {
  it("one checkable row per account, grouped under each CLI", () => {
    const labels = items({ updatedAt: NOW - 3 * 60000 }).map((i) => i.label || i.type);
    assert.deepEqual(labels, [
      "Claude Code",
      "Default — 5-hour 40% · week 10%",
      "Personal — 5-hour 2% · week 0%",
      "Team — no usage data",
      "Codex",
      "Default — week 55%",
      "Work — week 12%",
      "Grok",
      "Default — no usage data",
      "separator",
      "Updated 3 min ago",
      "Refresh usage",
    ]);
  });

  it("one checkmark per CLI: its default account", () => {
    const rows = items().filter((i) => i.type === "checkbox");
    assert.deepEqual(
      rows.filter((r) => r.checked).map((r) => r.label.split(" — ")[0]),
      ["Personal", "Default", "Default"],
    );
  });

  it("rows with no usage data stay pickable", () => {
    const rows = items().filter((i) => i.type === "checkbox");
    for (const r of rows) assert.notEqual(r.enabled, false, r.label);
    // CLI headers and the age line are labels, not choices.
    assert.equal(items()[0].enabled, false);
  });

  it("sublabel: email and plan when known, plus a reset within the hour", () => {
    const rows = items().filter((i) => i.type === "checkbox");
    assert.equal(
      rows.find((r) => r.label.startsWith("Personal")).sublabel,
      "me@example.com · Max plan · 5-hour resets in 30m",
    );
    assert.equal(rows.find((r) => r.label === "Default — week 55%").sublabel, "Week resets in 20m");
    assert.equal(rows.find((r) => r.label.startsWith("Default — 5-hour 40%")).sublabel, undefined);
  });

  it("picking a row and Refresh usage call back", () => {
    const picked = [];
    let refreshed = 0;
    const menu = items({ onPick: (ref) => picked.push(ref), onRefresh: () => refreshed++ });
    menu.find((i) => i.label === "Work — week 12%").click();
    menu.find((i) => i.label === "Refresh usage").click();
    assert.deepEqual(picked, ["codex:work"]);
    assert.equal(refreshed, 1);
  });

  it("before the first answer it says so instead of an empty menu", () => {
    const menu = items({ usage: null, loading: true });
    assert.equal(menu[0].label, "Loading usage…");
    assert.equal(menu.at(-1).label, "Refreshing…");
    assert.equal(menu.at(-1).enabled, false);
  });
});

describe("usageTitle (#1859)", () => {
  const title = (settings, u = usage) => usageTitle({ usage: u, instances, providerName, settings: { providerInstances: instances, ...settings } });

  it("is the default provider's selected account and its 5-hour %", () => {
    assert.equal(title({ defaultAccounts: { claude: "personal" } }), "Personal 2%");
    // Picking a Codex account does not move the title off Claude Code.
    assert.equal(title({ defaultAccounts: { codex: "work" } }), "Claude Code 40%");
    assert.equal(title({ defaultProvider: "codex", defaultAccounts: { codex: "work" } }), "Work 12%");
  });

  it("falls back to the first window, then to the bare name, then empty", () => {
    assert.equal(title({ defaultProvider: "codex" }), "Codex 55%");
    assert.equal(title({ defaultAccounts: { claude: "team" } }), "Team");
    assert.equal(title({}, null), "");
  });
});

describe("default account (#1859)", () => {
  it("is settings.defaultAccounts per CLI; the CLI's own login when unset or removed", () => {
    assert.equal(selectedAccountRef(SETTINGS, "claude"), "claude:personal");
    assert.equal(selectedAccountRef(SETTINGS, "codex"), "codex");
    assert.equal(selectedAccountRef({ ...SETTINGS, defaultAccounts: { claude: "gone" } }, "claude"), "claude");
  });

  it("picking a Codex account sets only codex's default account", () => {
    const s = { defaultProvider: "claude", defaultModel: "opus", defaultAccounts: { claude: "personal" } };
    assert.deepEqual(defaultAccountPatch(s, "codex:work"), { defaultAccounts: { claude: "personal", codex: "work" } });
    // The CLI's own login clears the entry.
    assert.deepEqual(defaultAccountPatch(s, "claude"), { defaultAccounts: {} });
  });

  it("a pinned defaultProvider is that CLI's effective default account", () => {
    const pinned = { providerInstances: instances, defaultProvider: "claude:team", defaultAccounts: { claude: "personal" } };
    assert.equal(selectedAccountRef(pinned, "claude"), "claude:team");
    assert.equal(selectedAccountRef(pinned, "codex"), "codex");
  });

  it("a default provider pinned to another account of that CLI loosens to the bare CLI", () => {
    assert.deepEqual(defaultAccountPatch({ defaultProvider: "claude:team" }, "claude:personal"), {
      defaultAccounts: { claude: "personal" },
      defaultProvider: "claude",
    });
    assert.equal(defaultAccountPatch({ defaultProvider: "claude:team" }, "codex:work").defaultProvider, undefined);
  });
});

function fakeTray(calls) {
  return class FakeTray {
    constructor(icon) {
      calls.push({ op: "new", icon });
      this.listeners = {};
    }
    setToolTip() {}
    on(ev, fn) {
      this.listeners[ev] = fn;
    }
    popUpContextMenu(m) {
      calls.push({ op: "menu", m });
    }
    setTitle(t) {
      calls.push({ op: "title", t });
    }
    setContextMenu(m) {
      calls.push({ op: "menu", m });
    }
    destroy() {
      calls.push({ op: "destroy" });
    }
  };
}


function harness(over = {}) {
  const calls = [];
  const settings = { menuBarUsage: false, defaultProvider: null, defaultModel: null, defaultAccounts: {}, providerInstances: instances, ...over.settings };
  let fetches = 0;
  let clock = NOW;
  const timers = [];
  const ctrl = createUsageMenu({
    platform: "darwin",
    headless: false,
    Tray: fakeTray(calls),
    Menu: { buildFromTemplate: (t) => t },
    icon: "icon",
    getSettings: () => settings,
    saveSettings: (patch) => Object.assign(settings, patch),
    fetchUsage: async () => {
      fetches++;
      return usage;
    },
    providerName,
    onShow: () => {},
    onQuit: () => {},
    now: () => clock,
    setInterval: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearInterval: (t) => {
      t.cleared = true;
    },
    ...over.opts,
  });
  /** Click the menu bar item; returns the menu it popped up. */
  const lastMenu = () => {
    ctrl.menuBar.listeners.click();
    return calls.filter((c) => c.op === "menu").at(-1).m;
  };
  const lastTitle = () => calls.filter((c) => c.op === "title").at(-1).t;
  return { ctrl, calls, settings, timers, lastMenu, lastTitle, fetches: () => fetches, tick: (ms) => (clock += ms) };
}

describe("createUsageMenu (#1859)", () => {
  it("creates nothing while the setting is off", () => {
    const h = harness();
    h.ctrl.sync();
    h.ctrl.setUsage(usage);
    h.ctrl.setLive("claude", [win("5-hour", 1)]);
    assert.equal(h.ctrl.menuBar, null);
    assert.equal(h.calls.length, 0);
    assert.equal(h.fetches(), 0);
    assert.equal(h.timers.length, 0);
    assert.equal(h.ctrl.items(), null);
  });

  it("creates nothing headless, even with the setting on", () => {
    const h = harness({ settings: { menuBarUsage: true }, opts: { headless: true } });
    h.ctrl.sync();
    assert.equal(h.ctrl.menuBar, null);
    assert.equal(h.calls.length, 0);
    assert.equal(h.fetches(), 0);
  });

  it("on macOS: one menu bar Tray, fetched once, titled with the selected account", async () => {
    const h = harness({ settings: { menuBarUsage: true, defaultAccounts: { claude: "personal" } } });
    h.ctrl.sync();
    // Turning on fetches once; a refresh while in flight joins it.
    await h.ctrl.refresh();
    assert.equal(h.fetches(), 1);
    // Refresh usage fetches again; still one menu bar item.
    await h.ctrl.items().find((i) => i.label === "Refresh usage").click();
    await h.ctrl.refresh();
    assert.equal(h.fetches(), 2);
    assert.equal(h.calls.filter((c) => c.op === "new").length, 1);
    assert.equal(h.lastTitle(), "Personal 2%");
    assert.deepEqual(h.lastMenu().slice(-5).map((i) => i.label || i.type), ["Updated just now", "Refresh usage", "Open Solenta", "separator", "Quit"]);
  });

  it("picking a Codex account leaves defaultProvider alone and sets codex's default account", () => {
    const h = harness({ settings: { menuBarUsage: true, defaultProvider: "claude", defaultModel: "opus", defaultAccounts: { claude: "personal" } } });
    h.ctrl.setUsage(usage);
    h.lastMenu().find((i) => i.label === "Work — week 12%").click();
    assert.equal(h.settings.defaultProvider, "claude");
    assert.equal(h.settings.defaultModel, "opus");
    assert.deepEqual(h.settings.defaultAccounts, { claude: "personal", codex: "work" });
    assert.equal(h.lastTitle(), "Personal 2%");
    assert.equal(h.lastMenu().find((i) => i.label === "Work — week 12%").checked, true);
  });

  it("opening the menu refetches stale data and leaves fresh data alone", async () => {
    const h = harness({ settings: { menuBarUsage: true } });
    h.ctrl.setUsage(usage);
    h.tick(60 * 1000);
    assert.ok(h.lastMenu().some((i) => i.label === "Updated 1 min ago"));
    await h.ctrl.refresh();
    assert.equal(h.fetches(), 1, "the refresh above was the only fetch: a minute old is fresh");
    h.tick(3 * 60 * 1000);
    const stale = h.lastMenu();
    assert.ok(stale.some((i) => i.label === "Refreshing…"), "three minutes old: refetch started on open");
    await h.ctrl.refresh();
    assert.equal(h.fetches(), 2);
    assert.ok(h.lastMenu().some((i) => i.label === "Updated just now"), "the next open shows the answer");
  });

  it("a pinned defaultProvider drives title and checkmark; picking another account keeps both consistent", () => {
    const h = harness({ settings: { menuBarUsage: true, defaultProvider: "claude:team", defaultAccounts: {} } });
    h.ctrl.setUsage(usage);
    assert.equal(h.lastTitle(), "Team");
    const checked = () => h.lastMenu().filter((i) => i.checked).map((i) => i.label.split(" — ")[0]);
    assert.deepEqual(checked(), ["Team", "Default", "Default"]);
    h.lastMenu().find((i) => i.label.startsWith("Personal")).click();
    // Pin stripped into defaultAccounts: still Claude Code, now Personal.
    assert.equal(h.settings.defaultProvider, "claude");
    assert.deepEqual(h.settings.defaultAccounts, { claude: "personal" });
    assert.equal(h.lastTitle(), "Personal 2%");
    assert.deepEqual(checked(), ["Personal", "Default", "Default"]);
    const { defaultAccountFor } = require("../providerInstances.js");
    assert.equal(defaultAccountFor(h.settings, "claude"), "personal", "new threads agree with the menu");
  });

  it("live run windows update the matching account's row and the title", () => {
    const h = harness({ settings: { menuBarUsage: true, defaultAccounts: { claude: "personal" } } });
    h.ctrl.setUsage(usage);
    h.ctrl.setLive("claude:personal", [win("5-hour", 63)]);
    assert.equal(h.lastTitle(), "Personal 63%");
    assert.ok(h.lastMenu().some((i) => i.label === "Personal — 5-hour 63% · week 0%"), "weekly kept, 5-hour replaced");
    // A row with no data yet gains one.
    h.ctrl.setLive("claude:team", [win("weekly", 7)]);
    assert.ok(h.lastMenu().some((i) => i.label === "Team — week 7%"));
  });

  it("one 15-minute timer while on, cleared when turned off", async () => {
    const h = harness({ settings: { menuBarUsage: true } });
    h.ctrl.setUsage(usage);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 15 * 60 * 1000);
    h.timers[0].fn();
    await h.ctrl.refresh();
    assert.equal(h.fetches(), 1);
    h.settings.menuBarUsage = false;
    h.ctrl.sync();
    assert.equal(h.timers[0].cleared, true);
    assert.equal(h.ctrl.menuBar, null);
    assert.ok(h.calls.some((c) => c.op === "destroy"));
  });

  it("on Windows/Linux: no Tray of its own, rows go into the existing tray menu", async () => {
    let changes = 0;
    const h = harness({ settings: { menuBarUsage: true }, opts: { platform: "win32", onChange: () => changes++ } });
    h.ctrl.setUsage(usage);
    assert.equal(h.calls.length, 0);
    assert.ok(changes > 0);
    const menu = trayMenuTemplate({ runningCount: 1, onShow() {}, onQuit() {}, usageItems: h.ctrl.items() });
    assert.equal(menu[0].label, "Show Solenta");
    assert.ok(menu.some((i) => i.label === "Personal — 5-hour 2% · week 0%"));
    assert.equal(menu.at(-1).label, "Quit");
    // Right-click on stale data refetches.
    h.tick(3 * 60 * 1000);
    h.ctrl.refreshIfStale();
    await h.ctrl.refresh();
    assert.equal(h.fetches(), 1);
    // Off: the close-to-tray menu is exactly what it was.
    h.settings.menuBarUsage = false;
    assert.equal(trayMenuTemplate({ runningCount: 1, onShow() {}, onQuit() {}, usageItems: h.ctrl.items() }).length, 4);
  });
});

describe("live run windows (#1859)", () => {
  const usageMod = require("../providerUsage.js");

  it("claude rate_limit_event: utilization fraction to %, five_hour/seven_day labels", () => {
    const [w] = usageMod.claudeRateLimitWindows({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.81, resetsAt: 1_800_000_000 });
    assert.equal(w.label, "5-hour");
    assert.equal(Math.round(w.usedPercent), 81);
    assert.equal(w.resetsAt, 1_800_000_000_000);
    assert.equal(usageMod.claudeRateLimitWindows({ rateLimitType: "seven_day", utilization: 0.2 })[0].label, "weekly");
    // No utilization (below the CLI's alert thresholds): nothing is known.
    assert.deepEqual(usageMod.claudeRateLimitWindows({ status: "allowed", rateLimitType: "five_hour" }), []);
    assert.deepEqual(usageMod.claudeRateLimitWindows({ rateLimitType: "overage", utilization: 0.5 }), []);
  });

  it("codex account/rateLimits/updated becomes an account.rate_limits event", () => {
    const { notificationToJsonl } = require("../codex-appserver.js");
    const ev = notificationToJsonl({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1_800_000_000 } } },
    });
    assert.equal(ev.type, "account.rate_limits");
    assert.equal(ev.windows[0].label, "weekly");
    assert.equal(ev.windows[0].usedPercent, 30);
  });

  it("reportLiveUsage reaches listeners under the account ref", () => {
    const seen = [];
    const off = usageMod.onLiveUsage((ref, w) => seen.push([ref, w.length]));
    usageMod.reportLiveUsage("claude:personal", [win("5-hour", 5)]);
    usageMod.reportLiveUsage("claude", []);
    off();
    usageMod.reportLiveUsage("claude", [win("5-hour", 5)]);
    assert.deepEqual(seen, [["claude:personal", 1]]);
  });
});

describe("menuBarUsage / defaultAccounts settings + IPC hooks (#1859)", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-menubar-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("defaults off, validates, and settings:set resyncs the menu", async () => {
    const { Store, normalizeSettings } = require("../store");
    assert.equal(normalizeSettings({}).menuBarUsage, false);
    assert.equal(normalizeSettings({ menuBarUsage: "yes" }).menuBarUsage, false);
    assert.deepEqual(normalizeSettings({}).defaultAccounts, {});
    assert.deepEqual(normalizeSettings({ defaultAccounts: { claude: " work ", codex: 3, "Bad Key": "x" } }).defaultAccounts, { claude: "work" });
    const store = new Store(path.join(dir, "store.json"));
    const { IPC_HANDLERS, makeCtx } = require("../ipc");
    let syncs = 0;
    const ctx = makeCtx({ store, usageMenu: { sync: () => syncs++, setUsage() {} } });
    const next = await IPC_HANDLERS["settings:set"](ctx, { menuBarUsage: true, defaultAccounts: { codex: "work" } });
    assert.equal(next.menuBarUsage, true);
    assert.deepEqual(next.defaultAccounts, { codex: "work" });
    assert.equal(syncs, 1);
    await assert.rejects(IPC_HANDLERS["settings:set"](ctx, { menuBarUsage: 1 }), /menuBarUsage must be a boolean/);
    await assert.rejects(IPC_HANDLERS["settings:set"](ctx, { defaultAccounts: "work" }), /defaultAccounts must be an object/);
  });

  it("a new thread on a bare provider uses that CLI's default account; explicit and forked ones keep theirs", async () => {
    const { Store } = require("../store");
    const services = require("../services");
    const store = new Store(path.join(dir, "store.json"));
    store.setSettings({ providerInstances: instances, defaultAccounts: { claude: "team" } });
    const repo = path.join(dir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    const bare = services.createThread(store, { projectId: project.id, title: "a", provider: "claude" });
    assert.equal(bare.provider, "claude");
    assert.equal(bare.providerInstance, "team");
    const unset = services.createThread(store, { projectId: project.id, title: "b" });
    assert.equal(unset.providerInstance, "team");
    const explicit = services.createThread(store, { projectId: project.id, title: "c", provider: "claude:personal" });
    assert.equal(explicit.providerInstance, "personal");
    const codex = services.createThread(store, { projectId: project.id, title: "d", provider: "codex" });
    assert.equal(codex.providerInstance, undefined);
    const fork = services.createThread(store, { projectId: project.id, title: "e", provider: "claude", projectDefaults: false });
    assert.equal(fork.providerInstance, undefined);
    // A pinned defaultProvider is the effective default for new threads too.
    store.setSettings({ defaultProvider: "claude:personal" });
    assert.equal(services.createThread(store, { projectId: project.id, title: "f", provider: "claude" }).providerInstance, "personal");
    store.setSettings({ defaultProvider: null });
    // The picker's base row names the default account.
    const list = await services.listProvidersForApi(store);
    assert.equal(list.find((p) => p.id === "claude").defaultAccount, "Team");
    assert.equal(list.find((p) => p.id === "codex").defaultAccount, undefined);
  });
});

describe("switching an existing thread's provider (#1859)", () => {
  let dir;
  let store;
  let project;
  const services = require("../services");
  const { IPC_HANDLERS, makeCtx } = require("../ipc");
  beforeEach(async () => {
    const { Store } = require("../store");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-setprov-"));
    store = new Store(path.join(dir, "store.json"));
    store.setSettings({ providerInstances: instances, defaultAccounts: { claude: "team" } });
    const repo = path.join(dir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ctx = () => makeCtx({ store, broadcast() {} });

  it("the picker's bare row uses the default account it is labelled with", async () => {
    const t = services.createThread(store, { projectId: project.id, title: "a", provider: "codex" });
    const next = await IPC_HANDLERS["threads:setProvider"](ctx(), { threadId: t.id, provider: "claude" });
    assert.equal(next.provider, "claude");
    assert.equal(store.getThread(t.id).providerInstance, "team");
    // The row label and what is stored agree.
    const row = (await services.listProvidersForApi(store)).find((p) => p.id === "claude");
    assert.equal(row.defaultAccount, "Team");
  });

  it("an explicitly chosen instance is untouched", async () => {
    const t = services.createThread(store, { projectId: project.id, title: "b", provider: "codex" });
    await IPC_HANDLERS["threads:setProvider"](ctx(), { threadId: t.id, provider: "claude:personal" });
    assert.equal(store.getThread(t.id).providerInstance, "personal");
  });

  it("internal callers and automation threads keep the exact ref", () => {
    const t = services.createThread(store, { projectId: project.id, title: "c", provider: "claude:personal" });
    services.setProvider(store, { threadId: t.id, provider: "claude" });
    assert.equal(store.getThread(t.id).providerInstance ?? null, null, "quota failover asks for exactly `claude`");
    const auto = services.createThread(store, { projectId: project.id, title: "d", provider: "codex", automationId: "a1" });
    services.setProvider(store, { threadId: auto.id, provider: "claude", useDefaultAccount: true });
    assert.equal(store.getThread(auto.id).providerInstance ?? null, null);
  });
});

describe("terminal account env (#1859)", () => {
  const terminal = require("../terminal.js");
  const realOpen = terminal.open;
  let opened;
  beforeEach(() => {
    opened = [];
    terminal.open = (threadId, root, opts) => {
      opened.push(opts.env);
      return { termId: "t" };
    };
  });
  afterEach(() => {
    terminal.open = realOpen;
  });

  function ctxFor(thread, settings, project = { id: "p", path: "/tmp" }) {
    return {
      store: {
        getSettings: () => ({ providerInstances: instances, defaultProvider: null, defaultAccounts: {}, ...settings }),
        getThread: () => thread,
        getProject: () => project,
      },
      broadcast() {},
    };
  }
  const handler = require("../ipc-devserver.js")["terminal:open"];

  it("new terminals use each CLI's default account", async () => {
    await handler(ctxFor({ id: "t1", projectId: "p", provider: "grok" }, { defaultAccounts: { claude: "team", codex: "work" } }), { threadId: "t1" });
    assert.equal(opened[0].CLAUDE_CONFIG_DIR, "/tmp/t");
    assert.equal(opened[0].CODEX_HOME, "/tmp/cw");
    assert.equal(opened[0].SECRET, undefined, "only the config dir, never instance keys");
  });

  it("a pinned defaultProvider is the terminal's default too", async () => {
    await handler(ctxFor({ id: "t1", projectId: "p", provider: "grok" }, { defaultProvider: "claude:personal", defaultAccounts: { claude: "team" } }), { threadId: "t1" });
    assert.equal(opened[0].CLAUDE_CONFIG_DIR, "/tmp/p");
  });

  it("the thread's own account wins for its CLI", async () => {
    await handler(
      ctxFor({ id: "t1", projectId: "p", provider: "claude", providerInstance: "personal" }, { defaultAccounts: { claude: "team" } }),
      { threadId: "t1" },
    );
    assert.equal(opened[0].CLAUDE_CONFIG_DIR, "/tmp/p");
    // A thread on the CLI's own login keeps it even if another is the default.
    await handler(ctxFor({ id: "t1", projectId: "p", provider: "claude" }, { defaultAccounts: { claude: "team" } }), { threadId: "t1" });
    assert.equal(opened[1].CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  });

  it("remote projects get no local config dirs", async () => {
    await handler(
      ctxFor({ id: "t1", projectId: "p", provider: "grok" }, { defaultAccounts: { claude: "team" } }, { id: "p", path: "/tmp", remoteHost: "box" }),
      { threadId: "t1" },
    );
    assert.equal(opened[0].CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  });
});
