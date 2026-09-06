"use strict";

/**
 * #433 / #554: Codex rollout reader pointed at one known sessionId.
 * Reclaim (and later import) share this parser. No second session store.
 *
 * Run: node --test electron/test/cli-sessions.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const {
  findCodexSessionFile,
  parseCodexRollout,
  readCodexSessionTurns,
  listCodexSessions,
  importCodexSession,
  encodeClaudeProjectDir,
  findClaudeSessionFile,
  readClaudeSessionTurns,
  encodeGrokSessionDir,
  findGrokSessionFile,
  readGrokSessionTurns,
  parseGrokChatHistory,
  listGrokSessions,
  importGrokSession,
  parseCursorJsonl,
  listCursorSessions,
  importCursorSession,
  listOpenCodeSessions,
  importOpenCodeSession,
  readOpenCodeImportTurns,
} = require("../cli-sessions.js");
const { DatabaseSync } = require("node:sqlite");

const SESSION_A = "01a07579-aaaa-7000-8000-aaaaaaaaaaaa";
const SESSION_B = "01a07579-bbbb-7000-8000-bbbbbbbbbbbb";

function writeRollout(home, sessionId, records, shard = ["2026", "09", "06"]) {
  const dir = path.join(home, "sessions", ...shard);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${shard[0]}-${shard[1]}-${shard[2]}T12-00-00`;
  const file = path.join(dir, `rollout-${stamp}-${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: "2026-09-06T12:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId, session_id: sessionId },
    }),
    ...records.map((r) => JSON.stringify(r)),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function messageRecord(role, text, timestamp) {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [
        {
          type: role === "assistant" ? "output_text" : "input_text",
          text,
        },
      ],
    },
  };
}

describe("Codex session reader (#433 / #554)", () => {
  let home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cli-sessions-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("finds one rollout by sessionId and ignores a sibling session", () => {
    writeRollout(home, SESSION_A, [
      messageRecord("user", "prompt a", "2026-09-06T12:00:01.000Z"),
      messageRecord("assistant", "reply a", "2026-09-06T12:00:02.000Z"),
    ]);
    writeRollout(home, SESSION_B, [
      messageRecord("user", "prompt b", "2026-09-06T12:00:01.000Z"),
      messageRecord("assistant", "reply b", "2026-09-06T12:00:02.000Z"),
    ]);

    const found = findCodexSessionFile(home, SESSION_B);
    assert.ok(found, "must locate the known sessionId");
    assert.match(found, new RegExp(`${SESSION_B}\\.jsonl$`));
    assert.equal(findCodexSessionFile(home, SESSION_A) === found, false);

    const turns = readCodexSessionTurns(home, SESSION_B);
    assert.deepEqual(
      turns.map((t) => `${t.role}:${t.text}`),
      ["user:prompt b", "assistant:reply b"],
    );
  });

  it("skips injected user wrappers and developer messages", () => {
    writeRollout(home, SESSION_A, [
      messageRecord(
        "user",
        "<recommended_plugins>\nAtlassian Rovo\n",
        "2026-09-06T12:00:01.000Z",
      ),
      {
        timestamp: "2026-09-06T12:00:01.500Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<skills_instructions>\n" }],
        },
      },
      messageRecord("user", "real prompt", "2026-09-06T12:00:02.000Z"),
      messageRecord("assistant", "real reply", "2026-09-06T12:00:03.000Z"),
    ]);

    const turns = readCodexSessionTurns(home, SESSION_A);
    assert.deepEqual(
      turns.map((t) => `${t.role}:${t.text}`),
      ["user:real prompt", "assistant:real reply"],
    );
  });

  it("returns [] when the sessionId is missing", () => {
    writeRollout(home, SESSION_A, [
      messageRecord("assistant", "nope", "2026-09-06T12:00:02.000Z"),
    ]);
    assert.deepEqual(readCodexSessionTurns(home, SESSION_B), []);
    assert.equal(findCodexSessionFile(home, SESSION_B), null);
  });

  it("rejects a sessionId that is not a path-safe id", () => {
    writeRollout(home, SESSION_A, [
      messageRecord("user", "prompt a", "2026-09-06T12:00:01.000Z"),
    ]);
    assert.equal(findCodexSessionFile(home, "../sessions"), null);
    assert.equal(findCodexSessionFile(home, "a/b"), null);
    assert.equal(findCodexSessionFile(home, ""), null);
  });
});

describe("listCodexSessions (#433)", () => {
  let home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cli-sessions-list-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("lists both rollouts in a mocked date-sharded sessions directory", () => {
    writeRollout(home, SESSION_A, [
      messageRecord("user", "prompt a", "2026-09-06T12:00:01.000Z"),
      messageRecord("assistant", "reply a", "2026-09-06T12:00:02.000Z"),
    ]);
    writeRollout(
      home,
      SESSION_B,
      [
        messageRecord("user", "prompt b", "2026-09-06T12:00:01.000Z"),
        messageRecord("assistant", "reply b", "2026-09-06T12:00:02.000Z"),
      ],
      ["2026", "08", "31"],
    );

    const listed = listCodexSessions(home);
    assert.equal(listed.length, 2);
    const ids = listed.map((s) => s.sessionId).sort();
    assert.deepEqual(ids, [SESSION_A, SESSION_B].sort());
  });
});

describe("importCodexSession (#433)", () => {
  let home;
  let tmpDir;
  let store;
  let projectId;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cli-sessions-imp-"));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cli-sessions-store-"));
    store = new Store(path.join(tmpDir, "store.json"));
    projectId = "proj-import";
    store.setProjects([
      {
        id: projectId,
        slug: "demo",
        name: "demo",
        path: path.join(tmpDir, "demo"),
      },
    ]);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a thread whose transcript matches the parsed turns and ignores the sibling", () => {
    const fileA = writeRollout(home, SESSION_A, [
      messageRecord("user", "prompt a", "2026-09-06T12:00:01.000Z"),
      messageRecord("assistant", "reply a", "2026-09-06T12:00:02.000Z"),
    ]);
    writeRollout(
      home,
      SESSION_B,
      [
        messageRecord("user", "prompt b", "2026-09-06T12:00:01.000Z"),
        messageRecord("assistant", "reply b", "2026-09-06T12:00:02.000Z"),
      ],
      ["2026", "08", "31"],
    );

    const expected = parseCodexRollout(fs.readFileSync(fileA, "utf8"));
    const thread = importCodexSession(store, {
      home,
      sessionId: SESSION_A,
      projectId,
    });

    assert.ok(thread && thread.id);
    assert.equal(thread.provider, "codex");
    assert.equal(thread.sessionId, SESSION_A);
    assert.equal(thread.projectId, projectId);

    const messages = store.getMessages(thread.id);
    assert.deepEqual(
      messages.map((m) => `${m.role}:${m.text}`),
      expected.map((t) => `${t.role}:${t.text}`),
    );
    assert.deepEqual(
      messages.map((m) => `${m.role}:${m.text}`),
      ["user:prompt a", "assistant:reply a"],
    );
    assert.equal(
      messages.some((m) => m.text === "prompt b" || m.text === "reply b"),
      false,
    );
    assert.equal(store.getThreads().length, 1);
  });

  it("re-importing the same session does not mint a second thread", () => {
    writeRollout(home, SESSION_A, [
      messageRecord("user", "prompt a", "2026-09-06T12:00:01.000Z"),
      messageRecord("assistant", "reply a", "2026-09-06T12:00:02.000Z"),
    ]);
    const first = importCodexSession(store, {
      home,
      sessionId: SESSION_A,
      projectId,
    });
    const second = importCodexSession(store, {
      home,
      sessionId: SESSION_A,
      projectId,
    });
    assert.equal(second.id, first.id);
    assert.equal(store.getThreads().length, 1);
    assert.equal(store.getMessages(first.id).length, 2);
  });
});

const CLAUDE_CWD = "/tmp/solenta-claude-wt";
const GROK_CWD = "/tmp/solenta-grok-wt";

// Claude Code 2.1.x: dash-encoded cwd longer than 200 chars becomes
// `{encoded.slice(0,200)}-{abs(djb2(cwd)).toString(36)}`. That also covers
// names past the 255-byte dirname cap (historical ENAMETOOLONG).
const CLAUDE_LONG_CWD = `/tmp/${"a".repeat(300)}`;
const CLAUDE_LONG_GROUP =
  "-tmp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-w6az8n";
// Claude Code 2.1.219 LM(): overflow sibling dirs share RA().slice(0,200)+'-'.
const CLAUDE_LONG_PREFIX = `${CLAUDE_LONG_GROUP.slice(0, 200)}-`;
const CLAUDE_SIBLING_GROUP = `${CLAUDE_LONG_PREFIX}drift1`;

function claudeProjectDir(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

function writeClaudeSessionAtGroup(home, group, sessionId, records) {
  const dir = path.join(home, "projects", group);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return file;
}

function writeClaudeSession(home, cwd, sessionId, records) {
  return writeClaudeSessionAtGroup(
    home,
    claudeProjectDir(cwd),
    sessionId,
    records,
  );
}

function claudeUser(text, timestamp, extra = {}) {
  return {
    type: "user",
    message: { role: "user", content: text },
    timestamp,
    sessionId: extra.sessionId,
    isSidechain: extra.isSidechain === true,
    cwd: extra.cwd,
  };
}

function claudeAssistant(text, timestamp, extra = {}) {
  const content = extra.parts || [{ type: "text", text }];
  return {
    type: "assistant",
    message: { role: "assistant", content },
    timestamp,
    sessionId: extra.sessionId,
    isSidechain: extra.isSidechain === true,
  };
}

describe("Claude session reader (#554)", () => {
  let home;
  /** @type {string | null} */
  let linkedRoot;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-claude-sessions-"));
    linkedRoot = null;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (linkedRoot) fs.rmSync(linkedRoot, { recursive: true, force: true });
  });

  /**
   * Claude Code 2.1.219 Nqe() does `s = realpath(cwd) || cwd` before RA()/LM().
   * @param {string} realRel
   * @param {string} linkRel
   */
  function makeLinkedWorktree(realRel, linkRel) {
    linkedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coder-claude-link-"));
    const real = path.join(linkedRoot, realRel);
    const link = path.join(linkedRoot, linkRel);
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link);
    const resolved = fs.realpathSync(link);
    assert.notEqual(link, resolved, "fixture symlink realpath must differ from cwd");
    return { real, link, resolved };
  }

  it("opens one jsonl by sessionId+cwd and ignores another project dir", () => {
    writeClaudeSession(home, CLAUDE_CWD, SESSION_A, [
      claudeUser("prompt a", "2026-09-06T12:00:01.000Z"),
      claudeAssistant("reply a", "2026-09-06T12:00:02.000Z"),
    ]);
    writeClaudeSession(home, "/tmp/other-wt", SESSION_B, [
      claudeUser("prompt b", "2026-09-06T12:00:01.000Z"),
      claudeAssistant("reply b", "2026-09-06T12:00:02.000Z"),
    ]);
    // Same sessionId under a different cwd must not be found (no scan).
    writeClaudeSession(home, "/tmp/other-wt", SESSION_A, [
      claudeUser("wrong cwd", "2026-09-06T12:00:01.000Z"),
    ]);

    const found = findClaudeSessionFile(home, CLAUDE_CWD, SESSION_A);
    assert.ok(found, "must locate the known sessionId under the encoded cwd");
    assert.match(found, new RegExp(`${SESSION_A}\\.jsonl$`));
    assert.equal(findClaudeSessionFile(home, CLAUDE_CWD, SESSION_B), null);

    const turns = readClaudeSessionTurns(home, CLAUDE_CWD, SESSION_A);
    assert.deepEqual(
      turns.map((t) => `${t.role}:${t.text}`),
      ["user:prompt a", "assistant:reply a"],
    );
  });

  it("skips tool results, thinking, sidechains, and XML-wrapped user blobs", () => {
    writeClaudeSession(home, CLAUDE_CWD, SESSION_A, [
      claudeUser(
        "<command-name>/compact</command-name>",
        "2026-09-06T12:00:01.000Z",
      ),
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
        timestamp: "2026-09-06T12:00:01.500Z",
      },
      claudeAssistant("", "2026-09-06T12:00:02.000Z", {
        parts: [{ type: "thinking", thinking: "plan" }],
      }),
      claudeAssistant("", "2026-09-06T12:00:02.500Z", {
        parts: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
      }),
      claudeUser("real prompt", "2026-09-06T12:00:03.000Z"),
      claudeAssistant("real reply", "2026-09-06T12:00:04.000Z"),
      claudeUser("side prompt", "2026-09-06T12:00:05.000Z", {
        isSidechain: true,
      }),
      claudeAssistant("side reply", "2026-09-06T12:00:06.000Z", {
        isSidechain: true,
      }),
    ]);

    const turns = readClaudeSessionTurns(home, CLAUDE_CWD, SESSION_A);
    assert.deepEqual(
      turns.map((t) => `${t.role}:${t.text}`),
      ["user:real prompt", "assistant:real reply"],
    );
  });

  it("rejects a sessionId that is not a path-safe id", () => {
    writeClaudeSession(home, CLAUDE_CWD, SESSION_A, [
      claudeUser("prompt a", "2026-09-06T12:00:01.000Z"),
    ]);
    assert.equal(findClaudeSessionFile(home, CLAUDE_CWD, "../sessions"), null);
    assert.equal(findClaudeSessionFile(home, CLAUDE_CWD, "a/b"), null);
    assert.equal(findClaudeSessionFile(home, CLAUDE_CWD, ""), null);
  });

  it("opens the truncated-hash project dir when dash-encoded cwd exceeds 255 bytes", () => {
    const dashed = claudeProjectDir(CLAUDE_LONG_CWD);
    assert.ok(
      Buffer.byteLength(dashed, "utf8") > 255,
      "fixture cwd must overflow the 255-byte dirname cap",
    );
    assert.ok(dashed.length > 200, "Claude hashes after 200 encoded chars");
    writeClaudeSessionAtGroup(home, CLAUDE_LONG_GROUP, SESSION_A, [
      claudeUser("long cwd prompt", "2026-09-06T12:00:01.000Z"),
      claudeAssistant("long cwd reply", "2026-09-06T12:00:02.000Z"),
    ]);
    writeClaudeSessionAtGroup(home, claudeProjectDir("/tmp/other-wt"), SESSION_B, [
      claudeUser("wrong group", "2026-09-06T12:00:01.000Z"),
    ]);

    assert.equal(encodeClaudeProjectDir(CLAUDE_LONG_CWD), CLAUDE_LONG_GROUP);
    assert.equal(encodeClaudeProjectDir(CLAUDE_CWD), claudeProjectDir(CLAUDE_CWD));

    const found = findClaudeSessionFile(home, CLAUDE_LONG_CWD, SESSION_A);
    assert.ok(found, "must locate the hashed project dir without scanning projects/");
    assert.match(found, new RegExp(`${SESSION_A}\\.jsonl$`));
    assert.equal(found.includes(CLAUDE_LONG_GROUP), true);
    assert.equal(findClaudeSessionFile(home, CLAUDE_LONG_CWD, SESSION_B), null);

    const turns = readClaudeSessionTurns(home, CLAUDE_LONG_CWD, SESSION_A);
    assert.deepEqual(
      turns.map((t) => `${t.role}:${t.text}`),
      ["user:long cwd prompt", "assistant:long cwd reply"],
    );
  });

  it("opens a prefix-sibling hashed dir when the RA() jsonl is missing", () => {
    assert.equal(CLAUDE_SIBLING_GROUP.startsWith(CLAUDE_LONG_PREFIX), true);
    assert.notEqual(CLAUDE_SIBLING_GROUP, CLAUDE_LONG_GROUP);
    writeClaudeSessionAtGroup(home, CLAUDE_SIBLING_GROUP, SESSION_A, [
      claudeUser("sibling prompt", "2026-09-06T12:00:01.000Z"),
      claudeAssistant("sibling reply", "2026-09-06T12:00:02.000Z"),
    ]);
    writeClaudeSessionAtGroup(home, claudeProjectDir("/tmp/other-wt"), SESSION_A, [
      claudeUser("wrong group", "2026-09-06T12:00:01.000Z"),
    ]);
    writeClaudeSessionAtGroup(home, claudeProjectDir("/tmp/other-wt"), SESSION_B, [
      claudeUser("other session", "2026-09-06T12:00:01.000Z"),
    ]);

    const found = findClaudeSessionFile(home, CLAUDE_LONG_CWD, SESSION_A);
    assert.ok(found, "must locate the prefix-sibling jsonl without a full projects/ walk");
    assert.equal(found.includes(CLAUDE_SIBLING_GROUP), true);
    assert.equal(found.includes(CLAUDE_LONG_GROUP), false);
    assert.equal(findClaudeSessionFile(home, CLAUDE_LONG_CWD, SESSION_B), null);

    const turns = readClaudeSessionTurns(home, CLAUDE_LONG_CWD, SESSION_A);
    assert.deepEqual(
      turns.map((t) => `${t.role}:${t.text}`),
      ["user:sibling prompt", "assistant:sibling reply"],
    );
  });

  it("prefers the RA() hashed dir over a prefix sibling", () => {
    writeClaudeSessionAtGroup(home, CLAUDE_LONG_GROUP, SESSION_A, [
      claudeUser("ra prompt", "2026-09-06T12:00:01.000Z"),
    ]);
    writeClaudeSessionAtGroup(home, CLAUDE_SIBLING_GROUP, SESSION_A, [
      claudeUser("sibling prompt", "2026-09-06T12:00:01.000Z"),
    ]);

    const found = findClaudeSessionFile(home, CLAUDE_LONG_CWD, SESSION_A);
    assert.ok(found);
    assert.equal(found.includes(CLAUDE_LONG_GROUP), true);
    assert.equal(found.includes(CLAUDE_SIBLING_GROUP), false);
  });

  it("opens RA(realpath(cwd)) when the stored cwd is a symlink", () => {
    const { link, resolved } = makeLinkedWorktree("real-wt", "link-wt");
    assert.ok(
      encodeClaudeProjectDir(link).length <= 200,
      "stored symlink cwd must stay a short RA() so this is not an overflow scan",
    );
    writeClaudeSession(home, resolved, SESSION_A, [
      claudeUser("realpath prompt", "2026-09-06T12:00:01.000Z"),
      claudeAssistant("realpath reply", "2026-09-06T12:00:02.000Z"),
    ]);
    writeClaudeSession(home, "/tmp/other-wt", SESSION_A, [
      claudeUser("wrong cwd", "2026-09-06T12:00:01.000Z"),
    ]);

    const found = findClaudeSessionFile(home, link, SESSION_A);
    assert.ok(found, "must locate RA(realpath) without scanning projects/");
    assert.equal(found.includes(encodeClaudeProjectDir(resolved)), true);
    assert.equal(found.includes(encodeClaudeProjectDir(link)), false);
    assert.equal(findClaudeSessionFile(home, link, SESSION_B), null);

    const turns = readClaudeSessionTurns(home, link, SESSION_A);
    assert.deepEqual(
      turns.map((t) => `${t.role}:${t.text}`),
      ["user:realpath prompt", "assistant:realpath reply"],
    );
  });

  it("prefers RA(stored cwd) over RA(realpath) when both jsonl files exist", () => {
    const { link, resolved } = makeLinkedWorktree("real-wt", "link-wt");
    writeClaudeSession(home, link, SESSION_A, [
      claudeUser("stored prompt", "2026-09-06T12:00:01.000Z"),
    ]);
    writeClaudeSession(home, resolved, SESSION_A, [
      claudeUser("realpath prompt", "2026-09-06T12:00:01.000Z"),
    ]);

    const found = findClaudeSessionFile(home, link, SESSION_A);
    assert.ok(found);
    assert.equal(found.includes(encodeClaudeProjectDir(link)), true);
    assert.equal(found.includes(encodeClaudeProjectDir(resolved)), false);
  });

  it("opens RA(realpath) overflow siblings when a short symlink cwd misses", () => {
    const { link, resolved } = makeLinkedWorktree(
      path.join("real", "a".repeat(200)),
      "link-wt",
    );
    const storedEncoded = encodeClaudeProjectDir(link);
    const resolvedEncoded = encodeClaudeProjectDir(resolved);
    assert.ok(
      storedEncoded.length <= 200,
      "stored symlink cwd must be short so RA(cwd) does not readdir",
    );
    assert.ok(
      resolvedEncoded.length > 200,
      "realpath must overflow so LM() prefix siblings apply to RA(realpath)",
    );
    assert.notEqual(storedEncoded, resolvedEncoded);
    const resolvedPrefix = `${resolvedEncoded.slice(0, 200)}-`;
    const resolvedSibling = `${resolvedPrefix}drift1`;
    writeClaudeSessionAtGroup(home, resolvedSibling, SESSION_A, [
      claudeUser("realpath sibling prompt", "2026-09-06T12:00:01.000Z"),
      claudeAssistant("realpath sibling reply", "2026-09-06T12:00:02.000Z"),
    ]);
    writeClaudeSession(home, "/tmp/other-wt", SESSION_A, [
      claudeUser("wrong group", "2026-09-06T12:00:01.000Z"),
    ]);

    const found = findClaudeSessionFile(home, link, SESSION_A);
    assert.ok(found, "must locate prefix-sibling of RA(realpath), not a full walk");
    assert.equal(found.includes(resolvedSibling), true);
    assert.equal(found.includes(storedEncoded), false);
    assert.equal(findClaudeSessionFile(home, link, SESSION_B), null);

    const turns = readClaudeSessionTurns(home, link, SESSION_A);
    assert.deepEqual(
      turns.map((t) => `${t.role}:${t.text}`),
      ["user:realpath sibling prompt", "assistant:realpath sibling reply"],
    );
  });

  it("does not scan projects/ when a short symlink cwd and its realpath both miss", () => {
    const { link, resolved } = makeLinkedWorktree("real-wt", "link-wt");
    assert.ok(encodeClaudeProjectDir(link).length <= 200);
    assert.ok(encodeClaudeProjectDir(resolved).length <= 200);
    writeClaudeSession(home, "/tmp/other-wt", SESSION_A, [
      claudeUser("wrong cwd", "2026-09-06T12:00:01.000Z"),
    ]);

    assert.equal(findClaudeSessionFile(home, link, SESSION_A), null);
  });

  it("opens a jsonl under a linked git worktree hashed dir (e4l)", () => {
    const pair = makeGitWorktreePair();
    try {
      writeClaudeSession(home, pair.linkedPath, SESSION_A, [
        claudeUser("worktree prompt", "2026-09-06T12:00:01.000Z"),
        claudeAssistant("worktree reply", "2026-09-06T12:00:02.000Z"),
      ]);
      writeClaudeSession(home, "/tmp/other-wt", SESSION_A, [
        claudeUser("wrong cwd", "2026-09-06T12:00:01.000Z"),
      ]);

      const found = findClaudeSessionFile(home, pair.repo, SESSION_A);
      assert.ok(found, "must locate the jsonl under the linked worktree RA() dir");
      assert.equal(found.includes(encodeClaudeProjectDir(pair.linkedPath)), true);
      assert.equal(found.includes(encodeClaudeProjectDir("/tmp/other-wt")), false);
      assert.equal(findClaudeSessionFile(home, pair.repo, SESSION_B), null);

      const turns = readClaudeSessionTurns(home, pair.repo, SESSION_A);
      assert.deepEqual(
        turns.map((t) => `${t.role}:${t.text}`),
        ["user:worktree prompt", "assistant:worktree reply"],
      );
    } finally {
      fs.rmSync(pair.root, { recursive: true, force: true });
    }
  });

  it("prefers the cwd RA() dir over a linked git worktree", () => {
    const pair = makeGitWorktreePair();
    try {
      // GR() realpaths lookup cwd before RA(); write under that encoding
      // so a present hashed dir still wins over e4l (macOS /var vs /private/var).
      const cwd = fs.realpathSync(pair.repo).normalize("NFC");
      writeClaudeSession(home, cwd, SESSION_A, [
        claudeUser("cwd prompt", "2026-09-06T12:00:01.000Z"),
      ]);
      writeClaudeSession(home, pair.linkedPath, SESSION_A, [
        claudeUser("worktree prompt", "2026-09-06T12:00:01.000Z"),
      ]);

      const found = findClaudeSessionFile(home, pair.repo, SESSION_A);
      assert.ok(found);
      assert.equal(found.includes(encodeClaudeProjectDir(cwd)), true);
      assert.equal(found.includes(encodeClaudeProjectDir(pair.linkedPath)), false);
    } finally {
      fs.rmSync(pair.root, { recursive: true, force: true });
    }
  });

  it("does not walk unrelated project dirs when cwd is a git repo without that worktree", () => {
    const pair = makeGitWorktreePair();
    try {
      writeClaudeSession(home, "/tmp/other-wt", SESSION_A, [
        claudeUser("wrong cwd", "2026-09-06T12:00:01.000Z"),
      ]);
      assert.equal(findClaudeSessionFile(home, pair.repo, SESSION_A), null);
    } finally {
      fs.rmSync(pair.root, { recursive: true, force: true });
    }
  });

  it("opens a jsonl hashed under RA(realpath(cwd)) when lookup cwd is a symlink", () => {
    const pair = makeSymlinkCwd();
    try {
      writeClaudeSession(home, pair.realPath, SESSION_A, [
        claudeUser("realpath prompt", "2026-09-06T12:00:01.000Z"),
        claudeAssistant("realpath reply", "2026-09-06T12:00:02.000Z"),
      ]);
      writeClaudeSession(home, "/tmp/other-wt", SESSION_A, [
        claudeUser("wrong cwd", "2026-09-06T12:00:01.000Z"),
      ]);

      const found = findClaudeSessionFile(home, pair.link, SESSION_A);
      assert.ok(found, "must locate the jsonl under RA(realpath(cwd))");
      assert.equal(found.includes(encodeClaudeProjectDir(pair.realPath)), true);
      assert.equal(found.includes(encodeClaudeProjectDir(pair.link)), false);
      assert.equal(found.includes(encodeClaudeProjectDir("/tmp/other-wt")), false);
      assert.equal(findClaudeSessionFile(home, pair.link, SESSION_B), null);

      const turns = readClaudeSessionTurns(home, pair.link, SESSION_A);
      assert.deepEqual(
        turns.map((t) => `${t.role}:${t.text}`),
        ["user:realpath prompt", "assistant:realpath reply"],
      );
    } finally {
      fs.rmSync(pair.root, { recursive: true, force: true });
    }
  });

  it("prefers the canonical RA() dir when lookup cwd is already the realpath", () => {
    const pair = makeSymlinkCwd();
    try {
      writeClaudeSession(home, pair.realPath, SESSION_A, [
        claudeUser("canonical prompt", "2026-09-06T12:00:01.000Z"),
      ]);
      writeClaudeSession(home, pair.link, SESSION_A, [
        claudeUser("symlink prompt", "2026-09-06T12:00:01.000Z"),
      ]);

      const found = findClaudeSessionFile(home, pair.realPath, SESSION_A);
      assert.ok(found);
      assert.equal(found.includes(encodeClaudeProjectDir(pair.realPath)), true);
      assert.equal(found.includes(encodeClaudeProjectDir(pair.link)), false);
    } finally {
      fs.rmSync(pair.root, { recursive: true, force: true });
    }
  });

  it("does not walk unrelated project dirs when lookup cwd is a symlink", () => {
    const pair = makeSymlinkCwd();
    try {
      writeClaudeSession(home, "/tmp/other-wt", SESSION_A, [
        claudeUser("wrong cwd", "2026-09-06T12:00:01.000Z"),
      ]);
      assert.equal(findClaudeSessionFile(home, pair.link, SESSION_A), null);
    } finally {
      fs.rmSync(pair.root, { recursive: true, force: true });
    }
  });
});

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Main checkout + one linked worktree. Paths used for RA() come from
 * `git worktree list --porcelain` so they match Claude Code 2.1.219 Gue().
 */
