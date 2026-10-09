/**
 * Issue #1531: user model prices fill unmetered usage, never reported cost.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, normalizeSettings } = require("../store.js");
const {
  applyModelPrices,
  validateModelPrices,
} = require("../modelPrices.js");
const insights = require("../ipc-insights.js");

const cell = (over = {}) => ({
  costUsd: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  turns: 1,
  wastedUsd: 0,
  ...over,
});

describe("validateModelPrices", () => {
  it("keeps input/output and optional cache prices", () => {
    assert.deepEqual(
      validateModelPrices({ " gpt-5 ": { input: 1.25, output: 10, cacheRead: 0.125 } }),
      { "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 } },
    );
    assert.deepEqual(validateModelPrices(null), {});
  });

  it("rejects negative, missing and non-numeric prices", () => {
    assert.throws(() => validateModelPrices({ m: { input: -1, output: 1 } }), /non-negative/);
    assert.throws(() => validateModelPrices({ m: { input: 1 } }), /needs output/);
    assert.throws(() => validateModelPrices({ m: { input: "1", output: 1 } }), /non-negative/);
    assert.throws(() => validateModelPrices([]), /must be an object/);
  });

  it("normalizeSettings drops only the junk rows", () => {
    assert.deepEqual(normalizeSettings({}).modelPrices, {});
    assert.deepEqual(
      normalizeSettings({
        modelPrices: { ok: { input: 1, output: 2 }, bad: { input: -1, output: 2 } },
      }).modelPrices,
      { ok: { input: 1, output: 2 } },
    );
  });
});

describe("applyModelPrices", () => {
  const prices = { "gpt-5": { input: 1, output: 10, cacheRead: 0.1 } };

  it("prices unmetered cells and leaves reported cost alone", () => {
    const report = {
      byDay: {
        "2026-10-09": {
          codex: {
            "gpt-5": cell({ inputTokens: 1e6, cachedInputTokens: 1e6, outputTokens: 1e5 }),
          },
          claude: { "gpt-5": cell({ costUsd: 0.5, inputTokens: 1e6 }) },
          kimi: { other: cell({ inputTokens: 1e6 }) },
        },
      },
      threadsByDay: {
        "2026-10-09": { t1: { ...cell({ outputTokens: 1e6 }), model: "gpt-5" } },
      },
    };
    const out = applyModelPrices(report, prices);
    const day = out.byDay["2026-10-09"];
    assert.equal(day.codex["gpt-5"].costUsd, 1 + 0.1 + 1);
    assert.equal(day.claude["gpt-5"].costUsd, 0.5, "reported cost wins");
    assert.equal(day.kimi.other.costUsd, 0, "no price, stays unmetered");
    assert.equal(out.threadsByDay["2026-10-09"].t1.costUsd, 10);
    assert.equal(report.byDay["2026-10-09"].codex["gpt-5"].costUsd, 0, "ledger untouched");
  });

  it("is a no-op without prices", () => {
    const report = { byDay: {}, threadsByDay: {} };
    assert.equal(applyModelPrices(report, {}), report);
  });
});

describe("modelPrices setting", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-prices-"));
    store = new Store(path.join(tmpDir, "store.json"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips, replaces the whole map, and rejects bad input", async () => {
    store.setSettings({ modelPrices: { a: { input: 1, output: 2 }, b: { input: 3, output: 4 } } });
    assert.deepEqual(Object.keys(store.getSettings().modelPrices), ["a", "b"]);
    store.setSettings({ modelPrices: { a: { input: 1, output: 2 } } });
    assert.deepEqual(store.getSettings().modelPrices, { a: { input: 1, output: 2 } });
    assert.throws(() => store.setSettings({ modelPrices: { a: { input: -1, output: 2 } } }));
    assert.deepEqual(store.getSettings().modelPrices, { a: { input: 1, output: 2 } });

    store.recordUsage({ provider: "codex", model: "a", inputTokens: 1e6, outputTokens: 1e6 });
    const report = await insights["usage:byDay"]({ store });
    const [day] = Object.values(report.byDay);
    assert.equal(day.codex.a.costUsd, 3, "usage:byDay applies the saved prices");
  });
});
