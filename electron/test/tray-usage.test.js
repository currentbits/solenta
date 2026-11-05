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
];

const usage = [
  { provider: "claude", status: "ok", windows: [win("5-hour", 40), win("weekly", 10)], fetchedAt: NOW },
  { provider: "codex", status: "ok", windows: [win("weekly", 55.4, NOW + 20 * 60000)], fetchedAt: NOW },
  { provider: "grok", status: "unavailable", windows: [], fetchedAt: null, message: "not signed in" },
  { provider: "cursor", status: "unavailable", windows: [], fetchedAt: null },
  { provider: "claude:personal", status: "ok", windows: [win("5-hour", 2.4, NOW + 30 * 60000), win("weekly", 0)], fetchedAt: NOW },
  { provider: "claude:team", status: "error", windows: [], fetchedAt: null, message: "request timed out" },
  // A removed instance's stale row is not an account.
  { provider: "claude:gone", status: "ok", windows: [win("5-hour", 9)], fetchedAt: NOW },
];

function items(over = {}) {
  return usageMenuItems({
    usage,
    instances,
    providerName,
    accountOf: (ref) => (ref === "claude:personal" ? { email: "me@example.com", plan: "max" } : undefined),
    selectedRef: "claude:personal",
    now: NOW,
    onPick: () => {},
    onRefresh: () => {},
    ...over,
  });
}

describe("usageMenuItems (#1859)", () => {
  it("one checkable row per account, grouped under each CLI", () => {
    const labels = items().map((i) => i.label || i.type);
    assert.deepEqual(labels, [
      "Claude Code",
      "Default — 5-hour 40% · week 10%",
      "Personal — 5-hour 2% · week 0%",
      "Team — no usage data",
      "Codex",
      "Default — week 55%",
      "Grok",
      "Default — no usage data",
      "separator",
      "Refresh usage",
    ]);
  });

  it("checks the selected account and greys accounts with no data", () => {
    const rows = items().filter((i) => i.type === "checkbox");
    const personal = rows.find((r) => r.label.startsWith("Personal"));
    assert.equal(personal.checked, true);
    assert.equal(personal.enabled, true);
    assert.equal(rows.filter((r) => r.checked).length, 1);
    const team = rows.find((r) => r.label.startsWith("Team"));
    assert.equal(team.enabled, false);
    // CLI headers are labels, not choices.
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
    menu.find((i) => i.label === "Default — week 55%").click();
    menu.find((i) => i.label === "Refresh usage").click();
    assert.deepEqual(picked, ["codex"]);
    assert.equal(refreshed, 1);
  });

  it("before the first answer it says so instead of an empty menu", () => {
    const menu = items({ usage: null, loading: true });
    assert.equal(menu[0].label, "Loading usage…");
    assert.equal(menu.at(-1).label, "Refresh usage");
    assert.equal(menu.at(-1).enabled, false);
  });
});

describe("usageTitle (#1859)", () => {
  it("is the selected account and its 5-hour %", () => {
    assert.equal(usageTitle({ usage, instances, providerName, selectedRef: "claude:personal" }), "Personal 2%");
  });

  it("falls back to the first window, then to the bare name, then empty", () => {
    assert.equal(usageTitle({ usage, instances, providerName, selectedRef: "codex" }), "Codex 55%");
    assert.equal(usageTitle({ usage, instances, providerName, selectedRef: "claude:team" }), "Team");
    assert.equal(usageTitle({ usage: null, instances, providerName, selectedRef: "claude" }), "");
  });
});

describe("default account (#1859)", () => {
  it("is settings.defaultProvider, Claude Code when unset", () => {
    assert.equal(selectedAccountRef({ defaultProvider: null }), "claude");
    assert.equal(selectedAccountRef({ defaultProvider: "codex" }), "codex");
  });

  it("picking keeps the default model on the same CLI and clears it across CLIs", () => {
    const s = { defaultProvider: "claude", defaultModel: "opus" };
    assert.deepEqual(defaultAccountPatch(s, "claude:team"), { defaultProvider: "claude:team", defaultModel: "opus" });
    assert.deepEqual(defaultAccountPatch(s, "codex"), { defaultProvider: "codex", defaultModel: null });
  });
});

function fakeTray(calls) {
  return class FakeTray {
    constructor(icon) {
      calls.push({ op: "new", icon });
    }
    setToolTip() {}
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
  const settings = { menuBarUsage: false, defaultProvider: null, defaultModel: null, providerInstances: instances, ...over.settings };
  let fetches = 0;
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
    now: () => NOW,
    ...over.opts,
  });
  return { ctrl, calls, settings, fetches: () => fetches };
}

