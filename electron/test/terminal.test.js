"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const terminal = require("../terminal.js");

after(() => terminal.killAll());

const POSIX = process.platform !== "win32";
const ENV = { ...process.env, SHELL: "/bin/sh", PS1: "$ " };

/**
 * Wait until the session's output satisfies `done`, or give up.
 *
 * @param {string} threadId
 * @param {(text: string) => boolean} done
 * @param {string} [termId]
 */
async function waitFor(threadId, done, termId) {
  for (let i = 0; i < 200; i++) {
    const state = terminal.read(threadId, null, termId);
    if (done(state.text)) return state;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `timed out; saw ${JSON.stringify(terminal.read(threadId, null, termId).text)}`,
  );
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("terminal PTY sessions", () => {
  const skip = !POSIX ? "POSIX shell only" : !terminal.ptyAvailable() ? "node-pty unavailable" : false;

  it("spawns a real tty at the requested size, and resize reaches it", { skip }, async () => {
    const id = "pty-size";
    const opened = terminal.open(id, os.tmpdir(), { env: ENV, cols: 91, rows: 17 });
    assert.equal(opened.running, true);
    assert.equal(opened.pty, true);
    terminal.write(id, "stty size; tty\r");
    await waitFor(id, (t) => /17 91/.test(t) && /\/dev\//.test(t));
    assert.deepEqual(terminal.resize(id, 120, 40), { ok: true });
    terminal.write(id, "stty size\r");
    await waitFor(id, (t) => /40 120/.test(t));
    terminal.close(id);
  });

  it("Ctrl-C interrupts the foreground command and keeps the shell", { skip }, async () => {
    const id = "pty-intr";
    terminal.open(id, os.tmpdir(), { env: ENV });
    terminal.write(id, "X=kept; sleep 30\r");
    await new Promise((r) => setTimeout(r, 300));
    terminal.write(id, "\x03");
    terminal.write(id, "echo still-$X\r");
    await waitFor(id, (t) => /still-kept/.test(t));
    assert.equal(terminal.read(id).running, true);
    terminal.close(id);
  });

  it("close kills the shell process", { skip }, async () => {
    const id = "pty-kill";
    const pidFile = path.join(os.tmpdir(), `solenta-pty-kill-${process.pid}`);
    terminal.open(id, os.tmpdir(), { env: ENV });
    terminal.write(id, `echo $$ > ${pidFile}\r`);
    await waitFor(id, () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    fs.rmSync(pidFile, { force: true });
    assert.equal(alive(pid), true);
    terminal.close(id);
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 30));
    assert.equal(alive(pid), false);
    assert.equal(terminal.read(id).running, false);
  });
});

describe("terminal pipe fallback", () => {
  const skip = POSIX ? false : "POSIX shell only";

  it("echoes keystrokes, edits the line, and runs it on Enter", { skip }, async () => {
    const id = "pipe-cooked";
    const opened = terminal.open(id, os.tmpdir(), { env: ENV, pty: null });
    assert.equal(opened.pty, false);
    terminal.write(id, "echo alphx\x7fa\r");
    const state = await waitFor(id, (t) => /\r\nalpha\r\n/.test(t));
    assert.match(state.text, /^echo alphx\x08 \x08a\r\n/, "echo + backspace rendered");
    terminal.close(id);
  });

  it("keeps shell state between commands", { skip }, async () => {
    const id = "pipe-state";
    terminal.open(id, os.tmpdir(), { env: ENV, pty: null });
    terminal.write(id, "FOO=bar\recho v=$FOO\r");
    await waitFor(id, (t) => /^v=bar\r$/m.test(t));
    terminal.close(id);
  });
});

describe("terminal sessions", () => {
  const skip = POSIX ? false : "POSIX shell only";

  it("returns only the delta past a cursor and replays a stale one", { skip }, async () => {
    const id = "t-cursor";
    terminal.open(id, os.tmpdir(), { env: ENV, pty: null });
    terminal.write(id, "echo one\r");
    const first = await waitFor(id, (t) => /\r\none\r\n/.test(t));
    terminal.write(id, "echo two\r");
    await waitFor(id, (t) => /\r\ntwo\r\n/.test(t));
    const delta = terminal.read(id, first.cursor);
    assert.equal(delta.reset, false);
    assert.doesNotMatch(delta.text, /one/);
    assert.match(delta.text, /two/);
    const fresh = terminal.read(id, 10 ** 9);
    assert.equal(fresh.reset, true);
    assert.match(fresh.text, /one[\s\S]*two/);
    terminal.close(id);
  });

  it("keeps several independent terminals per thread", { skip }, async () => {
    const id = "t-split";
    terminal.open(id, os.tmpdir(), { env: ENV, pty: null });
    terminal.open(id, os.tmpdir(), { env: ENV, pty: null, termId: "2" });
    terminal.write(id, "echo left\r");
    terminal.write(id, "echo right\r", "2");
    await waitFor(id, (t) => /\r\nleft\r\n/.test(t));
    const right = await waitFor(id, (t) => /\r\nright\r\n/.test(t), "2");
    assert.doesNotMatch(right.text, /left/);
    assert.deepEqual(terminal.list(id), ["1", "2"]);
    assert.equal(terminal.listLive().filter((t) => t === id).length, 2);
    terminal.close(id, "2");
    assert.deepEqual(terminal.list(id), ["1"]);
    terminal.close(id);
  });

  it("re-attaches instead of spawning a second shell, flagging a moved root", { skip }, () => {
    const id = "t-reattach";
    const a = terminal.open(id, os.tmpdir(), { env: ENV, pty: null });
    const b = terminal.open(id, os.tmpdir(), { env: ENV, pty: null });
    assert.equal(b.startedAt, a.startedAt);
    assert.equal(b.staleRoot, false);
    const moved = terminal.open(id, "/somewhere/else", { env: ENV, pty: null });
    assert.equal(moved.startedAt, a.startedAt, "a running shell is not killed");
    assert.equal(moved.staleRoot, true);
    assert.equal(moved.cwd, os.tmpdir());
    terminal.close(id);
  });

  it("caps scrollback at LINE_LIMIT lines", { skip }, async () => {
    const id = "t-cap";
    terminal.open(id, os.tmpdir(), { env: ENV, pty: null });
    terminal.write(id, "seq 1 8000\r");
    const state = await waitFor(id, (t) => /\r\n8000\r\n/.test(t));
    const lines = state.text.split("\n").length - 1;
    assert.ok(lines <= terminal.LINE_LIMIT + 500, `kept ${lines} lines`);
    assert.doesNotMatch(state.text, /^1\r$/m, "oldest lines dropped");
    assert.ok(state.cursor > state.text.length, "cursor stays absolute");
    terminal.close(id);
  });

  it("pushes batched output with absolute offsets", { skip }, async () => {
    const id = "t-push";
    /** @type {any[]} */
    const pushes = [];
    terminal.open(id, os.tmpdir(), {
      env: ENV,
      pty: null,
      broadcast: (channel, payload) => pushes.push({ channel, ...(/** @type {object} */ (payload)) }),
    });
    terminal.write(id, "echo pushed\r");
    await waitFor(id, (t) => /\r\npushed\r\n/.test(t));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(pushes.length >= 1);
    assert.equal(pushes[0].channel, "terminal:data");
    assert.equal(pushes[0].threadId, id);
    assert.equal(pushes[0].termId, "1");
    assert.equal(pushes[0].from, 0);
    let joined = "";
    for (const p of pushes) {
      assert.equal(p.from, joined.length, "pushes are contiguous");
      joined += p.data;
    }
    assert.equal(joined, terminal.read(id).text);
    terminal.close(id);
  });

  it("flushes scrollback to disk on quit and replays it on the next open", { skip }, async () => {
    const id = "t-persist";
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-term-"));
    try {
      terminal.open(id, os.tmpdir(), { env: ENV, pty: null, logDir, termId: "3" });
      terminal.write(id, "echo remembered\r", "3");
      await waitFor(id, (t) => /\r\nremembered\r\n/.test(t), "3");
      terminal.killAll();
      const file = path.join(logDir, id, "3.log");
      assert.match(fs.readFileSync(file, "utf8"), /remembered/);
      assert.deepEqual(terminal.list(id, logDir), ["3"], "listed after restart");

      const reopened = terminal.open(id, os.tmpdir(), { env: ENV, pty: null, logDir, termId: "3" });
      assert.equal(reopened.running, true, "a fresh shell");
      assert.match(reopened.text, /remembered[\s\S]*restored output/);

      terminal.close(id, "3");
      assert.equal(fs.existsSync(file), false, "close forgets the scrollback");
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("terminal restarts", () => {
  const skip = POSIX ? false : "POSIX shell only";

  it("carries an exited shell's scrollback into its replacement", { skip }, async () => {
    const id = "t-exit";
    terminal.open(id, os.tmpdir(), { env: ENV, pty: null });
    terminal.write(id, "echo before; exit 3\r");
    await waitFor(id, (t) => /exited \(3\)/.test(t));
    const again = terminal.open(id, os.tmpdir(), { env: ENV, pty: null });
    assert.equal(again.running, true);
    assert.match(again.text, /before[\s\S]*exited \(3\)[\s\S]*restored output/);
    terminal.close(id);
  });

  it("does not resurrect a closed terminal's log from a pending flush", { skip }, async () => {
    const id = "t-flush";
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-term-"));
    try {
      terminal.open(id, os.tmpdir(), { env: ENV, pty: null, logDir });
      terminal.write(id, "echo x\r");
      await waitFor(id, (t) => /\r\nx\r\n/.test(t));
      terminal.close(id);
      await new Promise((r) => setTimeout(r, 1300));
      assert.equal(fs.existsSync(path.join(logDir, id, "1.log")), false);
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("terminal thread deletion (#1183)", () => {
  const skip = POSIX ? false : "POSIX shell only";

  it("killThread ends only that thread's shells and keeps their scrollback", { skip }, async () => {
    const id = "t-del";
    const other = "t-del-other";
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-term-"));
    try {
      terminal.open(id, os.tmpdir(), { env: ENV, pty: null, logDir });
      terminal.open(id, os.tmpdir(), { env: ENV, pty: null, logDir, termId: "2" });
      terminal.open(other, os.tmpdir(), { env: ENV, pty: null, logDir });
      terminal.write(id, "echo kept-on-trash\r");
      await waitFor(id, (t) => /\r\nkept-on-trash\r\n/.test(t));

      terminal.killThread(id);
      assert.equal(terminal.listLive().includes(id), false);
      assert.equal(terminal.read(id).running, false);
      assert.equal(terminal.read(other).running, true, "other thread untouched");
      assert.match(fs.readFileSync(path.join(logDir, id, "1.log"), "utf8"), /kept-on-trash/);
      assert.deepEqual(terminal.list(id, logDir), ["1", "2"]);

      const reopened = terminal.open(id, os.tmpdir(), { env: ENV, pty: null, logDir });
      assert.match(reopened.text, /kept-on-trash[\s\S]*restored output/);
    } finally {
      terminal.close(id);
      terminal.close(id, "2");
      terminal.close(other);
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("purgeThread ends its shells and deletes all its scrollback", { skip }, async () => {
    const id = "t-purge";
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-term-"));
    try {
      // A log left by an earlier app run, with no live session behind it.
      fs.mkdirSync(path.join(logDir, id));
      fs.writeFileSync(path.join(logDir, id, "7.log"), "old run\n");
      fs.writeFileSync(path.join(logDir, "keep.txt"), "");
      terminal.open(id, os.tmpdir(), { env: ENV, pty: null, logDir });
      terminal.write(id, "echo bye\r");
      await waitFor(id, (t) => /\r\nbye\r\n/.test(t));

      terminal.purgeThread(id, logDir);
      assert.equal(terminal.listLive().includes(id), false);
      assert.equal(fs.existsSync(path.join(logDir, id)), false);
      assert.deepEqual(terminal.list(id, logDir), []);
      assert.equal(fs.existsSync(path.join(logDir, "keep.txt")), true, "siblings untouched");
      await new Promise((r) => setTimeout(r, 1300));
      assert.equal(fs.existsSync(path.join(logDir, id, "1.log")), false, "no flush resurrects it");
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("terminal safety", () => {
  it("never runs an SSH project's shell locally", () => {
    let spawned = false;
    const state = terminal.open("t-remote", "/remote/path", {
      pty: null,
      spawn: /** @type {any} */ (() => {
        spawned = true;
      }),
      project: { remoteHost: "box", path: "/remote/path" },
    });
    assert.equal(spawned, false);
    assert.equal(state.running, false);
    assert.match(state.text, /not available for SSH/);
    terminal.close("t-remote");
  });

  it("rejects terminal ids that could escape the log directory", () => {
    assert.throws(() => terminal.open("t-bad", os.tmpdir(), { termId: "../x" }), /Invalid terminal id/);
    assert.throws(() => terminal.close("t-bad", "a/b"), /Invalid terminal id/);
  });

  it("reports a write to a missing or dead session instead of throwing", () => {
    assert.deepEqual(terminal.write("t-none", "ls\r"), { ok: false });
    assert.deepEqual(terminal.resize("t-none", 80, 24), { ok: false });
    assert.equal(terminal.read("t-none").running, false);
  });
});
