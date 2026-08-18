#!/usr/bin/env node
// Launch electron/smoke.js. On Linux, Chromium aborts before any JS runs
// when it is root without --no-sandbox (electron_main_delegate), and the
// npm-installed chrome-sandbox is not setuid so CI cannot use the SUID
// helper either. app.commandLine.appendSwitch is too late. The packaged
// app is unchanged — this wrapper is the smoke entry only.
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const electron = require("electron");
const args = [];
if (process.platform === "linux") args.push("--no-sandbox");
args.push(path.join(__dirname, "..", "electron", "smoke.js"));
args.push(...process.argv.slice(2));

const r = spawnSync(electron, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
