#!/usr/bin/env node
// Launch electron/smoke.js, then electron/preview-smoke.js (Browser pane
// evidence on a real guest, #1191). On Linux, Chromium aborts before any JS runs
// when it is root without --no-sandbox (electron_main_delegate), and the
// npm-installed chrome-sandbox is not setuid so CI cannot use the SUID
// helper either. app.commandLine.appendSwitch is too late. The packaged
// app is unchanged — this wrapper is the smoke entry only.
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const electron = require("electron");
const base = process.platform === "linux" ? ["--no-sandbox"] : [];
const dir = path.join(__dirname, "..", "electron");

const r = spawnSync(
  electron,
  [...base, path.join(dir, "smoke.js"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
function report(name, res) {
  if (res.status === 0) return;
  console.error(
    `${name} exited status=${res.status} signal=${res.signal}` +
      (res.error ? ` error=${res.error.message}` : ""),
  );
  process.exit(res.status || 1);
}
report("smoke.js", r);
const p = spawnSync(electron, [...base, path.join(dir, "preview-smoke.js")], {
  stdio: "inherit",
});
report("preview-smoke.js", p);
