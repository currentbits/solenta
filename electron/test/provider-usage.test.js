/**
 * Provider account quotas: Codex pooling, Grok ACP billing, managed
 * Claude/Kimi injection, process timeout/cleanup.
 *
 * Run: node --test electron/test/provider-usage.test.js
 */
"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeFakeBin } = require("./support/fakeBin.js");
const { knownProviderIds } = require("../providers.js");
const {
  fetchProviderLimits,
  fetchCodex,
  fetchGrok,
  normalizeCodexRateLimits,
  normalizeGrokBilling,
  toEpochMs,
  MSG_SIGNED_OUT,
  MSG_TIMEOUT,
  MSG_FAILED,
} = require("../providerUsage.js");

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-provider-usage-"));
  tmpDirs.push(dir);
  return dir;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitDead(pid, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (!alive(pid)) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`pid ${pid} still alive`));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitFile(filePath, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fs.existsSync(filePath)) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`missing ${filePath}`));
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

const LIVE_CODEX = {
  rateLimits: {
    limitId: "codex",
    primary: {
      usedPercent: 15,
      windowDurationMins: 10080,
      resetsAt: 1731552000,
    },
    secondary: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      primary: {
        usedPercent: 15,
        windowDurationMins: 10080,
        resetsAt: 1731552000,
      },
      secondary: null,
    },
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: {
        usedPercent: 8,
        windowDurationMins: 300,
        resetsAt: 1730947200,
      },
      secondary: {
        usedPercent: 41,
        windowDurationMins: 10080,
        resetsAt: 1731552000,
      },
    },
    base_model_inference: {
      limitId: "base_model_inference",
      limitName: "gpt-reserve",
      primary: {
        usedPercent: 15,
        windowDurationMins: 10080,
        resetsAt: 1731552000,
      },
      secondary: null,
    },
  },
};

