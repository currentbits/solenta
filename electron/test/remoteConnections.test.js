"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { WebSocketServer } = require("ws");
const {
  validateConnection,
  sshArgs,
  createTokenStore,
  openRemoteConnection,
  closeRemoteConnections,
} = require("../remoteConnections.js");

describe("remote Connections", () => {
  it("rejects SSH option injection and only forwards loopback ports", () => {
    assert.throws(() => validateConnection({ host: "-F/tmp/config", token: "x" }), /SSH host/);
    assert.throws(() => validateConnection({ host: "work;touch /tmp/no", token: "x" }), /SSH host/);
    assert.throws(() => validateConnection({ host: "work", remotePort: 70000, token: "x" }), /Remote port/);
    assert.deepEqual(sshArgs("user@work", 50000, 4620).slice(-3), [
      "-L", "127.0.0.1:50000:127.0.0.1:4620", "user@work",
    ]);
  });

  it("stores tokens only as keychain ciphertext and refuses plaintext backends", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-remote-"));
    const file = path.join(dir, "remote-connections.json");
    let backend = "keychain";
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => backend,
      encryptString: (text) => Buffer.from(`sealed:${text}`),
      decryptString: (buf) => String(buf).replace(/^sealed:/, ""),
    };
    try {
      const store = createTokenStore(file, safeStorage);
      assert.equal(store.get("work:4620"), "");
      assert.equal(store.set("work:4620", "remote-secret"), true);
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /remote-secret/);
      assert.equal(store.get("work:4620"), "remote-secret");
      store.delete("work:4620");
      assert.equal(store.get("work:4620"), "");
      backend = "basic_text";
      assert.equal(store.set("work:4620", "remote-secret"), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("authenticates the forwarded host before opening an isolated web window", async () => {
    const token = "remote-secret";
    let server;
    let tunnel;
    let window;
    const dialogs = [];
    const fakeSpawn = (_cmd, args) => {
      const localPort = Number(args[args.indexOf("-L") + 1].split(":")[1]);
      tunnel = new EventEmitter();
      tunnel.stderr = new EventEmitter();
      tunnel.kill = () => {
        server?.close();
        tunnel.emit("exit", 0);
      };
      server = http.createServer((_req, res) => res.end("Solenta"));
      const wss = new WebSocketServer({ server, path: "/ws" });
      wss.on("connection", (ws) => ws.on("message", (raw) => {
        if (JSON.parse(String(raw)).token === token) ws.send('{"kind":"auth-ok"}');
        else ws.close();
      }));
      server.listen(localPort, "127.0.0.1");
      return tunnel;
    };
    class FakeWindow extends EventEmitter {
      constructor(options) {
        super();
        this.options = options;
        this.webContents = Object.assign(new EventEmitter(), {
          setWindowOpenHandler() {},
        });
        window = this;
      }
      isDestroyed() { return this.destroyed === true; }
      async loadURL(url) { this.url = url; }
      show() { this.shown = true; }
      focus() {}
      close() { this.destroyed = true; this.emit("closed"); }
      destroy() { this.close(); }
    }

    const saved = new Map();
    const deps = {
      tokens: {
        get: (key) => saved.get(key) || "",
        set: (key, value) => { saved.set(key, value); return true; },
        delete: (key) => { saved.delete(key); },
      },
      spawn: fakeSpawn,
      electron: {
        BrowserWindow: FakeWindow,
        shell: { openExternal() {} },
        dialog: { showMessageBox: async (options) => { dialogs.push(options); } },
      },
    };
    try {
      const result = await openRemoteConnection({ host: "user@work", token }, deps);
      assert.deepEqual(result, { host: "user@work", remotePort: 4620, tokenSaved: true });
      assert.equal(saved.get("user@work:4620"), token);
      assert.equal(window.shown, true);
      assert.match(window.url, /\/\?token=remote-secret$/);
      assert.equal(window.options.webPreferences.nodeIntegration, false);
      assert.equal(window.options.webPreferences.sandbox, true);
      assert.equal(window.options.webPreferences.preload, undefined);
      assert.ok(window.options.webPreferences.partition.startsWith("solenta-remote-"));
      tunnel.emit("exit", 1);
      assert.equal(window.destroyed, true);
      assert.match(dialogs[0].message, /SSH connection to user@work ended/);

      // A blank token reuses the saved one.
      await openRemoteConnection({ host: "user@work", token: "" }, deps);
      assert.match(window.url, /\/\?token=remote-secret$/);
      window.close();
      await assert.rejects(
        openRemoteConnection({ host: "nobody@work", token: "" }, deps),
        /Enter the Solenta Web token/,
      );
      // A saved token the host now rejects is deleted.
      saved.set("stale@work:4620", "old-secret");
      await assert.rejects(
        openRemoteConnection({ host: "stale@work", token: "" }, deps),
        /rejected the saved token/,
      );
      assert.equal(saved.has("stale@work:4620"), false);
      window = null;
      await assert.rejects(
        openRemoteConnection({ host: "other@work", token: "wrong" }, deps),
        /rejected this token/,
      );
      assert.equal(window, null, "wrong token must never open a window");
    } finally {
      closeRemoteConnections();
      await new Promise((resolve) => server?.close(resolve) ?? resolve());
    }
  });
});
