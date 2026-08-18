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
if (process.platform === "win32") {
  args.push("electron/test/wsl.test.js");
} else {
  args.push("electron/test/*.test.js");
}

const r = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
