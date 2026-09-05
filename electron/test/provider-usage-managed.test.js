"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  readClaudeUsage,
  readKimiUsage,
} = require("../providerUsageManaged.js");

function hashedClaudeService(dir) {
  const hash = crypto
    .createHash("sha256")
    .update(String(dir).normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const CLAUDE_TOKEN = "SECRET_CLAUDE_TOKEN_xyz";
const KIMI_TOKEN = "SECRET_KIMI_TOKEN_xyz";
const CLAUDE_RESET_ISO = "2026-09-05T17:00:00.000Z";
const WEEK_RESET_ISO = "2026-09-12T12:00:00.000Z";
const CLAUDE_RESET_MS = Date.parse(CLAUDE_RESET_ISO);
const WEEK_RESET_MS = Date.parse(WEEK_RESET_ISO);

const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

function jsonRes(body, extra = {}) {
  return {
    ok: extra.ok !== false,
    status: extra.status ?? 200,
    url: extra.url,
    json: async () => body,
  };
}

function claudeAccount(over = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: CLAUDE_TOKEN,
      refreshToken: "SECRET_CLAUDE_REFRESH",
      expiresAt: NOW + 60 * 60 * 1000,
      ...over,
    },
  });
}

function kimiAccount(over = {}) {
  return JSON.stringify({
    access_token: KIMI_TOKEN,
    refresh_token: "SECRET_KIMI_REFRESH",
    expires_at: NOW / 1000 + 3600,
    token_type: "Bearer",
    ...over,
  });
}

function claudeOpts(over = {}) {
  const { fetch, readFile, body, account, ...rest } = over;
  return {
    platform: "linux",
    env: {},
    home: "/tmp/solenta-claude-home-does-not-exist",
    now: NOW,
    readFile:
      readFile ||
      (async () => account || claudeAccount()),
    fetch:
      fetch ||
      (async () => jsonRes(body || {
        five_hour: { utilization: 36, resets_at: CLAUDE_RESET_ISO },
        seven_day: { utilization: 12, resets_at: WEEK_RESET_ISO },
      })),
    ...rest,
  };
}

function kimiOpts(over = {}) {
  const { fetch, readFile, body, account, ...rest } = over;
  return {
    platform: "linux",
    env: {},
    home: "/tmp/solenta-kimi-home-does-not-exist",
    now: NOW,
    readFile:
      readFile ||
      (async () => account || kimiAccount()),
    fetch:
      fetch ||
      (async () => jsonRes(body || {
        usage: {
          used: "40",
          limit: "1000",
          resetTime: WEEK_RESET_ISO,
        },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { used: "1", limit: "100", resetTime: CLAUDE_RESET_ISO },
          },
        ],
      })),
    ...rest,
  };
}

function leaked(result, ...secrets) {
  const dump = JSON.stringify(result);
  return secrets.some((s) => dump.includes(s));
}

