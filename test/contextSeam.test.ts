import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextRing, threadContextWindow } from "../src/contextRing.ts";
import { contextBreakdown } from "../src/contextBreakdown.ts";
import type { ProviderInfo, SessionUsage } from "../src/shared/ipc";

/**
 * The join between the two halves of #317: the electron runner writes
 * SessionUsage, the renderer divides it by a window and splits it up. Each
 * side was built against a mock of the other, so this covers the seam:
 * verbatim provider payloads in, a rendered ring out.
 */

/** Real `result.usage` from `claude -p --output-format stream-json` (Haiku 4.5). */
const CLAUDE_RESULT_USAGE = {
  input_tokens: 10,
  cache_creation_input_tokens: 10_203,
  cache_read_input_tokens: 17_748,
  output_tokens: 175,
};

/** What runner.js:claudeContextTokens derives from it. */
const claudeUsage: SessionUsage = {
  model: "claude-haiku-4-5",
  inputTokens: CLAUDE_RESULT_USAGE.input_tokens,
  outputTokens: CLAUDE_RESULT_USAGE.output_tokens,
  costUsd: 0.01,
  turns: 1,
  contextTokens:
    CLAUDE_RESULT_USAGE.input_tokens +
    CLAUDE_RESULT_USAGE.cache_creation_input_tokens +
    CLAUDE_RESULT_USAGE.cache_read_input_tokens +
    CLAUDE_RESULT_USAGE.output_tokens,
};

const providers = [
  {
    id: "claude",
    modelInfo: [
      { id: "claude-haiku-4-5", contextTokens: 200_000 },
      { id: "claude-opus-5", contextTokens: 1_000_000, recommended: true },
    ],
  },
  { id: "kimi", modelInfo: [{ id: "kimi-code/k3", contextTokens: 1_000_000 }] },
] as unknown as ProviderInfo[];

describe("context ring seam: runner usage -> rendered ring", () => {
  it("a cached claude turn reads as real fill, not ~0%", () => {
    const window = threadContextWindow(
      claudeUsage.contextWindow,
      providers,
      "claude",
      claudeUsage.model,
    );
    const ring = contextRing({ used: claudeUsage.contextTokens, window });
    assert.ok(ring);
    assert.equal(ring.windowLabel, "200k");
    // 28,136 / 200,000 = 14%. The pre-fix formula (input+output only) gave
    // 185 tokens => 0%, which is the bug this issue is about.
    assert.equal(ring.percentLabel, "14%");
    assert.equal(ring.warn, false);
    const preFix = contextRing({
      used: CLAUDE_RESULT_USAGE.input_tokens + CLAUDE_RESULT_USAGE.output_tokens,
      window,
    });
    assert.equal(preFix?.percentLabel, "0%");
  });

  it("a CLI-reported window beats the static catalog", () => {
    // Codex is the provider that reports model_context_window; a thread whose
    // model is not in the catalog would otherwise have no denominator at all.
    const usage: SessionUsage = {
      model: "gpt-5.6-terra",
      inputTokens: 90_000,
      outputTokens: 1_000,
      costUsd: 0,
      turns: 1,
      contextTokens: 91_000,
      contextWindow: 272_000,
    };
    const window = threadContextWindow(
      usage.contextWindow,
      providers,
      "codex",
      usage.model,
    );
    assert.equal(window, 272_000);
    assert.equal(contextRing({ used: usage.contextTokens, window })?.percentLabel, "33%");
    // Without the reported window the catalog has nothing for codex -> no ring.
    assert.equal(threadContextWindow(undefined, providers, "codex", usage.model), null);
  });

  it("an unmeasurable provider shows no ring rather than a wrong one", () => {
    // runner.js leaves contextTokens unset for kimi; the window is known, so
    // only the missing numerator can suppress the ring.
    const usage: SessionUsage = {
      model: "kimi-code/k3",
      inputTokens: 1_200,
      outputTokens: 300,
      costUsd: 0,
      turns: 1,
    };
    const window = threadContextWindow(
      usage.contextWindow,
      providers,
      "kimi",
      usage.model,
    );
    assert.equal(window, 1_000_000);
    assert.equal(contextRing({ used: usage.contextTokens ?? null, window }), null);
  });

  it("the breakdown splits the measured total without inventing tokens", () => {
    const messages = [
      { id: "1", role: "user", text: "fix the parser", createdAt: 1 },
      {
        id: "2",
        role: "tool",
        text: "Read: parser.ts",
        createdAt: 2,
        tool: {
          id: "t1",
          name: "Read",
          input: '{"path":"parser.ts"}',
          output: "x".repeat(40_000),
          isError: false,
          done: true,
        },
      },
      { id: "3", role: "assistant", text: "y".repeat(400), createdAt: 3 },
    ] as never;
    const segs = contextBreakdown({
      messages,
      measured: claudeUsage.contextTokens!,
    });
    const sum = segs.reduce((n, s) => n + s.tokens, 0);
    assert.ok(sum <= claudeUsage.contextTokens!);
    for (const s of segs) assert.ok(s.tokens > 0);
    // Tool output dominates, and the unattributed remainder is the CLI's own
    // system prompt + tool definitions rather than a fabricated slice.
    assert.equal(segs[0].key, "tools");
    assert.ok(segs.find((s) => s.key === "system"));
  });
});
