"use strict";

// Run: node --test electron/test/verify-package-port.test.js
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { rmTree } = require("./support/rmTree");

it("package probes follow config port rewrites through startup, health, store, and embed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-verify-port-"));
  try {
    const configFile = path.join(dir, "memory-server.json");
    const dbFile = path.join(dir, "memory.db");
    const token = "isolated-test-token";
    fs.writeFileSync(configFile, JSON.stringify({ port: 49978, token, dbPath: dbFile }));
    fs.writeFileSync(dbFile, "isolated fixture db");
    fs.writeFileSync(path.join(dir, "requests.json"), "[]");
    fs.writeFileSync(path.join(dir, "boot.log"), "fixture boot");

    // Simulate the server rewriting its config, with no sockets or model download.
    // Move again at each stage so a one-time refresh cannot pass this regression.
    fs.writeFileSync(path.join(dir, "probe.cjs"), `
      const fs = require("node:fs");
      const assert = require("node:assert/strict");
      const configFile = process.env.CONFIG_FILE;
      const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
      const args = process.argv.slice(2);
      const requestsFile = process.env.REQUESTS_FILE;
      const requests = JSON.parse(fs.readFileSync(requestsFile, "utf8"));
      requests.push(args);
      fs.writeFileSync(requestsFile, JSON.stringify(requests));
      const step = requests.length - 1;
      const expected = [49978, 49994, 49995, null, 49996, 49997, 49998];
      if (args[0] === "lsof") {
        assert.equal(step, 3);
        assert.deepEqual(args, ["lsof", "-t", "--", process.env.DB_FILE]);
        cfg.port = 49996;
        fs.writeFileSync(configFile, JSON.stringify(cfg));
        console.log(process.pid);
      } else {
        const endpoint = step === 4 ? "api/store" : "health";
        assert.ok(args.includes("http://127.0.0.1:" + expected[step] + "/" + endpoint), args.join(" "));
        if (step === 4) {
          assert.ok(args.includes("POST"));
          assert.ok(args.includes("Authorization: Bearer " + process.env.TOKEN));
          assert.equal(JSON.parse(args[args.indexOf("-d") + 1]).force, true);
        }
        if ([0, 1, 4, 5].includes(step)) {
          cfg.port = expected[step + 1];
          fs.writeFileSync(configFile, JSON.stringify(cfg));
        }
        if (step === 0) process.exit(7); // old port refused; config now points at fallback
        console.log(JSON.stringify({ ok: step !== 1, vectors: { count: step === 6 ? 1 : 0 } }));
      }
    `);

    const source = fs.readFileSync(path.join(__dirname, "../../scripts/verify-package.sh"), "utf8");
    const probeStart = source.indexOf("# Wait up to 10s for the process");
    assert.ok(probeStart > 0);
    const refresh = source.match(/refresh_memory_port\(\) \{[\s\S]*?\n\}/)?.[0] || "";
    // Execute the real shell probes, bypassing only bundle layout/signing and launch.
    const result = spawnSync("bash", ["-c", `
      set -euo pipefail
      PORT=49978
      ELECTRON_PID=$$
      curl() { "$NODE_BIN" "$PROBE_FIXTURE" curl "$@"; }
      lsof() { "$NODE_BIN" "$PROBE_FIXTURE" lsof "$@"; }
      ${refresh}
      ${source.slice(probeStart)}
    `], {
      encoding: "utf8",
      timeout: 25000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODER_"))),
        CONFIG_FILE: configFile,
        DB_FILE: dbFile,
        TOKEN: token,
        LOG: path.join(dir, "boot.log"),
        NODE_BIN: process.execPath,
        PROBE_FIXTURE: path.join(dir, "probe.cjs"),
        REQUESTS_FILE: path.join(dir, "requests.json"),
        FORCE_COLOR: "1", // refreshed ports must be plain digits, not node -p inspect colors
      },
    });
    assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /isolation ok:/);
    assert.match(result.stdout, /AFTER_COUNT=1 \(was BEFORE_COUNT=0\)/);
    assert.match(result.stdout, /verify: OK/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "requests.json"))).length, 7);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { port: 49998, token, dbPath: dbFile });
  } finally {
    await rmTree(dir);
  }
});