function makeGitWorktreePair() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coder-claude-e4l-"));
  const repo = path.join(root, "repo");
  const linked = path.join(root, "linked");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["commit", "--allow-empty", "-m", "init"]);
  git(repo, ["worktree", "add", "-b", "linked", linked]);
  const porcelain = git(repo, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=",
    "worktree",
    "list",
    "--porcelain",
  ]);
  const trees = porcelain
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice(9));
  const linkedPath = trees.find((p) => path.basename(p) === "linked");
  const repoPath = trees.find((p) => path.basename(p) === "repo");
  if (!linkedPath || !repoPath) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(`expected repo+linked worktrees, got ${JSON.stringify(trees)}`);
  }
  return { root, repo, linked, linkedPath, repoPath };
}

/**
 * Real directory + a symlink to it. Claude Code 2.1.219 GR() realpaths cwd
 * before RA(), so the hashed dir is RA(realpath(link)), not RA(link).
 */
function makeSymlinkCwd() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coder-claude-gr-"));
  const real = path.join(root, "real");
  const link = path.join(root, "link");
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  const realPath = fs.realpathSync(link).normalize("NFC");
  if (encodeClaudeProjectDir(link) === encodeClaudeProjectDir(realPath)) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error("symlink cwd hashed the same as realpath; GR() would be untestable");
  }
  return { root, real, link, realPath };
}

