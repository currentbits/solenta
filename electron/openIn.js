"use strict";
/**
 * "Open in ‹editor›" for Thread details (#1411). A fixed allowlist: the
 * renderer only ever sends an id, never an app name or a command line.
 *
 * macOS opens via `open -a <App>` (installed = the .app bundle exists);
 * elsewhere via the editor's CLI (installed = on PATH). The file manager
 * is always available and goes through Electron's shell.openPath.
 *
 * With a line (#1506), editors that can jump to it get their own syntax:
 * `--goto path:line:col` (VS Code family), `--line N --column C path`
 * (JetBrains), `path:line:col` (Zed). On macOS that goes through the CLI
 * inside the app bundle, since `open -a` cannot pass a position to an
 * already running app. Arguments are always an argv array, never a shell
 * string.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

/** @typedef {"cursor" | "vscode" | "zed" | "idea" | "webstorm" | "pycharm" | "goland" | "rubymine" | "rider" | "clion" | "phpstorm" | "rustrover" | "fleet" | "terminal" | "finder"} EditorId */
/** @typedef {"vscode" | "jetbrains" | "zed" | null} GotoStyle */

/**
 * `macApps`: bundle names to look for, first match wins. `macCli`: the
 * launcher inside the bundle, used when a line is given.
 */
const VSCODE_CLI = (bin) => `Contents/Resources/app/bin/${bin}`;
const JB_CLI = (bin) => `Contents/MacOS/${bin}`;
const jetbrains = (id, name, bin, macApps = [name]) => ({
  id,
  name,
  macApps,
  bin,
  macCli: JB_CLI(bin),
  goto: "jetbrains",
});

const EDITORS = [
  { id: "cursor", name: "Cursor", macApps: ["Cursor"], bin: "cursor", macCli: VSCODE_CLI("cursor"), goto: "vscode" },
  { id: "vscode", name: "VS Code", macApps: ["Visual Studio Code"], bin: "code", macCli: VSCODE_CLI("code"), goto: "vscode" },
  { id: "zed", name: "Zed", macApps: ["Zed"], bin: "zed", macCli: "Contents/MacOS/cli", goto: "zed" },
  jetbrains("idea", "IntelliJ IDEA", "idea", ["IntelliJ IDEA", "IntelliJ IDEA Ultimate", "IntelliJ IDEA CE"]),
  jetbrains("webstorm", "WebStorm", "webstorm"),
  jetbrains("pycharm", "PyCharm", "pycharm", ["PyCharm", "PyCharm Professional Edition", "PyCharm CE", "PyCharm Community Edition"]),
  jetbrains("goland", "GoLand", "goland"),
  jetbrains("rubymine", "RubyMine", "rubymine"),
  jetbrains("rider", "Rider", "rider"),
  jetbrains("clion", "CLion", "clion"),
  jetbrains("phpstorm", "PhpStorm", "phpstorm"),
  jetbrains("rustrover", "RustRover", "rustrover"),
  // ponytail: Fleet has no documented line flag, so it opens the file only.
  { id: "fleet", name: "Fleet", macApps: ["Fleet"], bin: "fleet", macCli: null, goto: null },
  { id: "terminal", name: "Terminal", macApps: ["Terminal"], bin: null, macCli: null, goto: null },
  { id: "finder", name: "Finder", macApps: [], bin: null, macCli: null, goto: null },
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
 * First installed bundle for `editor` on macOS, or null.
 * @returns {{ app: string, bundle: string } | null}
 */
function findMacBundle(editor, deps) {
  for (const app of editor.macApps) {
    const bundles = [
      `/Applications/${app}.app`,
      path.join(deps.home, "Applications", `${app}.app`),
      `/System/Applications/Utilities/${app}.app`,
    ];
    const bundle = bundles.find((b) => deps.exists(b));
    if (bundle) return { app, bundle };
  }
  return null;
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
    if (mac ? findMacBundle(e, deps) : e.bin && deps.onPath(e.bin)) {
      out.push({ id: e.id, name: e.name });
    }
  }
  return out;
}

/** Positive integer or undefined; anything else from IPC is dropped. */
function position(n) {
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Editor argv for `target`, jumping to line/col when the editor can.
 * @param {GotoStyle} goto
 * @param {string} target
 * @param {number} [line]
 * @param {number} [col]
 */
function gotoArgs(goto, target, line, col) {
  if (!line || !goto) return [target];
  const pos = col ? `${target}:${line}:${col}` : `${target}:${line}`;
  if (goto === "vscode") return ["--goto", pos];
  if (goto === "zed") return [pos];
  return col
    ? ["--line", String(line), "--column", String(col), target]
    : ["--line", String(line), target];
}

/**
 * Open `target` (already validated by the caller) with editor `id`,
 * optionally at `line`/`col` (1-based).
 * @param {string} target
 * @param {string} id
 * @param {{ platform?: string, home?: string, exists?: (p: string) => boolean, line?: unknown, col?: unknown, openPath: (p: string) => Promise<string>, run?: (cmd: string, args: string[]) => Promise<void> }} deps
 */
async function openIn(target, id, deps) {
  const editor = EDITORS.find((e) => e.id === id);
  if (!editor) throw new Error(`Unknown editor: ${id}`);
  const platform = deps.platform || process.platform;
  const run = deps.run || runDetached;
  const line = position(deps.line);
  const col = line ? position(deps.col) : undefined;
  if (editor.id === "finder") {
    const err = await deps.openPath(target);
    if (err) throw new Error(err);
    return;
  }
  if (platform === "darwin") {
    const exists = deps.exists || ((p) => fs.existsSync(p));
    const found = findMacBundle(editor, { home: deps.home || os.homedir(), exists });
    const cli = found && editor.macCli ? path.join(found.bundle, editor.macCli) : null;
    if (line && editor.goto && cli && exists(cli)) {
      await run(cli, gotoArgs(editor.goto, target, line, col));
      return;
    }
    await run("open", ["-a", found ? found.app : editor.macApps[0], target]);
    return;
  }
  if (!editor.bin) throw new Error(`${editor.name} is only available on macOS`);
  await run(editor.bin, gotoArgs(editor.goto, target, line, col));
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
