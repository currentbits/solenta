#!/usr/bin/env node
"use strict";

/**
 * Compile and Seatbelt-check SolentaSimulatorHelper (#248).
 *
 * Full Xcode with Simulator is required. Command Line Tools is not enough;
 * this script never reports a pass without a real compile + sandbox self-test.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SOURCE_ROOT = path.join(ROOT, "native", "ios-simulator-helper");
const PROFILE = path.join(SOURCE_ROOT, "Resources", "helper.sb");
const HELPER_NAME = "SolentaSimulatorHelper";
const DENY_TESTS = [
  "deny-shell",
  "deny-spawn",
  "deny-home-read",
  "deny-home-write",
  "deny-listen",
  "deny-non-loopback",
];
const ALLOW_TESTS = ["allow-loopback-client"];
const UNVERIFIED = "unverified: full Xcode unavailable";

function parseArgs(argv) {
  const out = {
    developerDir: "",
    compile: false,
    sandboxSelfTest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--compile") {
      out.compile = true;
      continue;
    }
    if (arg === "--sandbox-self-test") {
      out.sandboxSelfTest = true;
      continue;
    }
    if (arg === "--developer-dir") {
      out.developerDir = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function xcodeSelectPath() {
  try {
    return execFileSync("/usr/bin/xcode-select", ["-p"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function hasFullXcode(developerDir) {
  if (!developerDir || !fs.existsSync(developerDir)) return false;
  if (developerDir.includes("CommandLineTools")) return false;
  const simulatorApp = path.join(developerDir, "Applications", "Simulator.app");
  if (!fs.existsSync(simulatorApp)) return false;
  try {
    execFileSync("/usr/bin/xcrun", ["simctl", "help"], {
      env: { ...process.env, DEVELOPER_DIR: developerDir },
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function failUnverified() {
  console.error(UNVERIFIED);
  process.exit(1);
}

function isRegularExecutable(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function findBuiltHelper(scratchHint) {
  const arch = process.arch;
  const candidates = [
    path.join(SOURCE_ROOT, ".build", "release", HELPER_NAME),
    path.join(SOURCE_ROOT, ".build", `${arch}-apple-macosx`, "release", HELPER_NAME),
  ];
  if (scratchHint) {
    candidates.unshift(
      path.join(scratchHint, "release", HELPER_NAME),
      path.join(scratchHint, `${arch}-apple-macosx`, "release", HELPER_NAME),
    );
  }
  for (const candidate of candidates) {
    if (isRegularExecutable(candidate)) return candidate;
  }
  return null;
}

function compileHelper(developerDir) {
  const env = { ...process.env, DEVELOPER_DIR: developerDir };
  const result = spawnSync(
    "/usr/bin/xcrun",
    [
      "swift",
      "build",
      "--package-path",
      SOURCE_ROOT,
      "--configuration",
      "release",
    ],
    {
      env,
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    const err = result.stderr || result.stdout || result.error || "swift build failed";
    console.error(String(err));
    failUnverified();
  }
  const helper = findBuiltHelper();
  if (!helper) {
    console.error("compiled helper executable missing");
    failUnverified();
  }
  return helper;
}

function runSandboxSelfTest(helperPath, developerDir) {
  const result = spawnSync(
    helperPath,
    [
      "--sandbox-profile",
      PROFILE,
      "--developer-dir",
      developerDir,
      "--sandbox-self-test",
    ],
    {
      env: { ...process.env, DEVELOPER_DIR: developerDir },
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    },
  );
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const lines = output.split(/\r?\n/).filter(Boolean);
  let failed = false;
  for (const name of DENY_TESTS) {
    const line = lines.find((entry) => entry.includes(`sandbox-self-test ${name} `));
    if (!line) {
      console.error(`sandbox-self-test ${name}: missing`);
      failed = true;
      continue;
    }
    const denied = /\bdenied\s*$/.test(line);
    if (denied) {
      console.log(`sandbox-self-test ${name}: denied`);
    } else {
      console.error(`sandbox-self-test ${name}: ALLOWED`);
      failed = true;
    }
  }
  for (const name of ALLOW_TESTS) {
    const line = lines.find((entry) => entry.includes(`sandbox-self-test ${name} `));
    if (!line) {
      console.error(`sandbox-self-test ${name}: missing`);
      failed = true;
      continue;
    }
    const allowed = /\ballowed\s*$/.test(line);
    if (allowed) {
      console.log(`sandbox-self-test ${name}: allowed`);
    } else {
      console.error(`sandbox-self-test ${name}: DENIED`);
      failed = true;
    }
  }
  if (result.status !== 0) failed = true;
  if (failed) process.exit(result.status === 0 ? 1 : result.status || 1);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
  if (args.help) {
    console.log(
      "usage: verify-ios-simulator-helper.js [--developer-dir DIR] [--compile] [--sandbox-self-test]",
    );
    process.exit(0);
  }
  if (!args.compile && !args.sandboxSelfTest) {
    console.error(
      "usage: verify-ios-simulator-helper.js [--developer-dir DIR] [--compile] [--sandbox-self-test]",
    );
    failUnverified();
  }

  const developerDir = args.developerDir || process.env.DEVELOPER_DIR || xcodeSelectPath();
  if (!hasFullXcode(developerDir)) {
    failUnverified();
  }

  let helperPath = null;
  if (args.compile) {
    helperPath = compileHelper(developerDir);
    console.log(`compiled ${helperPath}`);
  }
  if (args.sandboxSelfTest) {
    if (!helperPath) helperPath = findBuiltHelper();
    if (!helperPath) {
      console.error("helper executable missing; pass --compile");
      failUnverified();
    }
    runSandboxSelfTest(helperPath, developerDir);
  }
}

main();
