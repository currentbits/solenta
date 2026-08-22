/**
 * At-rest credential encryption (issue #543).
 *
 * Disk holds Electron safeStorage ciphertext; memory stays plaintext.
 * A missing OS keychain must warn, never silently look encrypted.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  PREFIX,
  createSecrets,
  getDefaultSecrets,
} = require("../secrets.js");
const { Store, SAVE_DEBOUNCE_MS } = require("../store.js");
const { createOtel } = require("../otel.js");
const {
  registerMcpServer,
  resetMemorySupForTests,
} = require("../memory-sup.js");

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(plain) {
      return Buffer.from(`ENC(${plain})`, "utf8");
    },
    decryptString(buf) {
      const s = Buffer.from(buf).toString("utf8");
      if (!s.startsWith("ENC(") || !s.endsWith(")")) {
        throw new Error("bad cipher");
      }
      return s.slice(4, -1);
    },
  };
}

describe("createSecrets", () => {
  it("round-trips a string through the enc:v1 envelope", () => {
    const s = createSecrets({ safeStorage: fakeSafeStorage() });
    const sealed = s.seal("sk-live-token");
    assert.ok(sealed.startsWith(PREFIX));
    assert.ok(!sealed.includes("sk-live-token"));
    assert.equal(s.open(sealed), "sk-live-token");
    assert.equal(s.isSealed(sealed), true);
    assert.equal(s.isSealed("sk-live-token"), false);
  });

  it("open() leaves plaintext alone so a pre-upgrade store can load", () => {
    const s = createSecrets({ safeStorage: fakeSafeStorage() });
    assert.equal(s.open("already-plain"), "already-plain");
  });

  it("seal() is idempotent: already-sealed values are not wrapped again", () => {
    const s = createSecrets({ safeStorage: fakeSafeStorage() });
    const sealed = s.seal("tok");
    assert.equal(s.seal(sealed), sealed);
    assert.equal(s.open(s.seal(sealed)), "tok");
  });

  it("warns once and writes plaintext when encryption is unavailable in Electron", () => {
    const logs = [];
    const s = createSecrets({
      safeStorage: { isEncryptionAvailable: () => false },
      inElectron: true,
      log: (m) => logs.push(String(m)),
    });
    assert.equal(s.isEncryptionAvailable(), false);
    assert.equal(s.seal("tok-one"), "tok-one");
    assert.equal(s.seal("tok-two"), "tok-two");
    assert.equal(s.isSealed(s.seal("tok-one")), false);
    assert.equal(logs.length, 1, "unavailable warning must fire once, not per write");
    assert.match(logs[0], /unavailable/i);
    assert.match(logs[0], /plaintext/i);
    assert.doesNotMatch(logs[0], /tok-one|tok-two/);
  });

  it("does not warn about missing encryption outside Electron (node tests, no keychain)", () => {
    const logs = [];
    const s = createSecrets({
      safeStorage: null,
      inElectron: false,
      log: (m) => logs.push(String(m)),
    });
    assert.equal(s.seal("tok"), "tok");
    assert.equal(logs.length, 0);
  });

  it("returns null and logs when ciphertext is corrupt, without echoing the blob", () => {
    const logs = [];
    const s = createSecrets({
      safeStorage: fakeSafeStorage(),
      log: (m) => logs.push(String(m)),
    });
    assert.equal(s.open(`${PREFIX}!!!!not-base64-cipher`), null);
    assert.ok(logs.some((l) => /failed to decrypt/i.test(l)));
    assert.ok(logs.every((l) => !l.includes("!!!!not-base64-cipher")));
  });

  it("recordUse never copies the secret value into the audit row", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-secrets-audit-"));
    const auditPath = path.join(dir, "secrets-audit.jsonl");
    try {
      const s = createSecrets({
        safeStorage: fakeSafeStorage(),
        auditPath,
      });
      s.recordUse({
        purpose: "mcp-inject",
        key: "mcp:team",
        secret: "must-not-appear",
        token: "must-not-appear",
      });
      const row = s.getAuditEvents()[0];
      assert.equal(row.event, "decrypt");
      assert.equal(row.purpose, "mcp-inject");
      assert.equal(row.key, "mcp:team");
      assert.ok(row.ts);
      assert.equal(row.secret, undefined);
      assert.equal(row.token, undefined);
      assert.ok(!JSON.stringify(row).includes("must-not-appear"));
      const onDisk = fs.readFileSync(auditPath, "utf8");
      assert.ok(!onDisk.includes("must-not-appear"));
      assert.match(onDisk, /mcp-inject/);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(auditPath).mode & 0o777, 0o600);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("concealSettings returns the same object when there is nothing to encrypt", () => {
    const s = createSecrets({ safeStorage: fakeSafeStorage() });
    const settings = {
      mcpServers: [{ name: "x", url: "https://x.example/mcp", enabled: true }],
      otel: { endpoint: null, headers: {}, claudeMetrics: false },
    };
    assert.equal(s.concealSettings(settings), settings);
  });
});

describe("Store conceals secrets on disk", () => {
  let tmpDir;
  let filePath;
  let logs;
  let secrets;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-secrets-"));
    filePath = path.join(tmpDir, "coder-store.json");
    logs = [];
    secrets = createSecrets({
      safeStorage: fakeSafeStorage(),
      inElectron: true,
      log: (m) => logs.push(String(m)),
      auditPath: path.join(tmpDir, "secrets-audit.jsonl"),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes MCP tokens and OTEL header values encrypted, keeps memory plaintext", () => {
    const store = new Store(filePath, { secrets });
    store.setSettings({
      mcpServers: [
        {
          name: "team-tools",
          url: "https://tools.example.com/mcp",
          enabled: true,
          token: "plain-token-alpha-unique",
        },
      ],
      otel: {
        endpoint: "https://otel.example.com",
        headers: { Authorization: "Bearer otel-secret-unique" },
        claudeMetrics: false,
      },
    });
    store.saveNow();

    assert.equal(
      store.getSettings().mcpServers[0].token,
      "plain-token-alpha-unique",
    );
    assert.equal(
      store.getSettings().otel.headers.Authorization,
      "Bearer otel-secret-unique",
    );
    assert.equal(
      store.data.settings.mcpServers[0].token,
      "plain-token-alpha-unique",
      "in-memory store must stay plaintext",
    );

    const disk = fs.readFileSync(filePath, "utf8");
    assert.ok(!disk.includes("plain-token-alpha-unique"));
    assert.ok(!disk.includes("otel-secret-unique"));
    const parsed = JSON.parse(disk);
    assert.ok(parsed.settings.mcpServers[0].token.startsWith(PREFIX));
    assert.ok(parsed.settings.otel.headers.Authorization.startsWith(PREFIX));
  });

  it("migrates plaintext credentials on load, encrypts in place, and logs the count", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        settings: {
          mcpServers: [
            {
              name: "a",
              url: "https://a.example.com/mcp",
              enabled: true,
              token: "plain-token-alpha-unique",
            },
            {
              name: "b",
              url: "https://b.example.com/mcp",
              enabled: true,
              token: "plain-token-beta-unique",
            },
          ],
          otel: {
            endpoint: "https://otel.example.com",
            headers: { Authorization: "Bearer otel-secret-unique" },
            claudeMetrics: false,
          },
        },
      }),
      "utf8",
    );

    const store = new Store(filePath, { secrets });
    assert.equal(store.getSettings().mcpServers[0].token, "plain-token-alpha-unique");
    assert.equal(store.getSettings().mcpServers[1].token, "plain-token-beta-unique");
    assert.equal(
      store.getSettings().otel.headers.Authorization,
      "Bearer otel-secret-unique",
    );
    assert.ok(
      logs.some((l) => /encrypted 3 plaintext credential/i.test(l)),
      `expected migration log, got: ${logs.join(" | ")}`,
    );

    store.saveNow();
    const disk = fs.readFileSync(filePath, "utf8");
    assert.ok(!disk.includes("plain-token-alpha-unique"));
    assert.ok(!disk.includes("plain-token-beta-unique"));
    assert.ok(!disk.includes("otel-secret-unique"));
    const parsed = JSON.parse(disk);
    assert.ok(parsed.settings.mcpServers[0].token.startsWith(PREFIX));
    assert.ok(parsed.settings.mcpServers[1].token.startsWith(PREFIX));
    assert.ok(parsed.settings.otel.headers.Authorization.startsWith(PREFIX));

    const reloaded = new Store(filePath, { secrets });
    assert.equal(
      reloaded.getSettings().mcpServers[0].token,
      "plain-token-alpha-unique",
    );
    // Second load of already-encrypted values must not count as a migration.
    const migrateLogs = logs.filter((l) =>
      /encrypted \d+ plaintext credential/i.test(l),
    );
    assert.equal(migrateLogs.length, 1);
  });

  it("async flush conceals secrets too, not only saveNow", async () => {
    const store = new Store(filePath, { secrets });
    store.setSettings({
      mcpServers: [
        {
          name: "team-tools",
          url: "https://tools.example.com/mcp",
          enabled: true,
          token: "plain-token-async-unique",
        },
      ],
    });
    store.save();
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 80));
    await store.flushPending();
    const disk = fs.readFileSync(filePath, "utf8");
    assert.ok(!disk.includes("plain-token-async-unique"));
    assert.ok(JSON.parse(disk).settings.mcpServers[0].token.startsWith(PREFIX));
    assert.equal(
      store.getSettings().mcpServers[0].token,
      "plain-token-async-unique",
    );
  });

  it("drops a corrupt sealed token on load rather than injecting ciphertext as a bearer", () => {
    const good = secrets.seal("good-token");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        settings: {
          mcpServers: [
            {
              name: "ok",
              url: "https://ok.example.com/mcp",
              enabled: true,
              token: good,
            },
            {
              name: "bad",
              url: "https://bad.example.com/mcp",
              enabled: true,
              token: `${PREFIX}not-valid-cipher`,
            },
          ],
        },
      }),
      "utf8",
    );
    const store = new Store(filePath, { secrets });
    const servers = store.getSettings().mcpServers;
    assert.equal(servers.find((s) => s.name === "ok").token, "good-token");
    assert.equal(servers.find((s) => s.name === "bad").token, undefined);
  });
});

describe("credential injection audit (#543 / #262 companion)", () => {
  afterEach(() => {
    resetMemorySupForTests();
  });

  it("records mcp-inject when a token is written into the CLI MCP config", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-secrets-mcp-"));
    const name = `audit-${crypto.randomBytes(6).toString("hex")}`;
    try {
      const before = getDefaultSecrets().getAuditEvents().length;
      registerMcpServer({
        name,
        url: "https://example.test/mcp",
        token: "super-secret-token-xyz",
        user: true,
        userDataPath: tmp,
      });
      const events = getDefaultSecrets().getAuditEvents().slice(before);
      const hit = events.find((e) => e.key === `mcp:${name}`);
      assert.ok(hit, "expected an mcp-inject audit row");
      assert.equal(hit.purpose, "mcp-inject");
      assert.equal(hit.event, "decrypt");
      assert.ok(!JSON.stringify(hit).includes("super-secret-token-xyz"));
      const mcpPath = path.join(tmp, "mcp-coder-memory.json");
      const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      assert.equal(
        mcp.mcpServers[name].headers.Authorization,
        "Bearer super-secret-token-xyz",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("records otel-export once per header key when custom headers are sent", async () => {
    const uses = [];
    const calls = [];
    const o = createOtel({
      getSettings: () => ({
        endpoint: "http://127.0.0.1:4318",
        headers: { Authorization: "Bearer otel-secret-unique" },
        claudeMetrics: false,
      }),
      getThread: () => ({ id: "t" }),
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200 };
      },
      recordSecretUse: (e) => uses.push(e),
      flushMs: 60_000,
      now: () => 1,
    });
    o.startRun({ threadId: "t", runId: "r1", provider: "claude" });
    o.endRun({ threadId: "t", runId: "r1", status: "done" });
    await o.flush();
    o.startRun({ threadId: "t", runId: "r2", provider: "claude" });
    o.endRun({ threadId: "t", runId: "r2", status: "done" });
    await o.flush();
    o.stop();
    assert.ok(calls.length >= 1);
    assert.equal(uses.length, 1, "otel header inject must not flood the audit log");
    assert.equal(uses[0].purpose, "otel-export");
    assert.equal(uses[0].key, "otel:Authorization");
    assert.ok(!JSON.stringify(uses).includes("otel-secret-unique"));
  });

  it("records otel-env when Claude native metrics headers are injected", () => {
    const uses = [];
    const o = createOtel({
      getSettings: () => ({
        endpoint: "http://127.0.0.1:4318",
        headers: { Authorization: "Bearer otel-secret-unique" },
        claudeMetrics: true,
      }),
      getThread: () => ({ id: "t" }),
      recordSecretUse: (e) => uses.push(e),
      flushMs: 60_000,
      now: () => 1,
    });
    const env = o.claudeEnv();
    assert.match(env.OTEL_EXPORTER_OTLP_HEADERS, /Authorization=Bearer otel-secret-unique/);
    assert.equal(uses.length, 1);
    assert.equal(uses[0].purpose, "otel-env");
    assert.equal(uses[0].key, "otel:Authorization");
    o.stop();
  });
});
