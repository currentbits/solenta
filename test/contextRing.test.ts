import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contextRing,
  contextWindowFor,
  formatWindowSize,
} from "../src/contextRing.ts";
import type { ProviderInfo } from "../src/shared/ipc";

describe("contextRing", () => {
  it("computes fraction, percent and window label", () => {
    const ring = contextRing({ used: 472_000, window: 1_000_000 });
    assert.ok(ring);
    assert.equal(ring.fraction, 0.472);
    assert.equal(ring.percentLabel, "47%");
    assert.equal(ring.windowLabel, "1M");
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
