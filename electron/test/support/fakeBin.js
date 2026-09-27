"use strict";

const fs = require("node:fs");

/**
 * Write a node fake CLI.
 *
 * POSIX: shebang file at `filePath`, mode 0755 — same bytes the 32 local
 * helpers used to write, so assertions that read the file or spawn it
 * see no change.
 *
 * Win32: the same shebang JS file. cross-spawn (agent CLIs after #442)
 * reads `#!/usr/bin/env node` and spawns node.exe with the script and
 * the original argv. A `.cmd` + `%*` hop is cmd.exe: it splits the
 * command line on newlines, so a prompt's attachment section never
 * arrives (hosted opencode assertion, job 108204293787), and the child
 * Solenta tracks is cmd.exe rather than the node process whose
 * descendant holds the pipes. child_process.execFile still cannot run
 * a shebang — those tests stay POSIX-only.
 *
 * @param {string} filePath destination path
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
  }
  return filePath;
}

module.exports = { writeFakeBin };
