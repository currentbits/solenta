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
  extractThinking,
  extractToolEvent,
  extractToolEvents,
  extractSessionId,
  extractUsage,
  harvestKimiSessionUsage,
  createStderrThinkingParser,
} = require("../kimi.js");
const { getProvider } = require("../providers.js");
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

  if (scenario === "tool-image") {
    emit({ role: "assistant", content: "Looking at the page" });
    await delay(20);
    emit({
      role: "assistant",
      tool_calls: [
        {
          type: "function",
          id: "tool-shot",
          function: {
            name: "preview",
            arguments: "{\\"action\\":\\"screenshot\\"}",
          },
        },
      ],
    });
    await delay(20);
    emit({
      role: "tool",
      tool_call_id: "tool-shot",
      content: [
        { type: "text", text: "captured" },
        { type: "image", data: "${PNG_B64}", mimeType: "image/png" },
      ],
    });
    await delay(20);
    emit({
      role: "meta",
      type: "session.resume_hint",
      session_id: "session_img",
      command: "kimi -r session_img",
      content: "To resume this session: kimi -r session_img",
    });
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

  // Issue #751: thinking content-block before the first tool card.
  if (scenario === "thinking-block-then-tool") {
    emit({
      role: "assistant",
      content: [{ type: "thinking", thinking: "I should read kimi.js first." }],
    });
    await delay(80);
    emit({
      role: "assistant",
      tool_calls: [
        {
          type: "function",
          id: "call-read-1",
          function: {
            name: "Read",
            arguments: "{\\"file_path\\":\\"electron/kimi.js\\"}",
          },
        },
      ],
    });
    await delay(15);
    emit({
      role: "tool",
      tool_call_id: "call-read-1",
      content: "module.exports",
    });
    process.exit(0);
    return;
  }

  // Issue #753: official stream-json drops thinking from JSONL; the
  // documented print-mode stderr shape (PromptTranscriptWriter) is a
  // •  block with wrap indent. Tool progress, resume notices, and the
  // live 0.39.1 See-log line share stderr and must not become thinking.
  if (scenario === "stderr-thinking-then-tool") {
    process.stderr.write("• I should write probe.txt first.\\n");
    process.stderr.write(" because the user asked for a file.\\n");
    await delay(200);
    process.stderr.write("Wrote 6 bytes to probe.txt\\n");
    process.stderr.write(
      "To resume this session: kimi -r session_fake123\\n",
    );
    process.stderr.write(
      "See log: /tmp/kimi-753-sample/home/logs/kimi-code.log\\n",
    );
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

  // Issue #752: reasoning_content must be visible before the first tool,
  // and a restated tool_calls line must not duplicate the card.
  if (scenario === "thinking-then-tool") {
    emit({
      role: "assistant",
      reasoning_content: "I should write probe.txt first.",
    });
    await delay(200);
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
    await delay(40);
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

  if (scenario === "usage-record") {
    emit({ role: "assistant", content: "ok" });
    emit({
      type: "usage.record",
      model: "kimi-code/k3",
      usage: {
        inputOther: 100,
        output: 20,
        inputCacheRead: 50,
        inputCacheCreation: 10,
      },
      usageScope: "turn",
    });
    emit({
      type: "usage.record",
      model: "kimi-code/k3",
      usage: {
        inputOther: 8,
        output: 3,
        inputCacheRead: 200,
        inputCacheCreation: 0,
      },
      usageScope: "turn",
    });
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

  it("extracts thinking from reasoning_content and thinking blocks", () => {
    assert.equal(extractThinking(REAL_TEXT), null);
    assert.equal(extractThinking(REAL_CALL), null);
    assert.equal(
      extractThinking({
        role: "assistant",
        reasoning_content: "I should write probe.txt first.",
      }),
      "I should write probe.txt first.",
    );
    assert.equal(
      extractThinking({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan the write" },
          { type: "text", text: "ok" },
        ],
      }),
      "plan the write",
    );
  });

  // Thinking shape is PromptTranscriptWriter (print-mode / docs): a •
  // block on stderr. Official 0.39.1 PromptBlockWriter wrap indent is
  // one space (0.31.1 used two). Live 0.39.1 stream-json capture (isolated
  // home, empty MCP) never emits that block: PromptJsonWriter.writeThinkingDelta
  // is a no-op, so stdout is only system.version and stderr is the quota
  // error + See log. Tool progress is raw text; text-mode resume is
  // "To resume this session:" (stream-json resume is a stdout meta line).
  const REAL_STDERR_THINK = "• I should write probe.txt first.";
  const REAL_STDERR_WRAP_V31 = "  because the user asked for a file.";
  const REAL_STDERR_WRAP_V39 = " because the user asked for a file.";
  const REAL_STDERR_PROGRESS = "Wrote 6 bytes to probe.txt";
  const REAL_STDERR_RESUME =
    "To resume this session: kimi -r session_cea263a5-1066-444e-84bc-4ce29d42fc6d";
  const REAL_STDERR_ERROR =
    "error: failed to run prompt: provider.auth_error: 403 You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota";
  const REAL_STDERR_SEE_LOG =
    "See log: /tmp/kimi-753-sample-13090/home/logs/kimi-code.log";
  const REAL_STDERR_FRESH =
    'No sessions to continue under "/tmp/kimi-stderr-sample"; starting a fresh session.';

  it("lifts recorded stderr thinking and ignores progress, resume, and errors (#753)", () => {
    const parse = createStderrThinkingParser();
    assert.equal(
      parse.push(REAL_STDERR_THINK),
      "I should write probe.txt first.",
    );
    assert.equal(
      parse.push(REAL_STDERR_WRAP_V31),
      "\nbecause the user asked for a file.",
      "wrap indent is part of the same thinking block",
    );
    assert.equal(
      parse.push(REAL_STDERR_WRAP_V39),
      "\nbecause the user asked for a file.",
      "0.39 PromptBlockWriter indents wraps by one space",
    );
    assert.equal(parse.push(""), null, "blank line ends the block");
    assert.equal(
      parse.push(REAL_STDERR_PROGRESS),
      null,
      "tool progress is raw text, not thinking",
    );
    assert.equal(parse.push(REAL_STDERR_RESUME), null);
    assert.equal(parse.push(REAL_STDERR_ERROR), null);
    assert.equal(parse.push(REAL_STDERR_SEE_LOG), null);
    assert.equal(parse.push(REAL_STDERR_FRESH), null);
    assert.equal(
      parse.push("• a later thought"),
      "a later thought",
      "a new bullet starts another thinking slice",
    );
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

  it("harvests MCP image blocks from role tool content and keeps base64 out of output (#702)", () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const events = extractToolEvents({
      role: "tool",
      tool_call_id: "tool-shot",
      content: [
        { type: "text", text: "captured" },
        { type: "image", data: png, mimeType: "image/png" },
      ],
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, "end");
    assert.equal(events[0].images.length, 1);
    assert.equal(events[0].images[0].data, png);
    assert.ok(!String(events[0].output).includes(png));
    assert.match(String(events[0].output), /\[image\]/);
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

  it("extracts thinking without treating it as assistant text (issue #751)", () => {
    assert.equal(
      extractThinking({ type: "thinking", text: "plan the edit" }),
      "plan the edit",
    );
    assert.equal(
      extractThinking({
        role: "assistant",
        content: [{ type: "thinking", thinking: "look at kimi.js" }],
      }),
      "look at kimi.js",
    );
    assert.equal(
      extractAssistantText({
        role: "assistant",
        content: [{ type: "thinking", thinking: "look at kimi.js" }],
      }),
      null,
    );
    assert.equal(extractThinking({ role: "assistant", content: "Hello" }), null);
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

  it("parses usage.record Moonshot buckets and does not invent USD (#696)", () => {
    const ev = {
      type: "usage.record",
      model: "kimi-code/k3",
      usage: {
        inputOther: 19830,
        output: 8047,
        inputCacheRead: 11264,
        inputCacheCreation: 0,
      },
      usageScope: "turn",
      time: 1785584169280,
    };
    const u = extractUsage(ev);
    assert.deepEqual(u, {
      inputTokens: 19830,
      outputTokens: 8047,
      cachedInputTokens: 11264,
      cacheWriteTokens: 0,
      contextTokens: 19830 + 8047 + 11264,
    });
    assert.equal(u.costUsd, undefined);
  });

  it("keeps contextTokens unset for billable in/out only (#317, #696)", () => {
    const u = extractUsage({ type: "usage", input_tokens: 12, output_tokens: 8 });
    assert.deepEqual(u, { inputTokens: 12, outputTokens: 8 });
    assert.equal(u.contextTokens, undefined);
    assert.equal(u.costUsd, undefined);
  });

  it("reads a real cost field when the CLI actually emits one", () => {
    const u = extractUsage({
      type: "usage.record",
      usage: { inputOther: 10, output: 4, inputCacheRead: 0, inputCacheCreation: 0 },
      total_cost_usd: 0.012,
    });
    assert.equal(u.costUsd, 0.012);
    assert.equal(u.contextTokens, 14);
  });
});

describe("harvestKimiSessionUsage (#696)", () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wire-"));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeWire(sessionId, agent, lines) {
    const dir = path.join(
      tmpHome,
      "sessions",
      "wd_probe",
      sessionId,
      "agents",
      agent,
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "wire.jsonl"),
      lines.map((o) => JSON.stringify(o)).join("\n") + "\n",
    );
  }

  it("sums usage.record lines and takes the last main context fill", () => {
    writeWire("session_abc", "main", [
      {
        type: "usage.record",
        model: "kimi-code/k3",
        usage: {
          inputOther: 100,
          output: 20,
          inputCacheRead: 50,
          inputCacheCreation: 10,
        },
        time: 1000,
      },
      {
        type: "usage.record",
        model: "kimi-code/k3",
        usage: {
          inputOther: 8,
          output: 3,
          inputCacheRead: 200,
          inputCacheCreation: 0,
        },
        time: 2000,
      },
      { type: "turn.prompt", time: 1500 },
    ]);
    const u = harvestKimiSessionUsage(tmpHome, "session_abc");
    assert.ok(u);
    assert.equal(u.inputTokens, 108);
    assert.equal(u.outputTokens, 23);
    assert.equal(u.cachedInputTokens, 250);
    assert.equal(u.cacheWriteTokens, 10);
    assert.equal(u.contextTokens, 8 + 3 + 200);
    assert.equal(u.costUsd, undefined);
  });

  it("drops records older than sinceMs so a resume does not re-bill", () => {
    writeWire("session_abc", "main", [
      {
        type: "usage.record",
        usage: { inputOther: 999, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        time: 1000,
      },
      {
        type: "usage.record",
        usage: { inputOther: 4, output: 2, inputCacheRead: 6, inputCacheCreation: 0 },
        time: 5000,
      },
    ]);
    const u = harvestKimiSessionUsage(tmpHome, "session_abc", { sinceMs: 4000 });
    assert.equal(u.inputTokens, 4);
    assert.equal(u.outputTokens, 2);
    assert.equal(u.cachedInputTokens, 6);
    assert.equal(u.contextTokens, 12);
  });

  it("returns null when the session has no usage.record lines", () => {
    writeWire("session_abc", "main", [{ type: "turn.prompt", time: 1 }]);
    assert.equal(harvestKimiSessionUsage(tmpHome, "session_abc"), null);
    assert.equal(harvestKimiSessionUsage(tmpHome, "session_missing"), null);
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
      userDataPath: tmpDir,
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

  it("saves screenshot tool results to disk and names them on the tool message (#702)", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "tool-image";
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

  it("surfaces a thinking card from stderr before the first tool_calls (#753)", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "stderr-thinking-then-tool";
    const thread = store.getThreads()[0];

    await runner.startRun({ threadId: thread.id, prompt: "write probe" });

    await waitFor(() =>
      store
        .getMessages(thread.id)
        .some((m) => m.thinking && /probe\.txt/.test(m.text)),
    );
    assert.equal(
      store.getMessages(thread.id).filter((m) => m.role === "tool").length,
      0,
      "stderr thinking must be visible before the later tool_calls",
    );

    await waitFor(
      () => store.getThread(thread.id).status === "done",
      { timeoutMs: 15000 },
    );

    const msgs = store.getMessages(thread.id);
    const thinking = msgs.filter((m) => m.thinking);
    assert.equal(thinking.length, 1, "one thinking card for the turn");
    assert.match(thinking[0].text, /probe\.txt/);
    assert.match(
      thinking[0].text,
      /probe\.txt first\.\nbecause the user asked/,
      "wrap continuation must not smash into the previous line",
    );
    assert.ok(
      !/To resume this session/.test(thinking[0].text),
      "resume notice must not land on the thinking card",
    );
    assert.ok(
      !/Wrote 6 bytes/.test(thinking[0].text),
      "tool-progress stderr must not land on the thinking card",
    );
    assert.ok(
      !/See log:/.test(thinking[0].text),
      "live 0.39.1 See-log line must not become thinking",
    );
    assert.equal(thinking[0].role, "event");

    const tools = msgs.filter((m) => m.role === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool.name, "Write");
    assert.equal(tools[0].tool.done, true);
  });

  it("surfaces thinking before the first tool and does not duplicate restated tool_calls (#752)", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "thinking-then-tool";
    const thread = store.getThreads()[0];

    await runner.startRun({ threadId: thread.id, prompt: "write probe" });

    await waitFor(() =>
      store
        .getMessages(thread.id)
        .some((m) => m.thinking && /probe\.txt/.test(m.text)),
    );
    assert.equal(
      store.getMessages(thread.id).filter((m) => m.role === "tool").length,
      0,
      "thinking must be visible before the later tool_calls",
    );

    await waitFor(
      () => store.getThread(thread.id).status === "done",
      { timeoutMs: 15000 },
    );

    const msgs = store.getMessages(thread.id);
    const thinking = msgs.filter((m) => m.thinking);
    assert.equal(thinking.length, 1, "one thinking card for the turn");
    assert.match(thinking[0].text, /probe\.txt/);
    assert.equal(thinking[0].role, "event");

    const tools = msgs.filter((m) => m.role === "tool");
    assert.equal(
      tools.length,
      1,
      "restated tool_calls must not duplicate the card",
    );
    assert.equal(tools[0].tool.name, "Write");
    assert.equal(tools[0].tool.done, true);
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

  it("surfaces thinking before the first tool card (issue #751)", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "thinking-block-then-tool";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "look around" });

    await waitFor(() =>
      store
        .getMessages(thread.id)
        .some((m) => m.thinking && /kimi\.js/.test(m.text)),
    );
    assert.equal(
      store.getMessages(thread.id).filter((m) => m.role === "tool").length,
      0,
      "thinking must be visible before the later tool_calls",
    );

    await waitFor(() => store.getThread(thread.id).status === "done");
    const msgs = store.getMessages(thread.id);
    assert.equal(msgs.filter((m) => m.thinking).length, 1);
    assert.equal(msgs.filter((m) => m.role === "tool").length, 1);
    assert.equal(msgs.find((m) => m.role === "tool").tool.name, "Read");
  });

  it("stream usage.record records tokens and cache, never USD spend (#696)", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "usage-record";
    const thread = store.getThreads()[0];
    const spentBefore = store.getSpendToday();
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 108);
    assert.equal(usage.outputTokens, 23);
    assert.equal(usage.contextTokens, 8 + 3 + 200);
    assert.equal(usage.costUsd, 0);
    assert.equal(usage.turns, 1);
    assert.equal(store.getSpendToday(), spentBefore);

    const days = store.getUsageByDay();
    const today = Object.values(days)[0];
    const cell = today && today.kimi && Object.values(today.kimi)[0];
    assert.ok(cell);
    assert.equal(cell.inputTokens, 108);
    assert.equal(cell.cachedInputTokens, 250);
    assert.equal(cell.cacheWriteTokens, 10);
    assert.equal(cell.costUsd, 0);
    assert.equal(cell.turns, 1);
  });

  it("harvests usage.record from the session wire when the stream is silent (#696)", async () => {
    const srcHome = path.join(tmpDir, "kimi-src");
    const wireDir = path.join(
      srcHome,
      "sessions",
      "wd_probe",
      "session_fake123",
      "agents",
      "main",
    );
    fs.mkdirSync(wireDir, { recursive: true });
    fs.writeFileSync(
      path.join(wireDir, "wire.jsonl"),
      `${JSON.stringify({
        type: "usage.record",
        model: "kimi-code/k3",
        usage: {
          inputOther: 431,
          output: 340,
          inputCacheRead: 214272,
          inputCacheCreation: 0,
        },
        usageScope: "turn",
        time: Date.now() + 60_000,
      })}\n`,
    );
    const prevHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = srcHome;
    try {
      const thread = store.getThreads()[0];
      const spentBefore = store.getSpendToday();
      await runner.startRun({ threadId: thread.id, prompt: "go" });
      await waitFor(() => store.getThread(thread.id).status === "done");

      const usage = store.getUsage(thread.id);
      assert.ok(usage);
      assert.equal(usage.inputTokens, 431);
      assert.equal(usage.outputTokens, 340);
      assert.equal(usage.contextTokens, 431 + 340 + 214272);
      assert.equal(usage.costUsd, 0);
      assert.equal(usage.turns, 1);
      assert.equal(store.getSpendToday(), spentBefore);

      const days = store.getUsageByDay();
      const today = Object.values(days)[0];
      const cell = today && today.kimi && Object.values(today.kimi)[0];
      assert.ok(cell, "pulse keeps the turn");
      assert.equal(cell.cachedInputTokens, 214272);
      assert.equal(cell.costUsd, 0);
    } finally {
      if (prevHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = prevHome;
    }
  });

  it("OTel records harvested tokens and omits invented $0 cost (#696)", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "usage-record";
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200 };
    };
    services.setSettings(store, {
      otel: {
        endpoint: "http://127.0.0.1:4318",
        headers: {},
        claudeMetrics: false,
      },
    });
    runner.stopAll();
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: (ch, payload) => pushes.push({ ch, payload }),
      tickMs: 50,
      userDataPath: tmpDir,
    });
    try {
      const thread = store.getThreads()[0];
      await runner.startRun({ threadId: thread.id, prompt: "go" });
      await waitFor(() => store.getThread(thread.id).status === "done");
      await runner.flushTranscripts();
      const spans = [];
      for (const c of calls) {
        for (const rs of c.body.resourceSpans || []) {
          for (const ss of rs.scopeSpans || []) spans.push(...(ss.spans || []));
        }
      }
      const run = spans.find((s) => String(s.name).includes("kimi"));
      assert.ok(run, `no kimi span in ${spans.map((s) => s.name).join(", ")}`);
      const attr = (key) => {
        const found = (run.attributes || []).find((a) => a.key === key);
        return found ? Object.values(found.value)[0] : undefined;
      };
      assert.equal(attr("gen_ai.usage.input_tokens"), "108");
      assert.equal(attr("gen_ai.usage.output_tokens"), "23");
      assert.equal(attr("solenta.cost.usd"), undefined);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});
