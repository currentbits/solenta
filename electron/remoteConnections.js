"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { WebSocket } = require("ws");

const DEFAULT_REMOTE_PORT = 4620;
const active = new Map();

// Saved web tokens, keyed by host:port and encrypted with the OS keychain.
// Plaintext fallbacks (Linux basic_text) are refused rather than written.
function createTokenStore(file, safeStorage) {
  const canEncrypt = () =>
    safeStorage.isEncryptionAvailable() &&
    safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  };
  const write = (tokens) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(tokens), { mode: 0o600 });
  };
  return {
    get(key) {
      const sealed = read()[key];
      if (typeof sealed !== "string" || !canEncrypt()) return "";
      try {
        return safeStorage.decryptString(Buffer.from(sealed, "base64"));
      } catch {
        return "";
      }
    },
    set(key, token) {
      if (!canEncrypt()) return false;
      write({ ...read(), [key]: safeStorage.encryptString(token).toString("base64") });
      return true;
    },
    delete(key) {
      const tokens = read();
      if (!(key in tokens)) return;
      delete tokens[key];
      write(tokens);
    },
  };
}

let defaultTokens = null;
function tokenStoreFor(deps) {
  if (deps.tokens) return deps.tokens;
  if (!defaultTokens) {
    const { app, safeStorage } = require("electron");
    defaultTokens = createTokenStore(
      path.join(app.getPath("userData"), "remote-connections.json"),
      safeStorage,
    );
  }
  return defaultTokens;
}

function validateConnection(input) {
  const host = typeof input?.host === "string" ? input.host.trim() : "";
  const label = typeof input?.label === "string" ? input.label.trim() : "";
  const token = typeof input?.token === "string" ? input.token.trim() : "";
  const remotePort = input?.remotePort ?? DEFAULT_REMOTE_PORT;
  // Arguments go to spawn without a shell, but a leading dash could still be
  // interpreted by ssh as an option. SSH config aliases and user@host work.
  if (!/^(?:[\w][\w.-]*@)?[\w][\w.:-]*$/.test(host) || host.length > 255) {
    throw new Error("Enter an SSH host or user@host without spaces or options.");
  }
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new Error("Remote port must be between 1 and 65535.");
  }
  if (token.length > 1024) {
    throw new Error("Enter the Solenta Web token from the remote host.");
  }
  return {
    host,
    label: label.slice(0, 60) || host,
    token,
    remotePort,
    remember: input?.remember !== false,
  };
}

function sshArgs(host, localPort, remotePort) {
  return [
    "-N", "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    host,
  ];
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

function probeToken(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let opened = false;
    let settled = false;
    const timer = setTimeout(() => done(new Error("SSH tunnel is not ready.")), 1_000);
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      err ? reject(err) : resolve();
    };
    ws.once("open", () => {
      opened = true;
      ws.send(JSON.stringify({ kind: "auth", token }));
    });
    ws.once("message", (raw) => {
      try {
        if (JSON.parse(String(raw)).kind === "auth-ok") return done();
      } catch {
        // A different service owns the forwarded port.
      }
      done(new Error("The forwarded port is not a Solenta Web host."));
    });
    ws.once("close", () => done(new Error(opened
      ? "The remote Solenta host rejected this token."
      : "SSH tunnel is not ready.")));
    ws.once("error", () => done(new Error("SSH tunnel is not ready.")));
  });
}

async function waitForHost(child, port, token, getFailure) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const failure = getFailure();
    if (failure) throw failure;
    try {
      await probeToken(port, token);
      return;
    } catch (err) {
      if (!/SSH tunnel is not ready/.test(err.message)) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw getFailure() || new Error("Timed out waiting for the remote Solenta host.");
}

async function openRemoteConnection(input, deps = {}) {
  const { host, label, remotePort, remember, token: typed } = validateConnection(input);
  const key = `${host}:${remotePort}`;
  const tokens = tokenStoreFor(deps);
  const token = typed || tokens.get(key);
  if (!token) throw new Error("Enter the Solenta Web token from the remote host.");
  const prior = active.get(key);
  if (prior) {
    if (prior.win && !prior.win.isDestroyed()) {
      prior.win.show();
      prior.win.focus();
    }
    return prior.promise;
  }

  const entry = { child: null, win: null, promise: null, closing: false };
  active.set(key, entry);
  entry.promise = (async () => {
    const port = await freeLoopbackPort();
    const child = (deps.spawn || spawn)("ssh", sshArgs(host, port, remotePort), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    entry.child = child;
    let stderr = "";
    let failure = null;
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-1000);
    });
    child.once("error", (err) => { failure = err; });
    child.once("exit", (code) => {
      failure = new Error(stderr.trim() || `SSH exited (${code ?? "unknown"}).`);
      if (entry.win && !entry.win.isDestroyed() && !entry.closing) {
        entry.win.close();
        const { dialog } = deps.electron || require("electron");
        void dialog.showMessageBox({
          type: "warning",
          title: "Remote connection ended",
          message: `The SSH connection to ${label} ended. Reconnect from Settings → Connections.`,
          detail: failure.message,
        }).catch(() => {});
      }
    });

    try {
      await waitForHost(child, port, token, () => failure);
      const { BrowserWindow, shell } = deps.electron || require("electron");
      const win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        show: false,
        title: `${label} · Solenta`,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          partition: `solenta-remote-${crypto.randomUUID()}`,
        },
      });
      entry.win = win;
      win.solentaRemote = true;
      const origin = `http://127.0.0.1:${port}`;
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url) && new URL(url).origin !== origin) {
          void shell.openExternal(url);
        }
        return { action: "deny" };
      });
      win.webContents.on("will-navigate", (event, url) => {
        if (new URL(url).origin === origin) return;
        event.preventDefault();
        if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      });
      win.on("closed", () => {
        entry.closing = true;
        active.delete(key);
        child.kill();
      });
      // Existing web hosts accept a query token and scrub it after boot.
      try {
        await win.loadURL(`${origin}/?token=${encodeURIComponent(token)}`);
      } catch {
        throw new Error("Unable to load the remote Solenta window.");
      }
      win.show();
      let tokenSaved = false;
      try {
        if (remember) tokenSaved = tokens.set(key, token);
        else tokens.delete(key);
      } catch {
        // The window is open; a failed save only means asking next time.
      }
      return { host, remotePort, tokenSaved };
    } catch (err) {
      active.delete(key);
      if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
      child.kill();
      if (!typed && /rejected this token/.test(err.message)) {
        try { tokens.delete(key); } catch { /* best effort */ }
        throw new Error("The remote Solenta host rejected the saved token. Enter its current token.");
      }
      throw err;
    }
  })().catch((err) => {
    active.delete(key);
    throw err;
  });
  return entry.promise;
}

function forgetRemoteConnection(input, deps = {}) {
  const { host, remotePort } = validateConnection({ ...input, token: "" });
  tokenStoreFor(deps).delete(`${host}:${remotePort}`);
}

function closeRemoteConnections() {
  for (const entry of active.values()) {
    entry.closing = true;
    entry.child?.kill();
  }
  active.clear();
}

module.exports = {
  validateConnection,
  sshArgs,
  probeToken,
  createTokenStore,
  openRemoteConnection,
  forgetRemoteConnection,
  closeRemoteConnections,
};
