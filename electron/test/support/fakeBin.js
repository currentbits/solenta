"use strict";

const fs = require("node:fs");

/**
 * Write a node fake CLI.
 *
 * POSIX: shebang file at `filePath`, mode 0755 — same bytes the 32 local
 * helpers used to write, so assertions that read the file or spawn it
 * see no change.
 *
 * Win32: the same JS file plus a `.cmd` wrapper. CreateProcess cannot
 * run a shebang; it can run `.cmd`. cross-spawn (agent CLIs after #442)
 * launches that wrapper via cmd.exe. child_process.execFile cannot
 * (gh, fm) — those tests stay POSIX-only even after this helper.
 *
 * @param {string} filePath destination path (not the .cmd)
 * @param {string} body script source; a shebang is prepended if missing
 * @returns {string} path to put in CODER_*_BIN
 */
function writeFakeBin(filePath, body) {
  let script = String(body);
  if (!script.startsWith("#!")) script = "#!/usr/bin/env node\n" + script;
  fs.writeFileSync(filePath, script, { mode: 0o755 });
  if (process.platform !== "win32") {
    // writeFileSync mode is umask-masked; the old helpers chmod'd.
    fs.chmodSync(filePath, 0o755);
    return filePath;
  }

  // process.execPath is correct HERE and wrong in electron/smoke.js's
  // same-named writeFakeBin: this runs under plain node (scripts/
  // test-electron.js), so execPath IS node. smoke.js runs under Electron,
  // where execPath is electron.exe and each fake would boot a second
  // Electron — it resolves node off PATH instead. Do not copy one into
  // the other without changing this line.
  //
  // ponytail: quote both paths, no further cmd escaping. Test tmpdirs
  // and process.execPath do not contain `"`. %* forwards argv as-is.
  const cmdPath = filePath.endsWith(".cmd") ? filePath : `${filePath}.cmd`;
  fs.writeFileSync(
    cmdPath,
    `@echo off\r\n"${process.execPath}" "${filePath}" %*\r\n`,
  );
  return cmdPath;
}

module.exports = { writeFakeBin };
