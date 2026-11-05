"use strict";

/**
 * Windows/Linux close-to-tray (issue #1807). Off by default; opting in
 * keeps the app running after the window closes, same spirit as macOS
 * staying in the dock. The tray's own Quit (and the Quit menu, and an
 * updater restart) always call app.quit(), which still runs through the
 * normal before-quit confirm-active-work flow (electron/quitGuard.js,
 * electron/shutdown.js) — this module only ever decides whether a window
 * CLOSE event hides instead of quitting; it never touches the quit path.
 */

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Whether a window close event should hide the window instead of quitting.
 * False whenever a real quit is already underway (Quit menu, tray Quit,
 * updater restart, SIGINT/SIGTERM): that path calls app.quit()/app.exit()
 * directly and never goes through a window's close handler on its own, but
 * callers that also use this during teardown must not get hidden instead.
 *
 * @param {{ platform?: NodeJS.Platform, closeToTray?: boolean, shuttingDown?: boolean }} opts
 */
function shouldHideOnClose(opts = {}) {
  if (opts.shuttingDown) return false;
  if (!opts.closeToTray) return false;
  return opts.platform === "win32" || opts.platform === "linux";
}

/**
 * Pure menu template (testable without a real Electron Menu). Click
 * handlers are passed through as-is. `usageItems` (#1859) slots the
 * account rows in above Quit when "Show usage in the menu bar" is on.
 *
 * @param {{ runningCount: number, onShow: () => void, onQuit: () => void, usageItems?: object[] | null }} opts
 */
function trayMenuTemplate({ runningCount, onShow, onQuit, usageItems }) {
  return [
    { label: "Show Solenta", click: onShow },
    { label: plural(runningCount, "running thread", "running threads"), enabled: false },
    { type: "separator" },
    ...(usageItems && usageItems.length ? [...usageItems, { type: "separator" }] : []),
    { label: "Quit", click: onQuit },
  ];
}

// ---------------------------------------------------------------------------
// Usage in the menu bar (#1859)
// ---------------------------------------------------------------------------

/** No quota source at all (electron/providerUsage.js): never an account row. */
const NO_USAGE = new Set(["cursor", "opencode", "muse"]);
/** A reset this close is worth a sublabel. */
const RESET_NEAR_MS = 60 * 60 * 1000;

/** @param {number} n */
function pct(n) {
  return `${Math.round(n)}%`;
}

/** @param {number} ms */
function inMinutes(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? "1h" : `${m}m`;
}

/** Data older than this is refetched when the menu opens. */
const STALE_MS = 2 * 60 * 1000;
/** The one timed refresh while the setting is on: covers an idle app whose window reset. */
const IDLE_REFRESH_MS = 15 * 60 * 1000;

/** @param {number} ms */
function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

/**
 * The account new `base` threads and terminals use (settings.defaultAccounts):
 * `base:<id>`, or `base` for the CLI's own login (also when the id is gone).
 * @param {any} settings
 * @param {string} base
 */
function selectedAccountRef(settings, base) {
  const map = (settings && settings.defaultAccounts) || {};
  const id = typeof map[base] === "string" ? map[base] : "";
  const known = id && ((settings && settings.providerInstances) || []).some((i) => i.provider === base && i.id === id);
  return known ? `${base}:${id}` : base;
}

/** The CLI the title follows: the default provider's, else Claude Code. */
function titleProvider(settings) {
  const ref = settings && typeof settings.defaultProvider === "string" ? settings.defaultProvider.trim() : "";
  return (ref || "claude").split(":")[0];
}

/**
 * Settings patch for picking an account: only that CLI's default account.
 * Which agent new threads use (defaultProvider) never changes; a default
 * provider pinned to another account of the same CLI is loosened to the bare
 * CLI so the pick takes effect.
 * @param {any} settings
 * @param {string} ref
 */
function defaultAccountPatch(settings, ref) {
  const [base, id] = ref.split(":");
  const map = { ...((settings && settings.defaultAccounts) || {}) };
  if (id) map[base] = id;
  else delete map[base];
  /** @type {Record<string, unknown>} */
  const patch = { defaultAccounts: map };
  const dp = settings && typeof settings.defaultProvider === "string" ? settings.defaultProvider : "";
  if (dp.startsWith(`${base}:`)) patch.defaultProvider = base;
  return patch;
}

