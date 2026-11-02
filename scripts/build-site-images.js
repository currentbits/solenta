#!/usr/bin/env node
// Requires cwebp (libwebp). Outputs are committed; deployment has no build step.
"use strict";
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const assets = path.join(__dirname, "..", "site", "assets");
for (const name of ["screen-main", "screen-agents", "screen-kanban", "screen-automations"]) {
  for (const width of [800, 1680]) {
    execFileSync("cwebp", ["-quiet", "-q", "80", "-resize", String(width), "0",
      path.join(assets, `${name}.png`), "-o", path.join(assets, `${name}-${width}.webp`)], { stdio: "inherit" });
  }
}
