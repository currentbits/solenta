import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  STASH_STACK_CAP,
  loadStash,
  popStash,
  pushStash,
  stashIsEmpty,
  stashStorageKey,
  undoStash,
} from "../src/promptStash.ts";

const memory = new Map<string, string>();

function installStorage() {
  const store = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memory.set(k, v);
    },
    removeItem: (k: string) => {
      memory.delete(k);
    },
  };
  (globalThis as { window?: unknown }).window = {
    localStorage: store,
  };
}

describe("prompt stash", () => {
  beforeEach(() => {
    memory.clear();
    installStorage();
  });

  it("keys the stack per provider", () => {
    assert.equal(stashStorageKey("claude"), "coder.promptStash.claude");
    pushStash("claude", {
      text: "a",
      attachments: [],
      model: "opus",
      reasoningEffort: "high",
    });
    pushStash("grok", {
      text: "b",
      attachments: [],
      model: null,
      reasoningEffort: null,
    });
    assert.equal(loadStash("claude")[0]?.text, "a");
    assert.equal(loadStash("grok")[0]?.text, "b");
  });

  it("pushes LIFO and undo pops the just-stashed entry", () => {
    pushStash("claude", {
      text: "first",
      attachments: [],
      model: null,
      reasoningEffort: null,
    });
    pushStash("claude", {
      text: "second",
      attachments: [{ kind: "image", path: "/tmp/x.png", name: "x.png" }],
      model: "sonnet",
      reasoningEffort: null,
    });
    const undone = undoStash("claude");
    assert.equal(undone?.text, "second");
    assert.equal(undone?.attachments[0]?.name, "x.png");
    assert.equal(loadStash("claude")[0]?.text, "first");
  });

  it("pop restores the top and empties an exhausted stack", () => {
    pushStash("claude", {
      text: "only",
      attachments: [],
      model: null,
      reasoningEffort: null,
    });
    assert.equal(popStash("claude")?.text, "only");
    assert.equal(popStash("claude"), null);
    assert.deepEqual(loadStash("claude"), []);
  });

  it("caps the stack and treats empty text without attachments as empty", () => {
    for (let i = 0; i < STASH_STACK_CAP + 5; i++) {
      pushStash("claude", {
        text: `n${i}`,
        attachments: [],
        model: null,
        reasoningEffort: null,
      });
    }
    assert.equal(loadStash("claude").length, STASH_STACK_CAP);
    assert.equal(loadStash("claude")[0]?.text, `n${STASH_STACK_CAP + 4}`);
    assert.equal(
      stashIsEmpty({
        text: "  ",
        attachments: [],
        model: null,
        reasoningEffort: null,
      }),
      true,
    );
    assert.equal(
      stashIsEmpty({
        text: "",
        attachments: [{ kind: "file", path: "/a", name: "a" }],
        model: null,
        reasoningEffort: null,
      }),
      false,
    );
  });
});