describe("normalizeCodexRateLimits", () => {
  it("labels by duration: a 10080-min primary is weekly, not 5-hour", () => {
    const windows = normalizeCodexRateLimits({
      rateLimits: {
        primary: {
          usedPercent: 15,
          windowDurationMins: 10080,
          resetsAt: 1731552000,
        },
        secondary: null,
      },
    });
    assert.equal(windows.length, 1);
    assert.equal(windows[0].label, "weekly");
    assert.equal(windows[0].usedPercent, 15);
    assert.equal(windows[0].windowSeconds, 10080 * 60);
  });

  it("keeps the main weekly quota once and distinct Spark pools", () => {
    const windows = normalizeCodexRateLimits(LIVE_CODEX);
    const mainWeekly = windows.filter((w) => w.label === "weekly" && w.usedPercent === 15);
    assert.equal(mainWeekly.length, 1);
    assert.equal(mainWeekly[0].windowSeconds, 10080 * 60);
    assert.equal(
      windows.find((w) => w.label === "GPT-5.3-Codex-Spark 5-hour").usedPercent,
      8,
    );
    assert.equal(
      windows.find((w) => w.label === "GPT-5.3-Codex-Spark weekly").usedPercent,
      41,
    );
    const dumped = JSON.stringify(windows);
    assert.equal(dumped.includes("accountId"), false);
    assert.equal(dumped.includes("RateLimitResetCredit"), false);
  });

  it("does not drop a 15% weekly aggregate when Spark is the only other pool", () => {
    const windows = normalizeCodexRateLimits({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 15,
          windowDurationMins: 10080,
          resetsAt: 1731552000,
        },
        secondary: null,
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 15,
            windowDurationMins: 10080,
            resetsAt: 1731552000,
          },
          secondary: null,
        },
        spark: {
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          primary: {
            usedPercent: 0,
            windowDurationMins: 300,
            resetsAt: 1730947200,
          },
          secondary: null,
        },
      },
    });
    const mainWeekly = windows.filter((w) => w.label === "weekly" && w.usedPercent === 15);
    assert.equal(mainWeekly.length, 1);
    const spark = windows.find((w) => w.label === "GPT-5.3-Codex-Spark 5-hour");
    assert.ok(spark);
    assert.equal(spark.usedPercent, 0);
    assert.equal(windows.length, 2);
  });

  it("keeps a distinct reserve pool that shares the main weekly numbers", () => {
    const windows = normalizeCodexRateLimits({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 15,
          windowDurationMins: 10080,
          resetsAt: 1731552000,
        },
        secondary: null,
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 15,
            windowDurationMins: 10080,
            resetsAt: 1731552000,
          },
          secondary: null,
        },
        base_model_inference: {
          limitId: "base_model_inference",
          limitName: "gpt-reserve",
          primary: {
            usedPercent: 15,
            windowDurationMins: 10080,
            resetsAt: 1731552000,
          },
          secondary: null,
        },
      },
    });
    const mainWeekly = windows.filter((w) => w.label === "weekly" && w.usedPercent === 15);
    assert.equal(mainWeekly.length, 1);
    const reserve = windows.find((w) => w.label === "gpt-reserve weekly");
    assert.ok(reserve);
    assert.equal(reserve.usedPercent, 15);
    assert.equal(reserve.windowSeconds, 10080 * 60);
    assert.equal(windows.length, 2);
  });

  it("omits a missing secondary instead of inventing 0%", () => {
    const windows = normalizeCodexRateLimits({
      rateLimits: {
        primary: {
          usedPercent: 10,
          windowDurationMins: 300,
          resetsAt: 1730947200,
        },
        secondary: null,
      },
    });
    assert.equal(windows.length, 1);
    assert.equal(windows[0].label, "5-hour");
    assert.equal(windows[0].usedPercent, 10);
  });

  it("skips invalid usedPercent and empty snapshots", () => {
    assert.deepEqual(normalizeCodexRateLimits(null), []);
    assert.deepEqual(normalizeCodexRateLimits({}), []);
    assert.deepEqual(
      normalizeCodexRateLimits({
        rateLimits: {
          primary: { usedPercent: "nope", windowDurationMins: 300 },
          secondary: { windowDurationMins: 10080 },
        },
      }),
      [],
    );
  });

  it("keeps over-100 percents and a real 0%; rejects NaN/Infinity/negative", () => {
    const over = normalizeCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 150, windowDurationMins: 300, resetsAt: 10 },
      },
    });
    assert.equal(over[0].usedPercent, 150);
    const zero = normalizeCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1 },
      },
    });
    assert.equal(zero[0].usedPercent, 0);
    assert.deepEqual(
      normalizeCodexRateLimits({
        rateLimits: { primary: { usedPercent: -1, windowDurationMins: 300 } },
      }),
      [],
    );
    assert.deepEqual(
      normalizeCodexRateLimits({
        rateLimits: { primary: { usedPercent: Number.NaN, windowDurationMins: 300 } },
      }),
      [],
    );
    assert.deepEqual(
      normalizeCodexRateLimits({
        rateLimits: {
          primary: { usedPercent: Number.POSITIVE_INFINITY, windowDurationMins: 300 },
        },
      }),
      [],
    );
  });
});

describe("normalizeGrokBilling", () => {
  it("maps live weekly currentPeriod without inventing 5-hour", () => {
    const windows = normalizeGrokBilling({
      config: {
        creditUsagePercent: 36.0,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-09-01T15:53:40.809746+00:00",
          end: "2026-09-08T15:53:40.809746+00:00",
        },
        onDemandCap: { val: 0 },
        billingPeriodStart: "2026-09-01T15:53:40.809746+00:00",
        billingPeriodEnd: "2026-10-01T15:53:40.809746+00:00",
      },
      subscription_tier: "SuperGrok Heavy",
    });
    assert.equal(windows.length, 1);
    assert.equal(windows[0].label, "weekly");
    assert.equal(windows[0].usedPercent, 36);
    assert.equal(windows[0].resetsAt, Date.parse("2026-09-08T15:53:40.809746+00:00"));
    assert.equal(windows[0].windowSeconds, 7 * 24 * 3600);
  });

  it("labels monthly from period type, not weekly", () => {
    const windows = normalizeGrokBilling({
      config: {
        creditUsagePercent: 10,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_MONTHLY",
          start: "2026-09-01T00:00:00Z",
          end: "2026-10-01T00:00:00Z",
        },
      },
    });
    assert.equal(windows[0].label, "monthly");
    assert.notEqual(windows[0].label, "weekly");
  });

  it("omits a payload with no creditUsagePercent instead of 0%", () => {
    assert.deepEqual(
      normalizeGrokBilling({
        config: {
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
        },
      }),
      [],
    );
  });
});

