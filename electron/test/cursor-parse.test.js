"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractAssistantText,
  extractToolEvents,
  extractSessionId,
  extractUsage,
  parseToolArgs,
  normalizeCallId,
} = require("../cursor.js");

// Documented example sequence from
// https://cursor.com/docs/cli/reference/output-format.md
const SESSION_ID = "c6b62c6f-7ead-4fd6-9922-e952131177ff";
const READ_ID = "toolu_vrtx_01NnjaR886UcE8whekg2MGJd";
const WRITE_ID = "toolu_vrtx_01Q3VHVnWFSKygaRPT7WDxrv";

const DOC_INIT = {
  type: "system",
  subtype: "init",
  apiKeySource: "login",
  cwd: "/Users/user/project",
  session_id: SESSION_ID,
  model: "Claude 4 Sonnet",
  permissionMode: "default",
};

const DOC_USER = {
  type: "user",
  message: {
    role: "user",
    content: [{ type: "text", text: "Read README.md and create a summary" }],
  },
  session_id: SESSION_ID,
};

const DOC_ASSISTANT_1 = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "I'll read the README.md file" }],
  },
  session_id: SESSION_ID,
};

const DOC_READ_START = {
  type: "tool_call",
  subtype: "started",
  call_id: READ_ID,
  tool_call: { readToolCall: { args: { path: "README.md" } } },
  session_id: SESSION_ID,
};

const DOC_READ_END = {
  type: "tool_call",
  subtype: "completed",
  call_id: READ_ID,
  tool_call: {
    readToolCall: {
      args: { path: "README.md" },
      result: {
        success: {
          content: "# Project\n\nThis is a sample project...",
          isEmpty: false,
          exceededLimit: false,
          totalLines: 54,
          totalChars: 1254,
        },
      },
    },
  },
  session_id: SESSION_ID,
};

const DOC_ASSISTANT_2 = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Based on the README, I'll create a summary" }],
  },
  session_id: SESSION_ID,
};

const DOC_WRITE_START = {
  type: "tool_call",
  subtype: "started",
  call_id: WRITE_ID,
  tool_call: {
    writeToolCall: {
      args: {
        path: "summary.txt",
        fileText: "# README Summary\n\nThis project contains...",
        toolCallId: WRITE_ID,
      },
    },
  },
  session_id: SESSION_ID,
};

const DOC_WRITE_END = {
  type: "tool_call",
  subtype: "completed",
  call_id: WRITE_ID,
  tool_call: {
    writeToolCall: {
      args: {
        path: "summary.txt",
        fileText: "# README Summary\n\nThis project contains...",
        toolCallId: WRITE_ID,
      },
      result: {
        success: {
          path: "/Users/user/project/summary.txt",
          linesCreated: 19,
          fileSize: 942,
        },
      },
    },
  },
  session_id: SESSION_ID,
};

const DOC_ASSISTANT_3 = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Done! I've created the summary in summary.txt" },
    ],
  },
  session_id: SESSION_ID,
};

const DOC_RESULT = {
  type: "result",
  subtype: "success",
  duration_ms: 5234,
  duration_api_ms: 5234,
  is_error: false,
  result:
    "I'll read the README.md fileBased on the README, I'll create a summaryDone! I've created the summary in summary.txt",
  session_id: SESSION_ID,
  request_id: "10e11780-df2f-45dc-a1ff-4540af32e9c0",
};

const DOC_SEQUENCE = [
  DOC_INIT,
  DOC_USER,
  DOC_ASSISTANT_1,
  DOC_READ_START,
  DOC_READ_END,
  DOC_ASSISTANT_2,
  DOC_WRITE_START,
  DOC_WRITE_END,
  DOC_ASSISTANT_3,
  DOC_RESULT,
];

describe("cursor extractSessionId", () => {
  it("reads session_id from system/init", () => {
    assert.equal(extractSessionId(DOC_INIT), SESSION_ID);
  });

  it("reads session_id from the terminal result", () => {
    assert.equal(extractSessionId(DOC_RESULT), SESSION_ID);
  });

  it("ignores session_id on user, assistant, and tool_call events", () => {
    assert.equal(extractSessionId(DOC_USER), null);
    assert.equal(extractSessionId(DOC_ASSISTANT_1), null);
    assert.equal(extractSessionId(DOC_READ_START), null);
    assert.equal(
      extractSessionId({ type: "system", session_id: SESSION_ID }),
      null,
      "system without subtype init is not a session event",
    );
  });
});

