import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLAUDE_CACHE_TTL_MS,
  COLD_COMPACT_MIN_TOKENS,
  CONTEXT_WARN_FRACTION,
  coldCompactTokens,
  contextRing,
  contextWindowFor,
  formatWindowSize,
  threadContextWindow,
} from "../src/contextRing.ts";
import type { ProviderInfo } from "../src/shared/ipc";

describe("contextRing", () => {
  it("computes fraction, percent and window label", () => {
    const ring = contextRing({ used: 472_000, window: 1_000_000 });
    assert.ok(ring);
    assert.equal(ring.fraction, 0.472);
    assert.equal(ring.percentLabel, "47%");
    assert.equal(ring.windowLabel, "1M");
    assert.equal(ring.warn, false);
  });

  it("flags a near-limit fill so the ring can warn before compaction", () => {
    const under = contextRing({
      used: CONTEXT_WARN_FRACTION * 1_000_000 - 1,
      window: 1_000_000,
    });
    const at = contextRing({
      used: CONTEXT_WARN_FRACTION * 1_000_000,
      window: 1_000_000,
    });
    assert.ok(under);
    assert.ok(at);
    assert.equal(under.warn, false);
    assert.equal(at.warn, true);
  });

  it("clamps at 100% when the turn overflows the window", () => {
    const ring = contextRing({ used: 1_200_000, window: 1_000_000 });
    assert.ok(ring);
    assert.equal(ring.fraction, 1);
    assert.equal(ring.percentLabel, "100%");
  });

  it("hides without a documented window or a measured turn", () => {
    assert.equal(contextRing({ used: 100, window: null }), null);
    assert.equal(contextRing({ used: 100, window: undefined }), null);
    assert.equal(contextRing({ used: null, window: 1_000_000 }), null);
    assert.equal(contextRing({ used: 0, window: 1_000_000 }), null);
    assert.equal(contextRing({ used: 100, window: 0 }), null);
  });
});

describe("formatWindowSize", () => {
  it("formats M, k and small sizes", () => {
    assert.equal(formatWindowSize(1_000_000), "1M");
    assert.equal(formatWindowSize(256_000), "256k");
    assert.equal(formatWindowSize(200_000), "200k");
    assert.equal(formatWindowSize(900), "900");
  });
});

describe("contextWindowFor", () => {
  const providers: ProviderInfo[] = [
    {
      id: "kimi",
      name: "Kimi Code",
      available: true,
      supportsResume: true,
      models: ["kimi-code/k3", "kimi-code/k3-256k"],
      modelInfo: [
        {
          id: "kimi-code/k3",
          label: "K3",
          description: "",
          vendor: "Moonshot",
          recommended: true,
          contextTokens: 1_000_000,
        },
        {
          id: "kimi-code/k3-256k",
          label: "K3-256k",
          description: "",
          vendor: "Moonshot",
          contextTokens: 256_000,
        },
      ],
      efforts: [],
    },
    {
      id: "claude",
      name: "Claude Code",
      available: true,
      supportsResume: true,
      models: [],
      modelInfo: [],
      efforts: [],
    },
  ];

  it("uses the explicit model's window", () => {
    assert.equal(
      contextWindowFor(providers, "kimi", "kimi-code/k3-256k"),
      256_000,
    );
  });

  it("falls back to the recommended model when no override is set", () => {
    assert.equal(contextWindowFor(providers, "kimi", null), 1_000_000);
  });

  it("is null when nothing documents a window", () => {
    assert.equal(contextWindowFor(providers, "claude", "claude-opus-5"), null);
    assert.equal(contextWindowFor(providers, "nope", null), null);
  });
});

