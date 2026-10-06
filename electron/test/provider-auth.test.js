"use strict";

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const providerAuth = require("../providerAuth.js");
const terminal = require("../terminal.js");
const handlers = require("../ipc-devserver.js");

/**
 * Fake execFile: answers by the provider's status args, records calls.
 * Each reply is [exitCode, stdout, stderr?] or "spawn-error".
 */
function fakeExec(replies) {
  const calls = [];
  const fn = (bin, args, _opts, cb) => {
    calls.push([bin, ...args].join(" "));
    const key = args.join(" ");
    const reply = replies[key];
    if (reply === undefined || reply === "spawn-error") {
      const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      setImmediate(() => cb(err, "", ""));
      return;
    }
    const [code, stdout, stderr = ""] = reply;
    const err = code === 0 ? null : Object.assign(new Error("exit"), { code });
    setImmediate(() => cb(err, stdout, stderr));
  };
  return { fn, calls };
}

// Real outputs captured from the installed CLIs (see providerAuth.js).
const SIGNED_OUT = {
  "auth status --json": [1, '{"loggedIn": false, "authMethod": "none"}'],
  // codex prints its status on stderr.
  "login status": [1, "", "Not logged in\n"],
  "status --format json": [0, '{"status":"unauthenticated","isAuthenticated":false}'],
  "auth list": [0, "\x1b[0m\n┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n"],
};
const SIGNED_IN = {
  "auth status --json": [0, '{"loggedIn": true, "authMethod": "claude.ai"}'],
  "login status": [0, "", "Logged in using ChatGPT\n"],
  "status --format json": [0, '{"status":"authenticated","isAuthenticated":true}'],
  "auth list": [0, "└  2 credentials\n"],
};

describe("providerAuth", () => {
  beforeEach(() => providerAuth.reset());
  after(() => providerAuth.setExecFile(null));

  it("reads each CLI's signed-out answer; no-status CLIs stay unknown", async () => {
    providerAuth.setExecFile(fakeExec(SIGNED_OUT).fn);
    await providerAuth.refresh({ env: {} });
    assert.equal(providerAuth.get("claude"), "signedOut");
    assert.equal(providerAuth.get("codex"), "signedOut");
    assert.equal(providerAuth.get("cursor"), "signedOut");
    // Zero stored credentials may still mean env keys: never a guess.
    assert.equal(providerAuth.get("opencode"), "unknown");
    assert.equal(providerAuth.get("grok"), "unknown");
    assert.equal(providerAuth.get("kimi"), "unknown");
    assert.equal(providerAuth.get("muse"), "unknown");
  });

  it("reads signed-in answers", async () => {
    providerAuth.setExecFile(fakeExec(SIGNED_IN).fn);
    await providerAuth.refresh({ env: {} });
    for (const id of ["claude", "codex", "cursor", "opencode"]) {
      assert.equal(providerAuth.get(id), "signedIn", id);
    }
  });

  it("an API key in the env turns codex/cursor 'signed out' into unknown", async () => {
    providerAuth.setExecFile(fakeExec(SIGNED_OUT).fn);
    await providerAuth.refresh({ env: { OPENAI_API_KEY: "k", CURSOR_API_KEY: "k" } });
    assert.equal(providerAuth.get("codex"), "unknown");
    assert.equal(providerAuth.get("cursor"), "unknown");
    assert.equal(providerAuth.get("claude"), "signedOut");
  });

  it("spawn failures and unparseable output are unknown, not signed out", async () => {
    providerAuth.setExecFile(
      fakeExec({ "auth status --json": [1, "not json"], "login status": [2, "weird"] }).fn,
    );
    await providerAuth.refresh({ env: {} });
    assert.equal(providerAuth.get("claude"), "unknown");
    assert.equal(providerAuth.get("codex"), "unknown");
    assert.equal(providerAuth.get("cursor"), "unknown");
  });

  it("is absent before the first probe and rate-limits re-probes", async () => {
    const fake = fakeExec(SIGNED_IN);
    providerAuth.setExecFile(fake.fn);
    assert.equal(providerAuth.get("claude"), undefined);
    assert.equal(providerAuth.started(), false);
    await providerAuth.refresh({ env: {}, now: 1_000 });
    const first = fake.calls.length;
    assert.equal(first, 4);
    await providerAuth.refresh({ env: {}, now: 1_000 + providerAuth.TTL_MS - 1 });
    assert.equal(fake.calls.length, first, "inside the TTL: cached");
    providerAuth.invalidate();
    await providerAuth.refresh({ env: {}, now: 1_000 + providerAuth.TTL_MS - 1 });
    assert.equal(fake.calls.length, first * 2, "invalidate forces the next probe");
  });

  it("uses the bin override for both the probe and the login command", async () => {
    const fake = fakeExec(SIGNED_IN);
    providerAuth.setExecFile(fake.fn);
    await providerAuth.refresh({ env: { CODER_CLAUDE_BIN: "/opt/my claude" } });
    assert.ok(fake.calls.includes("/opt/my claude auth status --json"));
    assert.equal(
      providerAuth.loginCommand("claude", { env: { CODER_CLAUDE_BIN: "/opt/my claude" }, platform: "darwin" }),
      "'/opt/my claude' auth login",
    );
    assert.equal(
      providerAuth.loginCommand("claude", { env: { CODER_CLAUDE_BIN: "C:\\bin\\claude.exe" }, platform: "win32" }),
      '"C:\\bin\\claude.exe" auth login',
    );
    assert.equal(providerAuth.loginCommand("cursor", { env: {} }), "cursor-agent login");
    assert.equal(providerAuth.loginCommand("nope", { env: {} }), null);
  });
});

describe("terminal:signIn", () => {
  const skip = process.platform === "win32";
  after(() => terminal.killAll());

  it("types the login command into a dedicated home shell", { skip }, async () => {
    const saved = process.env.CODER_CODEX_BIN;
    // Stand-in binary: the test must never start a real login.
    process.env.CODER_CODEX_BIN = "/bin/echo";
    providerAuth.setExecFile(fakeExec(SIGNED_OUT).fn);
    await providerAuth.refresh({ env: {}, force: true });
    assert.equal(providerAuth.started(), true);
    try {
      const ctx = { store: { getThread: () => null }, broadcast: () => {} };
      const res = await handlers["terminal:signIn"](ctx, { provider: "codex" });
      assert.deepEqual(res, { threadId: "__signin__", termId: "signin" });
      let text = "";
      for (let i = 0; i < 200 && !/^login\r?$/m.test(text); i++) {
        await new Promise((r) => setTimeout(r, 25));
        text = (await handlers["terminal:read"](ctx, res)).text;
      }
      assert.match(text, /^login\r?$/m, `echo ran: ${JSON.stringify(text)}`);
      assert.equal(providerAuth.started(), false, "sign in invalidates the cache");
    } finally {
      providerAuth.setExecFile(null);
      if (saved === undefined) delete process.env.CODER_CODEX_BIN;
      else process.env.CODER_CODEX_BIN = saved;
    }
  });

  it("rejects unknown providers and unknown threads", async () => {
    const ctx = { store: { getThread: () => null }, broadcast: () => {} };
    await assert.rejects(handlers["terminal:signIn"](ctx, { provider: "rm -rf" }), /No sign-in command/);
    await assert.rejects(
      handlers["terminal:signIn"](ctx, { provider: "codex", threadId: "nope" }),
      /Unknown thread/,
    );
  });
});
