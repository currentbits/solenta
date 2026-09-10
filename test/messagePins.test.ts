/**
 * Issue #1217: bounded per-thread transcript bookmarks.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  THREAD_MESSAGE_PINS_MAX,
  THREAD_MESSAGE_PIN_EXCERPT_MAX,
  THREAD_MESSAGE_PIN_LABEL_MAX,
} from "../src/shared/ipc";
import {
  excerptFromText,
  isPinAvailable,
  labelMessagePin,
  normalizeMessagePins,
  pinDisplayText,
  pinMessage,
  pinsOf,
  unpinMessage,
} from "../src/messagePins";

describe("messagePins (issue #1217)", () => {
  it("legacy missing/invalid pins load as empty", () => {
    assert.deepEqual(normalizeMessagePins(undefined), []);
    assert.deepEqual(normalizeMessagePins(null), []);
    assert.deepEqual(normalizeMessagePins("nope"), []);
    assert.deepEqual(pinsOf({}), []);
    assert.deepEqual(pinsOf({ messagePins: undefined }), []);
  });

  it("drops invalid rows, dedupes by messageId, and caps count", () => {
    const rows = [];
    for (let i = 0; i < THREAD_MESSAGE_PINS_MAX + 5; i++) {
      rows.push({
        messageId: `m-${i}`,
        excerpt: `ex ${i}`,
        pinnedAt: i + 1,
      });
    }
    rows.push({ messageId: "m-0", excerpt: "dup", pinnedAt: 99 });
    rows.push({ messageId: "  ", excerpt: "blank" });
    rows.push({ excerpt: "no id" });
    const out = normalizeMessagePins(rows);
    assert.equal(out.length, THREAD_MESSAGE_PINS_MAX);
    assert.equal(out[0]!.messageId, "m-0");
    assert.equal(out[0]!.excerpt, "ex 0");
    assert.equal(out.at(-1)!.messageId, `m-${THREAD_MESSAGE_PINS_MAX - 1}`);
  });

  it("bounds excerpt and label length", () => {
    const long = "word ".repeat(80);
    const excerpt = excerptFromText(long);
    assert.ok(excerpt.length <= THREAD_MESSAGE_PIN_EXCERPT_MAX);
    const [pin] = normalizeMessagePins([
      {
        messageId: "m1",
        excerpt: long,
        label: "L".repeat(THREAD_MESSAGE_PIN_LABEL_MAX + 20),
        pinnedAt: 1,
      },
    ]);
    assert.ok(pin);
    assert.ok(pin.excerpt.length <= THREAD_MESSAGE_PIN_EXCERPT_MAX);
    assert.equal(pin.label?.length, THREAD_MESSAGE_PIN_LABEL_MAX);
  });

  it("pinning the same messageId does not duplicate", () => {
    const first = pinMessage([], { messageId: "m1", text: "hello", at: 1 });
    const again = pinMessage(first, { messageId: "m1", text: "hello more", at: 2 });
    assert.equal(again.length, 1);
    assert.equal(again[0]!.excerpt, "hello");
    assert.equal(again[0]!.pinnedAt, 1);
  });

  it("refuses a pin past the cap without dropping existing ones", () => {
    let pins = [];
    for (let i = 0; i < THREAD_MESSAGE_PINS_MAX; i++) {
      pins = pinMessage(pins, { messageId: `m-${i}`, text: `t${i}`, at: i });
    }
    const next = pinMessage(pins, { messageId: "overflow", text: "nope", at: 99 });
    assert.equal(next.length, THREAD_MESSAGE_PINS_MAX);
    assert.equal(
      next.some((p) => p.messageId === "overflow"),
      false,
    );
  });

  it("unpin and label keep identity; missing targets stay listed", () => {
    const pins = pinMessage([], { messageId: "gone", text: "decision", at: 1 });
    const labeled = labelMessagePin(pins, "gone", "  Keep this  ");
    assert.equal(labeled[0]!.label, "Keep this");
    assert.equal(pinDisplayText(labeled[0]!), "Keep this");
    assert.equal(isPinAvailable(labeled[0]!, new Set(["other"])), false);
    const cleared = labelMessagePin(labeled, "gone", "  ");
    assert.equal(cleared[0]!.label, undefined);
    assert.equal(pinDisplayText(cleared[0]!), "decision");
    assert.deepEqual(unpinMessage(cleared, "gone"), []);
  });
});
