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
const {
  extractSessionId,
  extractTextPart,
  extractThinkingPart,
  extractToolEvent,
} = require("../opencode.js");
const { getProvider, listProviders } = require("../providers.js");
const { writeFakeBin } = require("./support/fakeBin.js");

/** 1x1 transparent PNG, the "tool-image" scenario's payload. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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

/**
 * Fake opencode CLI emitting NDJSON --format json events.
 * @param {string} dir
 */
async function writeFakeOpencode(dir) {
  const scriptPath = path.join(dir, "fake-opencode.js");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");

if (process.env.CODER_FAKE_OPENCODE_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_OPENCODE_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}

const scenario = process.env.CODER_FAKE_OPENCODE_SCENARIO || "success";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

async function main() {
  if (scenario === "fail-exit") {
    process.stderr.write("opencode-stderr-boom\\n");
    process.exit(2);
    return;
  }

  if (scenario === "structured-overflow") {
    emit({
      type: "error",
      timestamp: Date.now(),
      sessionID: "ses_opencode_overflow",
      error: {
        name: "ContextOverflowError",
        data: {
          code: "context_length_exceeded",
          message:
            "input length and max_tokens exceed context limit: 131072 tokens",
        },
      },
    });
    process.exit(1);
    return;
  }

  if (scenario === "slow") {
    emit({
      type: "text",
      timestamp: Date.now(),
      sessionID: "ses_slow",
      part: { id: "p1", text: "partial" },
    });
    await delay(60000);
    process.exit(0);
    return;
  }

  if (scenario === "success") {
    emit({
      type: "step_start",
      timestamp: Date.now(),
      sessionID: "ses_opencode_001",
    });
    await delay(15);
    // Growing text on same part.id: first partial, then fuller
    emit({
      type: "text",
      timestamp: Date.now(),
      sessionID: "ses_opencode_001",
      part: { id: "part-a", text: "Hello" },
    });
    await delay(15);
    emit({
      type: "text",
      timestamp: Date.now(),
      sessionID: "ses_opencode_001",
      part: { id: "part-a", text: "Hello from" },
    });
    await delay(15);
    emit({
      type: "text",
      timestamp: Date.now(),
      sessionID: "ses_opencode_001",
      part: { id: "part-b", text: " opencode" },
    });
    await delay(15);
    emit({
      type: "tool_call",
      timestamp: Date.now(),
      sessionID: "ses_opencode_001",
      part: { id: "tool-1", name: "bash", input: { command: "echo hi" } },
    });
    await delay(15);
    emit({
      type: "tool_result",
      timestamp: Date.now(),
      sessionID: "ses_opencode_001",
      part: { id: "tool-1", name: "bash", output: "hi\\n" },
    });
    await delay(15);
    emit({
      type: "step_finish",
      timestamp: Date.now(),
      sessionID: "ses_opencode_001",
    });
    process.exit(0);
    return;
  }

  if (scenario === "plain-text") {
    process.stdout.write("Plain opencode reply without JSON\\n");
    process.exit(0);
    return;
  }

  if (scenario === "resume-turn") {
    emit({
      type: "text",
      timestamp: Date.now(),
      sessionID: "ses_opencode_001",
      part: { id: "p2", text: "Resumed reply" },
    });
    process.exit(0);
    return;
  }

  if (scenario === "tool-image") {
    emit({
      type: "step_start",
      timestamp: Date.now(),
      sessionID: "ses_opencode_img",
    });
    await delay(15);
    emit({
      type: "tool_call",
      timestamp: Date.now(),
      sessionID: "ses_opencode_img",
      part: { id: "tool-shot", name: "preview", input: { action: "screenshot" } },
    });
    await delay(15);
    emit({
      type: "tool_result",
      timestamp: Date.now(),
      sessionID: "ses_opencode_img",
      part: {
        id: "tool-shot",
        name: "preview",
        output: {
          content: [
            { type: "text", text: "captured" },
            { type: "image", data: "${PNG_B64}", mimeType: "image/png" },
          ],
        },
      },
    });
    await delay(15);
    emit({
      type: "step_finish",
      timestamp: Date.now(),
      sessionID: "ses_opencode_img",
    });
    process.exit(0);
    return;
  }

  if (scenario === "thinking-then-tool") {
    emit({
      type: "step_start",
      timestamp: Date.now(),
      sessionID: "ses_opencode_001",
    });
    await delay(10);
    emit({
      type: "reasoning",
      timestamp: Date.now(),
      sessionID: "ses_opencode_001",
      part: { id: "r1", type: "reasoning", text: "I should read opencode.js first." },
    });
    await delay(80);
    emit({
      type: "tool_call",
      timestamp: Date.now(),
      sessionID: "ses_opencode_001",
      part: { id: "call-read-1", name: "Read", input: { file_path: "electron/opencode.js" } },
    });
    await delay(15);
    emit({
      type: "tool_result",
      timestamp: Date.now(),
      sessionID: "ses_opencode_001",
      part: { id: "call-read-1", name: "Read", output: "exports" },
    });
    await delay(10);
    emit({
      type: "step_finish",
      timestamp: Date.now(),
      sessionID: "ses_opencode_001",
    });
    process.exit(0);
    return;
  }

  process.stderr.write("unknown scenario\\n");
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(String(e) + "\\n");
  process.exit(1);
});
`;
  return writeFakeBin(scriptPath, body);
}

describe("opencode extract helpers", () => {
  it("extracts sessionID and text part with defensive fallbacks", () => {
    assert.equal(
      extractSessionId({ type: "step_start", sessionID: "ses_1" }),
      "ses_1",
    );
    assert.equal(extractSessionId({ type: "x" }), null);

    assert.deepEqual(
      extractTextPart({
        type: "text",
        part: { id: "p1", text: "hi" },
      }),
      { id: "p1", text: "hi" },
    );
    assert.equal(extractTextPart({ type: "step_start", part: {} }), null);
  });

  it("extracts reasoning/thinking parts (issue #751)", () => {
    assert.deepEqual(
      extractThinkingPart({
        type: "reasoning",
        part: { id: "r1", type: "reasoning", text: "check the tests" },
      }),
      { id: "r1", text: "check the tests" },
    );
    assert.deepEqual(
      extractThinkingPart({
        type: "thinking",
        part: { id: "t1", text: "also thinking" },
      }),
      { id: "t1", text: "also thinking" },
    );
    assert.equal(extractThinkingPart({ type: "text", part: { text: "no" } }), null);
    assert.equal(extractTextPart({ type: "reasoning", part: { text: "x" } }), null);
  });

  it("extracts tool-ish events when type contains tool and name is set", () => {
    const start = extractToolEvent({
      type: "tool_call",
      part: { id: "t1", name: "bash", input: { x: 1 } },
    });
    assert.ok(start);
    assert.equal(start.id, "t1");
    assert.equal(start.name, "bash");
    assert.equal(start.phase, "start");

    const end = extractToolEvent({
      type: "tool_result",
      part: { id: "t1", name: "bash", output: "ok" },
    });
    assert.ok(end);
    assert.equal(end.phase, "end");
    assert.equal(end.output, "ok");
  });

  it("harvests MCP image blocks from tool_result output and keeps base64 out of output (#726)", () => {
    const end = extractToolEvent({
      type: "tool_result",
      part: {
        id: "tool-shot",
        name: "preview",
        output: {
          content: [
            { type: "text", text: "captured" },
            { type: "image", data: PNG_B64, mimeType: "image/png" },
          ],
        },
      },
    });
    assert.ok(end);
    assert.equal(end.phase, "end");
    assert.equal(end.name, "preview");
    assert.equal(end.images.length, 1);
    assert.equal(end.images[0].mediaType, "image/png");
    assert.equal(end.images[0].data, PNG_B64);
    assert.ok(!String(end.output).includes(PNG_B64));
    assert.match(String(end.output), /captured/);
    assert.match(String(end.output), /\[image\]/);
  });

  it("harvests Anthropic image blocks nested in tool_result output (#726)", () => {
    const end = extractToolEvent({
      type: "tool_result",
      part: {
        id: "t-read",
        name: "read",
        output: {
          content: [
            { type: "text", text: "Read image" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: PNG_B64,
              },
            },
          ],
        },
      },
    });
    assert.ok(end);
    assert.equal(end.images.length, 1);
    assert.equal(end.images[0].data, PNG_B64);
    assert.ok(!String(end.output).includes(PNG_B64));
    assert.match(String(end.output), /\[image\]/);
  });
});

describe("opencode provider registry", () => {
  it("lists opencode as opencode-json with supportsResume true", () => {
    const entry = getProvider("opencode");
    assert.equal(entry.kind, "opencode-json");
    assert.equal(entry.supportsResume, true);
    assert.ok(entry.models.length > 0, "opencode must list verified free models");
    assert.ok(entry.models.every((id) => id.includes("/")));
    assert.ok(entry.models.includes("opencode/hy3-free"));
    assert.ok(!entry.models.includes("opencode/north-mini-code-free"));

    const list = listProviders({ which: () => null, includeSimulate: false });
    const info = list.find((p) => p.id === "opencode");
    assert.equal(info.supportsResume, true);
    assert.deepEqual(info.models, entry.models);

    // buildArgs still forwards any -m string; membership is enforced at setProvider.
    const listed = entry.models[0];
    const args = entry.buildArgs({
      prompt: "go",
      sessionId: "ses_x",
      model: listed,
    });
    assert.deepEqual(args.slice(0, 3), ["run", "--format", "json"]);
    assert.equal(args[args.length - 1], "go");
    assert.equal(args[args.indexOf("-s") + 1], "ses_x");
    assert.equal(args[args.indexOf("-m") + 1], listed);
  });
});

describe("opencode runner integration", () => {
  let tmpDir;
  let store;
  let runner;
  let fakeBin;
  let argvFile;
  let prevBin;
  let prevScenario;
  let prevArgv;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-opencode-"));
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    git(projectDir, ["init"]);
    git(projectDir, ["config", "user.email", "t@t.com"]);
    git(projectDir, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(projectDir, "README.md"), "hi\n");
    git(projectDir, ["add", "."]);
    git(projectDir, ["commit", "-m", "init"]);

    fakeBin = await writeFakeOpencode(tmpDir);
    argvFile = path.join(tmpDir, "argv.json");

    prevBin = process.env.CODER_OPENCODE_BIN;
    prevScenario = process.env.CODER_FAKE_OPENCODE_SCENARIO;
    prevArgv = process.env.CODER_FAKE_OPENCODE_ARGV_FILE;
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_OPENCODE_BIN = fakeBin;
    process.env.CODER_FAKE_OPENCODE_ARGV_FILE = argvFile;
    process.env.CODER_FAKE_OPENCODE_SCENARIO = "success";

    const storePath = path.join(tmpDir, "store.json");
    store = new Store(storePath);
    const project = await services.addProject(store, projectDir);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "OpenCode Thread",
    });
    services.setProvider(store, { threadId: thread.id, provider: "opencode" });
    store.saveNow();

    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 50,
      userDataPath: tmpDir,
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    if (prevBin === undefined) delete process.env.CODER_OPENCODE_BIN;
    else process.env.CODER_OPENCODE_BIN = prevBin;
    if (prevScenario === undefined) delete process.env.CODER_FAKE_OPENCODE_SCENARIO;
    else process.env.CODER_FAKE_OPENCODE_SCENARIO = prevScenario;
    if (prevArgv === undefined) delete process.env.CODER_FAKE_OPENCODE_ARGV_FILE;
    else process.env.CODER_FAKE_OPENCODE_ARGV_FILE = prevArgv;
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("grows text across part-id repeats, captures sessionID, tools, estimated usage", async () => {
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "do the thing",
    });

    await waitFor(() => store.getThread(thread.id).status === "done");

    assert.equal(store.getThread(thread.id).sessionId, "ses_opencode_001");

    const msgs = store.getMessages(thread.id);
    const assistants = msgs.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    // part-a replaced (Hello -> Hello from) + part-b
    assert.equal(assistants[0].text, "Hello from opencode");
    assert.equal(assistants[0].runId, runId);

    const tools = msgs.filter((m) => m.role === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool.name, "bash");
    assert.equal(tools[0].tool.done, true);

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 0);
    assert.ok(usage.outputTokens > 0);
    assert.equal(usage.turns, 1);

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("run"));
    assert.ok(argv.includes("--format"));
    assert.ok(argv.includes("json"));
    // Prompt is always the last argv element (flags first).
    assert.equal(argv[argv.length - 1], "do the thing");
    assert.ok(!argv.includes("-s"));
  });

  it("second turn passes -s with captured sessionID", async () => {
    process.env.CODER_FAKE_OPENCODE_SCENARIO = "success";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "turn one" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(store.getThread(thread.id).sessionId, "ses_opencode_001");

    process.env.CODER_FAKE_OPENCODE_SCENARIO = "resume-turn";
    fs.unlinkSync(argvFile);

    await runner.startRun({ threadId: thread.id, prompt: "turn two" });
    await waitFor(() => {
      const msgs = store.getMessages(thread.id);
      return msgs.some(
        (m) => m.role === "assistant" && m.text === "Resumed reply",
      );
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("-s"), `expected -s in ${JSON.stringify(argv)}`);
    assert.equal(argv[argv.indexOf("-s") + 1], "ses_opencode_001");
    assert.equal(argv[argv.length - 1], "turn two");
  });

  it("plain-text fallback when stdout has no JSON lines", async () => {
    process.env.CODER_FAKE_OPENCODE_SCENARIO = "plain-text";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "plain" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const assistants = store
      .getMessages(thread.id)
      .filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.match(assistants[0].text, /Plain opencode reply without JSON/);
  });

  it("nonzero exit sets failed + stderr tail", async () => {
    process.env.CODER_FAKE_OPENCODE_SCENARIO = "fail-exit";
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "boom",
    });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    assert.ok(
      store
        .getMessages(thread.id)
        .some(
          (m) =>
            m.role === "event" &&
            /Run error/i.test(m.text) &&
            /opencode-stderr-boom/i.test(m.text) &&
            m.runId === runId,
        ),
    );
  });

  it("classifies stdout-only error JSON overflow and records one normalized event", async () => {
    process.env.CODER_FAKE_OPENCODE_SCENARIO = "structured-overflow";
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "overflow",
    });

    await waitFor(() => store.getThread(thread.id).status === "failed");

    const failed = store.getThread(thread.id);
    assert.equal(failed.lastErrorKind, "context-overflow");
    assert.equal(failed.quotaWaitUntil, null);
    assert.equal(failed.sessionId, "ses_opencode_overflow");
    assert.match(failed.lastError, /^Context window is full\./);

    const events = store
      .getMessages(thread.id)
      .filter((m) => m.role === "event" && m.runId === runId);
    assert.equal(events.length, 1);
    assert.match(events[0].text, /^Context window is full\./);
    assert.match(events[0].text, /context_length_exceeded/);
    assert.match(events[0].text, /input length and max_tokens/);
    assert.doesNotMatch(events[0].text, /Quota wait:/);
  });

  it("saves screenshot tool results to disk and names them on the tool message (#726)", async () => {
    process.env.CODER_FAKE_OPENCODE_SCENARIO = "tool-image";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "screenshot it" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const tool = store.getMessages(thread.id).find((m) => m.role === "tool");
    assert.ok(tool);
    assert.equal(tool.tool.done, true);
    assert.equal(tool.tool.name, "preview");
    assert.equal(tool.tool.images.length, 1);
    assert.ok(!JSON.stringify(tool).includes(PNG_B64));
    assert.ok(!String(tool.tool.output || "").includes(PNG_B64));
    const file = path.join(tmpDir, "tool-images", tool.tool.images[0]);
    assert.equal(fs.readFileSync(file).toString("base64"), PNG_B64);
  });

  it("stop kills the running process and sets idle", async () => {
    process.env.CODER_FAKE_OPENCODE_SCENARIO = "slow";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "slow" });
    await waitFor(() => store.getThread(thread.id).status === "working");
    await runner.stopRun({ threadId: thread.id });
    await waitFor(() => store.getThread(thread.id).status === "idle");
    assert.ok(
      store
        .getMessages(thread.id)
        .some((m) => m.role === "event" && /stopped/i.test(m.text)),
    );
  });

  it("surfaces reasoning before the first tool card (issue #751)", async () => {
    process.env.CODER_FAKE_OPENCODE_SCENARIO = "thinking-then-tool";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "look around" });

    await waitFor(() =>
      store
        .getMessages(thread.id)
        .some((m) => m.thinking && /opencode\.js/.test(m.text)),
    );
    assert.equal(
      store.getMessages(thread.id).filter((m) => m.role === "tool").length,
      0,
      "reasoning must be visible before the later tool_call",
    );

    await waitFor(() => store.getThread(thread.id).status === "done");
    const msgs = store.getMessages(thread.id);
    assert.equal(msgs.filter((m) => m.thinking).length, 1);
    assert.equal(msgs.filter((m) => m.role === "tool").length, 1);
    assert.equal(msgs.find((m) => m.role === "tool").tool.name, "Read");
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("--thinking"));
  });
});
