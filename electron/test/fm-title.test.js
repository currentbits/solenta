const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  maybeApplyFmTitle,
  buildTitlePrompt,
  buildRecentDigest,
  buildRegenerateTitlePrompt,
  regenerateTitle,
  regenerateTitles,
} = require("../fm-title.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Write an executable fake fm that runs `body` as node. */
function writeFakeFm(dir, body) {
  return writeFakeBin(path.join(dir, "fake-fm"), body);
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

describe("buildTitlePrompt (custom title instructions, #1765)", () => {
  it("is unchanged when instructions are empty", () => {
    const withEmpty = buildTitlePrompt("Do a thing", "Done.", "");
    const withNone = buildTitlePrompt("Do a thing", "Done.");
    assert.equal(withEmpty, withNone);
    assert.doesNotMatch(withEmpty, /Extra instructions/);
  });

  it("appends the instructions when set", () => {
    const prompt = buildTitlePrompt(
      "Do a thing",
      "Done.",
      "Start with the issue number. Lowercase.",
    );
    assert.match(
      prompt,
      /Extra instructions:\nStart with the issue number\. Lowercase\./,
    );
    // Still has the base rules and the user/assistant text.
    assert.match(prompt, /Write a title of at most 6 words/);
    assert.match(prompt, /User:\nDo a thing/);
  });
});

describe("maybeApplyFmTitle", () => {
  let tmpDir;
  let store;
  let thread;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-fm-title-"));
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

  it("saves a sanitised fm title after the first assistant reply", async () => {
    const userText = "Fix the flaky login test in auth.spec.ts";
    seedFirstTurn(store, thread.id, userText, "I'll look at the failing spec.");
    // Production path: startRun already stamped the first prompt line.
    store.updateThread(thread.id, {
      title: userText.slice(0, services.THREAD_TITLE_MAX),
    });

    const bin = writeFakeFm(
      tmpDir,
      `console.log('  "Fix login flake."  \\nextra');`,
    );
    const saved = await maybeApplyFmTitle(store, thread.id, {
      env: { ...process.env, CODER_FM_BIN: bin },
    });
    assert.equal(saved, "Fix login flake");
    assert.equal(store.getThread(thread.id).title, "Fix login flake");
    assert.ok(store.getThread(thread.id).fmTitleAt);
  });

  it("leaves the title untouched when fm is unavailable", async () => {
    seedFirstTurn(store, thread.id, "Do a thing", "Done.");
    assert.equal(store.getThread(thread.id).title, "New Thread");

    const saved = await maybeApplyFmTitle(store, thread.id, {
      env: { ...process.env, CODER_FM_BIN: "/nope/fm" },
    });
    assert.equal(saved, null);
    assert.equal(store.getThread(thread.id).title, "New Thread");
  });

  it("a run without fm does not opt the thread out of a later one", async () => {
    seedFirstTurn(store, thread.id, "Do a thing", "Done.");
    await maybeApplyFmTitle(store, thread.id, {
      env: { ...process.env, CODER_FM_BIN: "/nope/fm" },
    });
    assert.equal(store.getThread(thread.id).fmTitleAt, undefined);

    // Same thread, later turn, macOS 27 now present.
    const bin = writeFakeFm(tmpDir, `console.log("Do the thing");`);
    const saved = await maybeApplyFmTitle(store, thread.id, {
      env: { ...process.env, CODER_FM_BIN: bin },
    });
    assert.equal(saved, "Do the thing");
  });

  it("titles once, then leaves the thread alone on later turns", async () => {
    seedFirstTurn(store, thread.id, "Do a thing", "Done.");
    const bin = writeFakeFm(tmpDir, `console.log("First title");`);
    const env = { ...process.env, CODER_FM_BIN: bin };

    assert.equal(await maybeApplyFmTitle(store, thread.id, { env }), "First title");
    assert.equal(await maybeApplyFmTitle(store, thread.id, { env }), null);
    assert.equal(store.getThread(thread.id).title, "First title");
  });

  it("never overwrites a user-set title", async () => {
    const titled = services.renameThread(store, {
      threadId: thread.id,
      title: "Ship checklist",
    });
    assert.equal(titled.title, "Ship checklist");
    seedFirstTurn(
      store,
      thread.id,
      "Please walk the release checklist",
      "Starting with the first item.",
    );

    const bin = writeFakeFm(tmpDir, `console.log("Overwrite me");`);
    const saved = await maybeApplyFmTitle(store, thread.id, {
      env: { ...process.env, CODER_FM_BIN: bin },
    });
    assert.equal(saved, null);
    assert.equal(store.getThread(thread.id).title, "Ship checklist");
  });

  it("passes the titleInstructions setting through to the fm prompt (#1765)", async () => {
    services.setSettings(store, {
      titleInstructions: "Start with the issue number.",
    });
    seedFirstTurn(store, thread.id, "Fix the flaky test", "Looking now.");

    const captured = path.join(tmpDir, "captured-prompt.txt");
    const bin = writeFakeFm(
      tmpDir,
      `const fs = require("fs");
fs.writeFileSync(${JSON.stringify(captured)}, process.argv[process.argv.length - 1]);
console.log("Captured title");`,
    );
    await maybeApplyFmTitle(store, thread.id, {
      env: { ...process.env, CODER_FM_BIN: bin },
    });
    const prompt = fs.readFileSync(captured, "utf8");
    assert.match(prompt, /Extra instructions:\nStart with the issue number\./);
  });
});

describe("buildRecentDigest (#1774)", () => {
  it("prefixes roles, drops other message kinds, and caps the window", () => {
    const msgs = [
      { role: "user", text: "Fix the login bug" },
      { role: "event", text: "Run started" },
      { role: "assistant", text: "Looking at auth.ts" },
      { role: "user", text: "Actually, do the signup flow instead" },
    ];
    const digest = buildRecentDigest(msgs);
    assert.equal(
      digest,
      "User: Fix the login bug\nAssistant: Looking at auth.ts\nUser: Actually, do the signup flow instead",
    );
  });

  it("is empty for no messages or messages with no text", () => {
    assert.equal(buildRecentDigest([]), "");
    assert.equal(buildRecentDigest([{ role: "user", text: "" }]), "");
  });
});

describe("buildRegenerateTitlePrompt (#1774)", () => {
  it("includes the first request and recent activity, drift framing, and instructions", () => {
    const prompt = buildRegenerateTitlePrompt(
      "Fix the login bug",
      "User: Actually, do the signup flow instead",
      "Lowercase only.",
    );
    assert.match(prompt, /actually about now/);
    assert.match(prompt, /First request:\nFix the login bug/);
    assert.match(
      prompt,
      /Recent activity:\nUser: Actually, do the signup flow instead/,
    );
    assert.match(prompt, /Extra instructions:\nLowercase only\./);
  });

  it("omits the digest and instructions blocks when absent", () => {
    const prompt = buildRegenerateTitlePrompt("Fix the login bug", "", "");
    assert.doesNotMatch(prompt, /Recent activity/);
    assert.doesNotMatch(prompt, /Extra instructions/);
  });
});

describe("regenerateTitle (#1774)", () => {
  let tmpDir;
  let store;
  let thread;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-regen-title-"));
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

  it("overwrites even a title the user set by hand, since the user picked this thread", async () => {
    services.renameThread(store, { threadId: thread.id, title: "Ship checklist" });
    seedFirstTurn(store, thread.id, "Fix the login bug", "Looking now.");

    const bin = writeFakeFm(tmpDir, `console.log("Fix the signup flow");`);
    const title = await regenerateTitle(store, thread.id, {
      env: { ...process.env, CODER_FM_BIN: bin },
    });
    assert.equal(title, "Fix the signup flow");
    assert.equal(store.getThread(thread.id).title, "Fix the signup flow");
  });

  it("throws and leaves the title alone when fm is unavailable", async () => {
    seedFirstTurn(store, thread.id, "Fix the login bug", "Looking now.");
    await assert.rejects(
      regenerateTitle(store, thread.id, {
        env: { ...process.env, CODER_FM_BIN: "/nope/fm" },
      }),
      /Title generator is not available/,
    );
    assert.equal(store.getThread(thread.id).title, "New Thread");
  });

  it("refuses a trashed thread", async () => {
    seedFirstTurn(store, thread.id, "Fix the login bug", "Looking now.");
    services.trashThread(store, { threadId: thread.id });
    const bin = writeFakeFm(tmpDir, `console.log("New title");`);
    await assert.rejects(
      regenerateTitle(store, thread.id, {
        env: { ...process.env, CODER_FM_BIN: bin },
      }),
      /Cannot regenerate a trashed thread/,
    );
  });
});

describe("regenerateTitles (#1774)", () => {
  let tmpDir;
  let store;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-regen-titles-"));
    store = new Store(path.join(tmpDir, "store.json"));

    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);

    project = await services.addProject(store, repo);
  });

  afterEach(async () => {
    await rmTree(tmpDir);
  });

  function makeThread(text) {
    const t = services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });
    seedFirstTurn(store, t.id, text, "Working on it.");
    return t;
  }

  it("regenerates every thread and reports one result each", async () => {
    const a = makeThread("Fix the login bug");
    const b = makeThread("Add dark mode");
    const bin = writeFakeFm(
      tmpDir,
      `console.log("Title for " + process.argv[process.argv.length - 1].slice(0, 5));`,
    );
    const env = { ...process.env, CODER_FM_BIN: bin };

    const results = await regenerateTitles(store, [a.id, b.id], { env });
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(typeof r.threadId, "string");
      assert.ok(r.title, `thread ${r.threadId} got a title`);
      assert.equal(r.error, undefined);
    }
    assert.notEqual(store.getThread(a.id).title, "New Thread");
    assert.notEqual(store.getThread(b.id).title, "New Thread");
  });

  it("skips a trashed thread with an error, and keeps the rest going", async () => {
    const a = makeThread("Fix the login bug");
    const trashed = makeThread("Old abandoned task");
    services.trashThread(store, { threadId: trashed.id });
    const bin = writeFakeFm(tmpDir, `console.log("Fresh title");`);

    const results = await regenerateTitles(store, [a.id, trashed.id], {
      env: { ...process.env, CODER_FM_BIN: bin },
    });
    const forA = results.find((r) => r.threadId === a.id);
    const forTrashed = results.find((r) => r.threadId === trashed.id);
    assert.equal(forA.title, "Fresh title");
    assert.match(forTrashed.error, /trashed/);
    assert.equal(store.getThread(trashed.id).title, "New Thread");
  });

  it("one thread's failure does not stop the others", async () => {
    const ok = makeThread("Fix the login bug");
    const empty = services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });
    // No messages at all: regenerateTitle throws "no messages to title".
    const bin = writeFakeFm(tmpDir, `console.log("Fresh title");`);

    const results = await regenerateTitles(store, [empty.id, ok.id], {
      env: { ...process.env, CODER_FM_BIN: bin },
    });
    const forEmpty = results.find((r) => r.threadId === empty.id);
    const forOk = results.find((r) => r.threadId === ok.id);
    assert.match(forEmpty.error, /no messages/);
    assert.equal(forOk.title, "Fresh title");
  });

  it("never runs more than 2 fm calls at once", async () => {
    const threads = [
      makeThread("Task one"),
      makeThread("Task two"),
      makeThread("Task three"),
      makeThread("Task four"),
    ];
    const logFile = path.join(tmpDir, "concurrency.log");
    const bin = writeFakeFm(
      tmpDir,
      `const fs = require("fs");
const log = ${JSON.stringify(logFile)};
fs.appendFileSync(log, "start " + Date.now() + "\\n");
setTimeout(() => {
  fs.appendFileSync(log, "end " + Date.now() + "\\n");
  console.log("Regenerated");
}, 60);
`,
    );
    await regenerateTitles(
      store,
      threads.map((t) => t.id),
      { env: { ...process.env, CODER_FM_BIN: bin } },
    );

    const events = fs
      .readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [kind, ts] = line.split(" ");
        return { kind, ts: Number(ts) };
      })
      .sort((x, y) => x.ts - y.ts || (x.kind === "end" ? -1 : 1));
    let current = 0;
    let max = 0;
    for (const ev of events) {
      current += ev.kind === "start" ? 1 : -1;
      max = Math.max(max, current);
    }
    assert.equal(events.length, 8, "4 starts + 4 ends");
    assert.ok(max <= 2, `never more than 2 concurrent, saw ${max}`);
    assert.ok(max >= 2, `concurrency actually reaches 2, saw ${max}`);
  });
});
