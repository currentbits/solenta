const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  splitMessagesByThread,
  serializeMessages,
  stringifyStore,
  findThreadValue,
  peekLastAssistantValue,
  indexMessagesObject,
} = require("../jsonEnvelope.js");

describe("splitMessagesByThread", () => {
  it("replaces messagesByThread with {} and indexes each thread", () => {
    const doc = JSON.stringify({
      projects: [{ id: "p1" }],
      threads: [{ id: "t1", title: "one" }],
      messagesByThread: {
        t1: [
          { id: "m0", role: "user", text: "hi", createdAt: 1 },
          { id: "m1", role: "assistant", text: "hello", createdAt: 2 },
        ],
        t2: [{ id: "n0", role: "user", text: "other", createdAt: 3 }],
      },
      settings: { dailyBudgetUsd: 5 },
    });
    const split = splitMessagesByThread(doc);
    const envelope = JSON.parse(split.envelopeJson);
    assert.deepEqual(envelope.messagesByThread, {});
    assert.equal(envelope.threads[0].id, "t1");
    assert.equal(envelope.settings.dailyBudgetUsd, 5);
    assert.ok(split.raw && split.raw[0] === "{");
    const r1 = findThreadValue(split.raw, "t1");
    const r2 = findThreadValue(split.raw, "t2");
    assert.ok(r1 && r2);
    const t1 = JSON.parse(split.raw.slice(r1.start, r1.end));
    assert.equal(t1[1].text, "hello");
    assert.equal(peekLastAssistantValue(split.raw, r1.start, r1.end).text, "hello");
    assert.equal(peekLastAssistantValue(split.raw, r2.start, r2.end), null);
  });

  it("does not put transcript bytes in the envelope", () => {
    const canary = "CANARY_" + "x".repeat(2000);
    const doc = JSON.stringify({
      threads: [{ id: "t1" }],
      messagesByThread: {
        t1: [
          {
            id: "m0",
            role: "tool",
            tool: { name: "bash", input: canary },
            createdAt: 1,
          },
          { id: "m1", role: "assistant", text: "done", createdAt: 2 },
        ],
      },
    });
    const split = splitMessagesByThread(doc);
    assert.equal(split.envelopeJson.includes("CANARY_"), false);
    assert.equal(split.raw.includes(canary), true);
    const r = findThreadValue(split.raw, "t1");
    assert.equal(peekLastAssistantValue(split.raw, r.start, r.end).text, "done");
  });

  it("handles pretty-printed JSON and escaped quotes", () => {
    const doc = `{
  "threads": [{ "id": "t1", "title": "messagesByThread" }],
  "messagesByThread": {
    "t1": [
      { "id": "m0", "role": "tool", "tool": { "input": "say \\"hi\\" {not an object}" }, "createdAt": 1 },
      { "id": "m1", "role": "assistant", "text": "ok", "createdAt": 2 }
    ]
  },
  "settings": { "x": 1 }
}`;
    const split = splitMessagesByThread(doc);
    const envelope = JSON.parse(split.envelopeJson);
    assert.equal(envelope.threads[0].title, "messagesByThread");
    assert.deepEqual(envelope.messagesByThread, {});
    const r = findThreadValue(split.raw, "t1");
    const msgs = JSON.parse(split.raw.slice(r.start, r.end));
    assert.equal(msgs[0].tool.input, 'say "hi" {not an object}');
    assert.equal(peekLastAssistantValue(split.raw, r.start, r.end).text, "ok");
  });

  it("returns raw null when messagesByThread is missing or not an object", () => {
    const missing = splitMessagesByThread(JSON.stringify({ threads: [] }));
    assert.equal(missing.raw, null);
    const nulled = splitMessagesByThread(
      JSON.stringify({ messagesByThread: null, threads: [] }),
    );
    assert.equal(nulled.raw, null);
    assert.deepEqual(JSON.parse(nulled.envelopeJson).messagesByThread, {});
  });

  it("keeps messagesByThread as the last key without a tail scan", () => {
    const doc = JSON.stringify({
      threads: [{ id: "t1" }],
      settings: { dailyBudgetUsd: 9 },
      messagesByThread: {
        t1: [{ id: "m0", role: "assistant", text: "tail", createdAt: 1 }],
      },
    });
    const split = splitMessagesByThread(doc);
    const envelope = JSON.parse(split.envelopeJson);
    assert.equal(envelope.settings.dailyBudgetUsd, 9);
    assert.deepEqual(envelope.messagesByThread, {});
    const r = findThreadValue(split.raw, "t1");
    assert.equal(peekLastAssistantValue(split.raw, r.start, r.end).text, "tail");
  });

  it("throws on malformed JSON so the caller can fall back", () => {
    assert.throws(() => splitMessagesByThread("{not json"), SyntaxError);
    assert.throws(() => splitMessagesByThread("[1,2]"), /store root must be an object/);
  });
});

describe("serializeMessages / stringifyStore", () => {
  it("reuses the original slice when nothing was hydrated", () => {
    const doc = JSON.stringify({
      threads: [{ id: "t1" }],
      messagesByThread: { t1: [{ id: "m0", role: "user", text: "a" }] },
    });
    const split = splitMessagesByThread(doc);
    const lazy = { raw: split.raw, ranges: split.ranges, intact: true };
    assert.equal(serializeMessages({}, lazy), split.raw);
    const out = JSON.parse(stringifyStore({ threads: [{ id: "t1" }], settings: { n: 1 } }, {}, lazy));
    assert.equal(out.settings.n, 1);
    assert.equal(out.messagesByThread.t1[0].text, "a");
  });

  it("stringifies a hydrated thread and splices the rest from raw", () => {
    const doc = JSON.stringify({
      messagesByThread: {
        t1: [{ id: "m0", role: "user", text: "old" }],
        t2: [{ id: "n0", role: "user", text: "keep" }],
      },
    });
    const split = splitMessagesByThread(doc);
    const indexed = indexMessagesObject(split.raw);
    const lazy = { raw: split.raw, ranges: indexed.ranges, intact: false };
    lazy.ranges.delete("t1");
    const json = serializeMessages(
      { t1: [{ id: "m0", role: "user", text: "new" }] },
      lazy,
    );
    const parsed = JSON.parse(json);
    assert.equal(parsed.t1[0].text, "new");
    assert.equal(parsed.t2[0].text, "keep");
  });

  it("omits a deleted thread and includes a newly added one", () => {
    const doc = JSON.stringify({
      messagesByThread: {
        gone: [{ id: "g", role: "user", text: "x" }],
        stay: [{ id: "s", role: "user", text: "y" }],
      },
    });
    const split = splitMessagesByThread(doc);
    const indexed = indexMessagesObject(split.raw);
    const lazy = { raw: split.raw, ranges: indexed.ranges, intact: false };
    lazy.ranges.delete("gone");
    const parsed = JSON.parse(
      serializeMessages({ stay: [{ id: "s", role: "user", text: "y" }], fresh: [] }, lazy),
    );
    assert.equal("gone" in parsed, false);
    assert.deepEqual(parsed.fresh, []);
    assert.equal(parsed.stay[0].text, "y");
  });
});
