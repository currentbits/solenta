/**
 * Slack chat channel (#1718) over Socket Mode against a fake Slack: a
 * loopback WebSocket server plus an injected fetch. Never touches slack.com.
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
const { fakeSlack, fakeTelegram, fakeRunner, waitFor } = require("./support/fakeChat.js");

const ME = "U0ME";
const DM = "D0ME";
// Fakes, built from parts so secret scanners never see a token-shaped literal.
const FAKE_SLACK_APP = ["xapp", "1", "A1", "secret", "app", "xyz"].join("-");
const FAKE_SLACK_BOT = ["xoxb", "1", "secret", "bot", "xyz"].join("-");
const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

describe("slack channel", () => {
  let tmpDir;
  let store;
  let slack;
  let runner;
  let logs;
  let channels;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-slack-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([{ id: "p1", slug: "acme/app", name: "app", path: tmpDir }]);
    store.setSettings({
      slack: { appToken: FAKE_SLACK_APP, botToken: FAKE_SLACK_BOT, allowedSenderIds: [ME], projectId: "p1" },
    });
    store.saveNow();
    slack = await fakeSlack({ appToken: FAKE_SLACK_APP, botToken: FAKE_SLACK_BOT });
    runner = fakeRunner();
    logs = [];
    channels = createChannels({ store, runner, fetch: slack.fetch, log: (m) => logs.push(m), backoffMs: 60_000 });
    await channels.connect("slack");
    await waitFor(() => slack.srv.sock, "socket");
  });

  afterEach(async () => {
    await channels.stopAll();
    await slack.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("connects as the bot over one socket and persists enabled", () => {
    assert.deepEqual(channels.status().slack, { state: "connected", botUsername: "solenta_bot", error: null });
    assert.deepEqual(channels.status().telegram.state, "off");
    assert.equal(store.getSettings().slack.enabled, true);
    // getMe's connections.open URL is the one the first socket uses.
    assert.equal(slack.opens, 1);
    assert.equal(slack.srv.connections, 1);
  });

  it("acks every envelope, ignores senders off the allowlist and never replies", async () => {
    const e1 = slack.message("U0STRANGER", "rm -rf everything", "D0STRANGER");
    slack.message("U0STRANGER", "again", "D0STRANGER");
    slack.message(ME, "/status", DM);
    await waitFor(() => slack.sent.length === 1, "status reply");
    assert.equal(slack.sent[0].channel, DM);
    assert.equal(runner.starts.length, 0);
    assert.equal(store.getThreads().length, 0);
    assert.ok(slack.acks.includes(e1));
    assert.equal(slack.acks.length, 3);
    assert.equal(logs.filter((l) => l.includes("U0STRANGER")).length, 1);
  });

  it("ignores channels, groups and multi-person DMs even from an allowed sender", async () => {
    slack.message(ME, "deploy prod", "C0PUBLIC", "channel");
    slack.message(ME, "again", "C0PUBLIC", "channel");
    slack.message(ME, "private group", "G0GROUP", "group");
    slack.message(ME, "mpim", "G0MPIM", "mpim");
    slack.message(ME, "/status", DM);
    await waitFor(() => slack.sent.length === 1, "status reply");
    assert.equal(runner.starts.length, 0);
    assert.ok(slack.sent.every((m) => m.channel === DM));
    assert.equal(logs.filter((l) => l.includes("C0PUBLIC")).length, 1);
  });

  it("ignores bot posts and edits, so its own replies never loop back", async () => {
    slack.message(ME, "from a bot", DM, "im", { bot_id: "B1" });
    slack.message(ME, "edited", DM, "im", { subtype: "message_changed" });
    slack.message(ME, "/status", DM);
    await waitFor(() => slack.sent.length === 1, "status reply");
    assert.equal(runner.starts.length, 0);
  });

  it("a DM creates a tagged thread and sends the unescaped prompt", async () => {
    slack.message(ME, "fix a &lt; b &amp;&amp; c &gt; d\nsecond line", DM);
    await waitFor(() => runner.starts.length === 1, "startRun");
    const [thread] = store.getThreads();
    assert.equal(thread.projectId, "p1");
    assert.deepEqual(thread.channel, { kind: "slack", chatId: DM });
    assert.equal(thread.permissionMode, "default");
    assert.deepEqual(runner.starts[0], { threadId: thread.id, prompt: "fix a < b && c > d\nsecond line" });
    assert.equal(store.getChannelState("slack").chats[DM], thread.id);
  });

  it("follow-ups continue the same thread and queue while it runs", async () => {
    slack.message(ME, "first", DM);
    await waitFor(() => runner.starts.length === 1);
    const id = runner.starts[0].threadId;
    slack.message(ME, "second", DM);
    await waitFor(() => runner.starts.length === 2);
    assert.equal(runner.starts[1].threadId, id);
    runner.running.add(id);
    slack.message(ME, "third while busy", DM);
    await waitFor(() => store.getThread(id).queued != null, "queued");
    assert.match(JSON.stringify(store.getThread(id).queued), /third while busy/);
    assert.equal(runner.starts.length, 2);
  });

  it("posts the result back as plain, escaped text in 3,500-char chunks", async () => {
    slack.message(ME, "go", DM);
    await waitFor(() => runner.starts.length === 1);
    const id = runner.starts[0].threadId;
    const before = slack.sent.length;
    const text = "<b>&</b>" + "a".repeat(5000);
    store.appendMessage(id, { id: "m1", role: "assistant", text, createdAt: Date.now() });
    channels.onThreadUpdate(store.getThread(id), "done");
    await waitFor(() => slack.sent.length === before + 2, "two chunks");
    const parts = slack.sent.slice(before);
    assert.ok(parts.every((p) => p.mrkdwn === false && p.channel === DM));
    assert.ok(parts[0].text.startsWith("&lt;b&gt;&amp;&lt;/b&gt;"));
    const unescaped = parts.map((p) => p.text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    assert.ok(unescaped.every((p) => p.length <= 3500));
    assert.equal(unescaped.join(""), text);
  });

  it("approval buttons call respondPermission; strangers and channel presses do nothing", async () => {
    slack.message(ME, "go", DM);
    await waitFor(() => runner.starts.length === 1);
    const id = runner.starts[0].threadId;
    runner.approvals = [{ threadId: id, requestId: "req-1", summary: "Bash: npm test", command: "npm test" }];
    channels.onThreadUpdate(store.getThread(id), "waiting");
    await waitFor(() => slack.sent.some((m) => m.blocks), "buttons");
    const msg = slack.sent.find((m) => m.blocks);
    assert.match(msg.blocks[0].text.text, /npm test/);
    const [allow, deny] = msg.blocks[1].elements;
    assert.equal(allow.text.text, "Allow");
    assert.equal(deny.text.text, "Deny");

    slack.press("U0STRANGER", allow.value, DM);
    slack.press(ME, allow.value, "C0PUBLIC");
    slack.press(ME, allow.value, DM);
    await waitFor(() => runner.responses.length === 1, "respondPermission");
    assert.deepEqual(runner.responses[0], { threadId: id, requestId: "req-1", decision: "allow" });
    await waitFor(() => slack.sent.some((m) => m.text === "Allowed"), "answer");
    // A used button is spent.
    slack.press(ME, allow.value, DM);
    await waitFor(() => slack.sent.some((m) => /expired/.test(m.text)), "expired");
    assert.equal(runner.responses.length, 1);
  });

  it("disconnect closes the socket and leaves no timers", async () => {
    const baseline = timers();
    await channels.disconnect("slack");
    await waitFor(() => slack.srv.closes === 1, "server saw close");
    assert.equal(channels.status().slack.state, "off");
    assert.equal(store.getSettings().slack.enabled, false);
    assert.ok(timers() <= baseline);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(slack.srv.connections, 1, "no reconnect after disconnect");
  });

  it("reconnects on a fresh URL after a drop and after a disconnect message", async () => {
    slack.drop();
    await waitFor(() => slack.srv.connections === 2, "reconnect after drop");
    assert.equal(slack.opens, 2);
    slack.disconnect("refresh_requested");
    await waitFor(() => slack.srv.connections === 3, "reconnect after refresh");
    assert.equal(slack.opens, 3);
    slack.message(ME, "/status", DM);
    await waitFor(() => slack.sent.length === 1, "still answering");
    assert.equal(channels.status().slack.state, "connected");
  });
});

describe("slack settings", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-slack-set-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("seals both tokens on disk and never sends them to the renderer", () => {
    const secrets = createSecrets({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (p) => Buffer.from(`ENC(${p})`, "utf8"),
        decryptString: (b) => Buffer.from(b).toString("utf8").slice(4, -1),
      },
    });
    const file = path.join(tmpDir, "store.json");
    const store = new Store(file, { secrets });
    store.setSettings({ slack: { appToken: FAKE_SLACK_APP, botToken: FAKE_SLACK_BOT, allowedSenderIds: ["u0me"] } });
    store.saveNow();
    const disk = fs.readFileSync(file, "utf8");
    assert.ok(!disk.includes("secret-app-xyz") && !disk.includes("secret-bot-xyz"));
    const saved = JSON.parse(disk).settings.slack;
    assert.ok(saved.appToken.startsWith("enc:v1:") && saved.botToken.startsWith("enc:v1:"));
    const reloaded = new Store(file, { secrets }).getSettings().slack;
    assert.equal(reloaded.appToken, FAKE_SLACK_APP);
    assert.equal(reloaded.botToken, FAKE_SLACK_BOT);
    assert.deepEqual(reloaded.allowedSenderIds, ["U0ME"]);

    const redacted = redactSettings(store.getSettings());
    assert.equal("botToken" in redacted.slack || "appToken" in redacted.slack, false);
    assert.equal(redacted.slack.hasToken, true);
    assert.equal(redacted.slack.hasAppToken, true);
    store.setSettings({ slack: redacted.slack });
    assert.equal(store.getSettings().slack.appToken, FAKE_SLACK_APP);
    assert.equal(store.getSettings().slack.botToken, FAKE_SLACK_BOT);
  });

  it("rejects swapped tokens and bad member ids", () => {
    const store = new Store(path.join(tmpDir, "store.json"));
    assert.throws(() => store.setSettings({ slack: { botToken: FAKE_SLACK_APP } }), /must start with xoxb-/);
    assert.throws(() => store.setSettings({ slack: { appToken: FAKE_SLACK_BOT } }), /must start with xapp-/);
    assert.throws(() => store.setSettings({ slack: { allowedSenderIds: ["@me"] } }), /Slack member id/);
  });

  it("connect needs both tokens and an allowlist; a bad token's error never echoes it", async () => {
    const store = new Store(path.join(tmpDir, "store.json"));
    const slack = await fakeSlack({ appToken: FAKE_SLACK_APP, botToken: ["xoxb", "the", "real", "one"].join("-") });
    try {
      const channels = createChannels({ store, runner: fakeRunner(), fetch: slack.fetch, log() {} });
      store.setSettings({ slack: { botToken: FAKE_SLACK_BOT } });
      await assert.rejects(channels.connect("slack"), /both tokens/);
      store.setSettings({ slack: { appToken: FAKE_SLACK_APP } });
      await assert.rejects(channels.connect("slack"), /allowed sender/);
      store.setSettings({ slack: { allowedSenderIds: [ME] } });
      await assert.rejects(channels.connect("slack"), (err) => {
        assert.match(err.message, /invalid_auth/);
        assert.ok(!err.message.includes(FAKE_SLACK_BOT));
        return true;
      });
      assert.equal(channels.status().slack.state, "error");
      assert.equal(slack.srv.connections, 0);
    } finally {
      await slack.close();
    }
  });
});

describe("channels across kinds", () => {
  it("runs Telegram and Slack at once and routes each thread to its own chat", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-multi-"));
    const store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([{ id: "p1", slug: "acme/app", name: "app", path: tmpDir }]);
    store.setSettings({
      telegram: { botToken: "123:tg", allowedSenderIds: ["111"], projectId: "p1" },
      slack: { appToken: FAKE_SLACK_APP, botToken: FAKE_SLACK_BOT, allowedSenderIds: [ME], projectId: "p1" },
    });
    const tg = fakeTelegram();
    const slack = await fakeSlack({ appToken: FAKE_SLACK_APP, botToken: FAKE_SLACK_BOT });
    const fetch = (url, init) => (String(url).includes("api.telegram.org") ? tg.fetch(url, init) : slack.fetch(url, init));
    const runner = fakeRunner();
    const channels = createChannels({ store, runner, fetch, log() {}, backoffMs: 60_000 });
    try {
      await channels.connect("telegram");
      await channels.connect("slack");
      await waitFor(() => slack.srv.sock, "socket");
      assert.equal(channels.status().telegram.state, "connected");
      assert.equal(channels.status().slack.state, "connected");

      tg.message("111", "telegram task");
      slack.message(ME, "slack task", DM);
      await waitFor(() => runner.starts.length === 2, "both threads");
      const byKind = Object.fromEntries(store.getThreads().map((t) => [t.channel.kind, t]));
      assert.equal(byKind.telegram.channel.chatId, "111");
      assert.equal(byKind.slack.channel.chatId, DM);

      const tgBefore = tg.sent.length;
      const slackBefore = slack.sent.length;
      store.appendMessage(byKind.slack.id, { id: "s1", role: "assistant", text: "slack result", createdAt: Date.now() });
      store.appendMessage(byKind.telegram.id, { id: "t1", role: "assistant", text: "telegram result", createdAt: Date.now() });
      channels.onThreadUpdate(store.getThread(byKind.slack.id), "done");
      channels.onThreadUpdate(store.getThread(byKind.telegram.id), "done");
      await waitFor(() => slack.sent.length === slackBefore + 1 && tg.sent.length === tgBefore + 1, "results");
      assert.equal(slack.sent.at(-1).text, "slack result");
      assert.equal(tg.sent.at(-1).text, "telegram result");

      // Disconnecting one kind leaves the other running.
      await channels.disconnect("slack");
      assert.equal(channels.status().slack.state, "off");
      assert.equal(channels.status().telegram.state, "connected");
    } finally {
      await channels.stopAll();
      await slack.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
