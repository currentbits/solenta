"use strict";

/**
 * #1853: every provider PreToolUse hook lets ask rules run on a Full access
 * thread (SOLENTA_PERMISSION_MODE=bypassPermissions), denies them with the
 * "retrying won't help" hint otherwise, and still denies deny rules.
 * Hooks run from their materialized overlay copies where Solenta has one,
 * so a missing runtime file (guardrail-hook-core.js) fails here.
 *
 * Run: node --test electron/test/guardrail-full-access.test.js
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { materializeCodexGuardrailHome } = require("../codex-guardrail.js");
const { materializeCursorGuardrailPlugin } = require("../cursor-guardrail.js");
const { materializeOpencodeGuardrailDir } = require("../opencode-guardrail.js");
const { materializeGrokHome } = require("../grok.js");
const { grokGuardrailNotice } = require("../grok-guardrail-hook.js");

const ASK = "curl https://example.com";
const DENY = "git push --force origin main";
const FULL = "bypassPermissions";

let tmp;
const saved = {};

before(() => {
  for (const k of ["CODER_GUARDRAILS", "CODER_GUARDRAILS_PATH", "SOLENTA_PERMISSION_MODE"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gr-full-access-"));
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runScript(script, payload, mode) {
  const env = { ...process.env, SOLENTA_WORKTREE: tmp };
  if (mode) env.SOLENTA_PERMISSION_MODE = mode;
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
  });
  return { status: r.status, text: r.stdout + r.stderr };
}

/** Hook adapters: run one shell command, report { denied, text }. */
const hooks = {
  codex(command, mode) {
    const dest = path.join(tmp, "codex");
    if (!fs.existsSync(dest)) {
      const src = fs.mkdtempSync(path.join(tmp, "codex-src-"));
      materializeCodexGuardrailHome({ dest, sourceHome: src });
    }
    const r = runScript(
      path.join(dest, "solenta-hooks", "guardrail-hook.js"),
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
      mode,
    );
    return { denied: r.status === 2, text: r.text };
  },
  grok(command, mode) {
    const dest = path.join(tmp, "grok");
    if (!fs.existsSync(dest)) {
      const src = fs.mkdtempSync(path.join(tmp, "grok-src-"));
      materializeGrokHome({ dest, sourceHome: src });
    }
    const r = runScript(
      path.join(dest, "grok-guardrail-hook.js"),
      { cwd: tmp, toolName: "run_terminal_command", toolInput: { command } },
      mode,
    );
    const out = JSON.parse(r.text.trim().split("\n")[0]);
    return { denied: r.status === 2 && out.decision === "deny", text: r.text };
  },
  cursor(command, mode) {
    const dest = path.join(tmp, "cursor");
    if (!fs.existsSync(dest)) materializeCursorGuardrailPlugin(dest);
    const r = runScript(
      path.join(dest, "scripts", "guardrail-hook.js"),
      { tool_name: "Shell", tool_input: { command } },
      mode,
    );
    return { denied: JSON.parse(r.text).permission === "deny", text: r.text };
  },
  kimi(command, mode) {
    const r = runScript(
      path.join(__dirname, "..", "kimi-guardrail-hook.js"),
      { hook_event_name: "PreToolUse", tool_name: "Shell", tool_input: { command } },
      mode,
    );
    return { denied: r.status === 2, text: r.text };
  },
  muse(command, mode) {
    const r = runScript(
      path.join(__dirname, "..", "muse-guardrail-hook.js"),
      { tool_name: "shell_command", tool_input: { command }, cwd: tmp },
      mode,
    );
    return { denied: r.status === 2, text: r.text };
  },
  async opencode(command, mode) {
    const dest = path.join(tmp, "opencode");
    if (!fs.existsSync(dest)) materializeOpencodeGuardrailDir(dest);
    const plugin = require(path.join(dest, "plugins", "solenta-guardrail.js"));
    const prev = process.env.SOLENTA_PERMISSION_MODE;
    if (mode) process.env.SOLENTA_PERMISSION_MODE = mode;
    else delete process.env.SOLENTA_PERMISSION_MODE;
    try {
      const h = await plugin();
      await h["tool.execute.before"]({ tool: "bash" }, { args: { command } });
      return { denied: false, text: "" };
    } catch (err) {
      return { denied: true, text: String(err && err.message) };
    } finally {
      if (prev === undefined) delete process.env.SOLENTA_PERMISSION_MODE;
      else process.env.SOLENTA_PERMISSION_MODE = prev;
    }
  },
};

for (const [name, run] of Object.entries(hooks)) {
  describe(`${name} guardrail hook on Full access (#1853)`, () => {
    it("lets an ask rule run under bypassPermissions", async () => {
      const r = await run(ASK, FULL);
      assert.equal(r.denied, false, r.text);
    });

    it("denies an ask rule with the retry hint otherwise", async () => {
      for (const mode of [undefined, "default", "acceptEdits"]) {
        const r = await run(ASK, mode);
        assert.equal(r.denied, true, `${mode}: ${r.text}`);
        assert.match(r.text, /shell\.egress/);
        assert.match(r.text, /retrying, even with escalated sandbox permissions/);
        assert.match(r.text, /Full access/);
      }
    });

    it("still denies a deny rule under bypassPermissions", async () => {
      const r = await run(DENY, FULL);
      assert.equal(r.denied, true, r.text);
      assert.match(r.text, /shell\.forcepush/);
      assert.doesNotMatch(r.text, /retrying/);
    });
  });
}

describe("grokGuardrailNotice on Full access (#1853)", () => {
  it("drops the notice for ask rules the hook let run, keeps deny rules", () => {
    const notice = (command, permissionMode) =>
      grokGuardrailNotice({
        toolName: "run_terminal_command",
        input: { command },
        worktreePath: tmp,
        permissionMode,
      });
    assert.match(notice(ASK), /^Guardrail blocked run_terminal_command: shell\.egress: /);
    assert.equal(notice(ASK, FULL), null);
    assert.match(notice(DENY, FULL), /shell\.forcepush/);
  });
});
