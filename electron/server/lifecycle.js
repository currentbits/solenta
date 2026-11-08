"use strict";
// Service ownership stays outside the backend so an unloadable version cannot
// prevent the operator from stopping or uninstalling its service.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { processAlive } = require("./dataLock.js");
const quoteUnit = (s) => `"${String(s).replace(/[%\\"\n\r]/g, (c) => c === "%" ? "%%" : c === "\n" || c === "\r" ? "" : `\\${c}`)}"`;
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
function createLifecycle(options = {}, deps = {}) {
  const home = options.home || os.homedir();
  const dataDir = path.resolve(options.dataDir || path.join(home, ".solenta/data"));
  const root = path.resolve(options.root || path.join(home, ".solenta/server"));
  const platform = deps.platform || process.platform;
  const uid = deps.uid ?? process.getuid?.();
  const key = crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 12);
  const name = `solenta-server-${key}`;
  const stateFile = path.join(root, `service-${key}.json`);
  const current = path.join(root, `current-${key}`);
  const log = path.join(root, `service-${key}.log`);
  const manager = platform === "linux" ? "systemd-user" : platform === "darwin" ? "launchd" : null;
  const unit = platform === "linux" ? path.join(home, ".config/systemd/user", `${name}.service`) : path.join(home, "Library/LaunchAgents", `app.solenta.${name}.plist`);
  const domain = `gui/${uid}`;
  const label = `app.solenta.${name}`;
  const run = deps.run || ((command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }));
  const attempt = (command, args) => { try { return { ok: true, text: String(run(command, args)) }; } catch (error) { return { ok: false, text: String(error.stderr || error.message) }; } };
  const state = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
  const save = (s) => { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); const tmp = `${stateFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(tmp, stateFile); };
  const owned = () => { const s = state(); if (!s || !fs.existsSync(unit)) throw new Error("This server is externally managed. Install its user service explicitly before using lifecycle actions."); if (s.dataDir !== dataDir) throw new Error("Service belongs to another data directory."); return s; };
  function status() {
    const installed = !!state() && fs.existsSync(unit);
    const probe = manager === "systemd-user" ? attempt("systemctl", ["--user", "show-environment"]) : manager === "launchd" ? attempt("launchctl", ["print", domain]) : { ok: false };
    const running = installed && (manager === "systemd-user" ? attempt("systemctl", ["--user", "is-active", `${name}.service`]) : attempt("launchctl", ["print", `${domain}/${label}`]));
    let externalRunning = false;
    if (!installed) {
      try { const owner = JSON.parse(fs.readFileSync(path.join(dataDir, ".server-lock/owner.json"), "utf8")); externalRunning = Number.isInteger(owner.pid) && processAlive(owner.pid); } catch { /* No live external writer proven. */ }
    }
    const linger = manager === "systemd-user" ? attempt("loginctl", ["show-user", String(uid), "--property=Linger", "--value"]) : null;
    return { mode: installed ? "managed" : "external", manager, installed, available: probe.ok, running: externalRunning || (!!running?.ok && (manager !== "launchd" || /pid = \d+/.test(running.text))), ...(linger?.ok ? { linger: linger.text.trim() === "yes" } : {}), sessionLimit: manager === "systemd-user" ? "A user manager is required. Running after logout or before login requires the host administrator to enable linger." : manager === "launchd" ? "Starts in this user's GUI login session and stops at logout. No pre-login or reboot-without-login guarantee." : "No supported user service manager on this platform." };
  }
  async function ensureIdle() {
    if (!deps.inspectWork) throw new Error("Cannot verify active work; refusing to stop the server.");
    const work = await deps.inspectWork();
    if (!work || work.active !== 0) throw new Error("This computer has active runs or terminals, or activity could not be checked. Finish them before stopping or updating.");
  }
  const maintenance = path.join(dataDir, ".server-maintenance-request");
  const pending = path.join(root, `update-${key}.json`);
  const start = () => { owned(); if (manager === "systemd-user") run("systemctl", ["--user", "start", `${name}.service`]); else run("launchctl", ["kickstart", `${domain}/${label}`]); };
  async function stop() {
    owned();
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(maintenance, "Server lifecycle operation in progress.\n", { mode: 0o600 });
    try { if (status().running || fs.existsSync(path.join(dataDir, ".server-lock"))) await ensureIdle(); }
    catch (error) { fs.rmSync(maintenance, { force: true }); error.safeNoStop = true; throw error; }
    if (manager === "systemd-user") run("systemctl", ["--user", "stop", `${name}.service`]); else run("launchctl", ["kill", "SIGTERM", `${domain}/${label}`]);
    // systemd waits for termination; launchd KeepAlive would immediately respawn,
    // so unload the job. start() bootstraps it again when absent.
    if (manager === "launchd") run("launchctl", ["bootout", `${domain}/${label}`]);
    await (deps.waitStopped || waitStopped)(dataDir);
  }
  async function install(runtime, port = 4620, target = {}) {
    const s = status();
    if (!s.available) throw new Error(s.sessionLimit + " The service manager is unavailable; run solenta-server explicitly for external management.");
    if (s.installed) {
      const installed = owned();
      if (fs.realpathSync(runtime) !== installed.runtime || Number(port) !== installed.port) throw new Error("A different managed runtime already exists. Use update explicitly.");
      return action("start");
    }
    if (fs.existsSync(path.join(dataDir, ".server-lock"))) throw new Error("An external server owns this data directory. Stop it before installing a service.");
    runtime = fs.realpathSync(runtime);
    if (!fs.existsSync(path.join(runtime, "bin/solenta-server"))) throw new Error("Not a Solenta server runtime.");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.symlinkSync(runtime, current);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    const args = [path.join(current, "bin/solenta-server"), "--data-dir", dataDir, "--host", "127.0.0.1", "--port", String(port)];
    const text = manager === "systemd-user" ? `[Unit]\nDescription=Solenta server\n[Service]\nExecStart=${args.map(quoteUnit).join(" ")}\nRestart=on-failure\nTimeoutStopSec=60\n[Install]\nWantedBy=default.target\n` : `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>`;
    fs.writeFileSync(unit, text, { mode: 0o600 });
    save({ dataDir, runtime, port, manager });
    try {
      if (manager === "systemd-user") { run("systemctl", ["--user", "daemon-reload"]); run("systemctl", ["--user", "enable", "--now", `${name}.service`]); }
      else run("launchctl", ["bootstrap", domain, unit]);
      if (deps.ready) await deps.ready(port, runtime, target);
      return status();
    } catch (error) { throw new Error(`Service installation did not reach readiness: ${error.message}. Inspect status/logs before retrying.`); }
  }
  async function action(action) {
    if (action === "status") return { ...status(), recoveryRequired: fs.existsSync(pending) };
    if (action === "logs") { const s = status(); return { ...s, logs: manager === "systemd-user" ? run("journalctl", ["--user", "-u", `${name}.service`, "-n", "80", "--no-pager"]) : fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(-32768) : "No service log yet." }; }
    owned();
    if (fs.existsSync(pending)) throw new Error("An outstanding update requires recovery before another lifecycle action.");
    if (action === "start") {
      if (fs.existsSync(pending)) throw new Error("An interrupted update requires recovery; use solenta-service recover.");
      fs.rmSync(maintenance, { force: true }); if (manager === "launchd" && !attempt("launchctl", ["print", `${domain}/${label}`]).ok) run("launchctl", ["bootstrap", domain, unit]); else start(); if (deps.ready) await deps.ready(state().port, state().runtime); }
    else if (action === "stop") await stop();
    else if (action === "restart") { await stop(); return actionStart(); }
    else if (action === "uninstall") {
      if (status().running) await stop();
      if (manager === "systemd-user") run("systemctl", ["--user", "disable", `${name}.service`]);
      else attempt("launchctl", ["bootout", `${domain}/${label}`]);
      fs.unlinkSync(unit); fs.unlinkSync(stateFile); fs.unlinkSync(current);
      if (manager === "systemd-user") run("systemctl", ["--user", "daemon-reload"]);
    } else throw new Error("Unknown lifecycle action.");
    if (action !== "stop") fs.rmSync(maintenance, { force: true });
    return status();
  }
  function point(runtime) {
    const tmp = `${current}.${process.pid}.tmp`;
    fs.symlinkSync(runtime, tmp); fs.renameSync(tmp, current);
  }
  function writeJournal(journal, first = false) {
    if (first && fs.existsSync(pending)) throw new Error("An update journal already exists.");
    const tmp = `${pending}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(journal)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, pending);
  }
  async function update(runtime, target = {}) {
    const old = owned();
    if (fs.existsSync(pending)) throw new Error("An interrupted update requires recovery first.");
    runtime = fs.realpathSync(runtime);
    if (!deps.verifyRuntime || !deps.trial || !deps.ready) throw new Error("Update verification is unavailable.");
    await deps.verifyRuntime(runtime, target);
    const backup = path.join(root, `.data-backup-${key}`);
    // A whole data-directory snapshot includes JSON envelope/shards, tokens,
    // settings, memory database/WAL and ancillary state. No external project
    // files or provider-home configuration is part of this rollback boundary.
    if (fs.existsSync(backup)) throw new Error("An earlier data backup exists; inspect it before updating.");
    await (deps.checkBackupSpace || checkBackupSpace)(dataDir, root);
    const journal = { old, backup, runtime, dataDir, target, phase: "quiescing" };
    writeJournal(journal, true);
    let activated = false;
    let committedStatus;
    try {
      await stop();
      journal.phase = "snapshot"; writeJournal(journal);
      fs.cpSync(dataDir, backup, { recursive: true, dereference: false, filter: (src) => ![".server-lock", ".server-lock.guard"].includes(path.basename(src)) });
      journal.phase = "trial"; writeJournal(journal);
      await deps.trial(runtime, old.port, dataDir, target);
      point(runtime); save({ ...old, runtime });
      journal.phase = "activate"; writeJournal(journal);
      if (manager === "launchd") run("launchctl", ["bootstrap", domain, unit]); else start();
      await deps.ready(old.port, runtime, target);
      const metadata = JSON.parse(fs.readFileSync(path.join(runtime, "app/package.json"), "utf8"));
      committedStatus = { ...status(), updated: true, releaseTag: metadata.releaseTag, buildSha: metadata.buildSha };
      journal.phase = "commit-ready"; writeJournal(journal);
      // Removing the marker is the activation commit. A journal left after
      // this point is finalized by recovery; it can never restore stale data
      // underneath work that the released process has since accepted.
      fs.rmSync(maintenance, { force: true });
      activated = true;
      return await finishCleanup(committedStatus, backup);
    } catch (error) {
      if (activated) return { ...committedStatus, cleanupWarning: `The updated runtime is ready; post-activation cleanup failed: ${error.message}` };
      if (error.safeNoStop) { fs.rmSync(pending, { force: true }); throw error; }
      try { await recover(journal); }
      catch (restoreError) { throw new Error(`Update failed: ${error.message}. Recovery is incomplete: ${restoreError.message}. Service remains blocked; run recover after inspecting logs.`); }
      throw new Error(`Update failed: ${error.message}. Previous runtime and data directory were restored.`);
    }
  }
  async function recover(journal) {
    if (!journal) journal = JSON.parse(fs.readFileSync(pending, "utf8"));
    const released = !fs.existsSync(maintenance);
    const finalizing = (journal.phase === "commit-ready" && released) || journal.phase === "rollback-ready";
    if (finalizing) {
      const runtime = journal.phase === "commit-ready" ? journal.runtime : journal.old.runtime;
      const saved = owned();
      if (fs.realpathSync(saved.runtime) !== fs.realpathSync(runtime) || fs.realpathSync(current) !== fs.realpathSync(runtime)) throw new Error("The runtime no longer matches the recovery journal. Inspect it before continuing.");
      if (!status().running) {
        if (manager === "launchd") run("launchctl", ["bootstrap", domain, unit]); else start();
      }
      await deps.ready(saved.port, runtime, journal.phase === "commit-ready" ? journal.target : undefined);
      const finalStatus = status();
      fs.rmSync(maintenance, { force: true });
      return finishCleanup(finalStatus, journal.backup);
    }
    // Never replace state under a live writer, even during recovery. A
    // journal may have been written before stop created its marker.
    const hadMarker = fs.existsSync(maintenance);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(maintenance, "Server recovery in progress.\n", { mode: 0o600 });
    try { if (status().running || fs.existsSync(path.join(dataDir, ".server-lock"))) await ensureIdle(); }
    catch (error) { if (!hadMarker) fs.rmSync(maintenance, { force: true }); throw error; }
    if (manager === "systemd-user") run("systemctl", ["--user", "stop", `${name}.service`]);
    else attempt("launchctl", ["bootout", `${domain}/${label}`]);
    await (deps.waitStopped || waitStopped)(dataDir);
    if (!["snapshot", "quiescing"].includes(journal.phase)) {
      const failed = `${dataDir}.failed-update-${Date.now()}`;
      fs.renameSync(dataDir, failed);
      fs.cpSync(journal.backup, dataDir, { recursive: true, dereference: false });
      // Failed trial data is retained for diagnosis. It may contain secrets.
    }
    point(journal.old.runtime); save(journal.old);
    journal.phase = "rollback-ready"; writeJournal(journal);
    if (manager === "launchd") run("launchctl", ["bootstrap", domain, unit]); else start();
    await deps.ready(journal.old.port, journal.old.runtime);
    const restoredStatus = status();
    fs.rmSync(maintenance, { force: true });
    return finishCleanup(restoredStatus, journal.backup);
  }
  async function finishCleanup(result, backup) {
    const warnings = [];
    try {
      if (deps.removeJournal) await deps.removeJournal(pending);
      else fs.rmSync(pending, { force: true });
    } catch (error) { warnings.push(`update journal: ${error.message}`); }
    try {
      if (deps.removeBackup) await deps.removeBackup(backup);
      else fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) { warnings.push(`old data snapshot: ${error.message}`); }
    return warnings.length ? { ...result, cleanupWarning: `The runtime is ready. Cleanup needs attention (${warnings.join("; ")}).` } : result;
  }
  async function prepare(runtime, port = 4620, target = {}) {
    // Connect may stage a newer helper, but starting an existing owner is not
    // permission to replace its runtime or change its saved listener config.
    return status().installed ? action("start") : install(runtime, port, target);
  }
  async function actionStart() { return action("start"); }
  return { status, action, install, prepare, update, recover, paths: { root, dataDir, current, stateFile, unit }, state, save, stop };
}
async function waitStopped(dataDir) {
  for (let i = 0; i < 600; i++) {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(path.join(dataDir, ".server-lock/owner.json"), "utf8")); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    if (!processAlive(owner.pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("The server did not stop; runtime and data were not replaced.");
}
function checkBackupSpace(dataDir, backupRoot) {
  let bytes = 0;
  function visit(file) {
    const s = fs.lstatSync(file);
    if (s.isSymbolicLink()) { bytes += s.size; return; }
    if (s.isDirectory()) { for (const name of fs.readdirSync(file)) if (![".server-lock", ".server-lock.guard"].includes(name)) visit(path.join(file, name)); return; }
    if (!s.isFile()) throw new Error(`Cannot snapshot unsupported data entry ${file}; inspect it before updating. The server was not stopped.`);
    bytes += s.size;
  }
  if (fs.existsSync(dataDir)) visit(dataDir);
  const stats = fs.statfsSync(backupRoot);
  // A rollback retains failed trial data and creates a fresh restored copy.
  // Reserve both complete copies, plus growth/metadata headroom. No reflink
  // or hard-link assumption is made for mutable JSON and database files.
  const needed = Math.ceil(bytes * 2.2) + 64 * 1024 * 1024;
  const free = stats.bavail * stats.bsize;
  if (free < needed) throw new Error(`Not enough disk space to snapshot and restore the server data directory: ${Math.ceil(needed / 1048576)} MiB needed, ${Math.floor(free / 1048576)} MiB free. Free space and retry. The server was not stopped.`);
  return { bytes, needed, free };
}
module.exports = { createLifecycle, waitStopped, checkBackupSpace };
