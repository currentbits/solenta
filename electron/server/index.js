#!/usr/bin/env node
"use strict";

/**
 * solenta-server (#1829): Solenta's `--headless --serve-web` host in plain
 * Node, no Electron. Same boot as the desktop app (electron/main.js) behind
 * a stand-in `electron` module, so a second computer needs no desktop app.
 *
 *   node electron/server/index.js [--port N] [--host ADDR] [--data-dir DIR]
 *
 * Data defaults to ~/.solenta/data, kept apart from a desktop Solenta's own
 * data dir so both can run on one machine. Solenta Web's token is in
 * <data-dir>/web-token, where SSH connect already reads it.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { createElectronShim } = require("./electronShim.js");

function parseArgs(argv) {
  const out = { port: 4620, host: "127.0.0.1", dataDir: path.join(os.homedir(), ".solenta", "data") };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--port") out.port = Number(value());
    else if (flag === "--host") out.host = value();
    else if (flag === "--data-dir") out.dataDir = path.resolve(value());
    else if (flag === "--link") out.link = value();
    else if (flag === "--link-label") out.linkLabel = value();
    else if (flag === "--version") out.version = true;
    else if (flag === "--help") out.help = true;
    else throw new Error(`Unknown option ${argv[i]}. Try --help.`);
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error("--port must be 0-65535");
  return out;
}

const appRoot = path.join(__dirname, "..", "..");
const { version } = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
if (opts.version) {
  console.log(version);
  process.exit(0);
}
if (opts.help) {
  console.log("solenta-server [--port N] [--host ADDR] [--data-dir DIR] [--link DEVICE_LINK [--link-label NAME]]\nRuns Solenta's web host without the desktop app. --link lets its agents fork workers onto another Solenta (paste a Full access device link from that computer).");
  process.exit(0);
}

fs.mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
// No keychain here: settings secrets stay in the 0600 store, like dev builds.
process.env.SOLENTA_ENABLE_SAFE_STORAGE = "0";
process.env.SOLENTA_SERVER = "1";
if (opts.link) process.env.SOLENTA_LINK = opts.link;
if (opts.linkLabel) process.env.SOLENTA_LINK_LABEL = opts.linkLabel;

const electron = createElectronShim({ userData: opts.dataDir, appPath: appRoot, version });
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return electron;
  return load.call(this, request, ...rest);
};

process.argv = [process.argv[0], path.join(appRoot, "electron", "main.js"), "--headless", `--serve-web=${opts.port}`, `--serve-host=${opts.host}`];
require("../main.js");
