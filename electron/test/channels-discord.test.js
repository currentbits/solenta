/**
 * Discord chat channel (#1718) over the Gateway against a fake Discord: a
 * loopback WebSocket server plus an injected fetch. Never touches discord.com.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const { createSecrets } = require("../secrets.js");
const { redactSettings } = require("../mcp.js");
const { createChannels } = require("../channels/index.js");
const { createDiscord, INTENT_DIRECT_MESSAGES } = require("../channels/discord.js");
const { fakeDiscord, fakeRunner, waitFor } = require("./support/fakeChat.js");

const ME = "222";
const DM = "9222";
// Fake, built from parts so secret scanners never see a token-shaped literal.
const FAKE_DISCORD_BOT = ["MTIz", "discord-secret-token-xyz"].join(".");
const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

describe("discord channel", () => {
  let tmpDir;
  let store;
  let dc;
  let runner;
  let logs;
  let channels;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-discord-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([{ id: "p1", slug: "acme/app", name: "app", path: tmpDir }]);
    store.setSettings({ discord: { botToken: FAKE_DISCORD_BOT, allowedSenderIds: [ME], projectId: "p1" } });
    store.saveNow();
    dc = await fakeDiscord({ token: FAKE_DISCORD_BOT });
    runner = fakeRunner();
    logs = [];
    channels = createChannels({
      store,
      runner,
      fetch: dc.fetch,
      discordGatewayUrl: dc.gatewayUrl,
      log: (m) => logs.push(m),
      backoffMs: 60_000,
    });
    await channels.connect("discord");
    await waitFor(() => dc.logins.length === 1, "identify");
  });

  afterEach(async () => {
    await channels.stopAll();
    await dc.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("identifies with the DIRECT_MESSAGES intent only and persists enabled", () => {
    const [identify] = dc.logins;
    assert.equal(identify.op, 2);
    assert.equal(identify.d.token, FAKE_DISCORD_BOT);
    assert.equal(identify.d.intents, INTENT_DIRECT_MESSAGES);
    assert.equal(INTENT_DIRECT_MESSAGES, 4096);
    assert.deepEqual(channels.status().discord, { state: "connected", botUsername: "solenta_bot", error: null });
    assert.equal(store.getSettings().discord.enabled, true);
  });

  it("ignores senders off the allowlist and bots, never replies", async () => {
    dc.message("999", "rm -rf everything", "9999");
    dc.message("999", "again", "9999");
    dc.message(ME, "bot echo", DM, { author: { id: "1", bot: true } });
    dc.message(ME, "/status", DM);
    await waitFor(() => dc.sent.length === 1, "status reply");
    assert.equal(dc.sent[0].channel, DM);
    assert.equal(runner.starts.length, 0);
    assert.equal(logs.filter((l) => l.includes("999")).length, 1);
  });

  it("ignores guild messages even from an allowed sender", async () => {
    dc.message(ME, "deploy prod", "555", { guild_id: "777" });
    dc.message(ME, "again", "555", { guild_id: "777" });
    dc.message(ME, "/status", DM);
    await waitFor(() => dc.sent.length === 1, "status reply");
    assert.equal(runner.starts.length, 0);
    assert.ok(dc.sent.every((m) => m.channel === DM));
    assert.equal(logs.filter((l) => l.includes("555")).length, 1);
  });

  it("a DM creates a tagged thread; follow-ups continue and queue", async () => {
    dc.message(ME, "fix the login bug", DM);
    await waitFor(() => runner.starts.length === 1, "startRun");
    const [thread] = store.getThreads();
    assert.deepEqual(thread.channel, { kind: "discord", chatId: DM });
    assert.equal(thread.permissionMode, "default");
    assert.deepEqual(runner.starts[0], { threadId: thread.id, prompt: "fix the login bug" });
    dc.message(ME, "second", DM);
    await waitFor(() => runner.starts.length === 2);
    assert.equal(runner.starts[1].threadId, thread.id);
    runner.running.add(thread.id);
    dc.message(ME, "third while busy", DM);
    await waitFor(() => store.getThread(thread.id).queued != null, "queued");
    assert.equal(runner.starts.length, 2);
  });

  it("posts the result back in 2,000-char chunks that never ping anyone", async () => {
    dc.message(ME, "go", DM);
    await waitFor(() => runner.starts.length === 1);
    const id = runner.starts[0].threadId;
    const before = dc.sent.length;
    const text = "@everyone " + "a".repeat(4500);
    store.appendMessage(id, { id: "m1", role: "assistant", text, createdAt: Date.now() });
    channels.onThreadUpdate(store.getThread(id), "done");
    await waitFor(() => dc.sent.length === before + 3, "three chunks");
    const parts = dc.sent.slice(before);
    assert.ok(parts.every((p) => p.content.length <= 2000 && p.allowed_mentions.parse.length === 0));
    assert.equal(parts.map((p) => p.content).join(""), text);
  });

  it("approval buttons answer the interaction and call respondPermission; strangers and guild presses do nothing", async () => {
    dc.message(ME, "go", DM);
    await waitFor(() => runner.starts.length === 1);
    const id = runner.starts[0].threadId;
    runner.approvals = [{ threadId: id, requestId: "req-1", summary: "Bash: npm test", command: "npm test" }];
    channels.onThreadUpdate(store.getThread(id), "waiting");
    await waitFor(() => dc.sent.some((m) => m.components), "buttons");
    const msg = dc.sent.find((m) => m.components);
    assert.match(msg.content, /npm test/);
    const [allow, deny] = msg.components[0].components;
    assert.equal(msg.components[0].type, 1);
    assert.equal(allow.type, 2);
    assert.equal(allow.label, "Allow");
    assert.equal(deny.label, "Deny");

    dc.press("999", allow.custom_id, DM);
    dc.press(ME, allow.custom_id, "555", "777");
    const mine = dc.press(ME, allow.custom_id, DM);
    await waitFor(() => runner.responses.length === 1, "respondPermission");
    assert.deepEqual(runner.responses[0], { threadId: id, requestId: "req-1", decision: "allow" });
    await waitFor(() => dc.answered.length === 1, "callback");
    assert.deepEqual(dc.answered[0], { id: mine, token: `itok-${mine}`, type: 4, data: { content: "Allowed", flags: 64 } });
  });

  it("heartbeats with the last sequence and resumes on resume_gateway_url after a drop", async () => {
    dc.message(ME, "/status", DM);
    await waitFor(() => dc.sent.length === 1);
    const seq = dc.seq;
    dc.send({ op: 1 });
    await waitFor(() => dc.srv.received.some((m) => m.op === 1 && m.d === seq), "heartbeat with seq");
    dc.drop();
    await waitFor(() => dc.logins.length === 2, "resume");
    assert.deepEqual(dc.logins[1], { op: 6, d: { token: FAKE_DISCORD_BOT, session_id: "sess1", seq } });
    assert.match(dc.srv.paths[1], /^\/resume\/\?v=10&encoding=json$/);
    dc.message(ME, "/status", DM);
    await waitFor(() => dc.sent.length === 2, "still answering");
  });

  it("op 7 resumes; op 9 without resume re-identifies", async () => {
    dc.send({ op: 7, d: null });
    await waitFor(() => dc.logins.length === 2, "resume after reconnect");
    assert.equal(dc.logins[1].op, 6);
    await channels.stopAll();
    // Invalid session waits (scaled by backoffMs) before a fresh IDENTIFY.
    const st = [];
    const client = createDiscord({ token: FAKE_DISCORD_BOT, fetch: dc.fetch, gatewayUrl: dc.gatewayUrl, onMessage() {}, onButton() {}, onState: (s) => st.push(s), backoffMs: 5 });
    client.start();
    await waitFor(() => dc.logins.length === 3, "identify");
    dc.send({ op: 9, d: false });
    await waitFor(() => dc.logins.length === 4, "re-identify");
    assert.equal(dc.logins[3].op, 2);
    await client.stop();
  });

  it("disconnect closes the socket and leaves no timers", async () => {
    const baseline = timers();
    await channels.disconnect("discord");
    await waitFor(() => dc.srv.closes === 1, "server saw close");
    assert.equal(channels.status().discord.state, "off");
    assert.equal(store.getSettings().discord.enabled, false);
    // The heartbeat timer went with the socket.
    assert.ok(timers() < baseline, "heartbeat timer cleared");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(dc.srv.connections, 1, "no reconnect after disconnect");
  });

  it("a rejected token closes for good (4004) instead of retrying", async () => {
    dc.closeWith(4004);
    await waitFor(() => channels.status().discord.state === "error", "error state");
    assert.match(channels.status().discord.error, /4004/);
    assert.ok(!channels.status().discord.error.includes(FAKE_DISCORD_BOT));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(dc.srv.connections, 1);
  });
});

describe("discord settings", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-discord-set-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("seals the bot token on disk and never sends it to the renderer", () => {
    const secrets = createSecrets({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (p) => Buffer.from(`ENC(${p})`, "utf8"),
        decryptString: (b) => Buffer.from(b).toString("utf8").slice(4, -1),
      },
    });
    const file = path.join(tmpDir, "store.json");
    const store = new Store(file, { secrets });
    store.setSettings({ discord: { botToken: FAKE_DISCORD_BOT, allowedSenderIds: [ME] } });
    store.saveNow();
    const disk = fs.readFileSync(file, "utf8");
    assert.ok(!disk.includes("discord-secret-token-xyz"));
    assert.ok(JSON.parse(disk).settings.discord.botToken.startsWith("enc:v1:"));
    assert.equal(new Store(file, { secrets }).getSettings().discord.botToken, FAKE_DISCORD_BOT);
    const redacted = redactSettings(store.getSettings());
    assert.equal("botToken" in redacted.discord, false);
    assert.equal(redacted.discord.hasToken, true);
    store.setSettings({ discord: redacted.discord });
    assert.equal(store.getSettings().discord.botToken, FAKE_DISCORD_BOT);
  });

  it("rejects non-numeric user ids", () => {
    const store = new Store(path.join(tmpDir, "store.json"));
    assert.throws(() => store.setSettings({ discord: { allowedSenderIds: ["@me"] } }), /Discord user id must be a number/);
  });

  it("a bad token fails connect without echoing it and opens no socket", async () => {
    const store = new Store(path.join(tmpDir, "store.json"));
    const dc = await fakeDiscord({ token: "the-real-one" });
    try {
      store.setSettings({ discord: { botToken: FAKE_DISCORD_BOT, allowedSenderIds: [ME] } });
      const channels = createChannels({ store, runner: fakeRunner(), fetch: dc.fetch, discordGatewayUrl: dc.gatewayUrl, log() {} });
      await assert.rejects(channels.connect("discord"), (err) => {
        assert.match(err.message, /HTTP 401/);
        assert.ok(!err.message.includes(FAKE_DISCORD_BOT));
        return true;
      });
      assert.equal(dc.srv.connections, 0);
    } finally {
      await dc.close();
    }
  });
});
