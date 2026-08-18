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
  extractAssistantText,
  extractToolEvent,
  extractToolEvents,
  extractSessionId,
  extractUsage,
} = require("../kimi.js");
const { getProvider } = require("../providers.js");
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

/**
 * Fake kimi CLI. Reads CODER_FAKE_KIMI_SCENARIO and optional argv file.
 * @param {string} dir
 * @returns {string} script path
 */
async function writeFakeKimi(dir) {
  const scriptPath = path.join(dir, "fake-kimi.js");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");

if (process.env.CODER_FAKE_KIMI_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_KIMI_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}

const scenario = process.env.CODER_FAKE_KIMI_SCENARIO || "success";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

async function main() {
  if (scenario === "fail-exit") {
    process.stderr.write("kimi-stderr-boom\\n");
    process.exit(2);
    return;
  }

  if (scenario === "slow") {
    emit({ type: "text", text: "partial" });
    await delay(60000);
    process.exit(0);
    return;
  }

  if (scenario === "success") {
    // REAL kimi 0.31.1 stream-json shapes, recorded from a live run. The
    // previous fake used invented type-based shapes, so the whole suite was
    // green while real kimi turns rendered nothing.
    emit({ role: "assistant", content: "Hello " });
    await delay(20);
    emit({ role: "assistant", content: "from kimi!" });
    await delay(20);
    emit({
      role: "assistant",
      tool_calls: [
        {
          type: "function",
          id: "tool-1",
          function: {
            name: "Write",
            arguments: "{\\"path\\":\\"probe.txt\\",\\"content\\":\\"hello\\"}",
          },
        },
      ],
    });
    await delay(20);
    emit({
      role: "tool",
      tool_call_id: "tool-1",
      content: "Wrote 6 bytes to probe.txt",
    });
    await delay(20);
    emit({
      role: "meta",
      type: "session.resume_hint",
      session_id: "session_fake123",
      command: "kimi -r session_fake123",
      content: "To resume this session: kimi -r session_fake123",
    });
    process.exit(0);
    return;
  }

  if (scenario === "legacy-types") {
    // Old type-based shapes: kept parseable so a downgrade or older kimi
    // still streams; no resume hint, so sessionId stays null (no -c).
    emit({ type: "text", text: "Legacy " });
    await delay(20);
    emit({ type: "assistant", delta: "reply" });
    await delay(20);
    emit({
      type: "tool_call",
      id: "tool-1",
      name: "Bash",
      input: { command: "echo hi" },
    });
    await delay(20);
    emit({
      type: "tool_result",
      id: "tool-1",
      name: "Bash",
      output: "hi\\n",
    });
    await delay(20);
    emit({
      type: "usage",
      input_tokens: 12,
      output_tokens: 8,
    });
    process.exit(0);
    return;
  }

  if (scenario === "plain-text") {
    // No JSON at all: entire stdout is plain text.
    process.stdout.write("Plain kimi reply without JSON\\n");
    process.exit(0);
    return;
  }

  if (scenario === "continue-turn") {
    emit({ role: "assistant", content: "Continued reply" });
    emit({
      role: "meta",
      type: "session.resume_hint",
      session_id: "session_fake456",
      command: "kimi -r session_fake456",
      content: "To resume this session: kimi -r session_fake456",
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

describe("kimi extract helpers: REAL recorded stream lines", () => {
  // Recorded verbatim from kimi 0.31.1 `--output-format stream-json -p`.
  // The suite previously validated the parser only against invented shapes,
  // which is how a parser that could not read real kimi shipped green.
  const REAL_TEXT = { role: "assistant", content: "ok" };
  const REAL_CALL = {
    role: "assistant",
    tool_calls: [
      {
        type: "function",
        id: "tool_aJv40ujcg7kk2L4DgXWOUutM",
        function: {
          name: "Write",
          arguments: '{"path":"probe.txt","content":"hello\\n"}',
        },
      },
    ],
  };
  const REAL_RESULT = {
    role: "tool",
    tool_call_id: "tool_aJv40ujcg7kk2L4DgXWOUutM",
    content: "Wrote 6 bytes to probe.txt",
  };
  const REAL_META = {
    role: "meta",
    type: "session.resume_hint",
    session_id: "session_cea263a5-1066-444e-84bc-4ce29d42fc6d",
    command: "kimi -r session_cea263a5-1066-444e-84bc-4ce29d42fc6d",
    content:
      "To resume this session: kimi -r session_cea263a5-1066-444e-84bc-4ce29d42fc6d",
  };

  it("assistant text comes only from role assistant content", () => {
    assert.equal(extractAssistantText(REAL_TEXT), "ok");
    // Not recorded live, but if kimi ever streams block arrays, dropping
    // them reproduces done-in-0s-with-no-reply while gotJson blocks the
    // plain-text fallback.
    assert.equal(
      extractAssistantText({
        role: "assistant",
        content: [{ type: "text", text: "block " }, "tail"],
      }),
      "block tail",
    );
    assert.equal(
      extractAssistantText(REAL_META),
      null,
      "the meta hint has a content string and must NOT render as text",
    );
    assert.equal(
      extractAssistantText(REAL_RESULT),
      null,
      "a tool result's content is not assistant text",
    );
    assert.equal(extractAssistantText(REAL_CALL), null);
  });

  it("tool_calls arrays yield one start event per call", () => {
    const events = extractToolEvents(REAL_CALL);
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, "start");
    assert.equal(events[0].name, "Write");
    assert.equal(events[0].id, "tool_aJv40ujcg7kk2L4DgXWOUutM");
    assert.match(events[0].input, /probe\.txt/);

    const two = extractToolEvents({
      role: "assistant",
      tool_calls: [
        { type: "function", id: "a", function: { name: "Read", arguments: "{}" } },
        { type: "function", id: "b", function: { name: "Bash", arguments: "{}" } },
      ],
    });
    assert.deepEqual(
      two.map((e) => e.name),
      ["Read", "Bash"],
      "one stream line can carry several calls; none may be dropped",
    );
  });

  it("role tool lines are end events paired by tool_call_id", () => {
    const events = extractToolEvents(REAL_RESULT);
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, "end");
    assert.equal(events[0].id, "tool_aJv40ujcg7kk2L4DgXWOUutM");
    assert.match(String(events[0].output), /Wrote 6 bytes/);
  });

  it("session id comes from the meta resume hint only", () => {
    assert.equal(
      extractSessionId(REAL_META),
      "session_cea263a5-1066-444e-84bc-4ce29d42fc6d",
    );
    assert.equal(extractSessionId(REAL_TEXT), null);
    assert.equal(extractSessionId(REAL_RESULT), null);
    assert.equal(extractSessionId({ type: "usage", session_id: "x" }), null);
  });

  it("legacy type-based shapes still parse through extractToolEvents", () => {
    const legacy = extractToolEvents({
      type: "tool_call",
      id: "t1",
      name: "Bash",
      input: { command: "echo hi" },
    });
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].name, "Bash");
  });
});

describe("kimi extract helpers", () => {
  it("extracts assistant text from type text/message/assistant string fields", () => {
    assert.equal(extractAssistantText({ type: "text", text: "a" }), "a");
    assert.equal(extractAssistantText({ type: "message", content: "b" }), "b");
    assert.equal(extractAssistantText({ type: "assistant", delta: "c" }), "c");
    assert.equal(
      extractAssistantText({
        type: "assistant",
        message: { content: "nested-str" },
      }),
      "nested-str",
    );
    assert.equal(
      extractAssistantText({
        type: "assistant",
        message: { content: [{ type: "text", text: "arr" }] },
      }),
      "arr",
    );
    assert.equal(extractAssistantText({ type: "other", text: "x" }), null);
  });

  it("extracts tool events when type contains tool and name is set", () => {
    const start = extractToolEvent({
      type: "tool_call",
      id: "t1",
      name: "Bash",
      input: { command: "ls" },
    });
    assert.ok(start);
    assert.equal(start.id, "t1");
    assert.equal(start.name, "Bash");
    assert.equal(start.phase, "start");

    const end = extractToolEvent({
      type: "tool_result",
      id: "t1",
      name: "Bash",
      output: "ok",
    });
    assert.ok(end);
    assert.equal(end.phase, "end");
    assert.equal(end.output, "ok");

    assert.equal(
      extractToolEvent({ type: "tool_call", id: "x" /* no name */ }),
      null,
    );
  });

  it("extracts usage from top-level and nested usage fields", () => {
    assert.deepEqual(extractUsage({ input_tokens: 1, output_tokens: 2 }), {
      inputTokens: 1,
      outputTokens: 2,
    });
    assert.deepEqual(
      extractUsage({ usage: { prompt_tokens: 3, completion_tokens: 4 } }),
      { inputTokens: 3, outputTokens: 4 },
    );
    assert.equal(extractUsage({ type: "text", text: "hi" }), null);
  });
});

describe("kimi provider buildArgs", () => {
  it("builds stream-json args with model, no permission flags, -S resume", () => {
    const entry = getProvider("kimi");
    assert.ok(entry);
    assert.equal(entry.kind, "kimi-stream");
    assert.equal(entry.supportsResume, true);
    assert.deepEqual(entry.models, [
      // Alias keys: bare model values fail -m with config.invalid.
      "kimi-code/k3",
      "kimi-code/k3-256k",
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
    ]);

    const base = entry.buildArgs({ prompt: "hi", permissionMode: "default" });
    assert.ok(base.includes("-p"));
    assert.equal(base[base.indexOf("-p") + 1], "hi");
    assert.ok(base.includes("--output-format"));
    assert.ok(base.includes("stream-json"));
    assert.ok(!base.includes("-y"));
    assert.ok(!base.includes("--auto"));
    assert.ok(!base.includes("-c"));

    const withModel = entry.buildArgs({
      prompt: "p",
      model: "kimi-code/kimi-for-coding",
    });
    const mIdx = withModel.indexOf("-m");
    assert.ok(mIdx >= 0);
    assert.equal(withModel[mIdx + 1], "kimi-code/kimi-for-coding");

    // -p hard-errors combined with -y or --auto (verified live), so NO
    // permission mode may emit a flag.
    for (const permissionMode of [
      "acceptEdits",
      "bypassPermissions",
      "plan",
      "default",
    ]) {
      const argv = entry.buildArgs({ prompt: "p", permissionMode });
      assert.ok(
        !argv.includes("-y") && !argv.includes("--auto"),
        `${permissionMode} must not emit -y/--auto: ${JSON.stringify(argv)}`,
      );
    }

    // Leftover "cwd" sentinel must not emit -c (per-dir bleed) or -S cwd.
    const cont = entry.buildArgs({
      prompt: "again",
      sessionId: "cwd",
    });
    assert.ok(!cont.includes("-c"));
    assert.ok(!cont.includes("-S"));
    assert.ok(!cont.includes("cwd"));

    const resumed = entry.buildArgs({
      prompt: "again",
      sessionId: "session_abc",
    });
    const sIdx = resumed.indexOf("-S");
    assert.ok(sIdx >= 0, `expected -S: ${JSON.stringify(resumed)}`);
    assert.equal(resumed[sIdx + 1], "session_abc");
    assert.ok(!resumed.includes("-c"));
  });
});

describe("kimi runner integration", () => {
  let tmpDir;
  let store;
  let runner;
  let pushes;
  let fakeBin;
  let argvFile;
  let prevKimiBin;
  let prevScenario;
  let prevArgv;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-kimi-"));
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    git(projectDir, ["init"]);
    git(projectDir, ["config", "user.email", "t@t.com"]);
    git(projectDir, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(projectDir, "README.md"), "hi\n");
    git(projectDir, ["add", "."]);
    git(projectDir, ["commit", "-m", "init"]);

    fakeBin = await writeFakeKimi(tmpDir);
    argvFile = path.join(tmpDir, "argv.json");

    prevKimiBin = process.env.CODER_KIMI_BIN;
    prevScenario = process.env.CODER_FAKE_KIMI_SCENARIO;
    prevArgv = process.env.CODER_FAKE_KIMI_ARGV_FILE;
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_KIMI_BIN = fakeBin;
    process.env.CODER_FAKE_KIMI_ARGV_FILE = argvFile;
    process.env.CODER_FAKE_KIMI_SCENARIO = "success";

    const storePath = path.join(tmpDir, "store.json");
    store = new Store(storePath);
    const project = await services.addProject(store, projectDir);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Kimi Thread",
    });
    services.setProvider(store, { threadId: thread.id, provider: "kimi" });
    store.saveNow();

    pushes = [];
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: (ch, payload) => pushes.push({ ch, payload }),
      tickMs: 50,
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    if (prevKimiBin === undefined) delete process.env.CODER_KIMI_BIN;
    else process.env.CODER_KIMI_BIN = prevKimiBin;
    if (prevScenario === undefined) delete process.env.CODER_FAKE_KIMI_SCENARIO;
    else process.env.CODER_FAKE_KIMI_SCENARIO = prevScenario;
    if (prevArgv === undefined) delete process.env.CODER_FAKE_KIMI_ARGV_FILE;
    else process.env.CODER_FAKE_KIMI_ARGV_FILE = prevArgv;
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("streams REAL role-shaped events and captures the session id", async () => {
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "do the thing",
    });

    await waitFor(() => store.getThread(thread.id).status === "done");

    assert.equal(
      store.getThread(thread.id).sessionId,
      "session_fake123",
      "the resume hint's session id must be captured, not the cwd sentinel",
    );

    const msgs = store.getMessages(thread.id);
    const assistants = msgs.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].text, "Hello from kimi!");
    assert.equal(assistants[0].runId, runId);
    assert.ok(
      !assistants[0].text.includes("resume"),
      "the meta hint's content string must never render as assistant text",
    );

    const tools = msgs.filter((m) => m.role === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool.name, "Write");
    assert.equal(tools[0].tool.done, true);
    assert.match(tools[0].tool.input, /probe\.txt/);
    assert.match(String(tools[0].tool.output || ""), /Wrote 6 bytes/);

    // Real kimi prompt mode emits no usage events; the zero fallback applies.
    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 0);
    assert.equal(usage.outputTokens, 0);
    assert.equal(usage.turns, 1);

    const detail = services.getThreadDetail(store, thread.id);
    assert.equal(detail.workflow, null);

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("-p"));
    assert.ok(argv.includes("--output-format"));
    assert.ok(argv.includes("stream-json"));
    assert.equal(argv[argv.indexOf("-p") + 1], "do the thing");
    assert.ok(!argv.includes("-c"));
    assert.ok(!argv.includes("-S"));
  });

  it("legacy type-based shapes still parse, with no session stamp", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "legacy-types";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "legacy" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    assert.equal(
      store.getThread(thread.id).sessionId,
      null,
      "no resume hint must not invent the per-cwd sentinel",
    );
    const msgs = store.getMessages(thread.id);
    const assistants = msgs.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].text, "Legacy reply");
    const tools = msgs.filter((m) => m.role === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool.name, "Bash");
    const usage = store.getUsage(thread.id);
    assert.equal(usage.inputTokens, 12);
    assert.equal(usage.outputTokens, 8);
  });

  it("plain-text fallback when stdout has no JSON lines", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "plain-text";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "plain" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const assistants = store
      .getMessages(thread.id)
      .filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.match(assistants[0].text, /Plain kimi reply without JSON/);
  });

  it("second turn resumes with -S and the captured session id", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "success";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "turn one" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(store.getThread(thread.id).sessionId, "session_fake123");

    process.env.CODER_FAKE_KIMI_SCENARIO = "continue-turn";
    fs.unlinkSync(argvFile);

    await runner.startRun({ threadId: thread.id, prompt: "turn two" });
    await waitFor(() => {
      const msgs = store.getMessages(thread.id);
      return msgs.some(
        (m) => m.role === "assistant" && m.text === "Continued reply",
      );
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const sIdx = argv.indexOf("-S");
    assert.ok(sIdx >= 0, `expected -S in ${JSON.stringify(argv)}`);
    assert.equal(argv[sIdx + 1], "session_fake123");
    assert.ok(!argv.includes("-c"), "-c is never emitted");
    assert.equal(argv[argv.indexOf("-p") + 1], "turn two");
    assert.equal(
      store.getThread(thread.id).sessionId,
      "session_fake456",
      "each turn stores the newest hint's session id",
    );
    assert.equal(store.getUsage(thread.id).turns, 2);
  });

  it("a hint-less turn never downgrades a real session id", async () => {
    // The terminal stamp is captured || prior-real-id. A hint-less turn
    // must keep a real -S id, not wipe it and not invent "cwd".
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { sessionId: "session_prior" });
    store.saveNow();
    process.env.CODER_FAKE_KIMI_SCENARIO = "legacy-types"; // emits no hint

    await runner.startRun({ threadId: thread.id, prompt: "no hint" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const sIdx = argv.indexOf("-S");
    assert.ok(sIdx >= 0, `expected -S in ${JSON.stringify(argv)}`);
    assert.equal(argv[sIdx + 1], "session_prior");
    assert.equal(
      store.getThread(thread.id).sessionId,
      "session_prior",
      "a turn without a resume hint must keep the session it resumed",
    );
  });

  it("thread A's second turn does not -c into a session only thread B created", async () => {
    // Two no-worktree kimi threads share the project directory. A hint-less
    // turn used to stamp sessionId "cwd"; A's next -c then resumed whichever
    // session last ran in that dir (B's). Issue #220.
    const projectId = store.getThreads()[0].projectId;
    const threadA = store.getThreads()[0];
    const threadB = services.createThread(store, {
      projectId,
      title: "Kimi Thread B",
    });
    services.setProvider(store, { threadId: threadB.id, provider: "kimi" });
    store.saveNow();

    process.env.CODER_FAKE_KIMI_SCENARIO = "legacy-types";
    await runner.startRun({ threadId: threadA.id, prompt: "A turn one" });
    await waitFor(() => store.getThread(threadA.id).status === "done");
    assert.equal(
      store.getThread(threadA.id).sessionId,
      null,
      "hint-less A must not be stamped cwd",
    );

    process.env.CODER_FAKE_KIMI_SCENARIO = "success";
    fs.unlinkSync(argvFile);
    await runner.startRun({ threadId: threadB.id, prompt: "B turn one" });
    await waitFor(() => store.getThread(threadB.id).status === "done");
    assert.equal(store.getThread(threadB.id).sessionId, "session_fake123");

    process.env.CODER_FAKE_KIMI_SCENARIO = "continue-turn";
    fs.unlinkSync(argvFile);
    await runner.startRun({ threadId: threadA.id, prompt: "A turn two" });
    await waitFor(() => store.getThread(threadA.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(
      !argv.includes("-c"),
      `A's second turn must not -c (that is B's last cwd session): ${JSON.stringify(argv)}`,
    );
    assert.ok(!argv.includes("-S"), `A has no session of its own: ${JSON.stringify(argv)}`);
    assert.ok(!argv.includes("session_fake123"));
    assert.equal(argv[argv.indexOf("-p") + 1], "A turn two");
    assert.equal(store.getThread(threadA.id).sessionId, "session_fake456");
  });

  it("never emits permission flags (they hard-error with -p) and propagates -m", async () => {
    // Verified live: "error: Cannot combine --prompt with --yolo/--auto".
    // Emitting them made every acceptEdits/bypassPermissions kimi turn fail.
    for (const permissionMode of ["acceptEdits", "bypassPermissions"]) {
      const thread = store.getThreads()[0];
      store.updateThread(thread.id, {
        permissionMode,
        model: "kimi-code/kimi-for-coding-highspeed",
      });
      store.saveNow();

      await runner.startRun({ threadId: thread.id, prompt: "flagged" });
      await waitFor(() => store.getThread(thread.id).status === "done");

      const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
      assert.ok(
        !argv.includes("-y") && !argv.includes("--auto"),
        `${permissionMode} must not emit a flag -p rejects: ${JSON.stringify(argv)}`,
      );
      const mIdx = argv.indexOf("-m");
      assert.ok(mIdx >= 0);
      assert.equal(argv[mIdx + 1], "kimi-code/kimi-for-coding-highspeed");
      fs.unlinkSync(argvFile);
    }
  });

  it("nonzero exit sets failed + stderr tail", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "fail-exit";
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "boom",
    });
    await waitFor(() => store.getThread(thread.id).status === "failed");

    assert.ok(
      store.getMessages(thread.id).some(
        (m) =>
          m.role === "event" &&
          /Run error/i.test(m.text) &&
          /kimi-stderr-boom/i.test(m.text) &&
          m.runId === runId,
      ),
    );
  });

  it("stopRun kills kimi process and leaves idle", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "slow";
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "long",
    });
    await waitFor(() => store.getThread(thread.id).status === "working");
    await new Promise((r) => setTimeout(r, 80));

    await runner.stopRun({ threadId: thread.id });
    assert.equal(store.getThread(thread.id).status, "idle");
    assert.ok(
      store
        .getMessages(thread.id)
        .some(
          (m) =>
            m.role === "event" &&
            /Run stopped/i.test(m.text) &&
            m.runId === runId,
        ),
    );
  });
});
