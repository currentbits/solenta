"use strict";

/**
 * Workflow Claude / Codex / OpenCode / Cursor phases persist the stream
 * session on the workflow agent (not thread.sessionId) and emit that
 * provider's resume flag only when a later spawn of the same slot has a
 * real id. Never "cwd". Kimi stays a one-shot (issue #782 / #808).
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const { spawnPhaseAgent } = require("../workflow.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function readArgv(argvFile) {
  assert.ok(fs.existsSync(argvFile), "fake CLI must dump process.argv");
  return JSON.parse(fs.readFileSync(argvFile, "utf8"));
}

function writeDumpingBin(dir, name, emitBody) {
  const argvFile = path.join(dir, `${name}-argv.json`);
  const fake = writeFakeBin(
    path.join(dir, `fake-${name}`),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_WF_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_WF_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
${emitBody}
`,
  );
  return { fake, argvFile };
}

const CLAUDE_EMIT = `
emit({ type: "system", subtype: "init", session_id: "wf-claude-sess", model: "sonnet" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "CLAUDE_OK" }] } });
emit({ type: "result", result: "CLAUDE_OK", session_id: "wf-claude-sess", usage: { input_tokens: 1, output_tokens: 1 } });
`;

const GROK_EMIT = `
emit({ type: "system", subtype: "init", session_id: "wf-grok-sess", model: "grok-4.6" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "GROK_OK" }] } });
emit({ type: "result", result: "GROK_OK", session_id: "wf-grok-sess", usage: { input_tokens: 1, output_tokens: 1 } });
`;

const CODEX_EMIT = `
emit({ type: "thread.started", thread_id: "wf-codex-sess" });
emit({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "CODEX_OK" } });
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
`;

const OPENCODE_EMIT = `
emit({ type: "step_start", sessionID: "ses_wf_opencode" });
emit({ type: "text", sessionID: "ses_wf_opencode", part: { id: "p1", text: "OPENCODE_OK" } });
emit({ type: "step_finish", sessionID: "ses_wf_opencode" });
`;

const CURSOR_EMIT = `
emit({ type: "system", subtype: "init", session_id: "wf-cursor-sess", model: "auto" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "CURSOR_OK" }] }, timestamp_ms: 1 });
emit({ type: "result", session_id: "wf-cursor-sess", result: "CURSOR_OK" });
`;

const KIMI_EMIT = `
emit({ role: "assistant", content: "KIMI_OK" });
emit({
  role: "meta",
  type: "session.resume_hint",
  session_id: "session_wf_kimi",
  command: "kimi -S session_wf_kimi",
});
`;

function assertResumeFlag(argv, flag, id) {
  const idx = argv.indexOf(flag);
  assert.ok(idx >= 0, `expected ${flag}: ${JSON.stringify(argv)}`);
  assert.equal(argv[idx + 1], id);
}

function assertNoResumeFlag(argv, flag) {
  assert.ok(!argv.includes(flag), `${flag} must not be emitted: ${JSON.stringify(argv)}`);
}

const CASES = [
  {
    id: "claude",
    envBin: "CODER_CLAUDE_BIN",
    emit: CLAUDE_EMIT,
    sessionId: "wf-claude-sess",
    assertFresh(argv) {
      assertNoResumeFlag(argv, "--resume");
    },
    assertResume(argv) {
      assertResumeFlag(argv, "--resume", "wf-claude-sess");
    },
  },
  {
    id: "grok",
    envBin: "CODER_GROK_BIN",
    emit: GROK_EMIT,
    sessionId: "wf-grok-sess",
    assertFresh(argv) {
      assertNoResumeFlag(argv, "--resume");
    },
    assertResume(argv) {
      assertResumeFlag(argv, "--resume", "wf-grok-sess");
    },
  },
  {
    id: "codex",
    envBin: "CODER_CODEX_BIN",
    emit: CODEX_EMIT,
    sessionId: "wf-codex-sess",
    assertFresh(argv) {
      const execIdx = argv.indexOf("exec");
      assert.ok(execIdx >= 0, `expected exec: ${JSON.stringify(argv)}`);
      assert.notEqual(
        argv[execIdx + 1],
        "resume",
        `fresh exec must not resume: ${JSON.stringify(argv)}`,
      );
      assert.ok(argv.includes("--sandbox"), "fresh Codex still needs --sandbox");
    },
    assertResume(argv) {
      const execIdx = argv.indexOf("exec");
      assert.ok(execIdx >= 0, `expected exec: ${JSON.stringify(argv)}`);
      assert.equal(argv[execIdx + 1], "resume");
      assert.equal(argv[execIdx + 2], "wf-codex-sess");
      assert.ok(
        !argv.includes("--sandbox"),
        "codex exec resume must omit --sandbox (#795)",
      );
    },
  },
  {
    id: "opencode",
    envBin: "CODER_OPENCODE_BIN",
    emit: OPENCODE_EMIT,
    sessionId: "ses_wf_opencode",
    assertFresh(argv) {
      assertNoResumeFlag(argv, "-s");
    },
    assertResume(argv) {
      assertResumeFlag(argv, "-s", "ses_wf_opencode");
    },
  },
  {
    id: "cursor",
    envBin: "CODER_CURSOR_BIN",
    emit: CURSOR_EMIT,
    sessionId: "wf-cursor-sess",
    assertFresh(argv) {
      assertNoResumeFlag(argv, "--resume");
    },
    assertResume(argv) {
      assertResumeFlag(argv, "--resume", "wf-cursor-sess");
    },
  },
];

describe("workflow phase session resume (#808)", () => {
  let tmpDir;
  /** @type {Record<string, { fake: string, argvFile: string }>} */
  let bins;
  let prev;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-phase-resume-"));
    bins = {
      claude: writeDumpingBin(tmpDir, "claude", CLAUDE_EMIT),
      grok: writeDumpingBin(tmpDir, "grok", GROK_EMIT),
      codex: writeDumpingBin(tmpDir, "codex", CODEX_EMIT),
      opencode: writeDumpingBin(tmpDir, "opencode", OPENCODE_EMIT),
      cursor: writeDumpingBin(tmpDir, "cursor", CURSOR_EMIT),
      kimi: writeDumpingBin(tmpDir, "kimi", KIMI_EMIT),
    };
    prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_CLAUDE_BIN: process.env.CODER_CLAUDE_BIN,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_CODEX_BIN: process.env.CODER_CODEX_BIN,
      CODER_OPENCODE_BIN: process.env.CODER_OPENCODE_BIN,
      CODER_CURSOR_BIN: process.env.CODER_CURSOR_BIN,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_FAKE_WF_ARGV_FILE: process.env.CODER_FAKE_WF_ARGV_FILE,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_CLAUDE_BIN = bins.claude.fake;
    process.env.CODER_GROK_BIN = bins.grok.fake;
    process.env.CODER_CODEX_BIN = bins.codex.fake;
    process.env.CODER_OPENCODE_BIN = bins.opencode.fake;
    process.env.CODER_CURSOR_BIN = bins.cursor.fake;
    process.env.CODER_KIMI_BIN = bins.kimi.fake;
    process.env.CODER_GROK_MCP_DISABLE = "1";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  for (const c of CASES) {
    it(`${c.id}: fresh spawn captures the session id and emits no resume flag`, async () => {
      const projectDir = path.join(tmpDir, "proj");
      fs.mkdirSync(projectDir);
      process.env.CODER_FAKE_WF_ARGV_FILE = bins[c.id].argvFile;
      const { done } = spawnPhaseAgent({
        providerId: c.id,
        prompt: "first pass",
        cwd: projectDir,
        model: null,
      });
      const result = await done;
      assert.equal(result.ok, true, result.stderr);
      assert.equal(
        result.sessionId,
        c.sessionId,
        "phase child must surface extractSessionId",
      );
      c.assertFresh(readArgv(bins[c.id].argvFile));
    });

    it(`${c.id}: retry spawn with a real session id emits the resume flag`, async () => {
      const projectDir = path.join(tmpDir, "proj");
      fs.mkdirSync(projectDir);
      process.env.CODER_FAKE_WF_ARGV_FILE = bins[c.id].argvFile;
      const { done } = spawnPhaseAgent({
        providerId: c.id,
        prompt: "retry pass",
        cwd: projectDir,
        model: null,
        sessionId: c.sessionId,
      });
      const result = await done;
      assert.equal(result.ok, true, result.stderr);
      assert.equal(result.sessionId, c.sessionId);
      c.assertResume(readArgv(bins[c.id].argvFile));
    });

    it(`${c.id}: cwd sentinel and empty session id never resume`, async () => {
      const projectDir = path.join(tmpDir, "proj");
      fs.mkdirSync(projectDir);
      for (const sessionId of ["cwd", "", null]) {
        if (fs.existsSync(bins[c.id].argvFile)) fs.unlinkSync(bins[c.id].argvFile);
        process.env.CODER_FAKE_WF_ARGV_FILE = bins[c.id].argvFile;
        const { done } = spawnPhaseAgent({
          providerId: c.id,
          prompt: "no resume",
          cwd: projectDir,
          model: null,
          sessionId,
        });
        const result = await done;
        assert.equal(result.ok, true, result.stderr);
        const argv = readArgv(bins[c.id].argvFile);
        c.assertFresh(argv);
        assert.ok(
          !argv.includes("cwd"),
          `must not pass cwd as a session: ${JSON.stringify(argv)}`,
        );
      }
    });
  }

  it("kimi spawn stays a one-shot: no -S even when sessionId is passed", async () => {
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    process.env.CODER_FAKE_WF_ARGV_FILE = bins.kimi.argvFile;
    const { done } = spawnPhaseAgent({
      providerId: "kimi",
      prompt: "kimi one-shot",
      cwd: projectDir,
      model: null,
      sessionId: "session_wf_kimi",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);
    const argv = readArgv(bins.kimi.argvFile);
    assertNoResumeFlag(argv, "-S");
    assert.ok(!argv.includes("-c"), `-c must never be emitted: ${JSON.stringify(argv)}`);
  });

  it("startWorkflowRun stores the id on the agent, not thread.sessionId", async () => {
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    git(projectDir, ["init"]);
    git(projectDir, ["config", "user.email", "t@t.com"]);
    git(projectDir, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(projectDir, "README.md"), "hi\n");
    git(projectDir, ["add", "."]);
    git(projectDir, ["commit", "-m", "init"]);

    process.env.CODER_FAKE_WF_ARGV_FILE = bins.claude.argvFile;
    const store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    /** @type {object[]} */
    const workflows = [];
    const runner = createRunner({
      store,
      core,
      pushFn(channel, payload) {
        if (payload && payload.workflow) {
          workflows.push(payload.workflow);
        }
      },
      tickMs: 15,
      userDataPath: tmpDir,
    });
    try {
      const project = await services.addProject(store, projectDir);
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Phase Resume",
      });
      services.setProvider(store, { threadId: thread.id, provider: "claude" });
      const tmpl = services.saveTemplate(store, {
        name: "Claude resume",
        phases: [
          {
            name: "plan",
            agentCount: 1,
            instruction: "Plan briefly.",
            provider: "claude",
            model: null,
          },
        ],
      });

      await runner.startWorkflowRun({
        threadId: thread.id,
        prompt: "resume task",
        templateId: tmpl.id,
      });
      await waitFor(() => {
        const t = store.getThread(thread.id);
        return t && (t.status === "done" || t.status === "failed");
      });
      assert.equal(store.getThread(thread.id).status, "done");
      assert.equal(
        store.getThread(thread.id).sessionId,
        null,
        "workflow phase session must not land on the parent thread",
      );

      const seenAgent = workflows
        .flatMap((w) => w.phases || [])
        .flatMap((p) => p.agents || [])
        .find((a) => a.sessionId === "wf-claude-sess");
      assert.ok(
        seenAgent,
        "workflow agent must carry the captured session id",
      );

      const argv = readArgv(bins.claude.argvFile);
      assertNoResumeFlag(argv, "--resume");
    } finally {
      runner.stopAll();
    }
  });
});
