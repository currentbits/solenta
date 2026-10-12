#!/usr/bin/env node
"use strict";

/**
 * Fixture-driven fake agent CLI (#1428). Point a provider's binEnv
 * (CODER_CLAUDE_BIN) at this file and the real runner, normalizer, store
 * and pushDetail run against a recorded transcript.
 *
 * CODER_REPLAY_DIR holds *.ndjson fixtures (recorded with recordCli.js,
 * then trimmed). Line 1 is {"match": "..."}: the first unclaimed fixture
 * whose match is a substring of argv + the first stdin line is this
 * process's script, so a lead and its workers can share one env. Then:
 *
 *   {"expect": {"type": "user", "message.content~": "text"}}
 *       next stdin line must match: dotted path, `~` = substring
 *   {"emit": {...}, "delayMs": 5}   write one stdout line
 *   {"exit": 0}                     exit now
 *
 * Every step is appended to <dir>/replay.log. A mismatch logs
 * {mismatch} and exits 3. After the last line it behaves like an idle
 * keep-alive CLI: any further stdin line is a mismatch, EOF exits 0.
 */

const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const dir = process.env.CODER_REPLAY_DIR;
const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(obj) {
  fs.appendFileSync(path.join(dir, "replay.log"), JSON.stringify({ pid: process.pid, ...obj }) + "\n");
}

const queue = [];
let ended = false;
let wake = null;
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) queue.push(line);
  }
  if (wake) wake();
});
process.stdin.on("end", () => {
  ended = true;
  if (wake) wake();
});
async function nextLine() {
  while (!queue.length && !ended) await new Promise((r) => (wake = r));
  wake = null;
  return queue.length ? queue.shift() : null;
}

function get(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Flush stdout first: on macOS a pipe write is async and exit drops it. */
function exit(code) {
  process.stdout.write("", () => process.exit(code));
}

function fail(fixture, cursor, why, got) {
  log({ fixture, cursor, mismatch: why, got });
  process.stderr.write(`replay ${fixture}:${cursor}: ${why}\n`);
  exit(3);
}

function claim(text) {
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson")).sort()) {
    const steps = fs.readFileSync(path.join(dir, name), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    if (!text.includes(steps[0].match)) continue;
    try {
      fs.closeSync(fs.openSync(path.join(dir, name + ".claimed"), "wx"));
    } catch {
      continue; // another process already replays it
    }
    return { name, steps };
  }
  return null;
}

(async () => {
  const first = await nextLine();
  if (first != null) queue.unshift(first);
  const picked = claim(argv.join(" ") + "\n" + (first || ""));
  if (!picked) return fail(null, 0, "no unclaimed fixture matches", { argv, first });
  const { name, steps } = picked;
  log({ fixture: name, start: argv });

  for (let cursor = 1; cursor < steps.length; cursor++) {
    const step = steps[cursor];
    if (step.expect) {
      log({ fixture: name, cursor, waiting: "expect" });
      const line = await nextLine();
      if (line == null) return fail(name, cursor, "stdin closed", null);
      const got = JSON.parse(line);
      for (const [key, want] of Object.entries(step.expect)) {
        const sub = key.endsWith("~");
        const have = get(got, sub ? key.slice(0, -1) : key);
        const ok = sub ? String(have ?? "").includes(want) : isDeepStrictEqual(have, want);
        if (!ok) return fail(name, cursor, `expect ${key}`, got);
      }
    } else if (step.emit) {
      if (step.delayMs) await sleep(step.delayMs);
      process.stdout.write(JSON.stringify(step.emit) + "\n");
    } else if ("exit" in step) {
      log({ fixture: name, cursor, done: steps.length });
      return exit(step.exit);
    }
  }
  log({ fixture: name, done: steps.length });
  const extra = await nextLine();
  if (extra != null) return fail(name, steps.length, "stdin after the fixture ended", JSON.parse(extra));
  exit(0);
})();
