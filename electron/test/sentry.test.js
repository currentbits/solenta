"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolveSentryAuthToken, fetchProjectIssues } = require("../sentry.js");

describe("resolveSentryAuthToken", () => {
  it("prefers opts, then SENTRY_AUTH_TOKEN", () => {
    const prev = process.env.SENTRY_AUTH_TOKEN;
    process.env.SENTRY_AUTH_TOKEN = "env_tok";
    try {
      assert.equal(resolveSentryAuthToken({ sentryAuthToken: " set " }), "set");
      assert.equal(resolveSentryAuthToken({}), "env_tok");
    } finally {
      if (prev == null) delete process.env.SENTRY_AUTH_TOKEN;
      else process.env.SENTRY_AUTH_TOKEN = prev;
    }
  });
});

describe("fetchProjectIssues", () => {
  it("throws when the token is missing", async () => {
    await assert.rejects(
      () => fetchProjectIssues({ org: "acme", project: "pump", token: "" }),
      /no auth token \(Settings → Git\)/,
    );
  });

  it("GETs sentry.io with sort=new and optional environment", async () => {
    const seen = [];
    const rows = [{ firstSeen: "2026-10-11T00:00:00Z", shortId: "P-1" }];
    const out = await fetchProjectIssues({
      org: "acme",
      project: "pump",
      environment: "prod",
      token: "tok",
      fetch: async (url, init) => {
        seen.push({ url: String(url), init });
        return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
      },
    });
    assert.deepEqual(out, rows);
    assert.match(seen[0].url, /^https:\/\/sentry\.io\/api\/0\/projects\/acme\/pump\/issues\/\?/);
    assert.match(seen[0].url, /sort=new/);
    assert.match(seen[0].url, /limit=50/);
    assert.match(seen[0].url, /statsPeriod=/);
    assert.match(decodeURIComponent(seen[0].url), /is:unresolved environment:prod/);
    assert.equal(seen[0].init.headers.Authorization, "Bearer tok");
  });

  it("maps 401 to auth", async () => {
    await assert.rejects(
      () =>
        fetchProjectIssues({
          org: "a",
          project: "b",
          token: "t",
          fetch: async () => ({ ok: false, status: 401, text: async () => "" }),
        }),
      (err) => err && err.code === "auth",
    );
  });
});
