/**
 * Typed context chips (#1526): labels, send expansion, storage parse.
 *
 * Run: node --experimental-strip-types --test test/contextChips.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandOutputChip,
  CONTEXT_BODY_CAP,
  contextChipLabel,
  filterMentionExtras,
  formatContextChipsPrompt,
  formatThreadDigest,
  parseContextChips,
  type ContextChip,
} from "../src/contextChips.ts";

const quote: ContextChip = {
  id: "q1",
  kind: "quote",
  messageId: "m1",
  threadId: "t1",
  text: "agent said this",
  comment: "",
  quoteKind: "selection",
};

const thread: ContextChip = {
  id: "th1",
  kind: "thread",
  threadId: "t-other",
  title: "Fix the login",
};

const pr: ContextChip = {
  id: "pr1",
  kind: "pr",
  number: 1526,
  title: "Typed chips",
};

const skill: ContextChip = {
  id: "sk1",
  kind: "skill",
  name: "review-pr",
  description: "Review a pull request",
};

const term: ContextChip = {
  id: "te1",
  kind: "terminal",
  command: "npm test",
  text: "not ok 1\n  Error: boom",
  startLine: 12,
  endLine: 14,
};

describe("contextChipLabel", () => {
  it("names each kind", () => {
    assert.equal(contextChipLabel(thread), "Fix the login");
    assert.equal(contextChipLabel(pr), "#1526 Typed chips");
    assert.equal(contextChipLabel(skill), "review-pr");
    assert.equal(contextChipLabel(term), "term · npm test · L12-14");
    assert.equal(contextChipLabel(quote), "Cite");
  });

  it("drops the line range when the terminal has none", () => {
    assert.equal(
      contextChipLabel({ ...term, startLine: undefined, endLine: undefined }),
      "term · npm test · 2 lines",
    );
  });
});

describe("formatThreadDigest", () => {
  it("keeps the last user and assistant turns", () => {
    const text = formatThreadDigest([
      { role: "event", text: "started" },
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
      { role: "tool", text: "Bash: ls" },
    ]);
    assert.match(text, /\[Conversation\]/);
    assert.match(text, /User: hello/);
    assert.match(text, /Assistant: hi/);
    assert.doesNotMatch(text, /started|Bash/);
  });
});

describe("formatContextChipsPrompt", () => {
  it("wraps a quote and appends an optional note", async () => {
    const out = await formatContextChipsPrompt([
      { ...quote, comment: "this part is wrong" },
    ]);
    assert.match(out, /<reply-context message="m1">/);
    assert.match(out, /agent said this/);
    assert.match(out, /this part is wrong/);
  });

  it("expands a thread via the loader", async () => {
    const out = await formatContextChipsPrompt([thread], {
      threadDigest: async (id) => {
        assert.equal(id, "t-other");
        return formatThreadDigest([{ role: "user", text: "do it" }]);
      },
    });
    assert.match(out, /Fix the login/);
    assert.match(out, /User: do it/);
  });

  it("expands a PR title, body, and diffstat", async () => {
    const out = await formatContextChipsPrompt([pr], {
      prDetail: async (n) => {
        assert.equal(n, 1526);
        return { title: "Typed chips", body: "Do the chips.", additions: 10, deletions: 2 };
      },
    });
    assert.match(out, /#1526 Typed chips/);
    assert.match(out, /Do the chips\./);
    assert.match(out, /\+10 \/ −2/);
  });

  it("expands a skill body", async () => {
    const out = await formatContextChipsPrompt([skill], {
      skillBody: async (name) => {
        assert.equal(name, "review-pr");
        return "Always read the diff first.";
      },
    });
    assert.match(out, /review-pr/);
    assert.match(out, /Always read the diff first/);
  });

  it("includes a terminal excerpt with command and range", async () => {
    const out = await formatContextChipsPrompt([term]);
    assert.match(out, /npm test/);
    assert.match(out, /L12-14/);
    assert.match(out, /not ok 1/);
  });

  it("failed expand becomes a one-line note and does not throw", async () => {
    const out = await formatContextChipsPrompt([pr, skill], {
      prDetail: async () => ({ error: "gh not found" }),
      skillBody: async () => ({ error: "missing" }),
    });
    assert.match(out, /Could not load #1526 Typed chips: gh not found/);
    assert.match(out, /Could not load review-pr: missing/);
  });
});

describe("parseContextChips", () => {
  it("keeps well-formed chips and drops junk", () => {
    const kept = parseContextChips([
      thread,
      { kind: "nope" },
      { kind: "pr", number: 1 },
      pr,
      null,
    ]);
    assert.deepEqual(kept.map((c) => c.id), ["th1", "pr1"]);
  });
});

describe("filterMentionExtras", () => {
  const extras = [
    { kind: "thread" as const, id: "a", title: "Login bug" },
    { kind: "pr" as const, number: 12, title: "Add chips" },
    { kind: "skill" as const, name: "review-pr", description: "Review a PR" },
  ];

  it("empty query caps each kind", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      kind: "thread" as const,
      id: `t${i}`,
      title: `Thread ${i}`,
    }));
    assert.equal(filterMentionExtras(many, "", 8).length, 8);
  });

  it("filters across kinds by substring", () => {
    const rows = filterMentionExtras(extras, "pr");
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["pr", "skill"],
    );
  });
});

describe("commandOutputChip (#1216)", () => {
  it("keeps the tail of a long log and fits the send cap", async () => {
    const result = { command: "npm test", cwd: "/wt", log: "a".repeat(20_000) + "\nFAIL last" };
    const chip = commandOutputChip("c1", result, "[Test] failed: exit 1 in 2s");
    const sent = await formatContextChipsPrompt([chip]);
    assert.ok(sent.startsWith("Terminal npm test\n\n[Test] failed: exit 1 in 2s\ncwd: /wt\n\n…["));
    assert.ok(sent.endsWith("FAIL last"), "tail kept, not cut by the body cap");
    assert.ok(chip.text.length <= CONTEXT_BODY_CAP);
  });

  it("uses a picked selection over the whole log", () => {
    const chip = commandOutputChip("c2", { command: "x", log: "all of it" }, "[X] ok in 1s", "just this");
    assert.equal(chip.text, "[X] ok in 1s\n\njust this");
  });
});
