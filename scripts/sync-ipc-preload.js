#!/usr/bin/env node
/**
 * Inline src/shared/ipcChannels.ts into electron/preload.js.
 *
 * Sandbox preload cannot require a local module, so the table is copied
 * between markers. `--check` exits 1 when the copy is stale (wired into
 * `npm run typecheck`).
 *
 *   node --experimental-strip-types scripts/sync-ipc-preload.js
 *   node --experimental-strip-types scripts/sync-ipc-preload.js --check
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const PRELOAD = path.join(ROOT, "electron", "preload.js");
const TABLE = path.join(ROOT, "src", "shared", "ipcChannels.ts");

const PUSH_START = "/* <ipc-push> */";
const PUSH_END = "/* </ipc-push> */";
const CHANNELS_START = "/* <ipc-channels> */";
const CHANNELS_END = "/* </ipc-channels> */";

function formatPush(channels) {
  const inner = channels.map((c) => `  "${c}",`).join("\n");
  return `${PUSH_START}\nconst PUSH_CHANNELS = new Set([\n${inner}\n]);\n${PUSH_END}`;
}

function formatChannels(rows) {
  const inner = rows
    .map((r) => `  { ns: "${r.ns}", method: "${r.method}" },`)
    .join("\n");
  return `${CHANNELS_START}\nconst IPC_CHANNELS = Object.freeze([\n${inner}\n]);\n${CHANNELS_END}`;
}

function replaceBlock(src, start, end, block) {
  const i = src.indexOf(start);
  const j = src.indexOf(end);
  if (i < 0 || j < 0 || j < i) {
    throw new Error(`preload.js missing markers ${start} … ${end}`);
  }
  return src.slice(0, i) + block + src.slice(j + end.length);
}

async function main() {
  const check = process.argv.includes("--check");
  const mod = await import(pathToFileURL(TABLE).href);
  const current = fs.readFileSync(PRELOAD, "utf8");
  let next = replaceBlock(
    current,
    PUSH_START,
    PUSH_END,
    formatPush(mod.PUSH_CHANNELS),
  );
  next = replaceBlock(
    next,
    CHANNELS_START,
    CHANNELS_END,
    formatChannels(mod.IPC_CHANNELS),
  );
  if (next === current) {
    if (!check) process.stderr.write("preload.js already matches ipcChannels.ts\n");
    return;
  }
  if (check) {
    process.stderr.write(
      "electron/preload.js is stale. Run:\n  node --experimental-strip-types scripts/sync-ipc-preload.js\n",
    );
    process.exit(1);
  }
  fs.writeFileSync(PRELOAD, next);
  process.stderr.write("updated electron/preload.js from ipcChannels.ts\n");
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
  process.exit(1);
});
