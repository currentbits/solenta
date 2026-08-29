#!/usr/bin/env node
// Runs every test suite even when one fails, then exits non-zero if any
// failed. Replaces `&&` chaining so one red suite can no longer silently
// skip the rest. #790
"use strict";

const spawn = require("cross-spawn");

const SUITES = [
  "test:core",
  "test:renderer",
  "test:electron",
  "test:memory",
  "test:stats",
];

const failed = [];
for (const suite of SUITES) {
  console.log(`\n=== ${suite} ===`);
  const r = spawn.sync("npm", ["run", suite], { stdio: "inherit" });
  if (r.status !== 0) failed.push(suite);
}

if (failed.length > 0) {
  console.error(`\nFailed suites: ${failed.join(", ")}`);
  process.exit(1);
}
console.log("\nAll suites passed.");