/**
 * One account per usage row, grouped by CLI. A base overlay (#1714) reports
 * under the base ref too; the later row wins.
 * @param {{ usage: object[] | null, instances?: object[], providerName: (id: string) => string }} opts
 */
function usageAccounts({ usage, instances, providerName }) {
  /** @type {Map<string, any>} */
  const byRef = new Map();
  for (const row of usage || []) {
    if (!row || typeof row.provider !== "string") continue;
    const [base, id] = row.provider.split(":");
    if (NO_USAGE.has(base)) continue;
    const inst = id ? (instances || []).find((i) => i.provider === base && i.id === id) : null;
    if (id && !inst) continue;
    byRef.set(row.provider, {
      ref: row.provider,
      base,
      name: inst ? inst.name : "Default",
      // Menu bar title: the instance name, or the CLI's own for the default login.
      short: inst ? inst.name : providerName(base) || base,
      row,
    });
  }
  return [...byRef.values()].sort((a, b) => (a.base === b.base ? 0 : a.base < b.base ? -1 : 1));
}

/** @param {any} row @param {string} label */
function windowOf(row, label) {
  return row && row.status === "ok" ? (row.windows || []).find((w) => w.label === label) || null : null;
}

/**
 * Menu bar title, e.g. "Personal 2%": the default provider's selected
 * account and its 5-hour % (the first reported window when there is no
 * 5-hour one).
 * @param {{ usage: object[] | null, instances?: object[], providerName: (id: string) => string, settings: any }} opts
 */
function usageTitle(opts) {
  const ref = selectedAccountRef(opts.settings, titleProvider(opts.settings));
  const acct = usageAccounts(opts).find((a) => a.ref === ref);
  if (!acct) return "";
  const win = windowOf(acct.row, "5-hour") || (acct.row.status === "ok" ? (acct.row.windows || [])[0] : null);
  return win ? `${acct.short} ${pct(win.usedPercent)}` : acct.short;
}

/**
 * Account rows, their age and "Refresh usage" (pure; tests build it from
 * fake data). "Personal — 5-hour 2% · week 0%", the sign-in email/plan and a
 * near reset as the sublabel. One checkmark per CLI: its default account.
 * Accounts with no usage data stay pickable.
 *
 * @param {{
 *   usage: object[] | null,
 *   instances?: object[],
 *   providerName: (id: string) => string,
 *   accountOf?: (ref: string) => { email?: string, plan?: string } | undefined,
 *   settings: any,
 *   now: number,
 *   updatedAt?: number | null,
 *   onPick: (ref: string) => void,
 *   onRefresh: () => void,
 *   loading?: boolean,
 * }} opts
 */
function usageMenuItems(opts) {
  const items = [];
  let lastBase = null;
  for (const acct of usageAccounts(opts)) {
    if (acct.base !== lastBase) {
      items.push({ label: opts.providerName(acct.base) || acct.base, enabled: false });
      lastBase = acct.base;
    }
    const five = windowOf(acct.row, "5-hour");
    const week = windowOf(acct.row, "weekly");
    const parts = [];
    if (five) parts.push(`5-hour ${pct(five.usedPercent)}`);
    if (week) parts.push(`week ${pct(week.usedPercent)}`);
    const sub = [];
    const who = opts.accountOf ? opts.accountOf(acct.ref) : undefined;
    if (who && who.email) sub.push(who.email);
    if (who && who.plan) sub.push(`${who.plan[0].toUpperCase()}${who.plan.slice(1)} plan`);
    for (const [name, w] of [["5-hour", five], ["Week", week]]) {
      const left = w && w.resetsAt != null ? w.resetsAt - opts.now : null;
      if (left != null && left > 0 && left <= RESET_NEAR_MS) sub.push(`${name} resets in ${inMinutes(left)}`);
    }
    items.push({
      label: `${acct.name} — ${parts.length ? parts.join(" · ") : "no usage data"}`,
      ...(sub.length ? { sublabel: sub.join(" · ") } : {}),
      type: "checkbox",
      checked: acct.ref === selectedAccountRef(opts.settings, acct.base),
      click: () => opts.onPick(acct.ref),
    });
  }
  if (!items.length) {
    items.push({ label: opts.loading ? "Loading usage…" : "No usage data", enabled: false });
  }
  items.push({ type: "separator" });
  if (opts.updatedAt != null) {
    items.push({ label: `Updated ${ago(opts.now - opts.updatedAt)}`, enabled: false });
  }
  items.push({ label: opts.loading ? "Refreshing…" : "Refresh usage", enabled: !opts.loading, click: opts.onRefresh });
  return items;
}