describe("cursor extractAssistantText", () => {
  it("returns text from a streaming delta (timestamp_ms, no model_call_id)", () => {
    assert.equal(
      extractAssistantText({
        type: "assistant",
        timestamp_ms: 1_720_000_000_000,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hel" }],
        },
        session_id: SESSION_ID,
      }),
      "Hel",
    );
    assert.equal(
      extractAssistantText({
        type: "assistant",
        timestamp_ms: 1_720_000_000_010,
        message: { role: "assistant", content: "lo" },
      }),
      "lo",
    );
  });

  it("skips the buffered flush that carries model_call_id", () => {
    assert.equal(
      extractAssistantText({
        type: "assistant",
        timestamp_ms: 1_720_000_000_020,
        model_call_id: "call_before_tool",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I'll read the README.md file" }],
        },
        session_id: SESSION_ID,
      }),
      null,
    );
  });

  it("returns non-empty text when timestamp_ms is absent (complete message / final flush)", () => {
    // Chosen rule: extractAssistantText is stateless. Cursor's end-of-turn
    // flush (no timestamp_ms, no model_call_id, full concatenated text) is
    // the same shape as a complete non-streamed assistant message. Return
    // the body when content is non-empty so the no-stream case still
    // renders; skip only when the body is empty. Callers that accumulate
    // --stream-partial-output deltas may see the flush as a duplicate of
    // the concatenated answer.
    assert.equal(
      extractAssistantText({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I'll read the README.md fileBased on the README, I'll create a summaryDone! I've created the summary in summary.txt",
            },
          ],
        },
        session_id: SESSION_ID,
      }),
      "I'll read the README.md fileBased on the README, I'll create a summaryDone! I've created the summary in summary.txt",
    );
    assert.equal(
      extractAssistantText({
        type: "assistant",
        message: { role: "assistant", content: [] },
        session_id: SESSION_ID,
      }),
      null,
      "empty no-timestamp_ms assistant event is the skippable flush",
    );
  });

  it("does not treat user, system, tool_call, or result as assistant text", () => {
    assert.equal(extractAssistantText(DOC_USER), null);
    assert.equal(extractAssistantText(DOC_INIT), null);
    assert.equal(extractAssistantText(DOC_READ_START), null);
    assert.equal(
      extractAssistantText(DOC_RESULT),
      null,
      "result.result is the concatenated final answer, not an assistant delta",
    );
  });
});

describe("cursor extractToolEvents", () => {
  it("maps tool_call started readToolCall to phase start / Read", () => {
    const events = extractToolEvents(DOC_READ_START);
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, "start");
    assert.equal(events[0].name, "Read");
    assert.equal(events[0].id, READ_ID);
    assert.equal(events[0].output, null);
    assert.match(events[0].input, /README\.md/);
  });

  it("maps tool_call completed to phase end with the same id", () => {
    const events = extractToolEvents(DOC_READ_END);
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, "end");
    assert.equal(events[0].name, "Read");
    assert.equal(events[0].id, READ_ID);
    assert.equal(events[0].isError, false);
    assert.match(String(events[0].output), /sample project/);
  });

  it("maps writeToolCall to Write", () => {
    const start = extractToolEvents(DOC_WRITE_START);
    assert.equal(start.length, 1);
    assert.equal(start[0].name, "Write");
    assert.equal(start[0].phase, "start");
    assert.equal(start[0].id, WRITE_ID);
    assert.match(start[0].input, /summary\.txt/);

    const end = extractToolEvents(DOC_WRITE_END);
    assert.equal(end.length, 1);
    assert.equal(end[0].name, "Write");
    assert.equal(end[0].phase, "end");
    assert.equal(end[0].id, WRITE_ID);
  });

  it("uses function.name for function-shaped tool_call objects", () => {
    const events = extractToolEvents({
      type: "tool_call",
      subtype: "started",
      call_id: "fn_1",
      tool_call: {
        function: { name: "grep", arguments: '{"pattern":"foo"}' },
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].name, "grep");
    assert.equal(events[0].id, "fn_1");
    assert.equal(events[0].phase, "start");
    assert.match(events[0].input, /foo/);
  });

  it("normalizes newline-packed call_id to the first line (issue #691)", () => {
    const packed = "call_abc\nfc_def456";
    assert.equal(normalizeCallId(packed), "call_abc");
    assert.equal(normalizeCallId("call_plain"), "call_plain");
    const events = extractToolEvents({
      type: "tool_call",
      subtype: "started",
      call_id: packed,
      tool_call: { readToolCall: { args: { path: "README.md" } } },
    });
    assert.equal(events[0].id, "call_abc");
  });

  it("marks completed calls with result.error or result.failure as isError", () => {
    const err = extractToolEvents({
      type: "tool_call",
      subtype: "completed",
      call_id: "e1",
      tool_call: {
        readToolCall: {
          args: { path: "missing.txt" },
          result: { error: "ENOENT" },
        },
      },
    });
    assert.equal(err.length, 1);
    assert.equal(err[0].isError, true);
    assert.equal(err[0].phase, "end");
    assert.match(String(err[0].output), /ENOENT/);
  });
});

