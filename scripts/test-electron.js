#!/usr/bin/env node
// The electron suite on POSIX is `node --test electron/test/*.test.js`.
// On win32 most of those files spawn a shebang script as CODER_*_BIN
// (see electron/test/claude.test.js: "On macOS we can use a node shebang
// script directly as the binary"). CreateProcess will not execute those.
// Until fakes grow a .cmd wrapper, win32 only runs the WSL contract —
// the win32 path this matrix exists to keep honest. #437
"use strict";

const { spawnSync } = require("node:child_process");

const args = [
  "--import=./test/support/render.mjs",
  "--experimental-strip-types",
  "--test",
];
// The win32 list is exactly the files that model win32 behaviour without
// spawning anything real: pure resolvers, or fakes injected through
// ssh.setExecFile. Anything added here must hold to that — the moment a
// file needs a real git or a shebang fake, the Windows leg goes red.
const WIN32_FILES = [
  "electron/test/wsl.test.js", // the boundary contract itself
  "electron/test/worktree-wsl.test.js", // worktree placement across it
  "electron/test/doctor.test.js", // the win32 doctor probes
  "electron/test/sandbox.test.js", // sandbox resolution (platform injected)
];
if (process.platform === "win32") {
  args.push(...WIN32_FILES);
} else {
  args.push("electron/test/*.test.js");
}

const r = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
