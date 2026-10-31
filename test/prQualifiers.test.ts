/**
 * PR list query qualifiers (issue #1795 feature 4): parser + matcher.
 * Run: node --experimental-strip-types --test test/prQualifiers.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parsePrQuery,
  prMatchesQualifiers,
  removePrQualifier,
} from "../src/prQualifiers.ts";
import type { PrListItem } from "../src/shared/ipc.ts";

function pr(over: Partial<PrListItem> = {}): PrListItem {
  return {
    number: 1,
    title: "x",
    url: "https://github.com/acme/demo/pull/1",
    state: "OPEN",
    headRefName: "feat/x",
    ...over,
  };
}

describe("parsePrQuery", () => {
  it("leaves plain text alone", () => {
    assert.deepEqual(parsePrQuery("fix the thing"), {
      qualifiers: [],
      text: "fix the thing",
    });
  });

  it("extracts author/label/is/review/head qualifiers, case-insensitive keys", () => {
    const parsed = parsePrQuery("AUTHOR:alice is:draft fix thing label:bug head:feat/x");
    assert.deepEqual(parsed.qualifiers, [
      { kind: "author", value: "alice", token: "AUTHOR:alice" },
      { kind: "is", value: "draft", token: "is:draft" },
      { kind: "label", value: "bug", token: "label:bug" },
      { kind: "head", value: "feat/x", token: "head:feat/x" },
    ]);
    assert.equal(parsed.text, "fix thing");
  });

  it("repeats label qualifiers", () => {
    const parsed = parsePrQuery("label:bug label:urgent");
    assert.deepEqual(parsed.qualifiers.map((q) => q.value), ["bug", "urgent"]);
  });

  it("supports author:@me", () => {
    assert.deepEqual(parsePrQuery("author:@me").qualifiers, [
      { kind: "author", value: "@me", token: "author:@me" },
    ]);
  });

  it("leaves an unrecognized is:/review: value as free text", () => {
    const parsed = parsePrQuery("is:bogus review:nope");
    assert.deepEqual(parsed.qualifiers, []);
    assert.equal(parsed.text, "is:bogus review:nope");
  });

  it("accepts every is: and review: value", () => {
    for (const v of ["draft", "open", "merged", "closed"]) {
      assert.equal(parsePrQuery(`is:${v}`).qualifiers.length, 1, v);
    }
    for (const v of ["required", "approved", "changes_requested"]) {
      assert.equal(parsePrQuery(`review:${v}`).qualifiers.length, 1, v);
    }
  });
});

describe("removePrQualifier", () => {
  it("drops only the matching token", () => {
    const parsed = parsePrQuery("label:bug fix thing label:urgent");
    const next = removePrQualifier("label:bug fix thing label:urgent", parsed.qualifiers[0]);
    assert.equal(next, "fix thing label:urgent");
  });
});

describe("prMatchesQualifiers", () => {
  it("author: matches case-insensitively; @me resolves against viewerLogin", () => {
    const row = pr({ author: "Alice" });
    assert.equal(
      prMatchesQualifiers(row, [{ kind: "author", value: "alice", token: "author:alice" }], null),
      true,
    );
    assert.equal(
      prMatchesQualifiers(row, [{ kind: "author", value: "bob", token: "author:bob" }], null),
      false,
    );
    assert.equal(
      prMatchesQualifiers(row, [{ kind: "author", value: "@me", token: "author:@me" }], "alice"),
      true,
    );
    assert.equal(
      prMatchesQualifiers(row, [{ kind: "author", value: "@me", token: "author:@me" }], "bob"),
      false,
    );
    assert.equal(
      prMatchesQualifiers(row, [{ kind: "author", value: "@me", token: "author:@me" }], null),
      false,
      "no signed-in login never matches @me",
    );
  });

  it("label: matches one of the repeated labels, case-insensitively", () => {
    const row = pr({ labels: ["Bug", "urgent"] });
    assert.equal(
      prMatchesQualifiers(row, [{ kind: "label", value: "bug", token: "label:bug" }], null),
      true,
    );
    assert.equal(
      prMatchesQualifiers(row, [{ kind: "label", value: "missing", token: "label:missing" }], null),
      false,
    );
    assert.equal(
      prMatchesQualifiers(
        row,
        [
          { kind: "label", value: "bug", token: "label:bug" },
          { kind: "label", value: "urgent", token: "label:urgent" },
        ],
        null,
      ),
      true,
      "every qualifier must hold (AND, not OR)",
    );
  });

  it("is: matches draft via isDraft, and open/merged/closed via state", () => {
    assert.equal(
      prMatchesQualifiers(pr({ isDraft: true }), [{ kind: "is", value: "draft", token: "is:draft" }], null),
      true,
    );
    assert.equal(
      prMatchesQualifiers(pr({ isDraft: false }), [{ kind: "is", value: "draft", token: "is:draft" }], null),
      false,
    );
    assert.equal(
      prMatchesQualifiers(pr({ state: "MERGED" }), [{ kind: "is", value: "merged", token: "is:merged" }], null),
      true,
    );
    assert.equal(
      prMatchesQualifiers(pr({ state: "OPEN" }), [{ kind: "is", value: "closed", token: "is:closed" }], null),
      false,
    );
  });

  it("review: matches the normalized reviewDecision", () => {
    const approved = pr({ reviewDecision: "APPROVED" });
    assert.equal(
      prMatchesQualifiers(
        approved,
        [{ kind: "review", value: "approved", token: "review:approved" }],
        null,
      ),
      true,
    );
    assert.equal(
      prMatchesQualifiers(
        approved,
        [{ kind: "review", value: "changes_requested", token: "review:changes_requested" }],
        null,
      ),
      false,
    );
    assert.equal(
      prMatchesQualifiers(
        pr({ reviewDecision: "REVIEW_REQUIRED" }),
        [{ kind: "review", value: "required", token: "review:required" }],
        null,
      ),
      true,
    );
  });

  it("head: matches the branch name case-insensitively", () => {
    const row = pr({ headRefName: "Feat/Thing" });
    assert.equal(
      prMatchesQualifiers(row, [{ kind: "head", value: "feat/thing", token: "head:feat/thing" }], null),
      true,
    );
    assert.equal(
      prMatchesQualifiers(row, [{ kind: "head", value: "other", token: "head:other" }], null),
      false,
    );
  });

  it("no qualifiers always matches", () => {
    assert.equal(prMatchesQualifiers(pr(), [], null), true);
  });
});
