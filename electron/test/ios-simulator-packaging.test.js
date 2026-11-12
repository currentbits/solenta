"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

for (const [script, endMarker] of [
  ["package-app.sh", "# memory-server:"],
  ["package-cross.sh", "# App icon."],
]) {
  it(`${script} ships buildable simulator sources and licenses without host caches`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-simulator-package-"));
    try {
      const helper = path.join(tmp, "native", "ios-simulator-helper");
      const files = [
        "Package.swift", "protocol.json", "NOTICE.md", "LICENSES/Synara-MIT.txt",
        "LICENSES/Baguette-APACHE-2.0.txt", "LICENSES/ios-mcp-server-MIT.txt",
        "Resources/helper.sb", "Sources/SimulatorPrivateBridge/DTUHIDTransport.m",
        "Sources/SimulatorPrivateBridge/include/SimulatorPrivateBridge.h",
        "Sources/SolentaSimulatorHelper/main.swift", "Tests/InputTransportTests.m",
      ];
      for (const name of [...files, ".build/arm64-apple-macosx/release/helper", ".swiftpm/configuration/host.json"]) {
        const file = path.join(helper, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `fixture ${name}`);
      }
      const source = fs.readFileSync(path.join(__dirname, "../../scripts", script), "utf8");
      const start = source.indexOf("# iOS simulator helper sources");
      const end = source.indexOf(endMarker, start);
      assert.ok(start > 0 && end > start);
      const destination = path.join(tmp, "app with spaces");
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", source.slice(start, end)], {
        cwd: tmp, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, APP_DIR: destination, PAYLOAD: destination },
      });
      assert.equal(result.status, 0, `${result.error || ""}\n${result.stderr}`);
      const packaged = path.join(destination, "native", "ios-simulator-helper");
      for (const name of files) {
        assert.equal(fs.readFileSync(path.join(packaged, name), "utf8"), `fixture ${name}`);
      }
      assert.equal(fs.existsSync(path.join(packaged, ".build")), false);
      assert.equal(fs.existsSync(path.join(packaged, ".swiftpm")), false);
      assert.ok(fs.existsSync(path.join(helper, ".build/arm64-apple-macosx/release/helper")), "source cache is untouched");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}
