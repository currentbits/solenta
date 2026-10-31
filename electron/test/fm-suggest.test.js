const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  SUGGEST_PROMPT_LIMIT,
  SUGGESTION_MAX,
  buildSuggestPrompt,
  sanitizeSuggestion,
  maybeSuggestNextPrompt,
} = require("../fm-suggest.js");
const { rmTree } = require("./support/rmTree.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function seedFirstTurn(store, threadId, userText, assistantText) {
  store.appendMessage(threadId, {
    id: "m-user",
    role: "user",
    text: userText,
    createdAt: Date.now(),
  });
  store.appendMessage(threadId, {
    id: "m-asst",
    role: "assistant",
    text: assistantText,
    createdAt: Date.now() + 1,
  });
}

describe("buildSuggestPrompt (#1806)", () => {
  it("asks for one short instruction and a NONE escape", () => {
    const prompt = buildSuggestPrompt("Fix the bug", "Fixed it.");
    assert.match(prompt, /Suggest ONE short next instruction/);
    assert.match(prompt, /reply with exactly: NONE/);
    assert.match(prompt, /User asked:\nFix the bug/);
    assert.match(prompt, /Assistant replied:\nFixed it\./);
  });

  it("caps each side independently", () => {
    const long = "x".repeat(SUGGEST_PROMPT_LIMIT + 500);
    const prompt = buildSuggestPrompt(long, long);
    // Each capped copy appears once; the raw over-length string never does.
    assert.equal(prompt.includes(long), false);
    assert.equal(
      prompt.split(long.slice(0, SUGGEST_PROMPT_LIMIT)).length - 1,
      2,
    );
  });

  it("shows (empty) for a missing side instead of blank", () => {
    const prompt = buildSuggestPrompt("", "");
    assert.match(prompt, /User asked:\n\(empty\)/);
    assert.match(prompt, /Assistant replied:\n\(empty\)/);
  });
});

describe("sanitizeSuggestion (#1806)", () => {
  it("strips wrapping quotes/backticks and a trailing period", () => {
    assert.equal(sanitizeSuggestion('"Add a test for this."'), "Add a test for this");
    assert.equal(sanitizeSuggestion("`Run the linter`"), "Run the linter");
  });

  it("treats NONE (any case, trailing period) as no suggestion", () => {
    assert.equal(sanitizeSuggestion("NONE"), "");
    assert.equal(sanitizeSuggestion("none."), "");
    assert.equal(sanitizeSuggestion("  None  \n"), "");
  });

  it("returns empty for empty/whitespace-only input", () => {
    assert.equal(sanitizeSuggestion(""), "");
    assert.equal(sanitizeSuggestion("   \n  "), "");
  });

  it("caps an oversized reply", () => {
    const long = "a".repeat(SUGGESTION_MAX + 50);
    const out = sanitizeSuggestion(long);
    assert.equal(out.length, SUGGESTION_MAX);
  });
});

describe("maybeSuggestNextPrompt (#1806)", () => {
  let tmpDir;
  let store;
  let thread;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-fm-suggest-"));
    store = new Store(path.join(tmpDir, "store.json"));

    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);

    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });
  });

  afterEach(async () => {
    await rmTree(tmpDir);
  });

  it("is off by default: no fm call, nothing saved", async () => {
    seedFirstTurn(store, thread.id, "Fix the bug", "Fixed it.");
    let called = false;
    const saved = await maybeSuggestNextPrompt(store, thread.id, {
      fmRun: async () => {
        called = true;
        return "Run the tests";
      },
    });
    assert.equal(saved, null);
    assert.equal(called, false, "fm must never run while the setting is off");
    assert.equal(store.getThread(thread.id).nextPromptSuggestion, undefined);
  });

  it("saves a sanitised suggestion when the setting is on", async () => {
    store.setSettings({ suggestNextPrompt: true });
    seedFirstTurn(store, thread.id, "Fix the bug", "Fixed it.");
    const saved = await maybeSuggestNextPrompt(store, thread.id, {
      fmRun: async () => '"Run the tests"',
    });
    assert.equal(saved, "Run the tests");
    assert.equal(store.getThread(thread.id).nextPromptSuggestion, "Run the tests");
  });

  it("saves null when fm declines with NONE", async () => {
    store.setSettings({ suggestNextPrompt: true });
    seedFirstTurn(store, thread.id, "Fix the bug", "Fixed it.");
    const saved = await maybeSuggestNextPrompt(store, thread.id, {
      fmRun: async () => "NONE",
    });
    assert.equal(saved, null);
    assert.equal(store.getThread(thread.id).nextPromptSuggestion, null);
  });

  it("never runs on an automation thread", async () => {
    store.setSettings({ suggestNextPrompt: true });
    store.updateThread(thread.id, { automationId: "auto-1" });
    seedFirstTurn(store, thread.id, "Fix the bug", "Fixed it.");
    let called = false;
    const saved = await maybeSuggestNextPrompt(store, thread.id, {
      fmRun: async () => {
        called = true;
        return "Run the tests";
      },
    });
    assert.equal(saved, null);
    assert.equal(called, false);
  });

  it("never runs for a machine-delivered (isAutoTurn) turn chain", async () => {
    store.setSettings({ suggestNextPrompt: true });
    seedFirstTurn(store, thread.id, "Fix the bug", "Fixed it.");
    let called = false;
    const saved = await maybeSuggestNextPrompt(store, thread.id, {
      isAutoTurn: () => true,
      fmRun: async () => {
        called = true;
        return "Run the tests";
      },
    });
    assert.equal(saved, null);
    assert.equal(called, false);
  });

  it("skips a thread with no user+assistant turn yet", async () => {
    store.setSettings({ suggestNextPrompt: true });
    store.appendMessage(thread.id, {
      id: "m-user",
      role: "user",
      text: "Fix the bug",
      createdAt: Date.now(),
    });
    const saved = await maybeSuggestNextPrompt(store, thread.id, {
      fmRun: async () => "Run the tests",
    });
    assert.equal(saved, null);
  });

  it("runs at most one in flight per thread", async () => {
    store.setSettings({ suggestNextPrompt: true });
    seedFirstTurn(store, thread.id, "Fix the bug", "Fixed it.");
    let resolveFirst;
    const first = maybeSuggestNextPrompt(store, thread.id, {
      fmRun: () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    });
    // Second call while the first is still pending must see inFlight and
    // bail without ever calling fm.
    let secondCalled = false;
    const second = await maybeSuggestNextPrompt(store, thread.id, {
      fmRun: async () => {
        secondCalled = true;
        return "Should not run";
      },
    });
    assert.equal(second, null);
    assert.equal(secondCalled, false);
    resolveFirst("Run the tests");
    assert.equal(await first, "Run the tests");
  });

  it("drops a stale result when a new turn landed while fm ran", async () => {
    store.setSettings({ suggestNextPrompt: true });
    seedFirstTurn(store, thread.id, "Fix the bug", "Fixed it.");
    let resolveFm;
    const call = maybeSuggestNextPrompt(store, thread.id, {
      fmRun: () =>
        new Promise((resolve) => {
          resolveFm = resolve;
        }),
    });
    // A new message lands before fm answers (e.g. the next turn started).
    store.appendMessage(thread.id, {
      id: "m-user-2",
      role: "user",
      text: "Now fix the other bug",
      createdAt: Date.now() + 10,
    });
    resolveFm("Run the tests");
    const saved = await call;
    assert.equal(saved, null, "a stale suggestion must not land");
    assert.equal(store.getThread(thread.id).nextPromptSuggestion, undefined);
  });
});
