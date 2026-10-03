"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { WebSocket } = require("ws");

const DEFAULT_REMOTE_PORT = 4620;
// Tunnel respawn backoff after an unexpected SSH exit, about a minute total.
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
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

// Turn ssh's stderr into an instruction. BatchMode cannot prompt, so first
// contact and password logins have to be settled in a terminal once.
function explainSshFailure(host, stderr, code) {
  const text = stderr.trim();
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(text)) {
    return `The SSH host key for ${host} changed. Solenta will not send the web token until you verify the new key and update known_hosts.`;
  }
  if (/Host key verification failed/.test(text)) {
    return `${host} is not in known_hosts yet. Run "ssh ${host}" in a terminal once to verify its host key, then connect again.`;
  }
  if (/Permission denied/.test(text)) {
    return `SSH refused the login to ${host}. Connections need key-based login (an SSH key or agent); passwords cannot be entered here.`;
  }
  return text || `SSH exited (${code ?? "unknown"}).`;
}

function sshArgs(host, localPort, remotePort) {
  return [
    "-N", "-T",
    "-o", "BatchMode=yes",
    // The web token goes down this tunnel: refuse unknown or changed host
    // keys even if ~/.ssh/config relaxes checking for this host.
    "-o", "StrictHostKeyChecking=yes",
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

  const entry = {
    child: null, win: null, promise: null, closing: false, reconnecting: false,
  };
  active.set(key, entry);
  const spawnFn = deps.spawn || spawn;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const title = `${label} · Solenta`;
  let port = 0;

  const startTunnel = () => {
    const child = spawnFn("ssh", sshArgs(host, port, remotePort), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    entry.child = child;
    let stderr = "";
    child.failure = null;
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-1000);
    });
    child.once("error", (err) => { child.failure = err; });
    child.once("exit", (code) => {
      child.failure = new Error(explainSshFailure(host, stderr, code));
      if (entry.win && !entry.closing && !entry.reconnecting) void reconnect(child.failure);
    });
    return child;
  };

  // Respawn ssh on the SAME loopback port so the window's origin is unchanged;
  // the page's wire client reconnects its socket and resyncs on its own.
  const reconnect = async (failure) => {
    entry.reconnecting = true;
    let last = failure;
    for (const delay of RECONNECT_DELAYS_MS) {
      if (entry.win.isDestroyed()) return;
      entry.win.setTitle(`${label} · Reconnecting… · Solenta`);
      await sleep(delay);
      if (entry.closing) return;
      const child = startTunnel();
      try {
        await waitForHost(child, port, token, () => child.failure);
        entry.reconnecting = false;
        if (!entry.win.isDestroyed()) entry.win.setTitle(title);
        return;
      } catch (err) {
        last = err;
        child.kill();
        // A restarted host with a new token will not heal by retrying.
        if (/rejected this token|not a Solenta Web host/.test(err.message)) break;
      }
    }
    if (entry.closing || entry.win.isDestroyed()) return;
    entry.win.close();
    const { dialog } = deps.electron || require("electron");
    void dialog.showMessageBox({
      type: "warning",
      title: "Remote connection ended",
      message: `The SSH connection to ${label} ended. Reconnect from Settings → Connections.`,
      detail: last.message,
    }).catch(() => {});
  };

  entry.promise = (async () => {
    port = await freeLoopbackPort();
    const child = startTunnel();
    try {
      await waitForHost(child, port, token, () => child.failure);
      const { BrowserWindow, shell } = deps.electron || require("electron");
      const win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        show: false,
        title,
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
      // Keep the window title ours; the remote page would overwrite it.
      win.on("page-title-updated", (event) => event.preventDefault());
      win.on("closed", () => {
        entry.closing = true;
        active.delete(key);
        entry.child?.kill();
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
      entry.child?.kill();
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
  explainSshFailure,
  probeToken,
  createTokenStore,
  openRemoteConnection,
  forgetRemoteConnection,
  closeRemoteConnections,
};
