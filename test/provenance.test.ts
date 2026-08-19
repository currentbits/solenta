/**
 * Provenance tier classification on assistant messages (issue #404).
 * Run: node --experimental-strip-types --test test/provenance.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage, ToolCallInfo } from "../src/shared/ipc";
import {
  messageProvenance,
  provenanceVisible,
  PRIOR_MIN_CHARS,
} from "../src/provenance";

let seq = 0;

function msg(
  over: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">,
): ChatMessage {
  seq += 1;
  return {
    id: over.id ?? `m${seq}`,
    role: over.role,
    text: over.text,
    createdAt: over.createdAt ?? seq,
    runId: over.runId ?? "run-1",
    tool: over.tool,
  };
}

function tool(
  name: string,
  input: unknown,
  over: Partial<ToolCallInfo> = {},
): ChatMessage {
  return msg({
    role: "tool",
    text: `${name}: call`,
    tool: {
      id: `t${seq}`,
      name,
      input: typeof input === "string" ? input : JSON.stringify(input),
      output: null,
      isError: false,
      done: true,
      ...over,
    },
  });
}

const LONG_CLAIM =
  "The billing service retries failed charges three times with exponential " +
  "backoff, then marks the subscription past_due and notifies the account " +
  "owner by email. Webhook deliveries are deduplicated by event id, so a " +
  "retried send is safe to acknowledge more than once in the receiver.";

describe("messageProvenance (#404)", () => {
  it("returns null for non-assistant messages", () => {
    const messages = [msg({ role: "user", text: "hi" })];
    assert.equal(messageProvenance(messages, 0), null);
  });

  it("grounds on repo tool calls in the same turn", () => {
    const messages = [
      msg({ role: "user", text: "where is billing handled?" }),
      tool("Read", { file_path: "/tmp/wt/src/billing.ts" }),
      tool("Grep", { pattern: "retryCharge", path: "src" }),
      msg({ role: "assistant", text: "Billing lives in `src/billing.ts`." }),
    ];
    const prov = messageProvenance(messages, 3);
    assert.ok(prov);
    assert.equal(prov.grounded, true);
    assert.deepEqual(prov.repo, [
      "/tmp/wt/src/billing.ts",
      "src",
      "src/billing.ts",
    ]);
  });

  it("grounds on shared-memory tool calls, bare and mcp-prefixed", () => {
    const messages = [
      msg({ role: "user", text: "what do we know about retries?" }),
      tool("mcp__coder-memory__memory_search", { query: "retries" }),
      tool("memory_get", { id: "abc" }),
      msg({ role: "assistant", text: "Shared memory says three retries." }),
    ];
    const prov = messageProvenance(messages, 3);
    assert.ok(prov);
    assert.equal(prov.grounded, true);
    assert.deepEqual(prov.memory, ["memory_search", "memory_get"]);
  });

  it("grounds on gh issue commands and captures the number", () => {
    const messages = [
      msg({ role: "user", text: "what does the issue ask?" }),
      tool("Bash", { command: "gh issue view 404 --json title,body" }),
      msg({ role: "assistant", text: "It asks for provenance tiers." }),
    ];
    const prov = messageProvenance(messages, 2);
    assert.ok(prov);
    assert.equal(prov.grounded, true);
    assert.deepEqual(prov.issues, ["#404"]);
  });

  it("grounds on issue refs cited in the message text", () => {
    const messages = [
      msg({ role: "user", text: "summarize the plan" }),
      msg({
        role: "assistant",
        text: "This pairs with #239 and builds on the citations work.",
      }),
    ];
    const prov = messageProvenance(messages, 1);
    assert.ok(prov);
    assert.equal(prov.grounded, true);
    assert.deepEqual(prov.issues, ["#239"]);
  });

  it("stops scanning at the previous user message (turn boundary)", () => {
    const messages = [
      msg({ role: "user", text: "first" }),
      tool("Read", { file_path: "/tmp/wt/src/old.ts" }),
      msg({ role: "assistant", text: "done with the first task" }),
      msg({ role: "user", text: "now something else" }),
      msg({ role: "assistant", text: LONG_CLAIM }),
    ];
    const prov = messageProvenance(messages, 4);
    assert.ok(prov);
    assert.equal(prov.grounded, false);
    assert.deepEqual(prov.repo, []);
  });

  it("flags substantive ungrounded messages as model prior knowledge", () => {
    const messages = [
      msg({ role: "user", text: "how does billing retry?" }),
      msg({ role: "assistant", text: LONG_CLAIM }),
    ];
    const prov = messageProvenance(messages, 1);
    assert.ok(prov);
    assert.equal(prov.grounded, false);
    assert.equal(provenanceVisible(prov, LONG_CLAIM), true);
  });

  it("never tags short chatter, grounded or not", () => {
    const messages = [
      msg({ role: "user", text: "fix it" }),
      msg({ role: "assistant", text: "On it — looking now." }),
    ];
    const prov = messageProvenance(messages, 1);
    assert.ok(prov);
    assert.equal(prov.grounded, false);
    assert.equal(provenanceVisible(prov, "On it — looking now."), false);
  });

  it("parses truncated tool input via the regex fallback", () => {
    const truncated = '{\n  "file_path": "/tmp/wt/src/cut-off.ts",\n  "content": "';
    const messages = [
      msg({ role: "user", text: "write it" }),
      tool("Write", truncated),
      msg({ role: "assistant", text: "Wrote the file." }),
    ];
    const prov = messageProvenance(messages, 2);
    assert.ok(prov);
    assert.deepEqual(prov.repo, ["/tmp/wt/src/cut-off.ts"]);
  });

  it("ignores backticked spans that are not paths", () => {
    const messages = [
      msg({ role: "user", text: "how do I run it?" }),
      msg({
        role: "assistant",
        text: "Run `npm test` and check `console.log` output.",
      }),
    ];
    const prov = messageProvenance(messages, 1);
    assert.ok(prov);
    assert.equal(prov.grounded, false);
    assert.deepEqual(prov.repo, []);
  });

  it("does not read markdown headings as issue refs", () => {
    const messages = [
      msg({ role: "user", text: "explain" }),
      msg({ role: "assistant", text: "# Results\n\n# 404 handling differs." }),
    ];
    const prov = messageProvenance(messages, 1);
    assert.ok(prov);
    // "# 404" has a space and never matches; a bare "#404" would.
    assert.deepEqual(prov.issues, []);
  });

  it("PRIOR_MIN_CHARS gates exactly at the boundary", () => {
    const prov = { repo: [], memory: [], issues: [], grounded: false };
    assert.equal(provenanceVisible(prov, "x".repeat(PRIOR_MIN_CHARS - 1)), false);
    assert.equal(provenanceVisible(prov, "x".repeat(PRIOR_MIN_CHARS)), true);
    assert.equal(
      provenanceVisible({ ...prov, grounded: true }, "tiny"),
      true,
    );
  });
});