/**
 * Owns "Show usage in the menu bar". On macOS it is its own menu bar Tray;
 * on Windows/Linux the existing close-to-tray menu pulls `items()` instead
 * (`onChange` rebuilds it). Never created headless or with the setting off.
 *
 * Freshness without a tight poll: every usage:providerLimits answer
 * (`setUsage`), live windows from runs (`setLive`), a refetch when the menu
 * opens on data older than 2 minutes (`refreshIfStale`; the menu is built
 * at each click so its age line is current), and one 15-minute timer while
 * the setting is on, for an idle app whose window has reset.
 *
 * @param {{
 *   platform: NodeJS.Platform,
 *   headless: boolean,
 *   Tray: new (icon: any) => any,
 *   Menu: { buildFromTemplate: (t: unknown[]) => any },
 *   icon: any,
 *   getSettings: () => any,
 *   saveSettings: (patch: object) => void,
 *   fetchUsage: () => Promise<object[]>,
 *   providerName: (id: string) => string,
 *   accountOf?: (ref: string) => { email?: string, plan?: string } | undefined,
 *   onShow: () => void,
 *   onQuit: () => void,
 *   onChange?: () => void,
 *   now?: () => number,
 *   setInterval?: typeof setInterval,
 *   clearInterval?: typeof clearInterval,
 * }} opts
 */