function writeGrokSession(home, cwd, sessionId, records) {
  return writeGrokSessionAtGroup(
    home,
    encodeURIComponent(String(cwd)),
    sessionId,
    records,
  );
}

function writeGrokSessionAtGroup(home, group, sessionId, records) {
  const dir = path.join(home, "sessions", group, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "chat_history.jsonl");
  fs.writeFileSync(
    file,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return file;
}

// Grok: encodeURIComponent(cwd) > 255 bytes → `{slugify(basename,40)|workspace}-{blake3(cwd)[:16]}`.
// Vectors from grok-build encode_cwd_dirname / rust blake3 1.x (not a sessions/ scan).
const GROK_LONG_CWD = `/tmp/${"a".repeat(300)}`;
const GROK_LONG_GROUP =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-b27d87e57e568d10";
const GROK_CJK_CWD = `/Users/test/${"中".repeat(30)}`;
const GROK_CJK_GROUP = "workspace-43f12fb9a5ee1037";

describe("Grok session reader (#554)", () => {
  let home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grok-sessions-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("opens chat_history.jsonl by sessionId+cwd and ignores another cwd", () => {
    writeGrokSession(home, GROK_CWD, SESSION_A, [
      { type: "user", content: "prompt a" },
      { type: "assistant", content: "reply a" },
    ]);
    writeGrokSession(home, "/tmp/other-wt", SESSION_B, [
      { type: "user", content: "prompt b" },
      { type: "assistant", content: "reply b" },
    ]);
    writeGrokSession(home, "/tmp/other-wt", SESSION_A, [
      { type: "user", content: "wrong cwd" },
    ]);

    const found = findGrokSessionFile(home, GROK_CWD, SESSION_A);
    assert.ok(found, "must locate the known sessionId under the encoded cwd");
    assert.match(found, /chat_history\.jsonl$/);
    assert.equal(findGrokSessionFile(home, GROK_CWD, SESSION_B), null);

    const turns = readGrokSessionTurns(home, GROK_CWD, SESSION_A);
    assert.deepEqual(
      turns.map((t) => `${t.role}:${t.text}`),
      ["user:prompt a", "assistant:reply a"],
    );
  });

  it("extracts user_query, skips synthetics, and drops XML-only user blobs", () => {
    writeGrokSession(home, GROK_CWD, SESSION_A, [
      { type: "system", content: "You are Grok." },
      {
        type: "user",
        content: [
          {
            type: "text",
            text: "<user_info>\nOS\n</user_info>\n<user_query>\nreal prompt\n</user_query>",
          },
        ],
      },
      { type: "user", content: "list", synthetic_reason: "system_reminder" },
      { type: "reasoning", content: "thinking" },
      { type: "tool_result", content: "ok" },
      { type: "assistant", content: "real reply" },
      { type: "user", content: "<system-reminder>\nhooks\n</system-reminder>" },
      { type: "assistant", content: "", tool_calls: [{ name: "bash" }] },
    ]);

    const turns = readGrokSessionTurns(home, GROK_CWD, SESSION_A);
    assert.deepEqual(
      turns.map((t) => `${t.role}:${t.text}`),
      ["user:real prompt", "assistant:real reply"],
    );
  });

  it("rejects a sessionId that is not a path-safe id", () => {
    writeGrokSession(home, GROK_CWD, SESSION_A, [
      { type: "user", content: "prompt a" },
    ]);
    assert.equal(findGrokSessionFile(home, GROK_CWD, "../sessions"), null);
    assert.equal(findGrokSessionFile(home, GROK_CWD, "a/b"), null);
    assert.equal(findGrokSessionFile(home, GROK_CWD, ""), null);
  });

  it("opens the slug-hash group when encoded cwd exceeds 255 bytes", () => {
    assert.ok(
      Buffer.byteLength(encodeURIComponent(GROK_LONG_CWD), "utf8") > 255,
      "fixture cwd must overflow the 255-byte dirname cap",
    );
    writeGrokSessionAtGroup(home, GROK_LONG_GROUP, SESSION_A, [
      { type: "user", content: "long cwd prompt" },
      { type: "assistant", content: "long cwd reply" },
    ]);
    writeGrokSessionAtGroup(home, GROK_CJK_GROUP, SESSION_B, [
      { type: "user", content: "wrong group" },
    ]);

    assert.equal(encodeGrokSessionDir(GROK_LONG_CWD), GROK_LONG_GROUP);
    assert.equal(encodeGrokSessionDir(GROK_CJK_CWD), GROK_CJK_GROUP);
    assert.equal(encodeGrokSessionDir(GROK_CWD), encodeURIComponent(GROK_CWD));

    const found = findGrokSessionFile(home, GROK_LONG_CWD, SESSION_A);
    assert.ok(found, "must locate the hashed group without scanning sessions/");
    assert.match(found, /chat_history\.jsonl$/);
    assert.equal(found.includes(GROK_LONG_GROUP), true);
    assert.equal(findGrokSessionFile(home, GROK_LONG_CWD, SESSION_B), null);

    const turns = readGrokSessionTurns(home, GROK_LONG_CWD, SESSION_A);
    assert.deepEqual(
      turns.map((t) => `${t.role}:${t.text}`),
      ["user:long cwd prompt", "assistant:long cwd reply"],
    );
  });
});

describe("listGrokSessions (#972)", () => {
  let home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grok-sessions-list-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("lists both chat_history files in mocked encoded-cwd dirs", () => {
    writeGrokSession(home, GROK_CWD, SESSION_A, [
      { type: "user", content: "prompt a" },
      { type: "assistant", content: "reply a" },
    ]);
    writeGrokSession(home, "/tmp/other-wt", SESSION_B, [
      { type: "user", content: "prompt b" },
      { type: "assistant", content: "reply b" },
    ]);

    const listed = listGrokSessions(home);
    assert.equal(listed.length, 2);
    const ids = listed.map((s) => s.sessionId).sort();
    assert.deepEqual(ids, [SESSION_A, SESSION_B].sort());
    for (const row of listed) {
      assert.equal(typeof row.mtimeMs, "number");
      assert.equal(Number.isFinite(row.mtimeMs), true);
    }
  });

  it("lists hashed long-cwd groups without requiring the original cwd", () => {
    writeGrokSessionAtGroup(home, GROK_LONG_GROUP, SESSION_A, [
      { type: "user", content: "long cwd prompt" },
    ]);

    const listed = listGrokSessions(home);
    assert.deepEqual(
      listed.map((s) => s.sessionId),
      [SESSION_A],
    );
  });

  it("does not list files outside sessions/ or unsafe session ids", () => {
    writeGrokSession(home, GROK_CWD, SESSION_A, [
      { type: "user", content: "prompt a" },
    ]);
    fs.writeFileSync(
      path.join(home, "chat_history.jsonl"),
      `${JSON.stringify({ type: "user", content: "outside" })}\n`,
    );
    fs.mkdirSync(path.join(home, "sessions", "evil", "../sessions"), {
      recursive: true,
    });
    const unsafeDir = path.join(home, "sessions", encodeURIComponent(GROK_CWD), "evil_id");
    fs.mkdirSync(unsafeDir, { recursive: true });
    fs.writeFileSync(
      path.join(unsafeDir, "chat_history.jsonl"),
      `${JSON.stringify({ type: "user", content: "unsafe id" })}\n`,
    );

    const listed = listGrokSessions(home);
    assert.deepEqual(
      listed.map((s) => s.sessionId),
      [SESSION_A],
    );
  });
});

describe("importGrokSession (#972)", () => {
  let home;
  let tmpDir;
  let store;
  let projectId;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grok-sessions-imp-"));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grok-sessions-store-"));
    store = new Store(path.join(tmpDir, "store.json"));
    projectId = "proj-import";
    store.setProjects([
      {
        id: projectId,
        slug: "demo",
        name: "demo",
        path: path.join(tmpDir, "demo"),
      },
    ]);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a grok thread whose transcript matches the parsed turns and ignores the sibling", () => {
    const fileA = writeGrokSession(home, GROK_CWD, SESSION_A, [
      { type: "user", content: "prompt a" },
      { type: "assistant", content: "reply a" },
    ]);
    writeGrokSession(home, "/tmp/other-wt", SESSION_B, [
      { type: "user", content: "prompt b" },
      { type: "assistant", content: "reply b" },
    ]);

    const expected = parseGrokChatHistory(fs.readFileSync(fileA, "utf8"));
    const thread = importGrokSession(store, {
      home,
      sessionId: SESSION_A,
      projectId,
    });

    assert.ok(thread && thread.id);
    assert.equal(thread.provider, "grok");
    assert.equal(thread.sessionId, SESSION_A);
    assert.equal(thread.projectId, projectId);
    assert.equal(thread.ejected, false);

    const messages = store.getMessages(thread.id);
    assert.deepEqual(
      messages.map((m) => `${m.role}:${m.text}`),
      expected.map((t) => `${t.role}:${t.text}`),
    );
    assert.deepEqual(
      messages.map((m) => `${m.role}:${m.text}`),
      ["user:prompt a", "assistant:reply a"],
    );
    assert.equal(
      messages.some((m) => m.text === "prompt b" || m.text === "reply b"),
      false,
    );
    assert.equal(store.getThreads().length, 1);
    assert.equal(
      fs.existsSync(fileA),
      true,
      "must not copy or consume the Grok store",
    );
  });

  it("re-importing the same grok sessionId does not mint a second thread", () => {
    writeGrokSession(home, GROK_CWD, SESSION_A, [
      { type: "user", content: "prompt a" },
      { type: "assistant", content: "reply a" },
    ]);
    const first = importGrokSession(store, {
      home,
      sessionId: SESSION_A,
      projectId,
    });
    const second = importGrokSession(store, {
      home,
      sessionId: SESSION_A,
      projectId,
    });
    assert.equal(second.id, first.id);
    assert.equal(store.getThreads().length, 1);
    assert.equal(store.getMessages(first.id).length, 2);
  });

  it("rejects a sessionId that is not a path-safe id", () => {
    writeGrokSession(home, GROK_CWD, SESSION_A, [
      { type: "user", content: "prompt a" },
    ]);
    assert.throws(
      () =>
        importGrokSession(store, {
          home,
          sessionId: "../sessions",
          projectId,
        }),
      /invalid/i,
    );
    assert.equal(store.getThreads().length, 0);
  });
});

