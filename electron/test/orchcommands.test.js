/**
 * electron/orchcommands.js: /handoff, /advisor, /committee parse + prompts.
 *
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test electron/test/orchcommands.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  WORKERS_PER_KIND,
  parseOrchCommand,
  workerPrompt,
  dispatchNote,
} = require("../orchcommands.js");

const INSTALLED = ["claude", "codex", "grok", "kimi", "cursor"];
const CTX = { installed: INSTALLED, current: "claude" };

function parse(prompt, ctx) {
  return parseOrchCommand(prompt, ctx || CTX);
}

describe("parseOrchCommand", () => {
  it("parses each command with a task", () => {
    assert.deepEqual(parse("/handoff implement the plan"), {
      kind: "handoff",
      task: "implement the plan",
      providers: ["codex"],
    });
    assert.deepEqual(parse("/advisor is this the right approach?"), {
      kind: "advisor",
      task: "is this the right approach?",
      providers: ["codex"],
    });
    assert.deepEqual(parse("/committee why is CI red?"), {
      kind: "committee",
      task: "why is CI red?",
      providers: ["codex", "grok"],
    });
  });

  it("returns null for non-command prompts and @file first tokens", () => {
    assert.equal(parse("please /handoff this"), null);
    assert.equal(parse("just a prompt"), null);
    assert.equal(parse(""), null);
    assert.equal(parse("   "), null);
    assert.equal(parse("@file.ts summarize this"), null);
    assert.equal(parse("@grok fix the flaky test"), null);
    assert.equal(parse("/HANDOFF implement the plan"), null);
    assert.equal(parse("/Handoff implement"), null);
    assert.equal(parse("/hand-off implement"), null);
    assert.equal(parse("/handoffs implement"), null);
  });

  it("returns null for a bare command with no task", () => {
    assert.equal(parse("/handoff"), null);
    assert.equal(parse("/advisor"), null);
    assert.equal(parse("/committee"), null);
    assert.equal(parse("/advisor   "), null);
    assert.equal(parse("/advisor @codex"), null);
    assert.equal(parse("/committee @codex @grok"), null);
  });

  it("honours and consumes explicit @provider args", () => {
    assert.deepEqual(parse("/handoff @grok ship the patch"), {
      kind: "handoff",
      task: "ship the patch",
      providers: ["grok"],
    });
    assert.deepEqual(parse("/advisor @kimi is this sound?"), {
      kind: "advisor",
      task: "is this sound?",
      providers: ["kimi"],
    });
    assert.deepEqual(parse("/committee @kimi @grok why is CI red?"), {
      kind: "committee",
      task: "why is CI red?",
      providers: ["kimi", "grok"],
    });
    // handoff only consumes one; the rest stays on the task
    assert.deepEqual(parse("/handoff @grok @kimi ship the patch"), {
      kind: "handoff",
      task: "@kimi ship the patch",
      providers: ["grok"],
    });
  });

  it("leaves an unknown @foo in the task", () => {
    assert.deepEqual(parse("/advisor @foo is this sound?"), {
      kind: "advisor",
      task: "@foo is this sound?",
      providers: ["codex"],
    });
    assert.deepEqual(parse("/handoff @file.ts implement the plan"), {
      kind: "handoff",
      task: "@file.ts implement the plan",
      providers: ["codex"],
    });
    // first @ is known, second is not: only the known one is consumed
    assert.deepEqual(parse("/committee @grok @file.ts why is CI red?"), {
      kind: "committee",
      task: "@file.ts why is CI red?",
      providers: ["grok", "codex"],
    });
  });

  it("defaults contrast with current, in installed order", () => {
    assert.deepEqual(parse("/handoff do it", CTX).providers, ["codex"]);
    assert.deepEqual(
      parse("/handoff do it", { installed: INSTALLED, current: "codex" })
        .providers,
      ["claude"],
    );
    assert.deepEqual(
      parse("/committee do it", { installed: INSTALLED, current: "grok" })
        .providers,
      ["claude", "codex"],
    );
    // explicit current still fills the rest from contrasting ids
    assert.deepEqual(parse("/committee @claude do it", CTX).providers, [
      "claude",
      "codex",
    ]);
  });

  it("committee always yields exactly 2 providers", () => {
    assert.equal(WORKERS_PER_KIND.committee, 2);
    const a = parse("/committee why?");
    assert.equal(a.providers.length, 2);
    const b = parse("/committee @grok why?");
    assert.equal(b.providers.length, 2);
    assert.deepEqual(b.providers, ["grok", "codex"]);
    const c = parse("/committee @grok @kimi why?");
    assert.equal(c.providers.length, 2);
    assert.deepEqual(c.providers, ["grok", "kimi"]);
  });

  it("single-installed-provider fallback does not throw", () => {
    const one = { installed: ["claude"], current: "claude" };
    assert.deepEqual(parse("/handoff implement the plan", one), {
      kind: "handoff",
      task: "implement the plan",
      providers: ["claude"],
    });
    assert.deepEqual(parse("/committee why is CI red?", one), {
      kind: "committee",
      task: "why is CI red?",
      providers: ["claude", "claude"],
    });
    assert.equal(parse(null, one), null);
    assert.doesNotThrow(() => parse("/handoff do it", null));
    assert.doesNotThrow(() => parse("/handoff do it", {}));
    const emptyCtx = parse("/handoff do it", {});
    assert.equal(emptyCtx.kind, "handoff");
    assert.equal(emptyCtx.task, "do it");
    assert.equal(emptyCtx.providers.length, 1);
  });

  it("keeps a multi-line task intact", () => {
    assert.deepEqual(parse("/handoff @grok line one\nline two"), {
      kind: "handoff",
      task: "line one\nline two",
      providers: ["grok"],
    });
  });
});

describe("workerPrompt", () => {
  it("handoff names the implementer role and the task", () => {
    const p = workerPrompt("handoff", "ship the patch", {
      index: 0,
      total: 1,
      peerIds: [],
    });
    assert.match(p, /implementer/i);
    assert.match(p, /hand-off/i);
    assert.match(p, /ship the patch/);
    assert.ok(p.length < 1200);
  });

  it("advisor names the second-opinion role and forbids edits", () => {
    const p = workerPrompt("advisor", "is this the right approach?", {
      index: 0,
      total: 1,
      peerIds: [],
    });
    assert.match(p, /second opinion/i);
    assert.match(p, /do not edit files/i);
    assert.match(p, /verdict/i);
    assert.match(p, /is this the right approach\?/);
    assert.ok(p.length < 1200);
  });

  it("committee names the member role and every peer id", () => {
    const p = workerPrompt("committee", "why is CI red?", {
      index: 1,
      total: 2,
      peerIds: ["abc12345-xxxx", "def67890-yyyy"],
    });
    assert.match(p, /committee member 2 of 2/i);
    assert.match(p, /root-cause/i);
    assert.match(p, /peer_send/);
    assert.match(p, /abc12345-xxxx/);
    assert.match(p, /def67890-yyyy/);
    assert.match(p, /why is CI red\?/);
    assert.ok(p.length < 1200);
  });
});

describe("dispatchNote", () => {
  it("writes one orchestration line with 8-char thread ids", () => {
    assert.equal(
      dispatchNote("committee", [
        { id: "abc12345-rest-of-uuid", provider: "grok" },
        { id: "def67890-rest-of-uuid", provider: "codex" },
      ]),
      "[orchestration] /committee dispatched 2 workers (grok abc12345, codex def67890); they wake this thread when they land.",
    );
    assert.equal(
      dispatchNote("handoff", [{ id: "aabbccdd11223344", provider: "codex" }]),
      "[orchestration] /handoff dispatched 1 worker (codex aabbccdd); they wake this thread when they land.",
    );
  });
});
