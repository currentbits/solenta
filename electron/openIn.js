"use strict";
/**
 * "Open in ‹editor›" for Thread details (#1411). A fixed allowlist: the
 * renderer only ever sends an id, never an app name or a command line.
 *
 * macOS opens via `open -a <App>` (installed = the .app bundle exists);
 * elsewhere via the editor's CLI (installed = on PATH). The file manager
 * is always available and goes through Electron's shell.openPath.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

/** @typedef {"cursor" | "vscode" | "zed" | "terminal" | "finder"} EditorId */

const EDITORS = [
  { id: "cursor", name: "Cursor", macApp: "Cursor", bin: "cursor" },
  { id: "vscode", name: "VS Code", macApp: "Visual Studio Code", bin: "code" },
  { id: "zed", name: "Zed", macApp: "Zed", bin: "zed" },
  { id: "terminal", name: "Terminal", macApp: "Terminal", bin: null },
  { id: "finder", name: "Finder", macApp: null, bin: null },
];

function defaultDeps() {
  return {
    platform: process.platform,
    home: os.homedir(),
    exists: (p) => fs.existsSync(p),
    onPath: (bin) =>
      String(process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .some((dir) => {
          const names =
            process.platform === "win32" ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
          return names.some((n) => fs.existsSync(path.join(dir, n)));
        }),
  };
}

/**
 * Installed editors, file manager last.
 * @param {ReturnType<typeof defaultDeps>} [deps]
 * @returns {{ id: EditorId, name: string }[]}
 */
function listEditors(deps = defaultDeps()) {
  const mac = deps.platform === "darwin";
  const out = [];
  for (const e of EDITORS) {
    if (e.id === "finder") {
      out.push({ id: e.id, name: mac ? "Finder" : "File manager" });
      continue;
    }
    if (mac) {
      const bundles = [
        `/Applications/${e.macApp}.app`,
        path.join(deps.home, "Applications", `${e.macApp}.app`),
        `/System/Applications/Utilities/${e.macApp}.app`,
      ];
      if (bundles.some((b) => deps.exists(b))) out.push({ id: e.id, name: e.name });
    } else if (e.bin && deps.onPath(e.bin)) {
      out.push({ id: e.id, name: e.name });
    }
  }
  return out;
}

/**
 * Open `target` (already validated by the caller) with editor `id`.
 * @param {string} target
 * @param {string} id
 * @param {{ platform?: string, openPath: (p: string) => Promise<string>, run?: (cmd: string, args: string[]) => Promise<void> }} deps
 */
async function openIn(target, id, deps) {
  const editor = EDITORS.find((e) => e.id === id);
  if (!editor) throw new Error(`Unknown editor: ${id}`);
  const platform = deps.platform || process.platform;
  const run = deps.run || runDetached;
  if (editor.id === "finder") {
    const err = await deps.openPath(target);
    if (err) throw new Error(err);
    return;
  }
  if (platform === "darwin") {
    await run("open", ["-a", editor.macApp, target]);
    return;
  }
  if (!editor.bin) throw new Error(`${editor.name} is only available on macOS`);
  await run(editor.bin, [target]);
}

/** @param {string} cmd @param {string[]} args */
function runDetached(cmd, args) {
  return new Promise((resolve, reject) => {
    if (cmd === "open") {
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
      return;
    }
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.unref();
      setImmediate(resolve);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { EDITORS, listEditors, openIn };
