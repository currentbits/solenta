import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REPLY_QUOTE_CAP,
  excerptReply,
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
