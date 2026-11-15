const { it } = require("node:test");
const assert = require("node:assert/strict");
const { sequenceStateAfter, skipPartialSequence } = require("../terminalSequences.mjs");

it("discards cut CSI, OSC, DCS and intermediate escape sequences across chunks", () => {
  for (const [prefix, tail, end] of [
    ["\x1b[31", ";1", "mvisible"],
    ["\x1b]0;title", "more", "\x07visible"],
    ["\x1b]0;title", "\x1b", "\\visible"],
    ["\x1bP1;2", "payload\x1b", "\\visible"],
    ["\x1b(", "", "Bvisible"],
    ["\x1b(", "", "[visible"],
    ["\x9d0;title", "more", "\x9cvisible"],
  ]) {
    const state = sequenceStateAfter(0, prefix);
    assert.notEqual(state, 0);
    const first = skipPartialSequence(state, tail);
    assert.equal(first.text, "");
    assert.equal(skipPartialSequence(first.state, end).text, "visible");
  }
  assert.equal(skipPartialSequence(sequenceStateAfter(0, "\x1b]oops"), "\x18visible").text, "visible");
  assert.equal(skipPartialSequence(0, "\x1b[31mred").text, "\x1b[31mred");
});

it("retains trim state and persists only a safe replay suffix", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const terminal = require("../terminal.js");
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-ansi-"));
  let data;
  const pty = { spawn: () => ({ pid: 0, onData(cb) { data = cb; }, onExit() {} }) };
  try {
    terminal.open("ansi-trim", os.tmpdir(), { pty, logDir });
    data("\x1b]0;" + "x".repeat(terminal.CHAR_LIMIT + 10));
    const state = terminal.read("ansi-trim");
    assert.notEqual(state.sequenceState, 0);
    assert.equal(skipPartialSequence(state.sequenceState, state.text).text, "");
    data("\x07visible");
    assert.equal(terminal.read("ansi-trim", state.cursor).text, "\x07visible");
    terminal.killThread("ansi-trim");
    assert.equal(fs.readFileSync(path.join(logDir, "ansi-trim/1.log"), "utf8"), "visible");
    const restored = terminal.open("ansi-trim", os.tmpdir(), { pty, logDir });
    assert.equal(restored.sequenceState, 0);
    assert.match(restored.text, /^visible\x18/);
  } finally {
    terminal.killThread("ansi-trim");
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});