describe("toEpochMs", () => {
  it("converts seconds, ms, and ISO without inventing a time", () => {
    assert.equal(toEpochMs(1730947200), 1730947200000);
    assert.equal(toEpochMs(1730947200000), 1730947200000);
    assert.equal(toEpochMs("2026-04-11T07:00:00.000Z"), Date.parse("2026-04-11T07:00:00.000Z"));
    assert.equal(toEpochMs(null), null);
    assert.equal(toEpochMs(""), null);
    assert.equal(toEpochMs("not-a-date"), null);
  });
});

describe("fetchProviderLimits", () => {
  it("returns every real provider; Claude/Kimi inject so tests never require the managed file", async () => {
    const ids = knownProviderIds();
    assert.deepEqual(ids, [
      "claude",
      "codex",
      "grok",
      "opencode",
      "kimi",
      "cursor",
      "muse",
    ]);
    const rows = await fetchProviderLimits({
      fetchers: {
        claude: async () => ({
          provider: "claude",
          status: "unavailable",
          windows: [],
          fetchedAt: null,
          message: "usage unavailable",
        }),
        kimi: async () => ({
          provider: "kimi",
          status: "unavailable",
          windows: [],
          fetchedAt: null,
          message: "usage unavailable",
        }),
      },
    });
    assert.deepEqual(
      rows.map((r) => r.provider),
      ids,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.provider, r]));
    for (const row of rows) {
      assert.deepEqual(row.windows, []);
      assert.equal(row.fetchedAt, null);
    }
    assert.equal(byId.codex.status, "unavailable");
    assert.equal(byId.grok.status, "unavailable");
    assert.equal(byId.cursor.status, "unavailable");
    assert.equal(byId.opencode.status, "unavailable");
    assert.equal(byId.muse.status, "unavailable");
  });

  it("a missing managed module is an isolated error, not unsupported", async () => {
    const missing = Object.assign(new Error("Cannot find module './providerUsageManaged.js'"), {
      code: "MODULE_NOT_FOUND",
    });
    const rows = await fetchProviderLimits({
      fetchers: {
        claude: async () => {
          throw missing;
        },
        kimi: async () => {
          throw missing;
        },
      },
    });
    const byId = Object.fromEntries(rows.map((r) => [r.provider, r]));
    assert.equal(byId.claude.status, "error");
    assert.equal(byId.claude.message, MSG_FAILED);
    assert.equal(byId.kimi.status, "error");
    assert.equal(byId.kimi.message, MSG_FAILED);
    assert.notEqual(byId.cursor.status, "error");
    assert.match(byId.cursor.message, /no documented usage or quota command/i);
  });

  it("routes Claude/Kimi through injected fetchers", async () => {
    const rows = await fetchProviderLimits({
      fetchers: {
        claude: async () => ({
          provider: "claude",
          status: "ok",
          windows: [
            { label: "5-hour", usedPercent: 33, resetsAt: 1, windowSeconds: 18000 },
          ],
          fetchedAt: 9,
        }),
        kimi: async () => ({
          provider: "kimi",
          status: "unavailable",
          windows: [],
          fetchedAt: null,
          message: MSG_SIGNED_OUT,
        }),
      },
    });
    const byId = Object.fromEntries(rows.map((r) => [r.provider, r]));
    assert.equal(byId.claude.status, "ok");
    assert.equal(byId.claude.windows[0].usedPercent, 33);
    assert.equal(byId.kimi.status, "unavailable");
    assert.equal(byId.kimi.message, MSG_SIGNED_OUT);
    assert.equal(byId.cursor.status, "unavailable");
    assert.equal(byId.muse.status, "unavailable");
    assert.equal(byId.opencode.status, "unavailable");
  });

  it("keeps unsupported providers honest and isolates a thrown fetcher", async () => {
    const rows = await fetchProviderLimits({
      fetchers: {
        claude: async () => {
          throw new Error("Bearer sk-secret-should-not-leak-0123456789abcd boom");
        },
        kimi: async () => ({
          provider: "kimi",
          status: "ok",
          windows: [
            {
              label: "5-hour",
              usedPercent: 4,
              resetsAt: 1,
              windowSeconds: 18000,
            },
          ],
          fetchedAt: 99,
        }),
      },
    });
    const byId = Object.fromEntries(rows.map((r) => [r.provider, r]));
    assert.equal(rows.length, 7);
    assert.equal(byId.claude.status, "error");
    assert.equal(byId.claude.message, MSG_FAILED);
    assert.equal(String(JSON.stringify(byId.claude)).includes("sk-secret"), false);
    assert.equal(byId.kimi.status, "ok");
    assert.equal(byId.cursor.status, "unavailable");
    assert.match(byId.cursor.message, /no documented usage or quota command/i);
    assert.equal(byId.muse.status, "unavailable");
    assert.equal(byId.opencode.status, "unavailable");
  });
});

