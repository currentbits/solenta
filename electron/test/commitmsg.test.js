const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  suggestCommitMessage,
  buildSuggestArgs,
  cleanSubject,
  extractCodexMessage,
  extractSubject,
  PROMPT_PATCH_LIMIT,
} = require("../commitmsg.js");
const { buildPrompt } = require("../commitmsg.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("buildSuggestArgs", () => {
  it("claude: -p with optional --model, prompt last", () => {
    assert.deepEqual(buildSuggestArgs("claude", { model: null, prompt: "P" }), [
      "-p",
      "P",
    ]);
    assert.deepEqual(
      buildSuggestArgs("claude", { model: "claude-opus-5", prompt: "P" }),
      ["-p", "--model", "claude-opus-5", "P"],
    );
  });

  it("codex: exec --json, prompt last", () => {
    assert.deepEqual(buildSuggestArgs("codex", { model: null, prompt: "P" }), [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "P",
    ]);
  });

  it("kimi/grok: -p value form; opencode: run", () => {
    assert.deepEqual(buildSuggestArgs("kimi", { model: null, prompt: "P" }), [
      "-p",
      "P",
    ]);
    assert.deepEqual(
      buildSuggestArgs("grok", { model: "grok-4.5", prompt: "P" }),
      ["-m", "grok-4.5", "-p", "P"],
    );
    assert.deepEqual(
      buildSuggestArgs("opencode", { model: null, prompt: "P" }),
      ["run", "P"],
    );
  });

  it("cursor: -p is boolean, prompt last, read-only ask mode", () => {
    assert.deepEqual(buildSuggestArgs("cursor", { model: null, prompt: "P" }), [
      "-p",
      "--output-format",
      "text",
      "--trust",
      "--mode",
      "ask",
      "P",
    ]);
    assert.deepEqual(
      buildSuggestArgs("cursor", { model: "composer-2.5", prompt: "P" }),
      [
        "-p",
        "--output-format",
        "text",
        "--trust",
        "--mode",
        "ask",
        "--model",
        "composer-2.5",
        "P",
      ],
    );
  });

  it("unknown providers have no print mode", () => {
    assert.equal(buildSuggestArgs("simulate", { model: null, prompt: "P" }), null);
  });
});

describe("cleanSubject", () => {
  it("takes the first non-empty line and strips wrapping quotes/backticks", () => {
    assert.equal(cleanSubject('\n"feat: add thing"\nmore text'), "feat: add thing");
    assert.equal(cleanSubject("`fix: bug`"), "fix: bug");
  });

  it("skips code fences", () => {
    assert.equal(cleanSubject("```\nchore: tidy\n```"), "chore: tidy");
  });

  it("returns empty for blank input", () => {
    assert.equal(cleanSubject(" \n\n```\n```"), "");
  });
});

describe("extractCodexMessage", () => {
  it("reads item.completed agent_message items, last wins", () => {
    const lines = [
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "feat: first" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "feat: final" },
      }),
    ].join("\n");
    assert.equal(extractCodexMessage(lines), "feat: final");
  });

  it("reads msg variants and bare events", () => {
    assert.equal(
      extractCodexMessage(
        JSON.stringify({ msg: { type: "agent_message", message: "fix: m" } }),
      ),
      "fix: m",
    );
    assert.equal(
      extractCodexMessage(
        JSON.stringify({ type: "agent_message", message: "fix: bare" }),
      ),
      "fix: bare",
    );
  });

  it("ignores non-JSON noise", () => {
    assert.equal(
      extractCodexMessage(
        `thinking...\n${JSON.stringify({ item: { type: "agent_message", text: "x: y" } })}`,
      ),
      "x: y",
    );
  });
});

describe("extractSubject", () => {
  it("plain providers: first line of stdout", () => {
    assert.equal(extractSubject("claude", "feat: x\n\nExplanation"), "feat: x");
  });
});

describe("buildPrompt", () => {
  it("includes files and truncates huge patches", () => {
    const prompt = buildPrompt({
      files: [{ path: "a.ts", status: "M", additions: 3, deletions: 1 }],
      patch: "x".repeat(PROMPT_PATCH_LIMIT + 100),
    });
    assert.match(prompt, /M a\.ts \(\+3\/-1\)/);
    assert.match(prompt, /diff truncated/);
    assert.ok(prompt.length < PROMPT_PATCH_LIMIT + 2000);
  });
});

