const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { runJsonLines, SIGKILL_AFTER_MS } = require("../agent.js");

/** Run a node -e script through runJsonLines; resolves with events + exits. */
function run(script, extra = {}) {
  return new Promise((resolve) => {
    const events = [];
    const exits = [];
    const errors = [];
    const handle = runJsonLines({
      binary: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      onEvent: (ev) => {
        events.push(ev);
        if (extra.onEvent) extra.onEvent(ev, handle);
      },
      onError: (err) => errors.push(err),
      onExit: (info) => {
        exits.push(info);
        // Let a second error/close settle so a double finish would show.
        setTimeout(() => resolve({ events, exits, errors, handle }), 50);
      },
      ...extra.opts,
    });
    if (extra.afterSpawn) extra.afterSpawn(handle);
  });
}

describe("runJsonLines", () => {
  it("parses lines across chunks, skips non-JSON, flushes the partial last line", async () => {
    const script = [
      "process.stdout.write('{\"a\":1}\\nnot json\\n42\\n\\n{\"b\":');",
      "setTimeout(()=>process.stdout.write('2}\\n{\"c\":3}'),30);",
    ].join("");
    const { events, exits } = await run(script, { opts: { keepStdout: true } });
    assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { c: 3 }]);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].code, 0);
    assert.equal(exits[0].gotJson, true);
    assert.equal(
      exits[0].fullStdout,
      '{"a":1}\nnot json\n42\n\n{"b":2}\n{"c":3}',
    );
  });

  it("leaves fullStdout empty unless keepStdout, and keeps the stderr tail", async () => {
    const script =
      "process.stderr.write('boom');process.stdout.write('plain\\n');process.exit(3)";
    const { events, exits } = await run(script);
    assert.deepEqual(events, []);
    assert.deepEqual(exits, [
      { code: 3, stderr: "boom", fullStdout: "", gotJson: false },
    ]);
  });

  it("keeps parsing when onEvent throws", async () => {
    const script = "process.stdout.write('{\"n\":1}\\n{\"n\":2}\\n')";
    const { events } = await run(script, {
      onEvent: () => {
        throw new Error("consumer bug");
      },
    });
    assert.deepEqual(events, [{ n: 1 }, { n: 2 }]);
  });

  it("finishes once for a missing binary (error + close)", async () => {
    const { exits, errors, handle } = await run("", {
      opts: { binary: "/nonexistent/solenta-json-lines-bin" },
    });
    assert.equal(errors.length, 1);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].code, 1);
    assert.equal(handle.isFinished(), true);
    handle.kill(); // no-op after finish
  });

  it("escalates kill to SIGKILL when the child ignores SIGTERM", async () => {
    const script =
      "process.on('SIGTERM',()=>{});process.stdout.write('{\"ready\":true}\\n');setInterval(()=>{},1000)";
    let killedAt = 0;
    const { exits } = await run(script, {
      onEvent: (ev, handle) => {
        if (!ev.ready) return;
        killedAt = Date.now();
        handle.kill();
        handle.kill(); // second call must not re-arm the timer
      },
    });
    const elapsed = Date.now() - killedAt;
    assert.equal(exits.length, 1);
    assert.equal(exits[0].code, null);
    assert.ok(elapsed >= SIGKILL_AFTER_MS - 100, `killed after ${elapsed}ms`);
  });
});