const CURSOR_CWD = "/tmp/solenta-cursor-wt";

function cursorProjectDir(cwd) {
  return String(cwd)
    .replace(/^\//, "")
    .replace(/[^A-Za-z0-9]/g, "-");
}

function cursorUser(text) {
  return {
    role: "user",
    message: {
      content: [
        {
          type: "text",
          text: `<timestamp>Sunday, Sep 6, 2026, 12:00 PM (UTC+2)</timestamp>\n<user_query>\n${text}\n</user_query>`,
        },
      ],
    },
  };
}

function cursorAssistant(text) {
  return {
    role: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  };
}

function writeCursorSession(home, cwd, sessionId, records) {
  const dir = path.join(
    home,
    "projects",
    cursorProjectDir(cwd),
    "agent-transcripts",
    sessionId,
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return file;
}

describe("listCursorSessions (#975)", () => {
  let home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cursor-sessions-list-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("lists both jsonl files in mocked project agent-transcripts dirs", () => {
    writeCursorSession(home, CURSOR_CWD, SESSION_A, [
      cursorUser("prompt a"),
      cursorAssistant("reply a"),
    ]);
    writeCursorSession(home, "/tmp/other-wt", SESSION_B, [
      cursorUser("prompt b"),
      cursorAssistant("reply b"),
    ]);

    const listed = listCursorSessions(home);
    assert.equal(listed.length, 2);
    const ids = listed.map((s) => s.sessionId).sort();
    assert.deepEqual(ids, [SESSION_A, SESSION_B].sort());
    for (const row of listed) {
      assert.equal(typeof row.mtimeMs, "number");
      assert.equal(Number.isFinite(row.mtimeMs), true);
    }
  });

  it("does not list files outside projects/ or unsafe session ids", () => {
    writeCursorSession(home, CURSOR_CWD, SESSION_A, [
      cursorUser("prompt a"),
    ]);
    fs.writeFileSync(
      path.join(home, `${SESSION_B}.jsonl`),
      `${JSON.stringify(cursorUser("outside"))}\n`,
    );
    const chatsDir = path.join(home, "chats", "deadbeef", SESSION_B);
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(
      path.join(chatsDir, "meta.json"),
      JSON.stringify({ cwd: CURSOR_CWD }),
    );
    const unsafeDir = path.join(
      home,
      "projects",
      cursorProjectDir(CURSOR_CWD),
      "agent-transcripts",
      "evil_id",
    );
    fs.mkdirSync(unsafeDir, { recursive: true });
    fs.writeFileSync(
      path.join(unsafeDir, "evil_id.jsonl"),
      `${JSON.stringify(cursorUser("unsafe id"))}\n`,
    );

    const listed = listCursorSessions(home);
    assert.deepEqual(
      listed.map((s) => s.sessionId),
      [SESSION_A],
    );
  });
});

describe("importCursorSession (#975)", () => {
  let home;
  let tmpDir;
  let store;
  let projectId;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cursor-sessions-imp-"));
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "coder-cursor-sessions-store-"),
    );
    store = new Store(path.join(tmpDir, "store.json"));
    projectId = "proj-import";
    store.setProjects([
      {
        id: projectId,
        slug: "demo",
        name: "demo",
        path: path.join(tmpDir, "demo"),
      },
    ]);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a cursor thread whose transcript matches the parsed turns and ignores the sibling", () => {
    const fileA = writeCursorSession(home, CURSOR_CWD, SESSION_A, [
      cursorUser("prompt a"),
      cursorAssistant("reply a"),
      { type: "turn_ended", status: "success" },
    ]);
    writeCursorSession(home, "/tmp/other-wt", SESSION_B, [
      cursorUser("prompt b"),
      cursorAssistant("reply b"),
    ]);

    const expected = parseCursorJsonl(fs.readFileSync(fileA, "utf8"));
    const thread = importCursorSession(store, {
      home,
      sessionId: SESSION_A,
      projectId,
    });

    assert.ok(thread && thread.id);
    assert.equal(thread.provider, "cursor");
    assert.equal(thread.sessionId, SESSION_A);
    assert.equal(thread.projectId, projectId);
    assert.equal(thread.ejected, false);

    const messages = store.getMessages(thread.id);
    assert.deepEqual(
      messages.map((m) => `${m.role}:${m.text}`),
      expected.map((t) => `${t.role}:${t.text}`),
    );
    assert.deepEqual(
      messages.map((m) => `${m.role}:${m.text}`),
      ["user:prompt a", "assistant:reply a"],
    );
    assert.equal(
      messages.some((m) => m.text === "prompt b" || m.text === "reply b"),
      false,
    );
    assert.equal(store.getThreads().length, 1);
    assert.equal(
      fs.existsSync(fileA),
      true,
      "must not copy or consume the Cursor store",
    );
  });

  it("re-importing the same cursor sessionId does not mint a second thread", () => {
    writeCursorSession(home, CURSOR_CWD, SESSION_A, [
      cursorUser("prompt a"),
      cursorAssistant("reply a"),
    ]);
    const first = importCursorSession(store, {
      home,
      sessionId: SESSION_A,
      projectId,
    });
    const second = importCursorSession(store, {
      home,
      sessionId: SESSION_A,
      projectId,
    });
    assert.equal(second.id, first.id);
    assert.equal(store.getThreads().length, 1);
    assert.equal(store.getMessages(first.id).length, 2);
  });

  it("rejects a sessionId that is not a path-safe id", () => {
    writeCursorSession(home, CURSOR_CWD, SESSION_A, [
      cursorUser("prompt a"),
    ]);
    assert.throws(
      () =>
        importCursorSession(store, {
          home,
          sessionId: "../projects",
          projectId,
        }),
      /invalid/i,
    );
    assert.equal(store.getThreads().length, 0);
  });
});

