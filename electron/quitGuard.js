"use strict";

/**
 * Accidental-quit guard (issue #1195).
 *
 * User-initiated quit with live work gets a native dialog before any
 * teardown. Warm idle provider processes (CLI keepalives, ejected
 * sessions) are not "active work" and must not trip the dialog.
 *
 * Signal/crash paths never call this: they go straight to shutdown.
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
 * Snapshot of work that quit would destroy. Counts only managed, in-flight
 * work: runner `active` (+ side questions), persisted questions/plans,
 * live terminal shells, and running dev servers.
 *
 * @param {{
 *   listActiveThreadIds?: () => string[],
 *   listActiveBtwCount?: () => number,
 *   listThreads?: () => Array<{
 *     id?: string,
 *     title?: string,
 *     pendingQuestion?: unknown,
 *     pendingPlan?: unknown,
 *     awaitingInput?: boolean,
 *   }>,
 *   listLiveTerminals?: () => unknown[],
 *   listLiveDevServers?: () => unknown[],
 * }} [deps]
 */
function collectActiveWork(deps = {}) {
  const runIds = typeof deps.listActiveThreadIds === "function"
    ? deps.listActiveThreadIds() || []
    : [];
  const btw =
    typeof deps.listActiveBtwCount === "function"
      ? Number(deps.listActiveBtwCount()) || 0
      : 0;
  const threads =
    typeof deps.listThreads === "function" ? deps.listThreads() || [] : [];
  const terminals =
    typeof deps.listLiveTerminals === "function"
      ? deps.listLiveTerminals() || []
      : [];
  const servers =
    typeof deps.listLiveDevServers === "function"
      ? deps.listLiveDevServers() || []
      : [];
  const runSet = new Set(runIds);
  const byId = new Map();
  for (const t of threads) {
    if (t && t.id != null) byId.set(t.id, t);
  }
  const runTitles = [];
  for (const id of runIds) {
    const t = byId.get(id);
    const title = t && typeof t.title === "string" ? t.title.trim() : "";
    runTitles.push(title || "Untitled");
  }
  let questions = 0;
  let approvals = 0;
  for (const t of threads) {
    if (!t) continue;
    if (t.pendingQuestion) questions += 1;
    else if (t.pendingPlan) approvals += 1;
    else if (t.awaitingInput && !runSet.has(t.id)) approvals += 1;
  }
  const terminalCount = Array.isArray(terminals) ? terminals.length : 0;
  const serverCount = Array.isArray(servers) ? servers.length : 0;
  const runs = runIds.length + btw;
  return {
    runs,
    questions,
    approvals,
    terminals: terminalCount,
    servers: serverCount,
    runTitles: runTitles.slice(0, 5),
    hasWork:
      runs + questions + approvals + terminalCount + serverCount > 0,
  };
}

/**
 * @param {ReturnType<typeof collectActiveWork>} snapshot
 * @param {{ reason?: "quit" | "update" }} [opts]
 */
function formatQuitDialog(snapshot, opts = {}) {
  const reason = opts.reason === "update" ? "update" : "quit";
  const lines = [];
  if (snapshot.runs) {
    lines.push(plural(snapshot.runs, "running agent", "running agents"));
  }
  if (snapshot.questions) {
    lines.push(
      plural(
        snapshot.questions,
        "question waiting for an answer",
        "questions waiting for an answer",
      ),
    );
  }
  if (snapshot.approvals) {
    lines.push(
      plural(
        snapshot.approvals,
        "plan or approval waiting",
        "plans or approvals waiting",
      ),
    );
  }
  if (snapshot.terminals) {
    lines.push(
      plural(snapshot.terminals, "terminal session", "terminal sessions"),
    );
  }
  if (snapshot.servers) {
    lines.push(plural(snapshot.servers, "dev server", "dev servers"));
  }
  if (snapshot.runTitles && snapshot.runTitles.length) {
    lines.push("");
    for (const title of snapshot.runTitles) lines.push(title);
  }
  return {
    title:
      reason === "update" ? "Stop work and restart?" : "Stop work and quit?",
    message:
      reason === "update"
        ? "Restarting to update will stop this work."
        : "Quitting will stop this work.",
    detail: lines.join("\n"),
    confirmLabel:
      reason === "update" ? "Stop work and restart" : "Stop work and quit",
    cancelLabel: "Cancel",
    checkboxLabel: "Don't ask again",
  };
}

