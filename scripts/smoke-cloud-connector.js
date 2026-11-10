#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ensureBinary, VERSION } = require("../electron/cloud/connector");

(async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-connector-smoke-"));
  try {
    const binary = await ensureBinary({ cacheDir });
    assert.ok(path.resolve(binary).startsWith(`${path.resolve(cacheDir)}${path.sep}`));
    const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
    assert.ok(version.includes(VERSION));
    console.log(`[cloud connector] ${process.platform}-${process.arch}: ${version.trim()}`);
  } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
