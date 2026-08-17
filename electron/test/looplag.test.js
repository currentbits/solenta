const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { start, stop, snapshot, FLAG } = require("../looplag.js");

describe("looplag", () => {
  let prev;

  beforeEach(() => {
    prev = process.env[FLAG];
    delete process.env[FLAG];
    stop();
  });

  afterEach(() => {
    stop();
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  it("does nothing when CODER_LOOP_LAG is unset", () => {
    start();
    assert.equal(snapshot(), null);
  });

  it("does nothing when CODER_LOOP_LAG is not 1", () => {
    process.env[FLAG] = "0";
    start();
    assert.equal(snapshot(), null);
  });

  it("exposes mean/p50/p99/max in ms when enabled", () => {
    process.env[FLAG] = "1";
    start();
    const s = snapshot();
    assert.ok(s);
    for (const key of ["mean", "p50", "p99", "max"]) {
      assert.equal(typeof s[key], "number");
    }
  });

  it("stop() tears the histogram down", () => {
    process.env[FLAG] = "1";
    start();
    assert.ok(snapshot());
    stop();
    assert.equal(snapshot(), null);
  });
});
