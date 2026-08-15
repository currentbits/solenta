// `npm run dev`: Vite for HMR, Electron pointed at it.
//
// main.js already loads http://localhost:5173 when isDev, so this is the real
// main process — real services, real git, real providers — with hot reload.
// Browser-only Vite (`npm run dev:browser`) falls back to src/devCoder.ts,
// which is seeded fixtures, NOT a second implementation: anything it reports
// about settle/PR/worktree/provider rules is a guess. Dev on this script.
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const PORT = Number(process.env.PORT || 5173);
const ROOT = path.join(__dirname, "..");
const children = [];
let quitting = false;

function run(bin, args, env) {
  const child = spawn(bin, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  children.push(child);
  // Either half dying takes the pair down: a stale Vite behind a closed window
  // is the thing that makes people reach for a browser tab in the first place.
  child.on("exit", (code) => {
    if (quitting) return;
    quitting = true;
    for (const c of children) if (c !== child) c.kill();
    process.exit(code ?? 0);
  });
}

// fetch, not a raw socket: Vite binds localhost as ::1 here, and fetch tries
// both stacks the way Electron's loadURL will.
async function waitForServer(url) {
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    quitting = true;
    for (const c of children) c.kill();
    process.exit(0);
  });
}

const url = `http://localhost:${PORT}`;
const viteBin = path.join(
  ROOT,
  "node_modules/.bin",
  process.platform === "win32" ? "vite.cmd" : "vite",
);
run(viteBin, ["--port", String(PORT), "--strictPort"]);
// electron's node entry point exports the binary path.
waitForServer(url).then(() =>
  run(require("electron"), ["."], { VITE_DEV_SERVER_URL: url }),
);