describe("suggestCommitMessage", () => {
  let tmpDir;
  let store;
  let repo;
  let thread;
  let fakeBin;
  let logPath;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-msg-"));
    store = new Store(path.join(tmpDir, "store.json"));

    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);

    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "Message flow",
    });

    // Fake claude CLI: logs argv, prints a commit message on stdout.
    logPath = path.join(tmpDir, "fake-log.json");
    fakeBin = writeFakeBin(
      path.join(tmpDir, "fake-claude"),
      `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)));
console.log("feat: generated subject");
`,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fakeEnv() {
    return {
      ...process.env,
      CODER_CLAUDE_BIN: fakeBin,
      FAKE_CLAUDE_LOG: logPath,
      CODER_FM_DISABLE: "1",
    };
  }

  it("drafts a message through the thread provider's print mode", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    const result = await suggestCommitMessage({
      store,
      threadId: thread.id,
      env: fakeEnv(),
    });
    assert.equal(result.message, "feat: generated subject");

    const argv = JSON.parse(fs.readFileSync(logPath, "utf8"));
    assert.equal(argv[0], "-p");
    const prompt = argv[argv.length - 1];
    assert.match(prompt, /commit message/);
    assert.match(prompt, /\?\? a\.txt/);
  });

  it("rejects when there are no changes", async () => {
    await assert.rejects(
      suggestCommitMessage({ store, threadId: thread.id, env: fakeEnv() }),
      /no changes/i,
    );
  });

  it("rejects when the provider CLI is not installed", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    await assert.rejects(
      suggestCommitMessage({
        store,
        threadId: thread.id,
        env: {
          ...process.env,
          CODER_CLAUDE_BIN: path.join(tmpDir, "missing"),
          // Without this a real macOS 27 fm would answer and there would be
          // nothing to reject.
          CODER_FM_DISABLE: "1",
        },
      }),
      /not installed/i,
    );
  });

  it("fm answers even when the provider CLI is missing entirely", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    const fmBin = writeFakeBin(
      path.join(tmpDir, "fake-fm"),
      `#!/usr/bin/env node
console.log("chore: no billed CLI needed");
`,
    );

    const result = await suggestCommitMessage({
      store,
      threadId: thread.id,
      env: {
        ...process.env,
        CODER_CLAUDE_BIN: path.join(tmpDir, "missing"),
        CODER_FM_BIN: fmBin,
      },
    });
    assert.equal(result.message, "chore: no billed CLI needed");
  });

  it("uses fm when it returns a subject and never invokes the provider CLI", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    const fmBin = writeFakeBin(
      path.join(tmpDir, "fake-fm"),
      `#!/usr/bin/env node
console.log("feat: from on-device fm");
`,
    );

    const result = await suggestCommitMessage({
      store,
      threadId: thread.id,
      env: {
        ...process.env,
        CODER_CLAUDE_BIN: fakeBin,
        FAKE_CLAUDE_LOG: logPath,
        CODER_FM_BIN: fmBin,
      },
    });
    assert.equal(result.message, "feat: from on-device fm");
    assert.equal(fs.existsSync(logPath), false);
  });

  it("cursor threads print-mode instead of throwing no print mode (#701)", async () => {
    services.setProvider(store, { threadId: thread.id, provider: "cursor" });
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    const cursorLog = path.join(tmpDir, "fake-cursor-log.json");
    const cursorBin = writeFakeBin(
      path.join(tmpDir, "fake-cursor"),
      `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(process.env.FAKE_CURSOR_LOG, JSON.stringify(process.argv.slice(2)));
console.log("feat: cursor print subject");
`,
    );

    const result = await suggestCommitMessage({
      store,
      threadId: thread.id,
      env: {
        ...process.env,
        CODER_CURSOR_BIN: cursorBin,
        FAKE_CURSOR_LOG: cursorLog,
        CODER_FM_DISABLE: "1",
      },
    });
    assert.equal(result.message, "feat: cursor print subject");

    const argv = JSON.parse(fs.readFileSync(cursorLog, "utf8"));
    assert.equal(argv[0], "-p");
    assert.ok(argv.includes("--trust"));
    assert.equal(argv[argv.indexOf("--mode") + 1], "ask");
    assert.ok(!argv.includes("--force"));
    assert.ok(!argv.includes("stream-json"));
    const prompt = argv[argv.length - 1];
    assert.match(prompt, /commit message/);
    assert.match(prompt, /\?\? a\.txt/);
  });

  it("falls back to the provider when fm exits non-zero", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    const fmBin = writeFakeBin(
      path.join(tmpDir, "fake-fm"),
      `#!/usr/bin/env node
console.error("fm boom");
process.exit(3);
`,
    );

    const result = await suggestCommitMessage({
      store,
      threadId: thread.id,
      env: {
        ...process.env,
        CODER_CLAUDE_BIN: fakeBin,
        FAKE_CLAUDE_LOG: logPath,
        CODER_FM_BIN: fmBin,
      },
    });
    assert.equal(result.message, "feat: generated subject");
    const argv = JSON.parse(fs.readFileSync(logPath, "utf8"));
    assert.equal(argv[0], "-p");
  });
});