const OC_A = "ses_aaaa1111ffffABCDEFGHijkl";
const OC_B = "ses_bbbb2222ffffABCDEFGHijkl";

function openCodeDbPath(home) {
  return path.join(home, "opencode.db");
}

function ensureOpenCodeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'p',
      slug TEXT NOT NULL DEFAULT '',
      directory TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      cost REAL NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
}

function writeOpenCodeSession(home, sessionId, turns, mtimeMs = Date.now()) {
  fs.mkdirSync(home, { recursive: true });
  const dbPath = openCodeDbPath(home);
  const db = new DatabaseSync(dbPath);
  ensureOpenCodeSchema(db);
  const title =
    (turns.find((t) => t.role === "user") || {}).text || sessionId;
  db.prepare(
    `INSERT OR REPLACE INTO session (
      id, project_id, slug, directory, title, version, time_created, time_updated
    ) VALUES (?, 'p', '', '', ?, '', ?, ?)`,
  ).run(sessionId, title, mtimeMs, mtimeMs);
  let i = 0;
  for (const turn of turns) {
    i += 1;
    const msgId = `msg_${sessionId}_${i}`;
    const t = Number(turn.createdAt) || mtimeMs + i;
    db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(msgId, sessionId, t, t, JSON.stringify({ role: turn.role }));
    const parts = [
      { type: "text", text: turn.text },
      ...(turn.extraParts || []),
    ];
    let p = 0;
    for (const part of parts) {
      p += 1;
      db.prepare(
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        `prt_${sessionId}_${i}_${p}`,
        msgId,
        sessionId,
        t + p,
        t + p,
        JSON.stringify(part),
      );
    }
  }
  db.close();
  return dbPath;
}