function createUsageMenu(opts) {
  const now = opts.now || Date.now;
  const every = opts.setInterval || setInterval;
  const stopEvery = opts.clearInterval || clearInterval;
  /** @type {any[] | null} */
  let usage = null;
  /** @type {Promise<void> | null} */
  let fetching = null;
  let fetchedOnce = false;
  /** Last full fetch; drives refresh-on-open. */
  let fetchedAt = 0;
  /** Last full fetch or live window; shown as "Updated …". */
  let updatedAt = 0;
  let menuBar = null;
  let timer = null;

  const enabled = () => !opts.headless && opts.getSettings().menuBarUsage === true;

  function view() {
    const s = opts.getSettings();
    return {
      usage,
      instances: s.providerInstances || [],
      providerName: opts.providerName,
      accountOf: opts.accountOf,
      settings: s,
      now: now(),
      updatedAt: updatedAt || null,
      loading: Boolean(fetching),
      onPick: pick,
      onRefresh: () => void refresh(),
    };
  }

  function items() {
    return enabled() ? usageMenuItems(view()) : null;
  }

  /** @param {string} ref */
  function pick(ref) {
    opts.saveSettings(defaultAccountPatch(opts.getSettings(), ref));
    sync();
  }

  function refresh() {
    if (fetching) return fetching;
    fetchedOnce = true;
    fetching = Promise.resolve()
      .then(opts.fetchUsage)
      .then((rows) => {
        if (Array.isArray(rows)) {
          usage = rows;
          fetchedAt = updatedAt = now();
        }
      })
      .catch(() => {})
      .finally(() => {
        fetching = null;
        sync();
      });
    sync();
    return fetching;
  }

  /** Menu opened: refetch when the data is over 2 minutes old. */
  function refreshIfStale() {
    if (enabled() && !fetching && now() - fetchedAt > STALE_MS) void refresh();
  }

  /** @param {object[]} rows */
  function setUsage(rows) {
    if (!Array.isArray(rows)) return;
    usage = rows;
    fetchedAt = updatedAt = now();
    sync();
  }

  /**
   * Live windows from a run on account `ref`: replace same-label windows on
   * that row, keep the rest.
   * @param {string} ref @param {any[]} windows
   */
  function setLive(ref, windows) {
    if (!Array.isArray(windows) || !windows.length) return;
    const rows = usage ? usage.slice() : [];
    const at = rows.findIndex((r) => r && r.provider === ref);
    const prev = at >= 0 && rows[at].status === "ok" ? rows[at].windows || [] : [];
    const labels = new Set(windows.map((w) => w.label));
    const row = { provider: ref, status: "ok", windows: [...prev.filter((w) => !labels.has(w.label)), ...windows], fetchedAt: now() };
    if (at >= 0) rows[at] = row;
    else rows.push(row);
    usage = rows;
    updatedAt = now();
    sync();
  }

  function sync() {
    const on = enabled();
    if (on && !timer) {
      timer = every(() => void refresh(), IDLE_REFRESH_MS);
      if (timer && typeof timer.unref === "function") timer.unref();
    } else if (!on && timer) {
      stopEvery(timer);
      timer = null;
    }
    if (on && !fetchedOnce && !usage) {
      void refresh();
      return;
    }
    if (opts.platform !== "darwin") {
      if (opts.onChange) opts.onChange();
      return;
    }
    if (!on) {
      if (menuBar) menuBar.destroy();
      menuBar = null;
      return;
    }
    if (!menuBar) {
      menuBar = new opts.Tray(opts.icon);
      menuBar.setToolTip("Solenta");
      // Built at click time, not stored with setContextMenu: the age line
      // and percentages are as of opening, and opening on stale data refetches
      // (the next open shows the answer; an open NSMenu cannot be re-laid).
      menuBar.on("click", open);
      menuBar.on("right-click", open);
    }
    menuBar.setTitle(usageTitle(view()));
  }

  function buildMenu() {
    return opts.Menu.buildFromTemplate([
      ...usageMenuItems(view()),
      { label: "Open Solenta", click: opts.onShow },
      { type: "separator" },
      { label: "Quit", click: opts.onQuit },
    ]);
  }

  function open() {
    refreshIfStale();
    if (menuBar) menuBar.popUpContextMenu(buildMenu());
  }

  return {
    items,
    sync,
    refresh,
    refreshIfStale,
    setUsage,
    setLive,
    /** The macOS menu bar Tray, or null. */
    get menuBar() {
      return menuBar;
    },
    destroy() {
      if (timer) stopEvery(timer);
      timer = null;
      if (menuBar) menuBar.destroy();
      menuBar = null;
    },
  };
}

/**
 * Create and own the tray icon. `refresh()` rebuilds the context menu (the
 * running-thread count can change at any time); callers decide when to call
 * it — main.js calls it on "right-click" so the count is never stale.
 *
 * @param {{
 *   Tray: new (iconPath: string) => { setToolTip: (s: string) => void, setContextMenu: (m: unknown) => void, on: (ev: string, fn: () => void) => void, destroy: () => void },
 *   Menu: { buildFromTemplate: (t: unknown[]) => unknown },
 *   iconPath: string,
 *   getRunningCount: () => number,
 *   getUsageItems?: () => object[] | null,
 *   onShow: () => void,
 *   onQuit: () => void,
 * }} opts
 */
function createTray({ Tray, Menu, iconPath, getRunningCount, getUsageItems, onShow, onQuit }) {
  const tray = new Tray(iconPath);
  tray.setToolTip("Solenta");
  function refresh() {
    const template = trayMenuTemplate({
      runningCount: Number(getRunningCount()) || 0,
      onShow,
      onQuit,
      usageItems: getUsageItems ? getUsageItems() : null,
    });
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }
  refresh();
  tray.on("click", onShow);
  tray.on("right-click", refresh);
  return {
    tray,
    refresh,
    destroy: () => tray.destroy(),
  };
}

module.exports = {
  shouldHideOnClose,
  trayMenuTemplate,
  createTray,
  selectedAccountRef,
  titleProvider,
  defaultAccountPatch,
  usageTitle,
  usageMenuItems,
  createUsageMenu,
};
