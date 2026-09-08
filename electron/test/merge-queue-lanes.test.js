/**
 * #346 / #250 lane PORT contract. Isolation does not own PORT.
 *
 * Run: node --test electron/test/merge-queue-lanes.test.js
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { lanePort, laneEnv, DEFAULT_PORT_BASE } = require("../mergeQueue.js");

describe("merge queue laneEnv (#346)", () => {
  it("assigns PORT as portBase + lane number", () => {
    assert.equal(lanePort(1), DEFAULT_PORT_BASE + 1);
    assert.equal(lanePort(2, 5170), 5172);
    assert.throws(() => lanePort(0), /lane/i);
    assert.throws(() => lanePort(1, 0), /port/i);
    assert.deepEqual(laneEnv(3, 4000), {
      PORT: "4003",
      SOLENTA_LANE: "3",
    });
  });
});