describe("threadContextWindow", () => {
  const providers: ProviderInfo[] = [
    {
      id: "kimi",
      name: "Kimi Code",
      available: true,
      supportsResume: true,
      models: ["kimi-code/k3"],
      modelInfo: [
        {
          id: "kimi-code/k3",
          label: "K3",
          description: "",
          vendor: "Moonshot",
          recommended: true,
          contextTokens: 1_000_000,
        },
      ],
      efforts: [],
    },
  ];

  it("prefers the CLI-reported window over the static catalog", () => {
    assert.equal(
      threadContextWindow(200_000, providers, "kimi", "kimi-code/k3"),
      200_000,
    );
  });

  it("falls back to the catalog when the CLI did not report one", () => {
    assert.equal(
      threadContextWindow(undefined, providers, "kimi", "kimi-code/k3"),
      1_000_000,
    );
    assert.equal(
      threadContextWindow(null, providers, "kimi", "kimi-code/k3"),
      1_000_000,
    );
  });
});

describe("coldCompactTokens", () => {
  const now = 10 * CLAUDE_CACHE_TTL_MS;
  const cold = now - CLAUDE_CACHE_TTL_MS - 1;
  const base = {
    provider: "claude",
    contextTokens: 120_000,
    lastActivityAt: cold,
    now,
  };

  it("returns the context size for a cold, large claude thread", () => {
    assert.equal(coldCompactTokens(base), 120_000);
  });

  it("stays quiet inside the cache TTL", () => {
    const warm = { ...base, lastActivityAt: now - CLAUDE_CACHE_TTL_MS };
    assert.equal(coldCompactTokens(warm), null);
  });

  it("stays quiet below the size cutoff or without a measurement", () => {
    const small = { ...base, contextTokens: COLD_COMPACT_MIN_TOKENS - 1 };
    assert.equal(coldCompactTokens(small), null);
    assert.equal(coldCompactTokens({ ...base, contextTokens: undefined }), null);
    const atCutoff = { ...base, contextTokens: COLD_COMPACT_MIN_TOKENS };
    assert.equal(coldCompactTokens(atCutoff), COLD_COMPACT_MIN_TOKENS);
  });

  it("is claude only", () => {
    assert.equal(coldCompactTokens({ ...base, provider: "codex" }), null);
  });
});

// The numerator and model ceiling stay intact when Claude compacts earlier.
describe("Claude compaction-aware ring", () => {
  it("measures against the reported point and labels the model ceiling separately", () => {
    const ring = contextRing({ used: 100_000, window: 1_000_000, claude: true,
      compaction: { kind: "threshold", tokens: 117_000, source: "reported" } });
    assert.ok(ring);
    assert.equal(ring.percentLabel, "85%");
    assert.equal(ring.windowLabel, "117k");
    assert.equal(ring.modelWindowLabel, "1M");
    assert.equal(ring.limitLabel, "Auto-compact estimate");
    assert.match(ring.compactionNote ?? "", /percentage overrides/);
    assert.equal(ring.warn, true);
    assert.equal(ring.warnLabel, "Auto-compaction may be close");
  });

  it("uses an enforced threshold without claiming it is a model ceiling", () => {
    const ring = contextRing({ used: 30_000, window: 200_000, claude: true,
      compaction: { kind: "threshold", tokens: 39_000, source: "enforced" } });
    assert.equal(ring?.percentLabel, "77%");
    assert.equal(ring?.limitLabel, "Auto-compact threshold");
    assert.equal(ring?.compactionNote, null);
  });

  it("keeps a labeled model ceiling when compaction is off, reactive or unavailable", () => {
    for (const compaction of [undefined, { kind: "disabled" }, { kind: "reactive" }] satisfies
      Array<import("../src/shared/ipc").ContextCompaction | undefined>) {
      const ring = contextRing({ used: 180_000, window: 200_000, claude: true, compaction });
      assert.equal(ring?.percentLabel, "90%");
      assert.equal(ring?.limitLabel, "Model context window");
      assert.equal(ring?.warnLabel, "Context window is nearly full");
      assert.ok(ring?.compactionNote);
    }
  });

  it("ignores invalid policy data and hides non-finite measurements", () => {
    const ring = contextRing({ used: 100_000, window: 200_000, claude: true,
      compaction: { kind: "threshold", tokens: 300_000, source: "reported" } });
    assert.equal(ring?.percentLabel, "50%");
    assert.equal(contextRing({ used: NaN, window: 200_000 }), null);
    assert.equal(contextRing({ used: 10, window: Infinity }), null);
  });
});