describe("injected fetchers", () => {
  it("does not HTTP-fetch Claude/Kimi when fetchers are injected", async () => {
    const rows = await fetchProviderLimits({
      fetchers: {
        claude: async () => ({
          provider: "claude",
          status: "ok",
          windows: [{ label: "weekly", usedPercent: 12, resetsAt: null, windowSeconds: 604800 }],
          fetchedAt: 3,
        }),
        kimi: async () => ({
          provider: "kimi",
          status: "unavailable",
          windows: [],
          fetchedAt: null,
          message: MSG_SIGNED_OUT,
        }),
      },
    });
    const byId = Object.fromEntries(rows.map((r) => [r.provider, r]));
    assert.equal(byId.claude.windows[0].label, "weekly");
    assert.equal(byId.kimi.message, MSG_SIGNED_OUT);
  });
});

describe("fetchCodex process lifecycle", () => {
  it("reads a live-shaped app-server handshake, pools byLimitId, and kills the child", async () => {
    const dir = tmp();
    const pidFile = path.join(dir, "pid");
    const bin = writeFakeBin(
      path.join(dir, "codex"),
      `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: "fake" } }) + "\\n");
  }
  if (msg.method === "account/rateLimits/read") {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: ${JSON.stringify(LIVE_CODEX)}
    }) + "\\n");
  }
});
`,
    );
    const row = await fetchCodex({
      env: { ...process.env, CODER_CODEX_BIN: bin },
      timeoutMs: 4000,
      nowMs: () => 7,
    });
    assert.equal(row.status, "ok");
    assert.ok(row.windows.some((w) => w.label === "weekly" && w.usedPercent === 15));
    assert.ok(row.windows.some((w) => w.label === "GPT-5.3-Codex-Spark 5-hour"));
    assert.equal(row.fetchedAt, 7);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitDead(pid);
  });

  it("times out, reports error, and kills a hung app-server", async () => {
    const dir = tmp();
    const pidFile = path.join(dir, "pid");
    const bin = writeFakeBin(
      path.join(dir, "codex"),
      `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 10000);
`,
    );
    const pending = fetchCodex({
      env: { ...process.env, CODER_CODEX_BIN: bin },
      cwd: dir,
      timeoutMs: 800,
      sigkillAfterMs: 100,
    });
    await waitFile(pidFile);
    const row = await pending;
    assert.equal(row.status, "error");
    assert.equal(row.message, MSG_TIMEOUT);
    assert.deepEqual(row.windows, []);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitDead(pid);
  });

  it("maps a child that exits before RPC as usage request failed and reaps it", async () => {
    const dir = tmp();
    const pidFile = path.join(dir, "pid");
    const bin = writeFakeBin(
      path.join(dir, "codex"),
      `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.exit(1);
`,
    );
    const row = await fetchCodex({
      env: { ...process.env, CODER_CODEX_BIN: bin },
      cwd: dir,
      timeoutMs: 4000,
      sigkillAfterMs: 100,
    });
    assert.equal(row.status, "error");
    assert.equal(row.message, MSG_FAILED);
    assert.deepEqual(row.windows, []);
    const dumped = JSON.stringify(row);
    assert.equal(dumped.includes("secret"), false);
    assert.equal(dumped.includes("token"), false);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitDead(pid);
  });

  it("treats authentication errors as unavailable, not 0%", async () => {
    const dir = tmp();
    const bin = writeFakeBin(
      path.join(dir, "codex"),
      `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
  }
  if (msg.method === "account/rateLimits/read") {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      error: { code: -32600, message: "codex account authentication required to read rate limits" }
    }) + "\\n");
  }
});
`,
    );
    const row = await fetchCodex({
      env: { ...process.env, CODER_CODEX_BIN: bin },
      timeoutMs: 4000,
    });
    assert.equal(row.status, "unavailable");
    assert.deepEqual(row.windows, []);
    assert.equal(row.message, MSG_SIGNED_OUT);
  });
});