describe("readClaudeUsage", () => {
  it("maps five_hour and seven_day utilization to 5-hour and weekly windows", async () => {
    const result = await readClaudeUsage(claudeOpts());
    assert.equal(result.provider, "claude");
    assert.equal(result.status, "ok");
    assert.equal(result.fetchedAt, NOW);
    assert.deepEqual(result.windows, [
      {
        label: "5-hour",
        usedPercent: 36,
        resetsAt: CLAUDE_RESET_MS,
        windowSeconds: FIVE_HOUR_SECONDS,
      },
      {
        label: "weekly",
        usedPercent: 12,
        resetsAt: WEEK_RESET_MS,
        windowSeconds: WEEK_SECONDS,
      },
    ]);
    assert.equal(result.message, undefined);
    assert.equal(leaked(result, CLAUDE_TOKEN, "SECRET_CLAUDE_REFRESH"), false);
  });

  it("maps seven_day_sonnet/opus when present and skips absent scoped windows", async () => {
    const result = await readClaudeUsage(
      claudeOpts({
        body: {
          five_hour: { utilization: 10, resets_at: CLAUDE_RESET_ISO },
          seven_day: { utilization: 20, resets_at: WEEK_RESET_ISO },
          seven_day_sonnet: { utilization: 55, resets_at: WEEK_RESET_ISO },
          seven_day_opus: null,
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.windows.map((w) => w.label),
      ["5-hour", "weekly", "weekly (Sonnet)"],
    );
    assert.equal(result.windows[2].usedPercent, 55);
    assert.equal(result.windows[2].windowSeconds, WEEK_SECONDS);
    assert.equal(
      result.windows.some((w) => w.label === "weekly (Opus)"),
      false,
    );
  });

  it("treats utilization 0 as 0%, not missing", async () => {
    const result = await readClaudeUsage(
      claudeOpts({
        body: {
          five_hour: { utilization: 0, resets_at: CLAUDE_RESET_ISO },
          seven_day: { utilization: 0, resets_at: WEEK_RESET_ISO },
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.windows[0].usedPercent, 0);
    assert.equal(result.windows[1].usedPercent, 0);
  });

  it("omits a window when utilization is missing or invalid, never filling 0%", async () => {
    const result = await readClaudeUsage(
      claudeOpts({
        body: {
          five_hour: { utilization: null, resets_at: CLAUDE_RESET_ISO },
          seven_day: { utilization: 41.2, resets_at: WEEK_RESET_ISO },
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].label, "weekly");
    assert.equal(result.windows[0].usedPercent, 41.2);
  });

  it("returns unavailable when every window is missing or unusable", async () => {
    const result = await readClaudeUsage(
      claudeOpts({
        body: {
          five_hour: { resets_at: CLAUDE_RESET_ISO },
          seven_day: { utilization: "n/a" },
          seven_day_opus: null,
        },
      }),
    );
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.windows, []);
    assert.equal(result.fetchedAt, null);
    assert.equal(result.message, "usage unavailable");
  });

  it("accepts used_percentage and unix-second resets_at", async () => {
    const result = await readClaudeUsage(
      claudeOpts({
        body: {
          five_hour: { used_percentage: "23.5", resets_at: 1738425600 },
          seven_day: { used_percentage: 10, resets_at: "1738857600" },
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.windows[0].usedPercent, 23.5);
    assert.equal(result.windows[0].resetsAt, 1738425600 * 1000);
    assert.equal(result.windows[1].resetsAt, 1738857600 * 1000);
  });

  it("nullable resetsAt when the reset field is absent or junk", async () => {
    const result = await readClaudeUsage(
      claudeOpts({
        body: {
          five_hour: { utilization: 10, resets_at: "not-a-date" },
          seven_day: { utilization: 11 },
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.windows[0].resetsAt, null);
    assert.equal(result.windows[1].resetsAt, null);
  });

  it("POSTs nothing and hits only the verified OAuth usage URL with redirect:error", async () => {
    let called = null;
    const result = await readClaudeUsage(
      claudeOpts({
        fetch: async (url, init) => {
          called = { url, init };
          return jsonRes({
            five_hour: { utilization: 1, resets_at: CLAUDE_RESET_ISO },
            seven_day: { utilization: 2, resets_at: WEEK_RESET_ISO },
          });
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(called.url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(called.init.method, "GET");
    assert.equal(called.init.redirect, "error");
    assert.equal(called.init.headers.Authorization, `Bearer ${CLAUDE_TOKEN}`);
    assert.equal(called.init.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(leaked(result, CLAUDE_TOKEN), false);
  });

  it("returns unavailable when no account file exists and does not fetch", async () => {
    let fetched = false;
    const result = await readClaudeUsage(
      claudeOpts({
        readFile: async () => {
          const err = new Error("ENOENT");
          err.code = "ENOENT";
          throw err;
        },
        fetch: async () => {
          fetched = true;
          return jsonRes({});
        },
      }),
    );
    assert.equal(result.status, "unavailable");
    assert.equal(result.message, "not signed in");
    assert.equal(result.fetchedAt, null);
    assert.deepEqual(result.windows, []);
    assert.equal(fetched, false);
  });

  it("returns unavailable for an expired account without fetching", async () => {
    let fetched = false;
    const result = await readClaudeUsage(
      claudeOpts({
        account: claudeAccount({ expiresAt: NOW - 1 }),
        fetch: async () => {
          fetched = true;
          return jsonRes({});
        },
      }),
    );
    assert.equal(result.status, "unavailable");
    assert.equal(result.message, "not signed in");
    assert.equal(fetched, false);
    assert.equal(leaked(result, CLAUDE_TOKEN), false);
  });

  it("maps 401/403 to unavailable, not a fake 0% window", async () => {
    const result = await readClaudeUsage(
      claudeOpts({
        fetch: async () => jsonRes({ error: "nope" }, { status: 401, ok: false }),
      }),
    );
    assert.equal(result.status, "unavailable");
    assert.equal(result.message, "not signed in");
    assert.deepEqual(result.windows, []);
  });

  it("maps HTTP failures to error with a fixed message and no secret leak", async () => {
    const result = await readClaudeUsage(
      claudeOpts({
        fetch: async () => {
          throw new Error(`Bearer ${CLAUDE_TOKEN} blew up`);
        },
      }),
    );
    assert.equal(result.status, "error");
    assert.equal(result.message, "usage request failed");
    assert.equal(leaked(result, CLAUDE_TOKEN, "blew up"), false);
  });

  it("maps timeouts to a fixed timeout error", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    const result = await readClaudeUsage(
      claudeOpts({
        fetch: async () => {
          throw err;
        },
      }),
    );
    assert.equal(result.status, "error");
    assert.equal(result.message, "request timed out");
  });

  it("rejects a redirected response instead of sending the token onward", async () => {
    const result = await readClaudeUsage(
      claudeOpts({
        fetch: async () => ({
          status: 302,
          ok: false,
          url: "https://evil.example/steal",
          json: async () => ({ five_hour: { utilization: 99 } }),
        }),
      }),
    );
    assert.equal(result.status, "error");
    assert.equal(result.message, "usage request failed");
    assert.deepEqual(result.windows, []);
  });

  it("reads a darwin keychain payload when injected, still never writes", async () => {
    let fetchedUrl = "";
    const result = await readClaudeUsage(
      claudeOpts({
        platform: "darwin",
        readFile: async () => {
          throw new Error("file should not be required");
        },
        readDarwinAccount: async () => claudeAccount(),
        fetch: async (url) => {
          fetchedUrl = url;
          return jsonRes({
            five_hour: { utilization: 8, resets_at: CLAUDE_RESET_ISO },
            seven_day: { utilization: 9, resets_at: WEEK_RESET_ISO },
          });
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(fetchedUrl, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(result.windows[0].usedPercent, 8);
  });

  it("does not fall back to a file account after an expired keychain token", async () => {
    let readFile = false;
    let fetched = false;
    const result = await readClaudeUsage(
      claudeOpts({
        platform: "darwin",
        readDarwinAccount: async () =>
          claudeAccount({ expiresAt: NOW - 1 }),
        readFile: async () => {
          readFile = true;
          return claudeAccount({ accessToken: "SECRET_FILE_TOKEN" });
        },
        fetch: async () => {
          fetched = true;
          return jsonRes({});
        },
      }),
    );
    assert.equal(result.status, "unavailable");
    assert.equal(result.message, "not signed in");
    assert.equal(readFile, false);
    assert.equal(fetched, false);
    assert.equal(leaked(result, CLAUDE_TOKEN, "SECRET_FILE_TOKEN"), false);
  });

  it("uses the hashed keychain service for a custom CLAUDE_CONFIG_DIR, never the default", async () => {
    const custom = "/tmp/solenta-custom-claude-home";
    let service = null;
    let account = null;
    const result = await readClaudeUsage(
      claudeOpts({
        platform: "darwin",
        home: custom,
        env: { CLAUDE_CONFIG_DIR: custom, USER: "tester" },
        execFile: (cmd, args, _opts, cb) => {
          assert.equal(cmd, "security");
          account = args[args.indexOf("-a") + 1];
          service = args[args.indexOf("-s") + 1];
          cb(new Error("item not found"));
        },
        readFile: async () => claudeAccount(),
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(account, "tester");
    assert.equal(service, hashedClaudeService(custom));
    assert.notEqual(service, "Claude Code-credentials");
  });

  it("uses the unhashed default service when CLAUDE_SECURESTORAGE_CONFIG_DIR is empty", async () => {
    const custom = "/tmp/solenta-custom-claude-home";
    let service = null;
    const result = await readClaudeUsage(
      claudeOpts({
        platform: "darwin",
        home: custom,
        env: {
          CLAUDE_CONFIG_DIR: custom,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
          USER: "tester",
        },
        execFile: (cmd, args, _opts, cb) => {
          assert.equal(cmd, "security");
          service = args[args.indexOf("-s") + 1];
          cb(new Error("item not found"));
        },
        readFile: async () => claudeAccount(),
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(service, "Claude Code-credentials");
    assert.notEqual(service, hashedClaudeService(custom));
  });

  it("keeps finite overage >100 and omits Infinity/negative percents", async () => {
    const result = await readClaudeUsage(
      claudeOpts({
        body: {
          five_hour: { utilization: Number.POSITIVE_INFINITY, resets_at: CLAUDE_RESET_ISO },
          seven_day: { utilization: 140, resets_at: WEEK_RESET_ISO },
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].label, "weekly");
    assert.equal(result.windows[0].usedPercent, 140);
    assert.equal(Number.isFinite(result.windows[0].usedPercent), true);

    const negative = await readClaudeUsage(
      claudeOpts({
        body: {
          five_hour: { utilization: -1, resets_at: CLAUDE_RESET_ISO },
          seven_day: { utilization: Number.NaN, resets_at: WEEK_RESET_ISO },
        },
      }),
    );
    assert.equal(negative.status, "unavailable");
    assert.deepEqual(negative.windows, []);
  });

  it("preserves timeout when json() aborts during the body read", async () => {
    const result = await readClaudeUsage(
      claudeOpts({
        timeoutMs: 30,
        fetch: async (_url, init) => ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_, reject) => {
              const fail = () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              };
              if (init && init.signal) {
                if (init.signal.aborted) return fail();
                init.signal.addEventListener("abort", fail, { once: true });
              }
            }),
        }),
      }),
    );
    assert.equal(result.status, "error");
    assert.equal(result.message, "request timed out");
    assert.deepEqual(result.windows, []);
  });
});

describe("readKimiUsage", () => {
  it("parses the official summary-plus-limits payload", async () => {
    const result = await readKimiUsage(kimiOpts());
    assert.equal(result.provider, "kimi");
    assert.equal(result.status, "ok");
    assert.equal(result.fetchedAt, NOW);
    assert.deepEqual(result.windows, [
      {
        label: "5-hour",
        usedPercent: 1,
        resetsAt: CLAUDE_RESET_MS,
        windowSeconds: FIVE_HOUR_SECONDS,
      },
      {
        label: "weekly",
        usedPercent: 4,
        resetsAt: WEEK_RESET_MS,
        windowSeconds: WEEK_SECONDS,
      },
    ]);
    assert.equal(leaked(result, KIMI_TOKEN, "SECRET_KIMI_REFRESH"), false);
  });

  it("folds TIME_UNIT_HOUR / DAY / WEEK into labeled windows", async () => {
    const result = await readKimiUsage(
      kimiOpts({
        body: {
          usage: { used: "2", limit: "10", resetTime: WEEK_RESET_ISO },
          limits: [
            {
              window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
              detail: { used: "3", limit: "10", resetTime: CLAUDE_RESET_ISO },
            },
            {
              window: { duration: 1, timeUnit: "TIME_UNIT_DAY" },
              detail: { used: "1", limit: "4", resetTime: WEEK_RESET_ISO },
            },
          ],
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.windows.map((w) => w.label),
      ["5-hour", "daily", "weekly"],
    );
    assert.equal(result.windows[1].usedPercent, 25);
    assert.equal(result.windows[1].windowSeconds, 86400);
  });

  it("skips rows with missing, null, or non-positive limit instead of reporting 0%", async () => {
    const result = await readKimiUsage(
      kimiOpts({
        body: {
          usage: { used: "40", limit: null, resetTime: WEEK_RESET_ISO },
          limits: [
            {
              window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
              detail: { used: "1", limit: "0", resetTime: CLAUDE_RESET_ISO },
            },
            {
              window: { duration: 1, timeUnit: "TIME_UNIT_WEEK" },
              detail: { used: "5", limit: "20", resetTime: WEEK_RESET_ISO },
            },
          ],
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].label, "weekly");
    assert.equal(result.windows[0].usedPercent, 25);
  });

  it("skips a row with used missing even when limit is present", async () => {
    const result = await readKimiUsage(
      kimiOpts({
        body: {
          usage: { limit: "1000", resetTime: WEEK_RESET_ISO },
          limits: [
            {
              window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
              detail: { used: "7", limit: "10", resetTime: CLAUDE_RESET_ISO },
            },
          ],
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].label, "5-hour");
    assert.equal(result.windows[0].usedPercent, 70);
  });

  it("treats used 0 with a positive limit as 0%, not unavailable", async () => {
    const result = await readKimiUsage(
      kimiOpts({
        body: {
          usage: { used: "0", limit: "1000", resetTime: WEEK_RESET_ISO },
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].usedPercent, 0);
    assert.equal(result.windows[0].label, "weekly");
  });

  it("returns unavailable when the payload has no valid used+limit pair", async () => {
    const result = await readKimiUsage(
      kimiOpts({
        body: {
          usage: { used: "1" },
          limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" } }],
        },
      }),
    );
    assert.equal(result.status, "unavailable");
    assert.equal(result.message, "usage unavailable");
    assert.deepEqual(result.windows, []);
    assert.equal(result.fetchedAt, null);
  });

  it("GETs only the verified kimi usages origin with redirect:error", async () => {
    let called = null;
    const result = await readKimiUsage(
      kimiOpts({
        fetch: async (url, init) => {
          called = { url, init };
          return jsonRes({
            usage: { used: "1", limit: "2", resetTime: WEEK_RESET_ISO },
          });
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(called.url, "https://api.kimi.com/coding/v1/usages");
    assert.equal(called.init.method, "GET");
    assert.equal(called.init.redirect, "error");
    assert.equal(called.init.headers.Authorization, `Bearer ${KIMI_TOKEN}`);
    assert.equal(leaked(result, KIMI_TOKEN), false);
  });

  it("returns unavailable when the account file is absent", async () => {
    let fetched = false;
    const result = await readKimiUsage(
      kimiOpts({
        readFile: async () => {
          const err = new Error("ENOENT");
          err.code = "ENOENT";
          throw err;
        },
        fetch: async () => {
          fetched = true;
          return jsonRes({});
        },
      }),
    );
    assert.equal(result.status, "unavailable");
    assert.equal(result.message, "not signed in");
    assert.equal(fetched, false);
  });

  it("returns unavailable for an expired kimi token without refreshing it", async () => {
    let fetched = false;
    const result = await readKimiUsage(
      kimiOpts({
        account: kimiAccount({ expires_at: NOW / 1000 - 10 }),
        fetch: async () => {
          fetched = true;
          return jsonRes({});
        },
      }),
    );
    assert.equal(result.status, "unavailable");
    assert.equal(result.message, "not signed in");
    assert.equal(fetched, false);
    assert.equal(leaked(result, KIMI_TOKEN), false);
  });

  it("maps 401 to unavailable and 500 to error, isolated from claude", async () => {
    const kimi401 = await readKimiUsage(
      kimiOpts({
        fetch: async () => jsonRes({}, { status: 401, ok: false }),
      }),
    );
    const kimi500 = await readKimiUsage(
      kimiOpts({
        fetch: async () => jsonRes({}, { status: 500, ok: false }),
      }),
    );
    const claudeOk = await readClaudeUsage(claudeOpts());
    assert.equal(kimi401.status, "unavailable");
    assert.equal(kimi401.message, "not signed in");
    assert.equal(kimi500.status, "error");
    assert.equal(kimi500.message, "usage request failed");
    assert.equal(claudeOk.status, "ok");
    assert.equal(claudeOk.windows.length, 2);
  });

  it("does not leak fetch error text or tokens", async () => {
    const result = await readKimiUsage(
      kimiOpts({
        fetch: async () => {
          throw new Error(`Authorization Bearer ${KIMI_TOKEN} from https://api.kimi.com/coding/v1/usages`);
        },
      }),
    );
    assert.equal(result.status, "error");
    assert.equal(result.message, "usage request failed");
    assert.equal(leaked(result, KIMI_TOKEN, "api.kimi.com", "Bearer"), false);
  });

  it("rejects a cross-origin redirect", async () => {
    const result = await readKimiUsage(
      kimiOpts({
        fetch: async () => ({
          status: 301,
          url: "https://attacker.example/usages",
          json: async () => ({ usage: { used: "1", limit: "1" } }),
        }),
      }),
    );
    assert.equal(result.status, "error");
    assert.deepEqual(result.windows, []);
  });

  it("times out a hung local account read", async () => {
    const result = await readKimiUsage(
      kimiOpts({
        readTimeoutMs: 20,
        readFile: () => new Promise(() => {}),
      }),
    );
    assert.equal(result.status, "error");
    assert.equal(result.message, "request timed out");
    assert.deepEqual(result.windows, []);
  });

  it("does not fabricate weekly for limits[] with missing or unknown timeUnit", async () => {
    const missing = await readKimiUsage(
      kimiOpts({
        body: {
          limits: [
            {
              window: { duration: 300 },
              detail: { used: "40", limit: "100", resetTime: WEEK_RESET_ISO },
            },
          ],
        },
      }),
    );
    assert.equal(missing.status, "unavailable");
    assert.deepEqual(missing.windows, []);
    assert.equal(missing.message, "usage unavailable");

    const unknown = await readKimiUsage(
      kimiOpts({
        body: {
          usage: { used: "1", limit: "10", resetTime: WEEK_RESET_ISO },
          limits: [
            {
              window: { duration: 300, timeUnit: "TIME_UNIT_FORTNIGHT" },
              detail: { used: "99", limit: "100", resetTime: CLAUDE_RESET_ISO },
            },
          ],
        },
      }),
    );
    assert.equal(unknown.status, "ok");
    assert.deepEqual(
      unknown.windows.map((w) => w.label),
      ["weekly"],
    );
    assert.equal(unknown.windows[0].usedPercent, 10);
  });

  it("rejects used/limit overflow that would become Infinity, never leaking it", async () => {
    const result = await readKimiUsage(
      kimiOpts({
        body: {
          usage: {
            used: Number.MAX_VALUE,
            limit: Number.MIN_VALUE,
            resetTime: WEEK_RESET_ISO,
          },
        },
      }),
    );
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.windows, []);
    assert.equal(JSON.stringify(result).includes("Infinity"), false);
    assert.equal(JSON.stringify(result).includes("null"), true);
  });

  it("keeps finite used/limit overage above 100", async () => {
    const result = await readKimiUsage(
      kimiOpts({
        body: {
          usage: { used: "150", limit: "100", resetTime: WEEK_RESET_ISO },
        },
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].usedPercent, 150);
    assert.equal(Number.isFinite(result.windows[0].usedPercent), true);
  });
});

describe("failure isolation", () => {
  it("a kimi failure does not poison a claude success in the same tick", async () => {
    const [kimi, claude] = await Promise.all([
      readKimiUsage(
        kimiOpts({
          fetch: async () => {
            throw new Error(`kimi down ${KIMI_TOKEN}`);
          },
        }),
      ),
      readClaudeUsage(claudeOpts()),
    ]);
    assert.equal(kimi.status, "error");
    assert.equal(claude.status, "ok");
    assert.equal(claude.windows[0].usedPercent, 36);
    assert.equal(leaked(kimi, KIMI_TOKEN, CLAUDE_TOKEN), false);
    assert.equal(leaked(claude, KIMI_TOKEN, CLAUDE_TOKEN), false);
  });
});
