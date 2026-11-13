"use strict";

const { execFileSync } = require("node:child_process");

// Throwaway-repo git for tests. stderr is piped, so a failure's message is
// "Command failed: git …" followed by git's own stderr instead of nothing.
function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

module.exports = { git };
