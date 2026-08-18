const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { shouldNotify, isEffectivelySnoozed } = require("../notify.js");

describe("shouldNotify", () => {
  it("notifies working -> done when the window is not focused", () => {
    assert.equal(shouldNotify("working", "done", false), true);
  });

  it("notifies working -> failed when the window is not focused", () => {
    assert.equal(shouldNotify("working", "failed", false), true);
  });

  it("never notifies while the window is focused", () => {
    assert.equal(shouldNotify("working", "done", true), false);
    assert.equal(shouldNotify("working", "failed", true), false);
  });

  it("notifies working -> waiting: a run blocked on a prompt is a stall", () => {
    assert.equal(shouldNotify("working", "waiting", false), true);
    assert.equal(shouldNotify("working", "waiting", true), false);
    // One prompt, one notification.
    assert.equal(shouldNotify("waiting", "waiting", false), false);
  });

  it("still notifies once the answered run settles", () => {
    assert.equal(shouldNotify("waiting", "working", false), false);
    assert.equal(shouldNotify("waiting", "done", false), true);
    assert.equal(shouldNotify("waiting", "failed", false), true);
  });

  it("notifies a background failure with no live run (issue #34)", () => {
    // Budget-gated orchestrator wake-up: the thread was idle/done, not working.
    assert.equal(shouldNotify("done", "failed", false), true);
    assert.equal(shouldNotify("idle", "failed", false), true);
    assert.equal(shouldNotify("done", "failed", true), false);
    // One failure, one notification.
    assert.equal(shouldNotify("failed", "failed", false), false);
  });

  it("does not notify other status transitions", () => {
    assert.equal(shouldNotify("working", "working", false), false);
    assert.equal(shouldNotify("working", "idle", false), false);
    assert.equal(shouldNotify("idle", "working", false), false);
    assert.equal(shouldNotify("idle", "done", false), false);
    assert.equal(shouldNotify("done", "done", false), false);
    assert.equal(shouldNotify("failed", "done", false), false);
    assert.equal(shouldNotify(undefined, "done", false), false);
    assert.equal(shouldNotify(null, "failed", false), false);
  });
});

describe("isEffectivelySnoozed", () => {
  const NOW = 1_700_000_000_000;

  it("future until is snoozed; past until is not", () => {
    assert.equal(
      isEffectivelySnoozed(
        { snoozedUntil: NOW + 1000, snoozedAt: NOW - 100, status: "idle", updatedAt: NOW - 200 },
        NOW,
      ),
      true,
    );
    assert.equal(
      isEffectivelySnoozed(
        { snoozedUntil: NOW - 1, snoozedAt: NOW - 1000, status: "idle", updatedAt: NOW - 200 },
        NOW,
      ),
      false,
    );
  });

  it("raised-hand completion or awaitingInput is not snoozed", () => {
    assert.equal(
      isEffectivelySnoozed(
        {
          snoozedUntil: NOW + 10_000,
          snoozedAt: NOW - 5000,
          status: "done",
          updatedAt: NOW - 100,
        },
        NOW,
      ),
      false,
    );
    assert.equal(
      isEffectivelySnoozed(
        {
          snoozedUntil: NOW + 10_000,
          snoozedAt: NOW - 100,
          status: "working",
          updatedAt: NOW - 200,
          awaitingInput: true,
        },
        NOW,
      ),
      false,
    );
  });

  it("null / missing thread is never snoozed", () => {
    assert.equal(isEffectivelySnoozed(null, NOW), false);
    assert.equal(isEffectivelySnoozed({}, NOW), false);
  });
});
