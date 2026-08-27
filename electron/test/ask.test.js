/**
 * Issue #392: Ask mode prompt pack + completion order (fm → print → null).
 * Run: npm run test:electron
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  askNoteFor,
  formatMemoryHits,
  formatBootstrapNote,
  prefetchBootstrapNote,
  MEMORY_BOOTSTRAP_NUDGE,
  formatThreadDigest,
  formatMatchingFiles,
  buildAskPrompt,
  retrievalFallback,
  buildAskArgs,
  extractAskText,
  completeAsk,
  ASK_NOTE,
  ASK_PROMPT_LIMIT,
} = require("../ask.js");

describe("askNoteFor", () => {
  it("is silent when ask is off", () => {
    assert.equal(askNoteFor(null), "");
    assert.equal(askNoteFor({}), "");
    assert.equal(askNoteFor({ ask: false }), "");
  });

  it("names no-tools and no credits when on", () => {
    const note = askNoteFor({ ask: true });
    assert.equal(note, ASK_NOTE);
    assert.match(note, /Ask mode/);
    assert.match(note, /no tools/i);
    assert.match(note, /worktree/);
    assert.match(note, /credits/);
  });
});

describe("formatMemoryHits", () => {
  it("returns empty for nothing usable", () => {
    assert.equal(formatMemoryHits(null), "");
    assert.equal(formatMemoryHits([]), "");
    assert.equal(formatMemoryHits([null, {}]), "");
  });

  it("lists title and a clipped body", () => {
    const text = formatMemoryHits([
      { title: "Worktree fail-closed", body: "never fall back to checkout" },
    ]);
    assert.match(text, /^\[Memory\]/);
    assert.match(text, /Worktree fail-closed/);
    assert.match(text, /never fall back/);
  });
});

describe("formatBootstrapNote", () => {
  it("returns empty for nothing usable", () => {
    assert.equal(formatBootstrapNote(null), "");
    assert.equal(formatBootstrapNote({}), "");
  });

  it("lists conventions and reports truncated overflow", () => {
    const text = formatBootstrapNote({
      conventions: [{ title: "Fail closed", body: "never fall back" }],
      strategies: [],
      knowledge: [{ title: "Key is basename", excerpt: "not the slug" }],
      tasks: [],
      truncated: { conventions: 0, strategies: 0, knowledge: 3, tasks: 0 },
    });
    assert.match(text, /\[Memory bootstrap\]/);
    assert.match(text, /Fail closed/);
    assert.match(text, /truncated: 3 knowledge/);
  });
});

describe("prefetchBootstrapNote", () => {
  it("is silent on follow-up turns", async () => {
    assert.equal(await prefetchBootstrapNote({ firstTurn: false }), "");
  });

  it("is silent without a userDataPath or bootstrap seam", async () => {
    assert.equal(await prefetchBootstrapNote({ firstTurn: true }), "");
  });

  it("is silent when prefetch throws", async () => {
    const note = await prefetchBootstrapNote({
      firstTurn: true,
      bootstrapMemory: async () => {
        throw new Error("down");
      },
    });
    assert.equal(note, "");
  });

  it("nudges when bootstrap returns an empty pack", async () => {
    const note = await prefetchBootstrapNote({
      firstTurn: true,
      bootstrapMemory: async () => ({
        conventions: [],
        strategies: [],
        knowledge: [],
        tasks: [],
      }),
    });
    assert.equal(note, MEMORY_BOOTSTRAP_NUDGE);
  });

  it("formats a successful prefetch", async () => {
    const note = await prefetchBootstrapNote({
      firstTurn: true,
      bootstrapMemory: async () => ({
        conventions: [{ title: "No em dash", body: "never" }],
        truncated: { conventions: 0, strategies: 0, knowledge: 0, tasks: 0 },
      }),
    });
    assert.match(note, /No em dash/);
  });
});

describe("formatThreadDigest", () => {
  it("keeps the last user/assistant turns and drops events", () => {
    const text = formatThreadDigest([
      { role: "event", text: "Run started" },
      { role: "user", text: "where is createThread" },
      { role: "assistant", text: "electron/services.js" },
      { role: "tool", text: "grep" },
    ]);
    assert.match(text, /User: where is createThread/);
    assert.match(text, /Assistant: electron\/services\.js/);
    assert.doesNotMatch(text, /Run started/);
    assert.doesNotMatch(text, /grep/);
  });
});

describe("formatMatchingFiles", () => {
  const index = {
    files: [
      { path: "electron/services.js", symbols: ["createThread", "startAsk"] },
      { path: "src/App.tsx", symbols: ["App"] },
      { path: "electron/ask.js", symbols: ["completeAsk"] },
    ],
  };

  it("scores path and symbol overlap", () => {
    const text = formatMatchingFiles(index, "where is createThread");
    assert.match(text, /\[Matching files\]/);
    assert.match(text, /electron\/services\.js/);
    assert.match(text, /createThread/);
    assert.doesNotMatch(text, /App\.tsx/);
  });

  it("is empty when nothing overlaps", () => {
    assert.equal(formatMatchingFiles(index, "zzzz-no-such"), "");
    assert.equal(formatMatchingFiles(null, "createThread"), "");
  });
});

describe("buildAskPrompt", () => {
  it("states the no-tools contract and includes the pack", () => {
    const prompt = buildAskPrompt({
      question: "who owns createThread",
      indexNote: "[Code map] services.js — createThread",
      memoryNote: "[Memory]\n- Thread create",
      digestNote: "[Conversation]\nUser: hi",
      matchNote: "[Matching files]\n- electron/services.js",
    });
    assert.match(prompt, /no tools/i);
    assert.match(prompt, /who owns createThread/);
    assert.match(prompt, /Code map/);
    assert.match(prompt, /Memory/);
    assert.match(prompt, /Conversation/);
    assert.match(prompt, /Matching files/);
  });

  it("caps a huge pack", () => {
    const prompt = buildAskPrompt({
      question: "x",
      indexNote: "n".repeat(ASK_PROMPT_LIMIT + 1000),
    });
    assert.ok(prompt.length <= ASK_PROMPT_LIMIT + 40);
    assert.match(prompt, /truncated/);
  });
});

describe("retrievalFallback", () => {
  it("says there is no model and shows what was found", () => {
    const text = retrievalFallback({
      question: "createThread",
      matchNote: "[Matching files]\n- electron/services.js",
      memoryNote: "[Memory]\n- Thread create",
    });
    assert.match(text, /don't have a model/i);
    assert.match(text, /createThread/);
    assert.match(text, /services\.js/);
    assert.match(text, /Memory/);
  });

  it("says so when the pack is empty", () => {
    const text = retrievalFallback({ question: "???" });
    assert.match(text, /empty/);
  });
});

describe("buildAskArgs", () => {
  it("caps claude at one turn", () => {
    assert.deepEqual(buildAskArgs("claude", { prompt: "q", model: "sonnet" }), [
      "-p",
      "--max-turns",
      "1",
      "--model",
      "sonnet",
      "q",
    ]);
  });

  it("returns null for an unknown provider", () => {
    assert.equal(buildAskArgs("nope", { prompt: "q" }), null);
  });

  it("cursor: -p is boolean, prompt last, read-only ask mode", () => {
    assert.deepEqual(buildAskArgs("cursor", { prompt: "q", model: "composer-2.5" }), [
      "-p",
      "--output-format",
      "text",
      "--trust",
      "--mode",
      "ask",
      "--model",
      "composer-2.5",
      "q",
    ]);
    assert.deepEqual(buildAskArgs("cursor", { prompt: "q" }), [
      "-p",
      "--output-format",
      "text",
      "--trust",
      "--mode",
      "ask",
      "q",
    ]);
  });
});

describe("extractAskText", () => {
  it("reads the last codex agent_message", () => {
    const stdout = [
      '{"item":{"type":"agent_message","text":"first"}}',
      '{"type":"agent_message","message":"second"}',
    ].join("\n");
    assert.equal(extractAskText("codex", stdout), "second");
  });

  it("passes other providers through", () => {
    assert.equal(extractAskText("claude", "  hello\n"), "hello");
  });
});

describe("completeAsk", () => {
  it("prefers fm over print-mode", async () => {
    let printed = false;
    const out = await completeAsk({
      prompt: "where is createThread",
      provider: "claude",
      env: { ...process.env, CODER_CLAUDE_BIN: process.execPath },
      fmRun: async () => "from fm",
      runPrint: async () => {
        printed = true;
        return "from print";
      },
    });
    assert.deepEqual(out, { text: "from fm", source: "fm" });
    assert.equal(printed, false);
  });

  it("falls through to print when fm is silent", async () => {
    const out = await completeAsk({
      prompt: "where is createThread",
      provider: "claude",
      env: { ...process.env, CODER_CLAUDE_BIN: process.execPath },
      fmRun: async () => null,
      runPrint: async () => "from print",
    });
    assert.deepEqual(out, { text: "from print", source: "print" });
  });

  it("returns null when both fail so the runner can retrieve", async () => {
    const out = await completeAsk({
      prompt: "where is createThread",
      provider: "claude",
      env: { CODER_CLAUDE_BIN: "/nope/claude" },
      fmRun: async () => null,
    });
    assert.equal(out, null);
  });

  it("uses cursor print-mode instead of silently returning null (#701)", async () => {
    let printedArgs = null;
    const out = await completeAsk({
      prompt: "where is createThread",
      provider: "cursor",
      model: "composer-2.5",
      env: { ...process.env, CODER_CURSOR_BIN: process.execPath },
      fmRun: async () => null,
      runPrint: async (_bin, args) => {
        printedArgs = args;
        return "from cursor print";
      },
    });
    assert.deepEqual(out, { text: "from cursor print", source: "print" });
    assert.deepEqual(printedArgs, [
      "-p",
      "--output-format",
      "text",
      "--trust",
      "--mode",
      "ask",
      "--model",
      "composer-2.5",
      "where is createThread",
    ]);
  });
});