describe("cursor parseToolArgs", () => {
  it("parses a JSON object blob and rejects junk", () => {
    assert.deepEqual(parseToolArgs('{"description":"Review ops","model":"claude-sonnet-5-thinking-high"}'), {
      description: "Review ops",
      model: "claude-sonnet-5-thinking-high",
    });
    assert.equal(parseToolArgs(""), null);
    assert.equal(parseToolArgs("not json"), null);
    assert.equal(parseToolArgs("[1,2]"), null);
    assert.equal(parseToolArgs(null), null);
  });
});

describe("cursor extractUsage", () => {
  it("reads usage from a result event and returns null when omitted", () => {
    assert.equal(extractUsage(DOC_RESULT), null);
    assert.deepEqual(
      extractUsage({
        type: "result",
        usage: { input_tokens: 10, output_tokens: 4, cost: 0.02 },
      }),
      { inputTokens: 10, outputTokens: 4, costUsd: 0.02, contextTokens: 14 },
    );
    assert.equal(
      extractUsage({
        type: "assistant",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      null,
    );
  });

  it("includes Anthropic-style cache fields in contextTokens when present", () => {
    assert.deepEqual(
      extractUsage({
        type: "result",
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      }),
      { inputTokens: 10, outputTokens: 4, contextTokens: 134 },
    );
  });
});

describe("cursor documented stream-json sequence", () => {
  it("yields readable text plus one Read and one Write", () => {
    const texts = [];
    const tools = [];
    const sessionIds = [];
    for (const ev of DOC_SEQUENCE) {
      const text = extractAssistantText(ev);
      if (text) texts.push(text);
      tools.push(...extractToolEvents(ev));
      const sid = extractSessionId(ev);
      if (sid) sessionIds.push(sid);
    }

    const joined = texts.join("");
    assert.match(joined, /I'll read the README\.md file/);
    assert.match(joined, /Based on the README, I'll create a summary/);
    assert.match(joined, /summary\.txt/);
    assert.equal(
      texts.join(""),
      "I'll read the README.md fileBased on the README, I'll create a summaryDone! I've created the summary in summary.txt",
    );
    assert.ok(
      !texts.includes(DOC_RESULT.result),
      "result.result must not be returned as assistant text",
    );

    const starts = tools.filter((t) => t.phase === "start");
    assert.deepEqual(
      starts.map((t) => t.name),
      ["Read", "Write"],
    );
    assert.deepEqual(
      starts.map((t) => t.id),
      [READ_ID, WRITE_ID],
    );
    const ends = tools.filter((t) => t.phase === "end");
    assert.deepEqual(
      ends.map((t) => t.name),
      ["Read", "Write"],
    );
    assert.deepEqual(
      ends.map((t) => t.id),
      [READ_ID, WRITE_ID],
    );

    assert.deepEqual(sessionIds, [SESSION_ID, SESSION_ID]);
  });
});
