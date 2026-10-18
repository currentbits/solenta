"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { defaultWhich } = require("./providers.js");

/**
 * One-click Xcode MCP pairing (#488).
 *
 * An Apple project in the root gets a doctor card offering ONE server:
 * MobileBuildMCP (Sentry, formerly XcodeBuildMCP; 78+ tools) when its CLI is
 * on PATH, else Apple's `xcrun mcpbridge` (Xcode 26.3+). Never both: they
 * expose duplicate build/test tools. We only write the documented stdio
 * command into the MCP list; we never vendor or install either binary.
 */

/** Binary names, new first. `xcodebuildmcp` still ships as the old name. */
const BUILD_MCP_BINS = ["mobilebuildmcp", "xcodebuildmcp"];
const APPLE_PLATFORM_RE = /\.(iOS|tvOS|watchOS|visionOS)\s*\(/;

/**
 * @param {string | null | undefined} root
 * @returns {{ kind: "workspace" | "project" | "package", name: string } | null}
 */
function detectXcodeProject(root) {
  if (!root) return null;
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  // A workspace wraps the project (CocoaPods etc.), so it wins.
  const ws = names.find((n) => n.endsWith(".xcworkspace"));
  if (ws) return { kind: "workspace", name: ws };
  const proj = names.find((n) => n.endsWith(".xcodeproj"));
  if (proj) return { kind: "project", name: proj };
  if (names.includes("Package.swift")) {
    try {
      const text = fs.readFileSync(path.join(root, "Package.swift"), "utf8");
      if (APPLE_PLATFORM_RE.test(text)) return { kind: "package", name: "Package.swift" };
    } catch {
      // unreadable manifest: not an Apple project as far as we can tell
    }
  }
  return null;
}

/**
 * Name of an MCP server that already drives Xcode, by name or command.
 * @param {Array<{ name?: string, command?: string, args?: string[] }>} servers
 * @returns {string | null}
 */
function pairedXcodeServer(servers) {
  for (const s of servers || []) {
    if (!s) continue;
    const name = String(s.name || "");
    const cmd = path.basename(String(s.command || ""));
    const args = Array.isArray(s.args) ? s.args.map(String) : [];
    if (
      name === "xcode" ||
      BUILD_MCP_BINS.includes(name) ||
      BUILD_MCP_BINS.includes(cmd) ||
      (cmd === "xcrun" && args[0] === "mcpbridge") ||
      args.some((a) => BUILD_MCP_BINS.some((b) => a === b || a.startsWith(`${b}@`)))
    ) {
      return name;
    }
  }
  return null;
}

function defaultFindBridge() {
  try {
    execFileSync("xcrun", ["--find", "mcpbridge"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {{
 *   platform?: NodeJS.Platform,
 *   which?: (bin: string) => string | null,
 *   findBridge?: () => boolean,
 * }} XcodeDeps
 */

/**
 * Doctor card state, or null when there is nothing to offer (not macOS, or
 * no Apple project in the root).
 * @param {string | null | undefined} projectPath
 * @param {Array<{ name?: string, command?: string, args?: string[] }>} servers
 * @param {XcodeDeps} [deps]
 */
function xcodeMcpStatus(projectPath, servers, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== "darwin") return null;
  const project = detectXcodeProject(projectPath);
  if (!project) return null;
  const which = deps.which || ((bin) => defaultWhich(bin));
  // Only probe after detection: on a Mac without Xcode, xcrun is a shim that
  // can pop the Command Line Tools installer.
  const bridge = (deps.findBridge || defaultFindBridge)();
  const buildMcp = BUILD_MCP_BINS.find((b) => which(b)) || null;
  return {
    project,
    bridge,
    buildMcp,
    paired: pairedXcodeServer(servers),
    recommended: buildMcp ? "mobilebuildmcp" : bridge ? "xcode" : null,
  };
}

/**
 * MCP save input for the recommended server. Throws instead of adding a
 * second Xcode server or one whose binary is missing.
 * @param {string | null | undefined} projectPath
 * @param {Array<{ name?: string, command?: string, args?: string[] }>} servers
 * @param {XcodeDeps} [deps]
 */
function xcodePairInput(projectPath, servers, deps = {}) {
  const status = xcodeMcpStatus(projectPath, servers, deps);
  if (!status) throw new Error("No Xcode project or Swift package in this project.");
  if (status.paired) throw new Error(`Xcode is already paired as "${status.paired}".`);
  // The user's click is the trust: the command is fixed here, never from IPC.
  const base = { transport: "stdio", enabled: true, trusted: true };
  if (status.buildMcp) {
    return { ...base, name: "mobilebuildmcp", command: status.buildMcp, args: ["mcp"] };
  }
  if (status.bridge) {
    return { ...base, name: "xcode", command: "xcrun", args: ["mcpbridge"] };
  }
  throw new Error("Neither MobileBuildMCP nor Xcode's mcpbridge is installed.");
}

module.exports = {
  detectXcodeProject,
  pairedXcodeServer,
  xcodeMcpStatus,
  xcodePairInput,
};
