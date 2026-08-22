"use strict";

/**
 * Cross-thread delivery contract (#551): hold-until-idle, inbound policy,
 * attributed prompt. Pure helpers — spawn-free.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  INBOUND_POLICIES,
  normalizeInboundPolicy,
  attributedPrompt,
  decideCrossThreadSend,
} = require("../crossThread.js");

describe("normalizeInboundPolicy", () => {
  it("defaults missing and junk to accept", () => {
    assert.equal(normalizeInboundPolicy(undefined), "accept");
    assert.equal(normalizeInboundPolicy(null), "accept");
    assert.equal(normalizeInboundPolicy(""), "accept");
    assert.equal(normalizeInboundPolicy("nope"), "accept");
  });

  it("accepts the three named policies", () => {
    assert.equal(normalizeInboundPolicy("accept"), "accept");
    assert.equal(normalizeInboundPolicy("queue-only"), "queue-only");
    assert.equal(normalizeInboundPolicy("refuse"), "refuse");
    assert.deepEqual(INBOUND_POLICIES, ["accept", "queue-only", "refuse"]);
  });
});

describe("attributedPrompt", () => {
  it("wraps the body with the sending thread's id and title", () => {
    assert.equal(
      attributedPrompt({ id: "t1", title: "Lead" }, "stop rewriting main"),
      '[from thread t1 ("Lead")]\nstop rewriting main',
    );
  });

  it("passes the body through when there is no sender", () => {
    assert.equal(attributedPrompt(null, "plain"), "plain");
    assert.equal(attributedPrompt({}, "plain"), "plain");
  });
});

describe("decideCrossThreadSend", () => {
  const idle = { id: "t2", status: "idle", archived: false };

  it("delivers immediately to an idle accepting thread", () => {
    assert.deepEqual(decideCrossThreadSend({ target: idle, running: false }), {
      outcome: "delivered",
      policy: "accept",
      unarchive: false,
      queue: false,
      start: true,
    });
  });

  it("queues on a running accepting thread (hold-until-idle)", () => {
    const out = decideCrossThreadSend({
      target: { ...idle, status: "working" },
      running: true,
    });
    assert.equal(out.outcome, "queued");
    assert.equal(out.queue, true);
    assert.equal(out.start, false);
  });

  it("queues without starting when the receiver is queue-only, even if idle", () => {
    const out = decideCrossThreadSend({
      target: { ...idle, crossThreadInbound: "queue-only" },
      running: false,
    });
    assert.equal(out.outcome, "queued");
    assert.equal(out.start, false);
    assert.equal(out.policy, "queue-only");
  });

  it("refuses when the receiver's inbound policy is refuse", () => {
    const out = decideCrossThreadSend({
      target: { ...idle, crossThreadInbound: "refuse" },
      running: false,
    });
    assert.equal(out.outcome, "refused");
    assert.equal(out.reason, "inbound refuse");
  });

  it("reports archived non-workers as undeliverable", () => {
    const out = decideCrossThreadSend({
      target: { ...idle, archived: true },
      running: false,
    });
    assert.equal(out.outcome, "undeliverable");
    assert.equal(out.reason, "archived");
  });

  it("unarchives an orchWorker so a re-dispatch can land", () => {
    const out = decideCrossThreadSend({
      target: { ...idle, archived: true, orchWorker: true },
      running: false,
    });
    assert.equal(out.outcome, "delivered");
    assert.equal(out.unarchive, true);
    assert.equal(out.start, true);
  });

  it("does not deliver to or from an unattended (automation) thread", () => {
    assert.equal(
      decideCrossThreadSend({
        target: idle,
        from: { id: "a1", automationId: "auto-1" },
        running: false,
      }).outcome,
      "undeliverable",
    );
    assert.equal(
      decideCrossThreadSend({
        target: { ...idle, automationId: "auto-1" },
        from: { id: "t1" },
        running: false,
      }).reason,
      "unattended receiver",
    );
  });
});
