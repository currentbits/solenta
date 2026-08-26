"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolveByteRange } = require("../artifact-range.js");

describe("resolveByteRange", () => {
  it("resolves full, explicit, open-ended, and suffix ranges", () => {
    assert.deepEqual(resolveByteRange(undefined, 100), {
      status: 200,
      start: 0,
      end: 99,
      length: 100,
    });
    assert.deepEqual(resolveByteRange("bytes=10-19", 100), {
      status: 206,
      start: 10,
      end: 19,
      length: 10,
    });
    assert.deepEqual(resolveByteRange("bytes=10-", 100), {
      status: 206,
      start: 10,
      end: 99,
      length: 90,
    });
    assert.deepEqual(resolveByteRange("bytes=-5", 100), {
      status: 206,
      start: 95,
      end: 99,
      length: 5,
    });
  });

  it("clamps explicit end to size - 1", () => {
    assert.deepEqual(resolveByteRange("bytes=50-200", 100), {
      status: 206,
      start: 50,
      end: 99,
      length: 50,
    });
  });

  it("rejects malformed, multiple, empty, and unsatisfiable ranges", () => {
    assert.deepEqual(resolveByteRange("bytes=200-300", 100), { status: 416 });
    assert.deepEqual(resolveByteRange("bytes=0-1,5-6", 100), { status: 416 });
    assert.deepEqual(resolveByteRange("invalid", 100), { status: 416 });
    assert.deepEqual(resolveByteRange("bytes=", 100), { status: 416 });
    assert.deepEqual(resolveByteRange("bytes=-", 100), { status: 416 });
    assert.deepEqual(resolveByteRange("bytes=10--20", 100), { status: 416 });
    assert.deepEqual(resolveByteRange("bytes=99-10", 100), { status: 416 });
    assert.deepEqual(resolveByteRange("bytes=100-", 100), { status: 416 });
  });
});
