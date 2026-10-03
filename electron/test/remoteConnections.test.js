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
  explainSshFailure,
  createTokenStore,
  openRemoteConnection,
  closeRemoteConnections,
} = require("../remoteConnections.js");

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("remote Connections", () => {
  it("rejects SSH option injection and only forwards loopback ports", () => {
    assert.throws(() => validateConnection({ host: "-F/tmp/config", token: "x" }), /SSH host/);
    assert.throws(() => validateConnection({ host: "work;touch /tmp/no", token: "x" }), /SSH host/);
    assert.throws(() => validateConnection({ host: "work", remotePort: 70000, token: "x" }), /Remote port/);
    assert.deepEqual(sshArgs("user@work", 50000, 4620).slice(-3), [
      "-L", "127.0.0.1:50000:127.0.0.1:4620", "user@work",
    ]);
  });

  it("pins host keys and explains the ssh failures BatchMode cannot prompt for", () => {
    const args = sshArgs("work", 50000, 4620);
    assert.equal(args[args.indexOf("StrictHostKeyChecking=yes") - 1], "-o");
    assert.match(
      explainSshFailure("work", "No ED25519 host key is known for work and you have requested strict checking.\nHost key verification failed.\n", 255),
      /Run "ssh work" in a terminal once/,
    );
    assert.match(
      explainSshFailure("work", "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.", 255),
      /host key for work changed/,
    );
    assert.match(explainSshFailure("work", "user@work: Permission denied (publickey).", 255), /key-based login/);
    assert.equal(explainSshFailure("work", "ssh: connect to host work port 22: Connection refused\n", 255),
      "ssh: connect to host work port 22: Connection refused");
    assert.equal(explainSshFailure("work", "", null), "SSH exited (unknown).");
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
    const ports = [];
    let down = false;
    let notListening = false;
    let squatted = false;
    const squatterSaw = [];
    let remoteFile = "";
    const fakeSpawn = (_cmd, args) => {
      const localPort = Number(args[args.indexOf("-L") + 1].split(":")[1]);
      ports.push(localPort);
      if (notListening) {
        const idle = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() {} });
        setImmediate(() => idle.stderr.emit("data",
          "debug1: Entering interactive session.\nchannel 2: open failed: connect failed: Connection refused\n"));
        return idle;
      }
      if (squatted) {
        // Another local process won ssh's port: it hears every probe, and
        // ssh logs "listening" (pre-bind) and then dies on the bind.
        const squatter = http.createServer();
        new WebSocketServer({ server: squatter, path: "/ws" })
          .on("connection", (ws) => ws.on("message", (raw) => squatterSaw.push(String(raw))));
        const dead = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() {} });
        squatter.listen(localPort, "127.0.0.1", () => {
          dead.stderr.emit("data", `debug1: Local forwarding listening on 127.0.0.1 port ${localPort}.\n`);
          setTimeout(() => {
            dead.stderr.emit("data", `bind [127.0.0.1]:${localPort}: Address already in use\nCould not request local forwarding.\n`);
            dead.emit("close", 255);
            squatter.close();
          }, 300);
        });
        return dead;
      }
      if (down) {
        const dead = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() {} });
        setImmediate(() => {
          dead.stderr.emit("data", "ssh: connect to host work port 22: Connection refused");
          dead.emit("close", 255);
        });
        return dead;
      }
      tunnel = new EventEmitter();
      tunnel.stderr = new EventEmitter();
      tunnel.kill = () => {
        server?.close();
        tunnel.emit("close", 0);
      };
      server = http.createServer((_req, res) => res.end("Solenta"));
      const wss = new WebSocketServer({ server, path: "/ws" });
      wss.on("connection", (ws) => ws.on("message", (raw) => {
        if (JSON.parse(String(raw)).token === token) ws.send('{"kind":"auth-ok"}');
        else ws.close();
      }));
      // Real ssh -v prints this only after every forward is bound.
      server.listen(localPort, "127.0.0.1",
        () => tunnel.stderr.emit("data", "debug1: Entering interactive session.\n"));
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
      setTitle(title) { this.title = title; }
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
      sleep: async () => {},
      execFile: (_cmd, args, _opts, cb) => {
        const host = args[args.length - 2];
        if (host === "unknown@work") {
          return cb(Object.assign(new Error("ssh"), { code: 255 }), "", "Host key verification failed.\n");
        }
        if (remoteFile) return cb(null, `${remoteFile}\n`, "");
        cb(Object.assign(new Error("cat"), { code: 1 }), "", "");
      },
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
      // The window talks to a front port this process holds, never ssh's.
      assert.notEqual(Number(new URL(window.url).port), ports[0]);
      assert.equal(await (await fetch(window.url)).text(), "Solenta");

      // A dropped tunnel respawns behind the same front port; the window stays.
      const opened = window;
      tunnel.kill();
      await waitFor(() => ports.length === 2 && opened.title === "user@work · Solenta");
      assert.notEqual(opened.destroyed, true);
      assert.equal(dialogs.length, 0);
      assert.equal(await (await fetch(opened.url)).text(), "Solenta", "front port routes to the new tunnel");

      // A host that stays unreachable gives up, closes and explains.
      down = true;
      tunnel.kill();
      await waitFor(() => opened.destroyed === true, 10_000);
      await assert.rejects(fetch(opened.url), "the front port closes with the window");
      assert.equal(ports.length, 8, "one initial, one recovery, six failed retries");
      assert.match(dialogs[0].message, /SSH connection to user@work ended/);
      assert.match(dialogs[0].detail, /Connection refused/);
      down = false;

      // A blank token reuses the saved one.
      await openRemoteConnection({ host: "user@work", token: "" }, deps);
      assert.match(window.url, /\/\?token=remote-secret$/);
      window.close();
      await assert.rejects(
        openRemoteConnection({ host: "nobody@work", token: "" }, deps),
        /No web token found on nobody@work/,
      );

      // A blank token is read from the host's web-token file over SSH first.
      remoteFile = token;
      saved.clear();
      await openRemoteConnection({ host: "fresh@work", token: "" }, deps);
      assert.match(window.url, /\/\?token=remote-secret$/);
      assert.equal(saved.get("fresh@work:4620"), token);
      window.close();
      remoteFile = "";

      // SSH refusals surface before any tunnel is spawned.
      const spawned = ports.length;
      await assert.rejects(
        openRemoteConnection({ host: "unknown@work", token: "" }, deps),
        /not in known_hosts yet/,
      );
      assert.equal(ports.length, spawned);

      // Nothing on the remote port: fail fast and never start the host.
      notListening = true;
      const started = Date.now();
      await assert.rejects(
        openRemoteConnection({ host: "idle@work", token, remotePort: 4700 }, deps),
        /Nothing is listening on port 4700 on idle@work\. Start Solenta there with --serve-web=4700/,
      );
      assert.ok(Date.now() - started < 5_000, "must not wait for the 15 s timeout");
      notListening = false;

      // ssh lost its port to another local process: the token is never sent.
      squatted = true;
      await assert.rejects(
        openRemoteConnection({ host: "squat@work", token }, deps),
        /Address already in use/,
      );
      squatted = false;
      assert.deepEqual(squatterSaw, [], "the token must not reach a port ssh does not own");

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
