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
  readRemoteToken,
  prepareHostCommand,
  installHostCommand,
  installRemoteSolenta,
  inspectHost,
  compareVersions,
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
    assert.match(explainSshFailure("work", "ssh: connect to host work port 22: Connection refused\n", 255), /Remote Login/);
    assert.match(explainSshFailure("wrok", "ssh: Could not resolve hostname wrok: nodename nor servname provided\n", 255), /Cannot find wrok/);
    assert.match(explainSshFailure("work", "ssh: connect to host work port 22: Operation timed out\n", 255), /did not answer/);
    assert.equal(explainSshFailure("work", "kex_exchange_identification: read: Connection reset\n", 255),
      "kex_exchange_identification: read: Connection reset");
    assert.equal(explainSshFailure("work", "", null), "SSH exited (unknown).");
  });

  it("prepares the host over SSH: starts Solenta when nothing answers, then prints the token", async () => {
    const cmd = prepareHostCommand(4700);
    // One single-quoted sh -c, so fish or zsh login shells parse it the same.
    assert.match(cmd, /^sh -c '/);
    assert.ok(cmd.endsWith("'"));
    assert.equal(cmd.slice(7, -1).includes("'"), false, "no inner single quotes");
    assert.match(cmd, /http:\/\/127\.0\.0\.1:4700\//);
    assert.match(cmd, /open -n -g -a "\$app" --args --headless --serve-web=4700/);
    assert.match(cmd, /nohup "\$bin" --headless --serve-web=4700 --no-sandbox/);
    // Already running with web off: hand off, and only to a build that knows how.
    assert.match(cmd, /grep -q -- --handoff-only "\$res\/electron\/main\.js" 2>\/dev\/null \|\| exit 5/);
    assert.match(cmd, /open -n -g -a "\$app" --args --serve-web=4700 --handoff-only/);
    assert.match(cmd, /nohup "\$exe" --headless --serve-web=4700 --handoff-only --no-sandbox/);
    assert.ok(
      cmd.indexOf("--handoff-only\" ") < cmd.indexOf("--args --headless"),
      "the running-app check comes before any cold start",
    );

    const run = (code, stdout = "", stderr = "") => (cmdName, args, opts, cb) => {
      assert.equal(cmdName, "ssh");
      assert.equal(args.at(-1), prepareHostCommand(4620));
      assert.ok(opts.timeout >= 60_000, "leaves time for the host to start");
      cb(code ? Object.assign(new Error("exit"), { code }) : null, stdout, stderr);
    };
    assert.equal(await readRemoteToken("me@box", 4620, { execFile: run(0, "tok\n") }), "tok");
    assert.equal(await readRemoteToken("me@box", 4620, { execFile: run(1) }), "", "no token file");
    await assert.rejects(
      readRemoteToken("me@box", 4620, { execFile: run(3) }),
      /Solenta is not installed on me@box/,
    );
    await assert.rejects(
      readRemoteToken("me@box", 4620, { execFile: run(4, "", "libnss3.so: cannot open\n") }),
      /Solenta did not start on me@box[\s\S]*libnss3/,
    );
    await assert.rejects(
      readRemoteToken("me@box", 4620, { execFile: run(5) }),
      /open on me@box with web access off[\s\S]*Serve Solenta Web/,
    );
  });

  it("installs this build's Linux release over SSH, checksum-pinned, and reports missing libraries", async () => {
    const sha = "c".repeat(64);
    const url = "https://github.com/currentbits/solenta/releases/download/v0.26.0/Solenta-v0.26.0-linux-x64.tar.gz";
    const fetched = [];
    const updater = {
      buildStamp: () => ({ channel: "prod", tag: "v0.26.0" }),
      fetchTag: async (tag) => {
        fetched.push(tag);
        return { tag_name: tag, assets: [{ name: "Solenta-v0.26.0-linux-x64.tar.gz", browser_download_url: url, digest: `sha256:${sha}` }] };
      },
      fetchLatest: async () => assert.fail("a tagged build installs its own tag"),
      pickAsset: require("../updater.js").pickAsset,
    };
    const ran = [];
    const ok = (out) => (cmd, args, opts, cb) => {
      ran.push(args);
      assert.ok(opts.timeout >= 5 * 60_000, "room for a 170 MB download");
      cb(null, out, "");
    };
    const result = await installRemoteSolenta({ host: "me@server" }, {
      updater,
      execFile: ok("missing libnss3.so\nmissing libgbm.so.1\nmissing libweird.so.9\nrestart\ninstalled\n"),
    });
    assert.deepEqual(fetched, ["v0.26.0"]);
    assert.equal(ran[0].at(-2), "me@server");
    assert.equal(ran[0].at(-1), installHostCommand(url, sha));
    assert.deepEqual(result, {
      tag: "v0.26.0",
      missingLibraries: ["libnss3.so", "libgbm.so.1", "libweird.so.9"],
      aptCommand: "sudo apt install libnss3 libgbm1",
      restartNeeded: true,
    });

    const fail = (code) => (cmd, args, opts, cb) => cb(Object.assign(new Error("x"), { code }), "", "");
    await assert.rejects(installRemoteSolenta({ host: "me@mac" }, { updater, execFile: fail(10) }), /Linux only[\s\S]*solenta\.app/);
    await assert.rejects(installRemoteSolenta({ host: "me@pi" }, { updater, execFile: fail(11) }), /x86_64 only/);
    await assert.rejects(installRemoteSolenta({ host: "me@server" }, { updater, execFile: fail(14) }), /did not match the release checksum/);
    await assert.rejects(
      installRemoteSolenta({ host: "-oProxyCommand=x" }, { updater, execFile: ok("installed\n") }),
      /SSH host/,
    );
    const unsigned = { ...updater, fetchTag: async () => ({ tag_name: "v0.26.0", assets: [{ name: "Solenta-v0.26.0-linux-x64.tar.gz", browser_download_url: url }] }) };
    await assert.rejects(installRemoteSolenta({ host: "me@server" }, { updater: unsigned, execFile: ok("installed\n") }), /no checksum/);
  });

  it("the install script only interpolates a plain https URL and a hex digest", () => {
    const cmd = installHostCommand("https://example.com/a.tar.gz", "d".repeat(64));
    assert.match(cmd, /^sh -c '/);
    assert.equal(cmd.slice(7, -1).includes("'"), false);
    assert.match(cmd, /sha256sum/);
    assert.throws(() => installHostCommand('https://x/"$(id)"', "d".repeat(64)), /download URL/);
    assert.throws(() => installHostCommand("http://x/a.tar.gz", "d".repeat(64)), /download URL/);
    assert.throws(() => installHostCommand("https://x/a.tar.gz", "nothex"), /checksum/);
  });

  it("compares dotted versions", () => {
    assert.equal(compareVersions("0.25.0", "0.26.0"), -1);
    assert.equal(compareVersions("v0.26.0", "0.26.0"), 0);
    assert.equal(compareVersions("0.26.1", "0.26.0"), 1);
    assert.equal(compareVersions("0.26", "0.26.0"), 0);
  });

  it("inspectHost reads the version and agents over the forwarded socket", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.kind === "auth") return ws.send(JSON.stringify(msg.token === "t" ? { kind: "auth-ok" } : { kind: "x" }));
        if (msg.channel === "app:status") {
          return ws.send(JSON.stringify({ kind: "reply", id: msg.id, result: { build: { version: "0.25.0", platform: "linux" } } }));
        }
        ws.send(JSON.stringify({
          kind: "reply",
          id: msg.id,
          result: [{ id: "claude", name: "Claude Code", available: true, auth: "signedIn", account: { plan: "max" }, models: ["x"] }],
        }));
      });
    });
    await new Promise((resolve) => wss.once("listening", resolve));
    try {
      const info = await inspectHost(wss.address().port, "t");
      assert.deepEqual(info, {
        version: "0.25.0",
        platform: "linux",
        agents: [{ id: "claude", name: "Claude Code", available: true, auth: "signedIn", account: { plan: "max" } }],
      });
      assert.equal(await inspectHost(wss.address().port, "t", 300).then(() => "ok"), "ok");
    } finally {
      wss.close();
    }
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
      inspectHost: async () => ({ version: "0.25.0", platform: "linux", agents: [] }),
      localVersion: "0.26.0",
      electron: {
        BrowserWindow: FakeWindow,
        shell: { openExternal() {} },
        dialog: { showMessageBox: async (options) => { dialogs.push(options); } },
      },
    };
    try {
      const result = await openRemoteConnection({ host: "user@work", token }, deps);
      assert.deepEqual(result, {
        host: "user@work",
        remotePort: 4620,
        tokenSaved: true,
        remote: { version: "0.25.0", platform: "linux", agents: [], outdated: true },
        localVersion: "0.26.0",
      });
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
      assert.match(dialogs[0].detail, /not accepting SSH/);
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
