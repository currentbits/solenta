"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isQuotaLike,
  isContextOverflow,
  classifyContextOverflow,
  classifyCliUpgrade,
  parseQuotaError,
  quotaWaitEnabled,
  decideQuotaWait,
  formatQuotaWaitClock,
  MAX_WAIT_MS,
} = require("../quotaWait.js");

// Tuesday 2026-08-18 10:00 local — afternoon clocks stay same-day.
const NOW = new Date(2026, 7, 18, 10, 0, 0, 0).getTime();

describe("isQuotaLike", () => {
  it("matches Claude / Codex / Kimi quota language", () => {
    assert.equal(isQuotaLike("You've hit your limit · resets 3pm"), true);
    assert.equal(isQuotaLike("Claude usage limit reached. Your limit will reset at 3pm"), true);
    assert.equal(isQuotaLike("5-hour limit reached ∙ resets 3am"), true);
    assert.equal(isQuotaLike("rate_limit_error: 429 Too Many Requests"), true);
    assert.equal(isQuotaLike("You exceeded your current quota, please check your plan"), true);
    assert.equal(isQuotaLike("insufficient credits, please top up"), true);
    assert.equal(isQuotaLike("account quota or balance is exhausted"), true);
  });

  it("does not match Solenta's own budget cap (#286)", () => {
    assert.equal(isQuotaLike("Daily budget of $1.00 reached"), false);
    assert.equal(isQuotaLike("Orchestration budget exceeded"), false);
    assert.equal(isQuotaLike("Crew auto-turn cap reached (25 consecutive machine-delivered turns)"), false);
  });

  it("does not match ordinary run errors", () => {
    assert.equal(isQuotaLike("Run error (exit 1): spawn claude ENOENT"), false);
    assert.equal(isQuotaLike(""), false);
    assert.equal(isQuotaLike(null), false);
  });
});

describe("isContextOverflow", () => {
  it("matches structured and provider overflow language", () => {
    const positives = [
      "context_length_exceeded",
      "Prompt is too long",
      "maximum context length exceeded",
      "This model's maximum context length is 128000 tokens",
      "Your input exceeds the context window of this model",
      "request is too long for the model context window",
      "context window is full",
      "Context window full",
      "Error: context window is full, please start a new conversation",
    ];
    for (const text of positives) {
      assert.equal(isContextOverflow(text), true, text);
    }
  });

  it("matches narrow current Codex and OpenCode overflow phrases", () => {
    assert.equal(
      isContextOverflow(
        "Codex ran out of room in the model's context window. Start a new conversation.",
      ),
      true,
    );
    assert.equal(
      isContextOverflow(
        "input length and max_tokens exceed context limit: 131072 tokens",
      ),
      true,
    );
  });

  it("rejects quota, output-token, budget, and generic size errors", () => {
    const negatives = [
      "You've hit your session limit · resets 3pm",
      "rate_limit_error: 429 Too Many Requests",
      "Daily budget of $1.00 reached",
      "max_tokens must be less than 4096",
      "output token limit reached",
      "Request entity too large",
      "Run error (exit 1): spawn claude ENOENT",
      "The context window setting was changed; note it is not full yet.",
      "context window usage: 40% full",
      "Codex ran out of room in the model queue; quota resets at 3pm",
      "Codex has room in the model's context window; output token limit reached",
      "output length and max_tokens exceed context limit",
      "input length and max_tokens exceed output token limit",
      "",
      null,
    ];
    for (const text of negatives) {
      assert.equal(isContextOverflow(text), false, String(text));
    }
  });

  it("normalizes overflow while retaining short provider detail", () => {
    const parsed = classifyContextOverflow(
      "Run error: context_length_exceeded\nrequest had 250000 tokens\nignored tail",
    );
    assert.deepEqual(parsed, {
      kind: "context-overflow",
      text:
        "Context window is full. Fork to fresh context or rewind the last turn.\n" +
        "Provider error: Run error: context_length_exceeded\nrequest had 250000 tokens",
    });
    assert.equal(classifyContextOverflow("Run error: connection refused"), null);
  });
});

describe("classifyCliUpgrade", () => {
  it("matches the Codex newer-version 400 and keeps a short provider line", () => {
    const parsed = classifyCliUpgrade(
      `{"type":"error","status":400,"error":{"message":"The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}`,
    );
    assert.equal(parsed && parsed.kind, "cli-upgrade");
    assert.match(parsed.text, /codex update/);
    assert.match(parsed.text, /gpt-5\.6-sol/);
  });

  it("rejects overflow, quota, and ordinary spawn errors", () => {
    assert.equal(classifyCliUpgrade("Context window is full"), null);
    assert.equal(classifyCliUpgrade("You've hit your limit · resets 3pm"), null);
    assert.equal(classifyCliUpgrade("Run error (exit 1): spawn codex ENOENT"), null);
    assert.equal(classifyCliUpgrade(""), null);
  });
});

