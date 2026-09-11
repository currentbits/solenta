/**
 * Question-answer formatting (issue #1219): custom-answer gating and
 * path-in-text composition. No DOM.
 *
 * Run: node --import=./test/support/render.mjs --test test/questionAnswer.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AttachmentInfo, PendingQuestion } from "../src/shared/ipc";
import {
  composeQuestionAnswerValue,
  formatAttachmentPathLine,
  formatQuestionAnswer,
  questionAllowsCustomAnswer,
  REMOTE_QUESTION_ATTACH_NOTE,
} from "../src/questionAnswer";

const IMAGE: AttachmentInfo = {
  kind: "image",
  path: "/tmp/shot.png",
  name: "shot.png",
};
const FILE: AttachmentInfo = {
  kind: "file",
  path: "/tmp/app.log",
  name: "app.log",
};

function q(over: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    question: "Which?",
    header: "",
    multiSelect: false,
    options: [{ label: "A", description: "" }],
    ...over,
  };
}

describe("questionAllowsCustomAnswer", () => {
  it("defaults to allowing Other and files", () => {
    assert.equal(questionAllowsCustomAnswer(q()), true);
    assert.equal(questionAllowsCustomAnswer(q({ customAnswer: true })), true);
  });

  it("hides custom answers when the question is choice-only", () => {
    assert.equal(
      questionAllowsCustomAnswer(q({ customAnswer: false })),
      false,
    );
  });
});

describe("composeQuestionAnswerValue", () => {
  it("keeps a typed or selected answer without files", () => {
    assert.equal(composeQuestionAnswerValue("Postgres"), "Postgres");
    assert.equal(composeQuestionAnswerValue("  Postgres  "), "Postgres");
  });

  it("appends accessible saved paths under the picked text", () => {
    assert.equal(
      composeQuestionAnswerValue("Postgres", [IMAGE, FILE]),
      "Postgres\nImage: /tmp/shot.png\nFile: /tmp/app.log",
    );
  });

  it("file-only answers are the path lines, so submit is valid", () => {
    assert.equal(
      composeQuestionAnswerValue("", [IMAGE]),
      "Image: /tmp/shot.png",
    );
    assert.equal(composeQuestionAnswerValue("   ", [FILE]), "File: /tmp/app.log");
  });

  it("is empty when nothing was picked or attached", () => {
    assert.equal(composeQuestionAnswerValue(""), "");
    assert.equal(composeQuestionAnswerValue("  ", []), "");
  });
});

describe("formatQuestionAnswer", () => {
  it("quotes every answered question and drops the unanswered", () => {
    const text = formatQuestionAnswer({
      "Which database?": "Postgres",
      "Which cache?": "",
      "Which features?": "Auth, Billing",
    });
    assert.equal(
      text,
      "Answering your question:\n\n" +
        "Which database?\n→ Postgres\n\n" +
        "Which features?\n→ Auth, Billing",
    );
  });

  it("keeps path lines in the submitted follow-up text", () => {
    const value = composeQuestionAnswerValue("see log", [FILE]);
    const text = formatQuestionAnswer({ "Need a screenshot?": value });
    assert.match(text, /Need a screenshot\?/);
    assert.match(text, /→ see log\nFile: \/tmp\/app\.log/);
  });

  it("is empty when nothing was picked, so no turn is started", () => {
    assert.equal(formatQuestionAnswer({ "Which?": "" }), "");
  });
});

describe("formatAttachmentPathLine", () => {
  it("labels image, file, and folder paths", () => {
    assert.equal(formatAttachmentPathLine(IMAGE), "Image: /tmp/shot.png");
    assert.equal(formatAttachmentPathLine(FILE), "File: /tmp/app.log");
    assert.equal(
      formatAttachmentPathLine({
        kind: "folder",
        path: "/tmp/specs",
        name: "specs",
      }),
      "Folder: /tmp/specs",
    );
  });
});

describe("REMOTE_QUESTION_ATTACH_NOTE", () => {
  it("states unsupported transfer instead of a local path", () => {
    assert.match(REMOTE_QUESTION_ATTACH_NOTE, /remotely/);
    assert.equal(REMOTE_QUESTION_ATTACH_NOTE.includes("/tmp/"), false);
  });
});
