"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const terminal = require("../terminal.js");

after(() => terminal.killAll());

/**
 * Wait until the session's committed output satisfies `done`, or give up.
 *
 * @param {string} threadId
 * @param {(text: string) => boolean} done
 */
async function waitFor(threadId, done) {
  for (let i = 0; i < 100; i++) {
    const state = terminal.read(threadId, 0);
    if (done(state.text)) return state;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `timed out; saw ${JSON.stringify(terminal.read(threadId, 0).text)}`,
  );
}

describe("terminal sessions", () => {
  it("runs a command and streams its output", async (t) => {
    if (process.platform === "win32") return t.skip("POSIX shell only");
    const id = "t-run";
    const opened = terminal.open(id, os.tmpdir());
    assert.equal(opened.running, true);
    assert.equal(opened.cursor, 0);

    terminal.write(id, "echo alpha");
    const state = await waitFor(id, (text) => text.includes("alpha"));
    assert.match(state.text, /^\$ echo alpha\n/, "the command is echoed first");
    assert.match(state.text, /\balpha\b/);
    terminal.close(id);
  });

  it("keeps shell state between commands", async (t) => {
    if (process.platform === "win32") return t.skip("POSIX shell only");
    const id = "t-state";
    terminal.open(id, os.tmpdir());
    terminal.write(id, "FOO=bar");
    terminal.write(id, "echo v=$FOO");
    // ^v=bar$ on its own line: the echoed command also contains "v=$FOO".
    const state = await waitFor(id, (text) => /^v=bar$/m.test(text));
    assert.match(state.text, /^v=bar$/m, "one long-lived shell, not per-command");
    terminal.close(id);
  });

  it("returns only the delta past a cursor", async (t) => {
    if (process.platform === "win32") return t.skip("POSIX shell only");
    const id = "t-cursor";
    terminal.open(id, os.tmpdir());
    terminal.write(id, "echo one");
    const first = await waitFor(id, (text) => text.includes("one"));
    terminal.write(id, "echo two", first.cursor);
    const second = await waitFor(id, (text) => text.includes("two"));

    const delta = terminal.read(id, first.cursor);
    assert.equal(delta.reset, false);
    assert.equal(delta.text.includes("one"), false, "no replay of old output");
    assert.match(delta.text, /two/);
    assert.equal(delta.cursor, second.cursor);
    terminal.close(id);
  });

  it("replays everything for a stale or missing cursor", async (t) => {
    if (process.platform === "win32") return t.skip("POSIX shell only");
    const id = "t-reset";
    terminal.open(id, os.tmpdir());
    terminal.write(id, "echo gamma");
    await waitFor(id, (text) => text.includes("gamma"));

    const fresh = terminal.read(id, null);
    assert.equal(fresh.reset, true);
    assert.match(fresh.text, /gamma/);
    // A cursor past the end is a different thread's offset, not a delta.
    assert.equal(terminal.read(id, 1e9).reset, true);
    terminal.close(id);
  });

  it("re-attaches instead of spawning a second shell", async (t) => {
    if (process.platform === "win32") return t.skip("POSIX shell only");
    const id = "t-attach";
    terminal.open(id, os.tmpdir());
    terminal.write(id, "echo delta");
    await waitFor(id, (text) => text.includes("delta"));
    const again = terminal.open(id, os.tmpdir());
    assert.equal(again.reset, true);
    assert.match(again.text, /delta/, "scrollback survives a re-open");
    terminal.close(id);
  });

  it("close kills the session and forgets its scrollback", async (t) => {
    if (process.platform === "win32") return t.skip("POSIX shell only");
    const id = "t-close";
    terminal.open(id, os.tmpdir());
    terminal.write(id, "echo epsilon");
    await waitFor(id, (text) => text.includes("epsilon"));
    terminal.close(id);
    const after = terminal.read(id, 0);
    assert.equal(after.running, false);
    assert.equal(after.text, "");
  });

  it("strips ANSI and collapses \\r rewrites", async (t) => {
    if (process.platform === "win32") return t.skip("POSIX shell only");
    const id = "t-ansi";
    terminal.open(id, os.tmpdir());
    // 50%-then-100% progress bar, coloured: only the last rewrite survives.
    terminal.write(id, "printf '\\033[32m50%%\\r100%% done\\033[0m\\n'");
    const state = await waitFor(id, (text) => /^100% done$/m.test(text));
    // Assert on the OUTPUT lines; the echoed command still shows the source.
    const out = state.text.split("\n").slice(1).join("\n");
    assert.equal(out.includes("\u001B"), false, "no escape sequences");
    assert.equal(out.includes("50%"), false, "overwritten text is gone");
    assert.match(out, /^100% done$/m);
    terminal.close(id);
  });

  it("reports a write to a dead session instead of throwing", () => {
    const id = "t-dead";
    const state = terminal.write(id, "echo nope");
    assert.equal(state.running, false);
    assert.equal(state.text, "", "no session, no scrollback");
  });
});
