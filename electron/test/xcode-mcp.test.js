/**
 * One-click Xcode MCP pairing (#488): detect, prefer MobileBuildMCP, never
 * pair twice, no-op on a non-Apple repo.
 * Run: node --test electron/test/xcode-mcp.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  detectXcodeProject,
  pairedXcodeServer,
  xcodeMcpStatus,
  xcodePairInput,
} = require("../xcodeMcp.js");
const { IPC_HANDLERS } = require("../ipc.js");
const { Store } = require("../store.js");
const { resetMemorySupForTests } = require("../memory-sup.js");

const mac = (bins, bridge) => ({
  platform: "darwin",
  which: (b) => (bins.includes(b) ? `/opt/bin/${b}` : null),
  findBridge: () => bridge,
});

describe("xcode MCP pairing", () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-xcode-mcp-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("detects workspace over project, and iOS Swift packages only", () => {
    fs.mkdirSync(path.join(tmp, "App.xcodeproj"));
    assert.deepEqual(detectXcodeProject(tmp), { kind: "project", name: "App.xcodeproj" });
    fs.mkdirSync(path.join(tmp, "App.xcworkspace"));
    assert.deepEqual(detectXcodeProject(tmp), { kind: "workspace", name: "App.xcworkspace" });

    const pkg = fs.mkdtempSync(path.join(tmp, "pkg-"));
    fs.writeFileSync(path.join(pkg, "Package.swift"), "platforms: [.macOS(.v14)]");
    assert.equal(detectXcodeProject(pkg), null);
    fs.writeFileSync(path.join(pkg, "Package.swift"), "platforms: [.iOS(.v17), .macOS(.v14)]");
    assert.deepEqual(detectXcodeProject(pkg), { kind: "package", name: "Package.swift" });

    assert.equal(detectXcodeProject(path.join(tmp, "missing")), null);
  });

  it("is a no-op on a non-Apple repo and off macOS, without probing", () => {
    fs.writeFileSync(path.join(tmp, "package.json"), "{}");
    const deps = {
      platform: "darwin",
      which: () => assert.fail("probed which"),
      findBridge: () => assert.fail("probed xcrun"),
    };
    assert.equal(xcodeMcpStatus(tmp, [], deps), null);
    assert.throws(() => xcodePairInput(tmp, [], deps), /No Xcode project/);
    fs.mkdirSync(path.join(tmp, "App.xcodeproj"));
    assert.equal(xcodeMcpStatus(tmp, [], { ...deps, platform: "linux" }), null);
  });

  it("prefers MobileBuildMCP, falls back to mcpbridge, refuses with neither", () => {
    fs.mkdirSync(path.join(tmp, "App.xcodeproj"));
    assert.deepEqual(xcodePairInput(tmp, [], mac(["mobilebuildmcp"], true)), {
      transport: "stdio",
      enabled: true,
      trusted: true,
      name: "mobilebuildmcp",
      command: "mobilebuildmcp",
      args: ["mcp"],
    });
    // Legacy binary name still pairs.
    assert.equal(xcodePairInput(tmp, [], mac(["xcodebuildmcp"], false)).command, "xcodebuildmcp");
    const apple = xcodePairInput(tmp, [], mac([], true));
    assert.deepEqual([apple.name, apple.command, apple.args], ["xcode", "xcrun", ["mcpbridge"]]);
    assert.equal(xcodeMcpStatus(tmp, [], mac([], false)).recommended, null);
    assert.throws(() => xcodePairInput(tmp, [], mac([], false)), /Neither/);
  });

  it("refuses to add a second Xcode server, whichever one is there", () => {
    fs.mkdirSync(path.join(tmp, "App.xcodeproj"));
    const deps = mac(["mobilebuildmcp"], true);
    for (const existing of [
      { name: "xcode", command: "xcrun", args: ["mcpbridge"] },
      { name: "apple", command: "/usr/bin/xcrun", args: ["mcpbridge"] },
      { name: "XcodeBuildMCP", command: "npx", args: ["-y", "xcodebuildmcp@latest"] },
      { name: "mine", command: "/opt/bin/mobilebuildmcp", args: ["mcp"] },
    ]) {
      assert.equal(pairedXcodeServer([existing]), existing.name);
      assert.throws(() => xcodePairInput(tmp, [existing], deps), /already paired/);
    }
    assert.equal(pairedXcodeServer([{ name: "playwright", command: "npx", args: ["-y", "@playwright/mcp"] }]), null);
  });

  describe("IPC", () => {
    let ctx;
    let prevEnv;
    beforeEach(() => {
      prevEnv = {
        CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
        CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
      };
      process.env.CODER_KIMI_MCP_PATH = path.join(tmp, "kimi-mcp.json");
      process.env.CODER_GROK_MCP_DISABLE = "1";
      resetMemorySupForTests();
      ctx = { store: new Store(path.join(tmp, "store.json")), userDataPath: tmp };
    });
    afterEach(() => {
      resetMemorySupForTests();
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it("leaves a non-Apple repo's MCP list untouched", async () => {
      const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
      assert.equal(await IPC_HANDLERS["mcp:xcodeStatus"](ctx, { projectPath: repo }), null);
      await assert.rejects(
        IPC_HANDLERS["mcp:pairXcode"](ctx, { projectPath: repo }),
        /No Xcode project/,
      );
      assert.deepEqual(await IPC_HANDLERS["mcp:list"](ctx), []);
    });
  });
});
