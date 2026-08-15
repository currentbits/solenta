const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { shouldNotify } = require("../notify.js");

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
