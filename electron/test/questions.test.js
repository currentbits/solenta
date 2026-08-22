/**
 * Shared question sanitizer (issue #647). Every question that reaches the
 * option picker comes from an agent — claude's AskUserQuestion input, grok's
 * ask_user_question tool_use, the coder-threads ask_user tool, or a persisted
 * row reloaded from disk — so none of it may be trusted.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  normalizeQuestions,
  normalizePendingQuestion,
} = require("../questions.js");
const { Store } = require("../store.js");

describe("normalizeQuestions", () => {
  it("keeps a well-formed question and fills the optional fields", () => {
    assert.deepEqual(
      normalizeQuestions([
        {
          question: "Merge or PR?",
          options: [{ label: "Merge" }, { label: "PR", description: "Open" }],
        },
      ]),
      [
        {
          question: "Merge or PR?",
          header: "",
          multiSelect: false,
          options: [
            { label: "Merge", description: "" },
            { label: "PR", description: "Open" },
          ],
        },
      ],
    );
  });

  it("drops questions nobody could answer by clicking", () => {
    // No options, no LABELLED options, no question text, wrong container.
    assert.equal(normalizeQuestions([{ question: "A", options: [] }]), null);
    assert.equal(
      normalizeQuestions([{ question: "A", options: [{ description: "x" }] }]),
      null,
    );
    assert.equal(
      normalizeQuestions([{ question: "  ", options: [{ label: "A" }] }]),
      null,
    );
    assert.equal(normalizeQuestions([{ question: "A" }]), null);
    assert.equal(normalizeQuestions("questions"), null);
    assert.equal(normalizeQuestions(null), null);
    assert.equal(normalizeQuestions([]), null);
  });

  it("keeps the answerable questions when only some are junk", () => {
    const out = normalizeQuestions([
      { question: "bad", options: [] },
      { question: "good", options: [{ label: "Yes" }] },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].question, "good");
  });

  it("caps runaway text and counts", () => {
    const out = normalizeQuestions([
      {
        question: "q".repeat(5000),
        header: "h".repeat(500),
        multiSelect: true,
        options: Array.from({ length: 40 }, (_, i) => ({ label: `o${i}` })),
      },
    ]);
    assert.equal(out[0].question.length, 400);
    assert.equal(out[0].header.length, 40);
    assert.equal(out[0].multiSelect, true);
    assert.equal(out[0].options.length, 12);

    const many = normalizeQuestions(
      Array.from({ length: 30 }, (_, i) => ({
        question: `q${i}`,
        options: [{ label: "a" }],
      })),
    );
    assert.equal(many.length, 8);
  });

  it("coerces non-string labels away rather than rendering [object Object]", () => {
    assert.equal(
      normalizeQuestions([
        { question: "A", options: [{ label: { evil: true } }, { label: 7 }] },
      ]),
      null,
    );
  });
});

describe("normalizePendingQuestion", () => {
  it("keeps id and askedAt, defaulting a missing timestamp", () => {
    const card = normalizePendingQuestion({
      id: "card-1",
      askedAt: 1700000000000,
      questions: [{ question: "A", options: [{ label: "B" }] }],
    });
    assert.equal(card.id, "card-1");
    assert.equal(card.askedAt, 1700000000000);
    assert.equal(card.questions.length, 1);

    const noStamp = normalizePendingQuestion({
      questions: [{ question: "A", options: [{ label: "B" }] }],
    });
    assert.equal(noStamp.askedAt, 0);
    assert.equal(noStamp.id, "q");
  });

  it("drops a card with nothing answerable left", () => {
    // A card the user cannot answer would be a permanent Waiting badge.
    assert.equal(normalizePendingQuestion({ questions: [] }), null);
    assert.equal(normalizePendingQuestion({ questions: "nope" }), null);
    assert.equal(normalizePendingQuestion(null), null);
    assert.equal(normalizePendingQuestion("card"), null);
  });
});

describe("Store persists the question card", () => {
  it("survives a reload, and a corrupt one is healed away", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-q-"));
    try {
      const filePath = path.join(tmpDir, "coder-store.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          projects: [],
          threads: [
            {
              id: "good",
              pendingQuestion: {
                id: "c1",
                askedAt: 5,
                questions: [
                  { question: "Merge?", options: [{ label: "Yes" }] },
                ],
              },
            },
            { id: "junk", pendingQuestion: { questions: [{ nope: 1 }] } },
            { id: "none" },
          ],
          messagesByThread: {},
        }),
      );
      const store = new Store(filePath);
      assert.equal(
        store.getThread("good").pendingQuestion.questions[0].question,
        "Merge?",
      );
      // Healed away, and absent on rows that never had one — old fixtures
      // must not grow the key.
      assert.equal(store.getThread("junk").pendingQuestion, undefined);
      assert.equal(store.getThread("none").pendingQuestion, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