/**
 * Pre-1.14 OpenCode JSON tree:
 * storage/session/<projectID>/<sessionID>.json
 * storage/message/<sessionID>/<messageID>.json
 * storage/part/<messageID>/<partID>.json
 */
function writeOpenCodeJsonSession(
  home,
  sessionId,
  turns,
  mtimeMs = Date.now(),
  projectId = "proj_json",
) {
  const sessionDir = path.join(home, "storage", "session", projectId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `${sessionId}.json`);
  const title =
    (turns.find((t) => t.role === "user") || {}).text || sessionId;
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      id: sessionId,
      projectID: projectId,
      title,
      time: { created: mtimeMs, updated: mtimeMs },
    })}\n`,
  );
  const at = mtimeMs / 1000;
  fs.utimesSync(sessionFile, at, at);

  let i = 0;
  for (const turn of turns) {
    i += 1;
    const msgId = `msg_${sessionId}_${i}`;
    const t = Number(turn.createdAt) || mtimeMs + i;
    const msgDir = path.join(home, "storage", "message", sessionId);
    fs.mkdirSync(msgDir, { recursive: true });
    fs.writeFileSync(
      path.join(msgDir, `${msgId}.json`),
      `${JSON.stringify({
        id: msgId,
        sessionID: sessionId,
        role: turn.role,
        time: { created: t },
      })}\n`,
    );
    const parts = [
      { type: "text", text: turn.text },
      ...(turn.extraParts || []),
    ];
    let p = 0;
    for (const part of parts) {
      p += 1;
      const partId = `prt_${sessionId}_${i}_${p}`;
      const partDir = path.join(home, "storage", "part", msgId);
      fs.mkdirSync(partDir, { recursive: true });
      fs.writeFileSync(
        path.join(partDir, `${partId}.json`),
        `${JSON.stringify({
          id: partId,
          sessionID: sessionId,
          messageID: msgId,
          time: { created: t + p },
          ...part,
        })}\n`,
      );
    }
  }
  return sessionFile;
}

describe("listOpenCodeSessions (#976)", () => {
  let home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-opencode-sessions-list-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("lists both sessions in a mocked opencode.db", () => {
    writeOpenCodeSession(
      home,
      OC_A,
      [
        { role: "user", text: "prompt a" },
        { role: "assistant", text: "reply a" },
      ],
      2000,
    );
    writeOpenCodeSession(
      home,
      OC_B,
      [
        { role: "user", text: "prompt b" },
        { role: "assistant", text: "reply b" },
      ],
      1000,
    );

    const listed = listOpenCodeSessions(home);
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.map((s) => s.sessionId),
      [OC_A, OC_B],
    );
    for (const row of listed) {
      assert.equal(typeof row.mtimeMs, "number");
      assert.equal(Number.isFinite(row.mtimeMs), true);
    }
    assert.equal(listed[0].mtimeMs, 2000);
    assert.equal(listed[1].mtimeMs, 1000);
  });

  it("returns an empty list when opencode.db is missing", () => {
    assert.deepEqual(listOpenCodeSessions(home), []);
  });

  it("does not list files outside opencode.db or unsafe session ids", () => {
    writeOpenCodeSession(home, OC_A, [{ role: "user", text: "prompt a" }]);
    fs.mkdirSync(path.join(home, "storage", "session", "proj"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(home, "storage", "session", "proj", `${OC_B}.json`),
      JSON.stringify({ id: OC_B, title: "json leftover" }),
    );
    const db = new DatabaseSync(openCodeDbPath(home));
    db.prepare(
      `INSERT INTO session (
        id, project_id, slug, directory, title, version, time_created, time_updated
      ) VALUES (?, 'p', '', '', 'evil', '', 1, 1)`,
    ).run("../evil");
    db.close();

    const listed = listOpenCodeSessions(home);
    assert.deepEqual(
      listed.map((s) => s.sessionId),
      [OC_A],
    );
  });
});

describe("importOpenCodeSession (#976)", () => {
  let home;
  let tmpDir;
  let store;
  let projectId;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-opencode-sessions-imp-"));
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "coder-opencode-sessions-store-"),
    );
    store = new Store(path.join(tmpDir, "store.json"));
    projectId = "proj-import";
    store.setProjects([
      {
        id: projectId,
        slug: "demo",
        name: "demo",
        path: path.join(tmpDir, "demo"),
      },
    ]);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates an opencode thread whose transcript matches the parsed turns and ignores the sibling", () => {
    const dbPath = writeOpenCodeSession(home, OC_A, [
      { role: "user", text: "prompt a" },
      {
        role: "assistant",
        text: "reply a",
        extraParts: [
          { type: "step-start" },
          { type: "reasoning", text: "thinking" },
          { type: "tool", tool: "write" },
        ],
      },
    ]);
    writeOpenCodeSession(home, OC_B, [
      { role: "user", text: "prompt b" },
      { role: "assistant", text: "reply b" },
    ]);

    const expected = readOpenCodeImportTurns(home, OC_A);
    const thread = importOpenCodeSession(store, {
      home,
      sessionId: OC_A,
      projectId,
    });

    assert.ok(thread && thread.id);
    assert.equal(thread.provider, "opencode");
    assert.equal(thread.sessionId, OC_A);
    assert.equal(thread.projectId, projectId);
    assert.equal(thread.ejected, false);

    const messages = store.getMessages(thread.id);
    assert.deepEqual(
      messages.map((m) => `${m.role}:${m.text}`),
      expected.map((t) => `${t.role}:${t.text}`),
    );
    assert.deepEqual(
      messages.map((m) => `${m.role}:${m.text}`),
      ["user:prompt a", "assistant:reply a"],
    );
    assert.equal(
      messages.some((m) => m.text === "prompt b" || m.text === "reply b"),
      false,
    );
    assert.equal(
      messages.some((m) => m.text === "thinking"),
      false,
    );
    assert.equal(store.getThreads().length, 1);
    assert.equal(
      fs.existsSync(dbPath),
      true,
      "must not copy or consume the OpenCode store",
    );
    assert.equal(
      fs.existsSync(path.join(tmpDir, "opencode.db")),
      false,
      "must not copy opencode.db into the Solenta store dir",
    );
  });

  it("re-importing the same opencode sessionId does not mint a second thread", () => {
    writeOpenCodeSession(home, OC_A, [
      { role: "user", text: "prompt a" },
      { role: "assistant", text: "reply a" },
    ]);
    const first = importOpenCodeSession(store, {
      home,
      sessionId: OC_A,
      projectId,
    });
    const second = importOpenCodeSession(store, {
      home,
      sessionId: OC_A,
      projectId,
    });
    assert.equal(second.id, first.id);
    assert.equal(store.getThreads().length, 1);
    assert.equal(store.getMessages(first.id).length, 2);
  });

  it("rejects a sessionId that is not a path-safe id", () => {
    writeOpenCodeSession(home, OC_A, [{ role: "user", text: "prompt a" }]);
    assert.throws(
      () =>
        importOpenCodeSession(store, {
          home,
          sessionId: "../evil",
          projectId,
        }),
      /invalid/i,
    );
    assert.equal(store.getThreads().length, 0);
  });
});

describe("listOpenCodeSessions JSON fallback (#977)", () => {
  let home;

  beforeEach(() => {
    home = fs.mkdtempSync(
      path.join(os.tmpdir(), "coder-opencode-json-sessions-list-"),
    );
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("lists both sessions from a JSON-only home when opencode.db is missing", () => {
    writeOpenCodeJsonSession(
      home,
      OC_A,
      [
        { role: "user", text: "prompt a" },
        { role: "assistant", text: "reply a" },
      ],
      2000,
      "proj_a",
    );
    writeOpenCodeJsonSession(
      home,
      OC_B,
      [
        { role: "user", text: "prompt b" },
        { role: "assistant", text: "reply b" },
      ],
      1000,
      "proj_b",
    );

    assert.equal(fs.existsSync(openCodeDbPath(home)), false);

    const listed = listOpenCodeSessions(home);
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.map((s) => s.sessionId),
      [OC_A, OC_B],
    );
    assert.equal(listed[0].mtimeMs, 2000);
    assert.equal(listed[1].mtimeMs, 1000);
  });

  it("lists JSON sessions when opencode.db exists but has no session table", () => {
    writeOpenCodeJsonSession(
      home,
      OC_A,
      [{ role: "user", text: "prompt a" }],
      2000,
    );
    const db = new DatabaseSync(openCodeDbPath(home));
    db.exec("CREATE TABLE unrelated (id TEXT)");
    db.close();

    const listed = listOpenCodeSessions(home);
    assert.deepEqual(
      listed.map((s) => s.sessionId),
      [OC_A],
    );
  });

  it("does not list files outside storage/session or unsafe session ids", () => {
    writeOpenCodeJsonSession(home, OC_A, [{ role: "user", text: "prompt a" }]);
    fs.writeFileSync(
      path.join(home, `${OC_B}.json`),
      JSON.stringify({ id: OC_B, title: "outside storage" }),
    );
    fs.mkdirSync(path.join(home, "storage", "message", OC_B), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(home, "storage", "message", OC_B, "msg_1.json"),
      JSON.stringify({ id: "msg_1", role: "user" }),
    );
    fs.mkdirSync(path.join(home, "storage", "session", "proj"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(home, "storage", "session", "proj", "../evil.json"),
      JSON.stringify({ id: "../evil" }),
    );

    const listed = listOpenCodeSessions(home);
    assert.deepEqual(
      listed.map((s) => s.sessionId),
      [OC_A],
    );
  });
});

describe("importOpenCodeSession JSON fallback (#977)", () => {
  let home;
  let tmpDir;
  let store;
  let projectId;

  beforeEach(() => {
    home = fs.mkdtempSync(
      path.join(os.tmpdir(), "coder-opencode-json-sessions-imp-"),
    );
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "coder-opencode-json-sessions-store-"),
    );
    store = new Store(path.join(tmpDir, "store.json"));
    projectId = "proj-import";
    store.setProjects([
      {
        id: projectId,
        slug: "demo",
        name: "demo",
        path: path.join(tmpDir, "demo"),
      },
    ]);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates an opencode thread from JSON-only storage and does not copy the tree", () => {
    const fileA = writeOpenCodeJsonSession(home, OC_A, [
      { role: "user", text: "prompt a" },
      {
        role: "assistant",
        text: "reply a",
        extraParts: [
          { type: "step-start" },
          { type: "reasoning", text: "thinking" },
          { type: "tool", tool: "write" },
        ],
      },
    ]);
    writeOpenCodeJsonSession(
      home,
      OC_B,
      [
        { role: "user", text: "prompt b" },
        { role: "assistant", text: "reply b" },
      ],
      Date.now(),
      "proj_b",
    );

    assert.equal(fs.existsSync(openCodeDbPath(home)), false);

    const expected = readOpenCodeImportTurns(home, OC_A);
    const thread = importOpenCodeSession(store, {
      home,
      sessionId: OC_A,
      projectId,
    });

    assert.ok(thread && thread.id);
    assert.equal(thread.provider, "opencode");
    assert.equal(thread.sessionId, OC_A);
    assert.equal(thread.projectId, projectId);
    assert.equal(thread.ejected, false);

    const messages = store.getMessages(thread.id);
    assert.deepEqual(
      messages.map((m) => `${m.role}:${m.text}`),
      expected.map((t) => `${t.role}:${t.text}`),
    );
    assert.deepEqual(
      messages.map((m) => `${m.role}:${m.text}`),
      ["user:prompt a", "assistant:reply a"],
    );
    assert.equal(
      messages.some((m) => m.text === "prompt b" || m.text === "reply b"),
      false,
    );
    assert.equal(
      messages.some((m) => m.text === "thinking"),
      false,
    );
    assert.equal(store.getThreads().length, 1);
    assert.equal(
      fs.existsSync(fileA),
      true,
      "must not copy or consume the OpenCode JSON store",
    );
    assert.equal(
      fs.existsSync(path.join(tmpDir, "storage")),
      false,
      "must not copy storage/ into the Solenta store dir",
    );
  });

  it("re-importing the same JSON sessionId does not mint a second thread", () => {
    writeOpenCodeJsonSession(home, OC_A, [
      { role: "user", text: "prompt a" },
      { role: "assistant", text: "reply a" },
    ]);
    const first = importOpenCodeSession(store, {
      home,
      sessionId: OC_A,
      projectId,
    });
    const second = importOpenCodeSession(store, {
      home,
      sessionId: OC_A,
      projectId,
    });
    assert.equal(second.id, first.id);
    assert.equal(store.getThreads().length, 1);
    assert.equal(store.getMessages(first.id).length, 2);
  });
});