describe("fetchGrok ACP billing", () => {
  it("calls _x.ai/billing after initialize and maps weekly usage", async () => {
    const dir = tmp();
    const pidFile = path.join(dir, "pid");
    const methodsFile = path.join(dir, "methods.json");
    const initFile = path.join(dir, "init.json");
    const bin = writeFakeBin(
      path.join(dir, "grok"),
      `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const methods = [];
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  methods.push(msg.method);
  fs.writeFileSync(${JSON.stringify(methodsFile)}, JSON.stringify(methods));
  if (msg.method === "initialize") {
    fs.writeFileSync(${JSON.stringify(initFile)}, JSON.stringify(msg.params || {}));
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
  }
  if (msg.method === "x.ai/billing") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: "method not found" } }) + "\\n");
  }
  if (msg.method === "_x.ai/billing") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        config: {
          creditUsagePercent: 36.0,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-09-01T15:53:40.809Z",
            end: "2026-09-08T15:53:40.809Z"
          }
        },
        subscription_tier: "SuperGrok Heavy"
      }
    }) + "\\n");
  }
});
`,
    );
    const row = await fetchGrok({
      env: { ...process.env, CODER_GROK_BIN: bin },
      cwd: dir,
      timeoutMs: 4000,
      nowMs: () => 11,
    });
    assert.equal(row.status, "ok");
    assert.equal(row.windows.length, 1);
    assert.equal(row.windows[0].label, "weekly");
    assert.equal(row.windows[0].usedPercent, 36);
    assert.equal(row.fetchedAt, 11);
    const methods = JSON.parse(fs.readFileSync(methodsFile, "utf8"));
    assert.ok(methods.includes("initialize"));
    assert.ok(methods.includes("_x.ai/billing"));
    assert.equal(methods.includes("x.ai/billing"), false);
    const init = JSON.parse(fs.readFileSync(initFile, "utf8"));
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.clientInfo.name, "solenta");
    assert.equal(init.clientInfo.version, "1");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitDead(pid);
  });

  it("times out and kills a hung grok agent", async () => {
    const dir = tmp();
    const pidFile = path.join(dir, "pid");
    const bin = writeFakeBin(
      path.join(dir, "grok"),
      `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 10000);
`,
    );
    const pending = fetchGrok({
      env: { ...process.env, CODER_GROK_BIN: bin },
      cwd: dir,
      timeoutMs: 800,
      sigkillAfterMs: 100,
    });
    await waitFile(pidFile);
    const row = await pending;
    assert.equal(row.status, "error");
    assert.equal(row.message, MSG_TIMEOUT);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitDead(pid);
  });
});
