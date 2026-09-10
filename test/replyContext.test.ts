import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REPLY_QUOTE_CAP,
  excerptReply,
  makeReplyTarget,
  replySourceUnavailable,
  wrapReplyContext,
} from "../src/replyContext.ts";
import { waitWhatPrompt } from "../src/waitWhat.ts";
import { createDoubleOptionTracker, isOptionKey } from "../src/appsnapHotkey.ts";
import { repoRelativeDir } from "../src/mention.ts";

describe("reply-as-context", () => {
  it("excerpts whitespace-collapsed text", () => {
    assert.equal(excerptReply("hello   world"), "hello world");
    assert.equal(excerptReply("x".repeat(200)).length, 140);
    assert.ok(excerptReply("x".repeat(200)).endsWith("…"));
  });

  it("wraps the quote in a bounded block ahead of the user prompt", () => {
    const out = wrapReplyContext("agent said this", "why?", "msg-1");
    assert.equal(
      out,
      `<reply-context message="msg-1">\nagent said this\n</reply-context>\n\nwhy?`,
    );
  });

  it("caps a huge quote and still sends a prompt-less reply", () => {
    const quoted = "Q".repeat(REPLY_QUOTE_CAP + 20);
    const out = wrapReplyContext(quoted, "  ", "m2");
    assert.match(out, /quoted message truncated/);
    assert.ok(!out.includes("Q".repeat(REPLY_QUOTE_CAP + 1)));
  });

  it("still marks a pre-sliced snapshot as truncated", () => {
    const sliced = "Q".repeat(REPLY_QUOTE_CAP);
    const out = wrapReplyContext(sliced, "fix this", "m3", { truncated: true });
    assert.match(out, /quoted message truncated/);
    assert.match(out, /fix this/);
  });
});

describe("cite selection snapshot", () => {
  it("rejects an empty or whitespace-only selection", () => {
    assert.equal(
      makeReplyTarget({
        messageId: "a1",
        threadId: "t1",
        text: "",
        kind: "selection",
        sourceText: "full message",
      }),
      null,
    );
    assert.equal(
      makeReplyTarget({
        messageId: "a1",
        threadId: "t1",
        text: "   \n\t  ",
        kind: "selection",
        sourceText: "full message",
      }),
      null,
    );
  });

  it("quotes only the selected sentences, not the rest of the message", () => {
    const source =
      "Keep this intro. Alpha needs a fix. Bravo is also wrong. Ignore the outro.";
    const target = makeReplyTarget({
      messageId: "a1",
      threadId: "t1",
      text: "Alpha needs a fix. Bravo is also wrong.",
      kind: "selection",
      sourceText: source,
    });
    assert.ok(target);
    assert.equal(target.text, "Alpha needs a fix. Bravo is also wrong.");
    assert.equal(target.kind, "selection");
    assert.equal(target.threadId, "t1");
    assert.equal(target.truncated, false);
    assert.ok(!target.text.includes("Keep this intro"));
    assert.ok(!target.text.includes("Ignore the outro"));
  });

  it("bounds an over-limit selection with a truthful truncated flag", () => {
    const target = makeReplyTarget({
      messageId: "a1",
      threadId: "t1",
      text: "Q".repeat(REPLY_QUOTE_CAP + 40),
      kind: "selection",
      sourceText: "full",
    });
    assert.ok(target);
    assert.equal(target.text.length, REPLY_QUOTE_CAP);
    assert.equal(target.truncated, true);
  });

  it("keeps the snapshot readable when the source message is gone or changed", () => {
    const target = makeReplyTarget({
      messageId: "a1",
      threadId: "t1",
      text: "Alpha needs a fix.",
      kind: "selection",
      sourceText: "Alpha needs a fix. Bravo stays.",
    });
    assert.ok(target);
    assert.equal(
      replySourceUnavailable(target, null),
      true,
      "removed message is unavailable",
    );
    assert.equal(
      replySourceUnavailable(target, {
        id: "a1",
        role: "assistant",
        text: "rewritten body with no overlap",
      }),
      true,
      "changed body is unavailable",
    );
    assert.equal(
      replySourceUnavailable(target, {
        id: "a1",
        role: "assistant",
        text: "Alpha needs a fix. Bravo stays.",
      }),
      false,
    );
    assert.equal(target.text, "Alpha needs a fix.", "quote stays readable");
  });
});

describe("wait-what", () => {
  it("asks for a plain-English re-explain of the quoted message", () => {
    const out = waitWhatPrompt("Use forkWorkerThread with the pool alias.");
    assert.match(out, /plain English/);
    assert.match(out, /project's vocabulary/);
    assert.match(out, /Do not start new work/);
    assert.match(out, /<message>\nUse forkWorkerThread with the pool alias.\n<\/message>/);
  });
});

describe("double-Option", () => {
  it("fires on the second Option keyup inside the window", () => {
    const t = createDoubleOptionTracker(1_000);
    t.note("Alt", "keydown");
    assert.equal(t.note("Alt", "keyup"), false);
    assert.equal(t.note("Alt", "keyup"), true);
  });

  it("ignores a held Option keydown repeat and chorded Option", () => {
    const t = createDoubleOptionTracker(1_000);
    assert.equal(t.note("Alt", "keydown"), false);
    assert.equal(t.note("Alt", "keydown"), false);
    assert.equal(t.note("a", "keyup"), false);
    assert.equal(t.note("Alt", "keyup", { meta: true }), false);
    assert.equal(isOptionKey("AltLeft"), true);
    assert.equal(isOptionKey("Meta"), false);
  });
});

describe("repoRelativeDir", () => {
  it("turns a project-internal pick into a trailing-slash mention", () => {
    assert.equal(repoRelativeDir("/tmp/repo", "/tmp/repo/src"), "src/");
    assert.equal(repoRelativeDir("/tmp/repo", "/tmp/repo"), "./");
    assert.equal(repoRelativeDir("/tmp/repo", "/elsewhere/shots"), "/elsewhere/shots/");
  });
});