describe("createUsageMenu (#1859)", () => {
  it("creates nothing while the setting is off", async () => {
    const h = harness();
    h.ctrl.sync();
    h.ctrl.setUsage(usage);
    assert.equal(h.ctrl.menuBar, null);
    assert.equal(h.calls.length, 0);
    assert.equal(h.fetches(), 0);
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
    const h = harness({ settings: { menuBarUsage: true, defaultProvider: "claude:personal" } });
    h.ctrl.sync();
    // Turning on fetches once; a refresh while in flight joins it.
    await h.ctrl.refresh();
    assert.equal(h.fetches(), 1);
    // Refresh usage fetches again; still one menu bar item.
    await h.ctrl.items().find((i) => i.label === "Refresh usage").click();
    await h.ctrl.refresh();
    assert.equal(h.fetches(), 2);
    assert.equal(h.calls.filter((c) => c.op === "new").length, 1);
    assert.equal(h.calls.filter((c) => c.op === "title").at(-1).t, "Personal 2%");
    const menu = h.calls.filter((c) => c.op === "menu").at(-1).m;
    assert.deepEqual(menu.slice(-4).map((i) => i.label || i.type), ["Refresh usage", "Open Solenta", "separator", "Quit"]);
  });

  it("picking an account sets the default provider and retitles", async () => {
    const h = harness({ settings: { menuBarUsage: true, defaultProvider: "claude:personal", defaultModel: "opus" } });
    h.ctrl.setUsage(usage);
    const menu = h.calls.filter((c) => c.op === "menu").at(-1).m;
    menu.find((i) => i.label.startsWith("Default — 5-hour 40%")).click();
    assert.equal(h.settings.defaultProvider, "claude");
    assert.equal(h.settings.defaultModel, "opus");
    assert.equal(h.calls.filter((c) => c.op === "title").at(-1).t, "Claude Code 40%");
  });

  it("turning the setting off removes the menu bar item", () => {
    const h = harness({ settings: { menuBarUsage: true } });
    h.ctrl.setUsage(usage);
    assert.ok(h.ctrl.menuBar);
    h.settings.menuBarUsage = false;
    h.ctrl.sync();
    assert.equal(h.ctrl.menuBar, null);
    assert.ok(h.calls.some((c) => c.op === "destroy"));
  });

  it("on Windows/Linux: no Tray of its own, rows go into the existing tray menu", () => {
    let changes = 0;
    const h = harness({ settings: { menuBarUsage: true }, opts: { platform: "win32", onChange: () => changes++ } });
    h.ctrl.setUsage(usage);
    assert.equal(h.calls.length, 0);
    assert.ok(changes > 0);
    const menu = trayMenuTemplate({ runningCount: 1, onShow() {}, onQuit() {}, usageItems: h.ctrl.items() });
    assert.equal(menu[0].label, "Show Solenta");
    assert.ok(menu.some((i) => i.label === "Personal — 5-hour 2% · week 0%"));
    assert.equal(menu.at(-1).label, "Quit");
    // Off: the close-to-tray menu is exactly what it was.
    h.settings.menuBarUsage = false;
    assert.equal(trayMenuTemplate({ runningCount: 1, onShow() {}, onQuit() {}, usageItems: h.ctrl.items() }).length, 4);
  });
});

describe("menuBarUsage setting + IPC hooks (#1859)", () => {
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
    const store = new Store(path.join(dir, "store.json"));
    const { IPC_HANDLERS, makeCtx } = require("../ipc");
    let syncs = 0;
    const ctx = makeCtx({ store, usageMenu: { sync: () => syncs++, setUsage() {} } });
    const next = await IPC_HANDLERS["settings:set"](ctx, { menuBarUsage: true });
    assert.equal(next.menuBarUsage, true);
    assert.equal(syncs, 1);
    await assert.rejects(IPC_HANDLERS["settings:set"](ctx, { menuBarUsage: 1 }), /menuBarUsage must be a boolean/);
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
        getSettings: () => ({ providerInstances: instances.concat({ id: "work", name: "Work", provider: "codex", configDir: "/tmp/cw", env: { SECRET: "x" } }), ...settings }),
        getThread: () => thread,
        getProject: () => project,
      },
      broadcast() {},
    };
  }
  const handler = require("../ipc-devserver.js")["terminal:open"];

  it("new terminals use the default account the menu picked", async () => {
    await handler(ctxFor({ id: "t1", projectId: "p", provider: "codex" }, { defaultProvider: "claude:team" }), { threadId: "t1" });
    assert.equal(opened[0].CLAUDE_CONFIG_DIR, "/tmp/t");
  });

  it("the thread's own account wins for its CLI; keys never leak", async () => {
    await handler(
      ctxFor({ id: "t1", projectId: "p", provider: "codex", providerInstance: "work" }, { defaultProvider: "codex" }),
      { threadId: "t1" },
    );
    assert.equal(opened[0].CODEX_HOME, "/tmp/cw");
    assert.equal(opened[0].SECRET, undefined);
    // A thread on the default Claude login keeps it even if another is the default.
    await handler(ctxFor({ id: "t1", projectId: "p", provider: "claude" }, { defaultProvider: "claude:team" }), { threadId: "t1" });
    assert.equal(opened[1].CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  });

  it("remote projects get no local config dirs", async () => {
    await handler(
      ctxFor({ id: "t1", projectId: "p", provider: "codex" }, { defaultProvider: "claude:team" }, { id: "p", path: "/tmp", remoteHost: "box" }),
      { threadId: "t1" },
    );
    assert.equal(opened[0].CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  });
});