describe("parseQuotaError", () => {
  it("parses Claude clock resets as kind=reset", () => {
    const a = parseQuotaError("You've hit your limit · resets 3pm", NOW);
    assert.ok(a);
    assert.equal(a.kind, "reset");
    assert.equal(a.resetAt, new Date(2026, 7, 18, 15, 0, 0, 0).getTime());

    const b = parseQuotaError(
      "Claude usage limit reached. Your limit will reset at 3:05pm",
      NOW,
    );
    assert.equal(b.kind, "reset");
    assert.equal(b.resetAt, new Date(2026, 7, 18, 15, 5, 0, 0).getTime());
  });

  it("rolls a past clock to tomorrow", () => {
    const parsed = parseQuotaError("You've hit your session limit resets 3am", NOW);
    assert.equal(parsed.kind, "reset");
    assert.equal(parsed.resetAt, new Date(2026, 7, 19, 3, 0, 0, 0).getTime());
  });

  it("parses a named timezone", () => {
    const parsed = parseQuotaError(
      "You've hit your session limit resets 3pm (America/New_York)",
      NOW,
    );
    assert.equal(parsed.kind, "reset");
    assert.ok(Number.isFinite(parsed.resetAt));
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(parsed.resetAt));
    const hour = Number(parts.find((p) => p.type === "hour").value);
    assert.equal(hour, 15);
  });

  it("parses dated weekly resets", () => {
    const parsed = parseQuotaError(
      "Opus weekly limit reached ∙ resets Oct 6, 1pm",
      NOW,
    );
    assert.equal(parsed.kind, "reset");
    assert.equal(parsed.resetAt, new Date(2026, 9, 6, 13, 0, 0, 0).getTime());
  });

  it("parses ISO timestamps and durations", () => {
    const iso = parseQuotaError(
      "usage limit reached, resets at 2026-08-18T15:00:00-04:00",
      NOW,
    );
    assert.equal(iso.kind, "reset");
    assert.equal(iso.resetAt, Date.parse("2026-08-18T15:00:00-04:00"));

    const dur = parseQuotaError("You've hit your session limit resets in 4h", NOW);
    assert.equal(dur.kind, "reset");
    assert.equal(dur.resetAt, NOW + 4 * 60 * 60 * 1000);

    const retry = parseQuotaError(
      "rate_limit_error Retry-After: 20 try again later",
      NOW,
    );
    assert.equal(retry.kind, "reset");
    assert.equal(retry.resetAt, NOW + 20_000);
  });

  it("treats exhausted balance with no clock as exhausted", () => {
    const parsed = parseQuotaError(
      "account quota or balance is exhausted. Please top up.",
      NOW,
    );
    assert.deepEqual(parsed, { kind: "exhausted", resetAt: null });
  });

  it("returns null for non-quota errors", () => {
    assert.equal(parseQuotaError("Run error: spawn claude ENOENT", NOW), null);
    assert.equal(parseQuotaError("Daily budget of $1.00 reached", NOW), null);
  });
});

describe("decideQuotaWait", () => {
  const text = "You've hit your limit · resets 3pm";
  const settingsOn = { quotaWaitAutoResume: true };

  it("parks when there is a reset clock and auto-resume is on", () => {
    const d = decideQuotaWait({ text, thread: {}, settings: settingsOn, now: NOW });
    assert.deepEqual(d, { until: new Date(2026, 7, 18, 15, 0, 0, 0).getTime() });
  });

  it("does not park an exhausted balance (no clock)", () => {
    assert.equal(
      decideQuotaWait({
        text: "insufficient credits, please top up",
        thread: {},
        settings: settingsOn,
        now: NOW,
      }),
      null,
    );
  });

  it("does not park Solenta's own budget (#286)", () => {
    assert.equal(
      decideQuotaWait({
        text: "Daily budget of $1.00 reached",
        thread: {},
        settings: settingsOn,
        now: NOW,
      }),
      null,
    );
  });

  it("does not park after a one-shot resume (wake once)", () => {
    assert.equal(
      decideQuotaWait({
        text,
        thread: { quotaWaitResumed: true },
        settings: settingsOn,
        now: NOW,
      }),
      null,
    );
  });

  it("honors global and per-thread opt-out", () => {
    assert.equal(
      decideQuotaWait({
        text,
        thread: {},
        settings: { quotaWaitAutoResume: false },
        now: NOW,
      }),
      null,
    );
    assert.equal(
      decideQuotaWait({
        text,
        thread: { quotaWaitAutoResume: false },
        settings: settingsOn,
        now: NOW,
      }),
      null,
    );
    const forced = decideQuotaWait({
      text,
      thread: { quotaWaitAutoResume: true },
      settings: { quotaWaitAutoResume: false },
      now: NOW,
    });
    assert.ok(forced && forced.until);
  });

  it("refuses a reset further than MAX_WAIT_MS", () => {
    const far = NOW + MAX_WAIT_MS + 60_000;
    const iso = new Date(far).toISOString();
    assert.equal(
      decideQuotaWait({
        text: `usage limit reached, resets at ${iso}`,
        thread: {},
        settings: settingsOn,
        now: NOW,
      }),
      null,
    );
  });
});

describe("quotaWaitEnabled / formatQuotaWaitClock", () => {
  it("inherits the global default (on) unless the thread overrides", () => {
    assert.equal(quotaWaitEnabled({}, { quotaWaitAutoResume: true }), true);
    assert.equal(quotaWaitEnabled({}, { quotaWaitAutoResume: false }), false);
    assert.equal(quotaWaitEnabled({}, {}), true);
    assert.equal(
      quotaWaitEnabled({ quotaWaitAutoResume: false }, { quotaWaitAutoResume: true }),
      false,
    );
  });

  it("labels same-day, tomorrow, and weekday wakes", () => {
    assert.equal(
      formatQuotaWaitClock(new Date(2026, 7, 18, 15, 0, 0, 0).getTime(), NOW),
      "3pm",
    );
    assert.equal(
      formatQuotaWaitClock(new Date(2026, 7, 19, 9, 0, 0, 0).getTime(), NOW),
      "tomorrow 9am",
    );
    assert.match(
      formatQuotaWaitClock(new Date(2026, 7, 20, 9, 30, 0, 0).getTime(), NOW),
      /9:30am/,
    );
  });
});
