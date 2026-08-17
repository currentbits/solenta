const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");

// otel.js is unit-tested against injected deps; this covers the other half —
// that a real run through the runner actually reaches a collector, with the
// run span and its tool span in one trace. The wiring is otherwise only ever
// exercised against a no-op.

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

/** Fake claude that runs one tool and finishes with usage. */
function writeFakeClaude(dir) {
  const scriptPath = path.join(dir, "fake-claude.js");
  const body = `#!/usr/bin/env node
"use strict";
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
if (process.env.CODER_FAKE_CLAUDE_ENV_FILE) {
  require("fs").writeFileSync(
    process.env.CODER_FAKE_CLAUDE_ENV_FILE,
    JSON.stringify({
      telemetry: process.env.CLAUDE_CODE_ENABLE_TELEMETRY || null,
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS || null,
    }),
    "utf8",
  );
}
emit({ type: "system", subtype: "init", session_id: "sess-otel", model: "m" });
emit({
  type: "assistant",
  message: {
    content: [
      { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
    ],
  },
});
emit({
  type: "user",
  message: {
    content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
  },
});
emit({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
emit({
  type: "result",
  subtype: "success",
  result: "done",
  session_id: "sess-otel",
  usage: { input_tokens: 10, output_tokens: 5 },
  total_cost_usd: 0.01,
});
process.exit(0);
`;
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

/** Every span POSTed across all batches, flattened. */
function spansFrom(calls) {
  const spans = [];
  for (const call of calls) {
    for (const rs of call.body.resourceSpans || []) {
      for (const ss of rs.scopeSpans || []) {
        spans.push(...(ss.spans || []));
      }
    }
  }
  return spans;
}

function attrOf(span, key) {
  const found = (span.attributes || []).find((a) => a.key === key);
  if (!found) return undefined;
  return Object.values(found.value)[0];
}

describe("OTel spans from a real run", () => {
  let tmpDir;
  let store;
  let runner;
  let core;
  let prevBin;
  let prevEnvFile;
  let prevFetch;
  let envFile;
  /** @type {Array<{ url: string, body: object, headers: object }>} */
  let calls;

  beforeEach(async () => {
    prevBin = process.env.CODER_CLAUDE_BIN;
    prevEnvFile = process.env.CODER_FAKE_CLAUDE_ENV_FILE;
    prevFetch = globalThis.fetch;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-otel-run-"));
    store = new Store(path.join(tmpDir, "store.json"));
    envFile = path.join(tmpDir, "env.json");
    process.env.CODER_CLAUDE_BIN = writeFakeClaude(tmpDir);
    process.env.CODER_FAKE_CLAUDE_ENV_FILE = envFile;

    calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init.body)),
        headers: init.headers,
      });
      return { ok: true, status: 200 };
    };

    core = await loadCore();
    runner = createRunner({ store, core, pushFn: () => {}, tickMs: 15 });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    services.createThread(store, { projectId: project.id, title: "OTel Thread" });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    globalThis.fetch = prevFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevBin;
    if (prevEnvFile === undefined) delete process.env.CODER_FAKE_CLAUDE_ENV_FILE;
    else process.env.CODER_FAKE_CLAUDE_ENV_FILE = prevEnvFile;
  });

  it("posts the run span and its tool span in one trace", async () => {
    services.setSettings(store, {
      otel: { endpoint: "http://127.0.0.1:4318", headers: { "x-key": "s3cret" }, claudeMetrics: false },
    });
    const thread = store.getThreads()[0];

    await runner.startRun({ threadId: thread.id, prompt: "hello" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    await runner.flushTranscripts();

    assert.ok(calls.length > 0, "collector received no POST");
    assert.equal(calls[0].url, "http://127.0.0.1:4318/v1/traces");
    assert.equal(calls[0].headers["x-key"], "s3cret");

    const spans = spansFrom(calls);
    const run = spans.find((s) => s.name === "invoke_agent claude");
    const tool = spans.find((s) => s.name === "execute_tool Bash");
    assert.ok(run, `no run span in ${spans.map((s) => s.name).join(", ")}`);
    assert.ok(tool, `no tool span in ${spans.map((s) => s.name).join(", ")}`);

    // session.id is the THREAD, which is what makes the tree cross-provider.
    assert.equal(attrOf(run, "session.id"), thread.id);
    assert.equal(attrOf(run, "gen_ai.provider.name"), "claude");
    assert.equal(attrOf(run, "gen_ai.usage.input_tokens"), "10");
    assert.equal(attrOf(run, "gen_ai.usage.output_tokens"), "5");
    assert.equal(run.status.code, 1);
    assert.match(run.traceId, /^[0-9a-f]{32}$/);
    assert.match(run.spanId, /^[0-9a-f]{16}$/);
    assert.match(run.startTimeUnixNano, /^\d+$/);

    // The tool hangs off the run, in the same trace.
    assert.equal(tool.traceId, run.traceId);
    assert.equal(tool.parentSpanId, run.spanId);
    assert.equal(attrOf(tool, "gen_ai.tool.name"), "Bash");
    // Real bracketed duration, not a fabricated one.
    assert.ok(Number(tool.endTimeUnixNano) >= Number(tool.startTimeUnixNano));
  });

  it("posts nothing when no endpoint is configured", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "hello" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    await runner.flushTranscripts();
    assert.deepEqual(calls, []);
  });

  it("hands Claude Code the OTel env only when claudeMetrics is on", async () => {
    services.setSettings(store, {
      otel: { endpoint: "http://127.0.0.1:4318", headers: { "x-key": "v" }, claudeMetrics: true },
    });
    const thread = store.getThreads()[0];

    await runner.startRun({ threadId: thread.id, prompt: "hello" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const seen = JSON.parse(fs.readFileSync(envFile, "utf8"));
    assert.equal(seen.telemetry, "1");
    assert.equal(seen.endpoint, "http://127.0.0.1:4318");
    assert.equal(seen.headers, "x-key=v");
  });

  it("a failed run posts an ERROR span with the reason", async () => {
    services.setSettings(store, {
      otel: { endpoint: "http://127.0.0.1:4318", headers: {}, claudeMetrics: false },
    });
    // A binary that exits non-zero without ever emitting a result event.
    const failing = path.join(tmpDir, "fake-claude-fail.js");
    fs.writeFileSync(
      failing,
      '#!/usr/bin/env node\nprocess.stderr.write("boom: no such model\\n");\nprocess.exit(3);\n',
      { mode: 0o755 },
    );
    process.env.CODER_CLAUDE_BIN = failing;

    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "hello" });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    await runner.flushTranscripts();

    const run = spansFrom(calls).find((s) => s.name === "invoke_agent claude");
    assert.ok(run, "no run span for the failed run");
    assert.equal(run.status.code, 2);
    assert.match(run.status.message, /boom/);
    assert.equal(attrOf(run, "solenta.run.status"), "failed");
  });
});
