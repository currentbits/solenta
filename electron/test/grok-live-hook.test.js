"use strict";

/**
 * Live vendor canary for #812 / #826.
 *
 * grok 1.0.13 loads overlay `config.toml` `[[hooks.PreToolUse]]`
 * (`source.type: configToml`) and honors `{decision:deny}` / exit 2 before
 * `run_terminal_command` under `--always-approve`. There is no
 * `control_request` seam.
 *
 * Skipped unless GROK_LIVE=1. Never runs in CI (even if GROK_LIVE leaks).
 * Default electron suite stays on the fake grok in grok.test.js.
 *
 *   GROK_LIVE=1 node --test electron/test/grok-live-hook.test.js
 *
 * Optional: GROK_LIVE_BIN=/path/to/grok
 *
 * Do not symlink hooks/ or sessions/ into the probe home: user
 * ~/.grok/hooks/*.json must not fire, and grok stale-session GC deletes
 * through a sessions symlink.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const LIVE =
  process.env.GROK_LIVE === "1" && process.env.CI !== "true";

function tomlEscape(value) {
  const s = String(value);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if (c === "\\") out += "\\\\";
    else if (c === '"') out += '\\"';
    else if (c === "\b") out += "\\b";
    else if (c === "\t") out += "\\t";
    else if (c === "\n") out += "\\n";
    else if (c === "\f") out += "\\f";
    else if (c === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += c;
    }
  }
  return out;
}

function resolveGrokBin() {
  const candidates = [];
  if (process.env.GROK_LIVE_BIN) candidates.push(process.env.GROK_LIVE_BIN);
  candidates.push(path.join(os.homedir(), ".local", "bin", "grok"));
  candidates.push("/usr/local/bin/grok");
  try {
    const which = execFileSync(
      process.platform === "win32" ? "where" : "which",
      ["grok"],
      { encoding: "utf8", timeout: 5000 },
    )
      .trim()
      .split(/\r?\n/)[0];
    if (which) candidates.push(which);
  } catch {
    // not on PATH
  }
  const seen = new Set();
  for (const bin of candidates) {
    if (!bin || seen.has(bin)) continue;
    seen.add(bin);
    if (!fs.existsSync(bin)) continue;
    try {
      const ver = execFileSync(bin, ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (/\bgrok\s+\d+\./i.test(ver)) return { bin, version: ver.trim() };
    } catch {
      // fake or broken
    }
  }
  return null;
}

function resolveAuthJson() {
  const candidates = [];
  if (process.env.GROK_HOME) {
    candidates.push(path.join(process.env.GROK_HOME, "auth.json"));
  }
  candidates.push(path.join(os.homedir(), ".grok", "auth.json"));
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return fs.realpathSync(p);
    } catch {
      // unreadable
    }
  }
  return null;
}

function walkConfigTomlHooks(value, hits) {
  if (!value || typeof value !== "object") return;
  if (
    value.source &&
    typeof value.source === "object" &&
    value.source.type === "configToml"
  ) {
    hits.push(value);
  }
  if (Array.isArray(value)) {
    for (const child of value) walkConfigTomlHooks(child, hits);
    return;
  }
  for (const child of Object.values(value)) {
    walkConfigTomlHooks(child, hits);
  }
}

describe("live grok config.toml PreToolUse deny (#812)", { skip: !LIVE }, () => {
  let tmp;
  let overlay;
  let workDir;
  let markerPath;
  let canaryPath;
  let grokBin;
  let grokVersion;
  let inspectRaw;

  before(() => {
    const resolved = resolveGrokBin();
    assert.ok(
      resolved,
      "GROK_LIVE=1 but no real grok binary (set GROK_LIVE_BIN or install grok)",
    );
    grokBin = resolved.bin;
    grokVersion = resolved.version;

    const auth = resolveAuthJson();
    assert.ok(
      auth,
      "GROK_LIVE=1 but no grok auth.json (expected $GROK_HOME/auth.json or ~/.grok/auth.json)",
    );

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-live-hook-"));
    overlay = path.join(tmp, "grok-home");
    workDir = path.join(tmp, "work");
    fs.mkdirSync(overlay);
    fs.mkdirSync(workDir);
    fs.symlinkSync(auth, path.join(overlay, "auth.json"));

    markerPath = path.join(tmp, "hook-fired.txt");
    canaryPath = path.join(workDir, "SOLENTA_GROK_LIVE_CANARY.txt");

    const hookPath = path.join(overlay, "deny-hook.js");
    fs.writeFileSync(
      hookPath,
      `#!/usr/bin/env node
"use strict";
const fs = require("fs");
process.stdin.resume();
process.stdin.on("data", () => {});
fs.writeFileSync(${JSON.stringify(markerPath)}, "fired\\n");
process.stdout.write(
  JSON.stringify({
    decision: "deny",
    reason: "solenta-live-canary-deny",
  }) + "\\n",
);
process.exit(2);
`,
    );
    fs.chmodSync(hookPath, 0o755);

    const command =
      process.platform === "win32"
        ? `${process.execPath} ${hookPath}`
        : hookPath;
    fs.writeFileSync(
      path.join(overlay, "config.toml"),
      `[[hooks.PreToolUse]]
matcher = ""
hooks = [
  { type = "command", command = "${tomlEscape(command)}", timeout = 10 },
]
`,
    );

    inspectRaw = execFileSync(grokBin, ["inspect", "--json"], {
      cwd: workDir,
      env: { ...process.env, GROK_HOME: overlay },
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  after(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("inspect loads the overlay config.toml hook as configToml", () => {
    assert.match(inspectRaw, /configToml/);
    let parsed;
    try {
      parsed = JSON.parse(inspectRaw);
    } catch {
      assert.fail(`grok inspect --json was not JSON:\n${inspectRaw}`);
    }
    const hits = [];
    walkConfigTomlHooks(parsed, hits);
    assert.ok(
      hits.length > 0,
      `inspect listed no source.type=configToml hook:\n${inspectRaw}`,
    );
    const overlayCfg = path.join(overlay, "config.toml");
    assert.ok(
      hits.some(
        (h) =>
          typeof h.source.path === "string" &&
          path.resolve(h.source.path) === path.resolve(overlayCfg),
      ),
      `configToml hook path was not overlay config.toml (${overlayCfg}):\n${JSON.stringify(hits)}`,
    );
  });

  it(
    "deny blocks run_terminal_command before the canary is written",
    { timeout: 180_000 },
    () => {
      assert.ok(grokVersion, "grok --version missing");
      const prompt =
        `Create the file ${canaryPath} containing the exact text live-canary. ` +
        "You MUST use the run_terminal_command tool to write it (printf or echo). " +
        "Do not only describe the command. Do not use any other tool.";

      const result = spawnSync(
        grokBin,
        [
          "--always-approve",
          "--output-format",
          "streaming-messages-json",
          "--disable-web-search",
          "--no-subagents",
          "--no-plan",
          "--tools",
          "run_terminal_command",
          "--max-turns",
          "4",
          "--verbatim",
          "-p",
          prompt,
        ],
        {
          cwd: workDir,
          env: { ...process.env, GROK_HOME: overlay },
          encoding: "utf8",
          timeout: 180_000,
          maxBuffer: 10 * 1024 * 1024,
          killSignal: "SIGTERM",
        },
      );

      const transcript = `${result.stdout || ""}\n${result.stderr || ""}`;
      assert.equal(
        result.error && result.error.code,
        undefined,
        `live grok spawn failed (${result.error && result.error.code}): ${transcript}`,
      );
      assert.ok(
        fs.existsSync(markerPath),
        `PreToolUse hook never fired (marker missing). grok=${grokVersion}\n${transcript}`,
      );
      assert.equal(
        fs.existsSync(canaryPath),
        false,
        `canary was written; deny did not block the tool.\n${transcript}`,
      );
      assert.match(
        transcript,
        /Hook denied/,
        `transcript missing 'Hook denied'. grok=${grokVersion}\n${transcript}`,
      );
      assert.equal(
        /control_request/.test(transcript),
        false,
        `transcript contained control_request; grok must not use that seam.\n${transcript}`,
      );
    },
  );
});
