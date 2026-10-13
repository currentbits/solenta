#!/usr/bin/env node
"use strict";

/**
 * Recording proxy for replay fixtures (#1428). Point CODER_CLAUDE_BIN at
 * this file and drive Solenta (the app, or a runner script) as usual. It
 * spawns the real CLI with the same argv and appends every stdin line as
 * `expect` and every stdout line as `emit` (with its delay) to
 * CODER_RECORD_OUT. HOME and cwd are rewritten to /home/user and
 * /workspace. Hand-trim the result into a fixture under
 * electron/test/fixtures/replay/: keep the `expect` keys that matter (use
 * `key~` for substrings), add the `match` header, add gates.
 *
 *   CODER_RECORD_REAL_BIN  real binary (default: claude on PATH)
 *   CODER_RECORD_OUT       directory; one <time>-<pid>.ndjson per process
 *   CODER_RECORD_ARGS      extra argv for the real CLI only, space-separated
 *                          (e.g. "--setting-sources project --strict-mcp-config"
 *                          keeps your own hooks and MCP servers out of it)
 *
 * Read the transcript before committing it: the init event lists tools,
 * skills and MCP servers from the recording machine.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const out = process.env.CODER_RECORD_OUT;
if (!out) {
  process.stderr.write("recordCli: CODER_RECORD_OUT is required\n");
  process.exit(2);
}
const file = path.join(out, `${Date.now()}-${process.pid}.ndjson`);
const argv = process.argv.slice(2);
const extra = (process.env.CODER_RECORD_ARGS || "").split(" ").filter(Boolean);
const child = spawn(process.env.CODER_RECORD_REAL_BIN || "claude", [...argv, ...extra], {
  stdio: ["pipe", "pipe", "inherit"],
});

const cwds = [fs.realpathSync(process.cwd()), process.cwd()];
function scrub(s) {
  for (const c of cwds) s = s.split(c).join("/workspace");
  s = s.split(os.homedir()).join("/home/user");
  return s.replace(new RegExp(`\\b${os.userInfo().username}\\b`, "g"), "user");
}
let last = Date.now();
function record(obj) {
  fs.appendFileSync(file, scrub(JSON.stringify(obj)) + "\n");
}
record({ argv });

function lines(stream, onLine) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
}

lines(process.stdin, (line) => {
  try {
    record({ expect: JSON.parse(line) });
  } catch {
    record({ expectRaw: line });
  }
  child.stdin.write(line + "\n");
});
process.stdin.on("end", () => child.stdin.end());
child.stdin.on("error", () => {});

lines(child.stdout, (line) => {
  const now = Date.now();
  try {
    record({ emit: JSON.parse(line), delayMs: now - last });
  } catch {
    record({ emitRaw: line, delayMs: now - last });
  }
  last = now;
  process.stdout.write(line + "\n");
});

child.on("exit", (code) => {
  record({ exit: code ?? 1 });
  process.exit(code ?? 1);
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