/**
 * Last-window close on Windows/Linux is a quit. macOS window close is not.
 * Serve-web keeps the process up after the last window, so never block it.
 *
 * @param {{
 *   platform?: NodeJS.Platform,
 *   serveWeb?: boolean,
 *   shuttingDown?: boolean,
 *   wouldConfirm?: boolean | (() => boolean),
 * }} [opts]
 */
function shouldBlockWindowClose(opts = {}) {
  if (opts.platform === "darwin") return false;
  if (opts.serveWeb) return false;
  if (opts.shuttingDown) return false;
  if (typeof opts.wouldConfirm === "function") return Boolean(opts.wouldConfirm());
  return Boolean(opts.wouldConfirm);
}

/**
 * Native dialog used by the live app. Injected in tests.
 *
 * @param {ReturnType<typeof formatQuitDialog>} spec
 * @param {{
 *   dialog?: { showMessageBox: Function },
 *   BrowserWindow?: { getFocusedWindow: Function, getAllWindows: Function },
 * }} [deps]
 */
async function showNativeQuitDialog(spec, deps = {}) {
  const electron = deps.dialog && deps.BrowserWindow ? null : require("electron");
  const dialog = deps.dialog || electron.dialog;
  const BrowserWindow = deps.BrowserWindow || electron.BrowserWindow;
  const win =
    (BrowserWindow.getFocusedWindow && BrowserWindow.getFocusedWindow()) ||
    (BrowserWindow.getAllWindows
      ? BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed())
      : null);
  const payload = {
    type: "warning",
    buttons: [spec.cancelLabel, spec.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: spec.title,
    message: spec.message,
    detail: spec.detail,
    checkboxLabel: spec.checkboxLabel,
    checkboxChecked: false,
  };
  if (win && typeof dialog.showMessageBox === "function") {
    return dialog.showMessageBox(win, payload);
  }
  return dialog.showMessageBox(payload);
}

/**
 * @param {{
 *   collect?: () => ReturnType<typeof collectActiveWork>,
 *   getSettings?: () => { confirmQuitWithActiveWork?: boolean } | null,
 *   setSettings?: (patch: { confirmQuitWithActiveWork: boolean }) => void,
 *   showDialog?: (spec: ReturnType<typeof formatQuitDialog>) => Promise<{
 *     response?: number,
 *     checkboxChecked?: boolean,
 *   }>,
 *   listActiveThreadIds?: () => string[],
 *   listActiveBtwCount?: () => number,
 *   listThreads?: () => object[],
 *   listLiveTerminals?: () => unknown[],
 *   listLiveDevServers?: () => unknown[],
 * }} [opts]
 */
function createQuitPolicy(opts = {}) {
  let skipOnce = false;
  let confirming = false;

  function snapshot() {
    if (typeof opts.collect === "function") return opts.collect();
    return collectActiveWork(opts);
  }

  function settingOn() {
    const s = typeof opts.getSettings === "function" ? opts.getSettings() : null;
    return !s || s.confirmQuitWithActiveWork !== false;
  }

  function wouldConfirm() {
    if (skipOnce) return false;
    if (!settingOn()) return false;
    return snapshot().hasWork;
  }

  /**
   * @param {string | { reason?: string }} [reasonOrOpts]
   * @returns {Promise<boolean>} true → proceed with shutdown
   */
  async function confirmQuit(reasonOrOpts) {
    if (skipOnce) {
      skipOnce = false;
      return true;
    }
    if (!settingOn()) return true;
    const snap = snapshot();
    if (!snap.hasWork) return true;
    if (confirming) return false;
    confirming = true;
    const reason =
      typeof reasonOrOpts === "string"
        ? reasonOrOpts
        : reasonOrOpts && reasonOrOpts.reason === "update"
          ? "update"
          : "quit";
    try {
      const spec = formatQuitDialog(snap, { reason });
      const show =
        typeof opts.showDialog === "function"
          ? opts.showDialog
          : (s) => showNativeQuitDialog(s);
      const result = await show(spec);
      const response =
        result && typeof result.response === "number" ? result.response : 0;
      const confirmed = response === 1;
      if (confirmed && result && result.checkboxChecked) {
        if (typeof opts.setSettings === "function") {
          opts.setSettings({ confirmQuitWithActiveWork: false });
        }
      }
      return confirmed;
    } finally {
      confirming = false;
    }
  }

  function markSkipOnce() {
    skipOnce = true;
  }

  return {
    confirmQuit,
    wouldConfirm,
    markSkipOnce,
    snapshot,
  };
}

module.exports = {
  collectActiveWork,
  formatQuitDialog,
  shouldBlockWindowClose,
  showNativeQuitDialog,
  createQuitPolicy,
};
