"use strict";

const { execFile, spawn } = require("node:child_process");
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
    // -v only for the "Entering interactive session" readiness line; debug
    // lines are filtered out of every message shown to the user.
    "-v", "-N", "-T",
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

// Run on the host before every connect: start Solenta if nothing answers on
// the web port, then print <userData>/web-token (webAccess writes it on
// every start). macOS goes through `open -n` so a running app gets the
// flags via second-instance and turns Solenta Web on instead of a second
// copy starting; Linux starts the tarball headless (no display needed, and
// no renderer to sandbox). Both channels keep productName "Solenta", so one
// userData path. sh -c, single-quoted, so a fish or zsh login shell on the
// host does not change the syntax: no single quotes inside.
const NOT_INSTALLED_EXIT = 3;
const DID_NOT_START_EXIT = 4;
const HEADLESS_LOG = "$HOME/.solenta-headless.log";
function prepareHostCommand(port) {
  const p = Number(port);
  return `sh -c '
tok() { cat "$HOME/Library/Application Support/Solenta/web-token" 2>/dev/null || cat "\${XDG_CONFIG_HOME:-$HOME/.config}/Solenta/web-token" 2>/dev/null; }
up() { command -v curl >/dev/null 2>&1 || return 0; curl -s -o /dev/null -m 2 "http://127.0.0.1:${p}/"; }
if ! up; then
  app=""
  for a in /Applications/Solenta.app "$HOME/Applications/Solenta.app" "/Applications/Solenta Nightly.app"; do
    if [ -d "$a" ]; then app="$a"; break; fi
  done
  if [ -n "$app" ]; then
    open -n -g -a "$app" --args --headless --serve-web=${p} || exit ${DID_NOT_START_EXIT}
  else
    bin="$(command -v solenta 2>/dev/null || command -v solenta-nightly 2>/dev/null)"
    for b in "$HOME/solenta/solenta" "$HOME/solenta/solenta-nightly" "$HOME/.local/share/solenta/solenta" /opt/solenta/solenta; do
      if [ -z "$bin" ] && [ -x "$b" ]; then bin="$b"; fi
    done
    [ -n "$bin" ] || exit ${NOT_INSTALLED_EXIT}
    nohup "$bin" --headless --serve-web=${p} --no-sandbox >"${HEADLESS_LOG}" 2>&1 </dev/null &
  fi
  i=0
  until up; do
    i=$((i+1))
    if [ "$i" -gt 60 ]; then tail -n 5 "${HEADLESS_LOG}" >&2 2>/dev/null; exit ${DID_NOT_START_EXIT}; fi
    sleep 1
  done
fi
tok'`;
}

// "" when the host has no token file; throws on ssh failures (exit 255) so
// host-key and login problems surface before any tunnel is opened, and when
// Solenta is missing on the host or would not start.
function readRemoteToken(host, remotePort = DEFAULT_REMOTE_PORT, deps = {}) {
  return new Promise((resolve, reject) => {
    (deps.execFile || execFile)("ssh", [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=10",
      host,
      prepareHostCommand(remotePort),
    ], { timeout: 90_000, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err && (err.code === 255 || err.killed)) {
        return reject(new Error(err.killed
          ? `Timed out preparing Solenta on ${host}.`
          : explainSshFailure(host, String(stderr || ""), err.code)));
      }
      if (err && err.code === NOT_INSTALLED_EXIT) {
        return reject(new Error(`Solenta is not installed on ${host}. Install it there first: the app in /Applications on a Mac, or the Linux tarball unpacked to ~/solenta or on PATH as "solenta".`));
      }
      if (err && err.code === DID_NOT_START_EXIT) {
        const tail = String(stderr || "").trim();
        return reject(new Error(`Solenta did not start on ${host}. On a Mac someone must be logged in to the desktop; on Linux see ~/.solenta-headless.log there.${tail ? `\n${tail}` : ""}`));
      }
      const token = err ? "" : String(stdout).trim();
      resolve(token.length <= 1024 ? token : "");
    });
  });
}

// Install or update the Linux tarball in ~/solenta over SSH (#1660). The
// archive comes from this build's own GitHub release and is checked against
// the sha256 GitHub stamps on it before it replaces anything. A headless
// copy running from ~/solenta is stopped so the next connect starts the new
// one; a desktop copy keeps running the old files until it restarts.
const INSTALL_EXITS = {
  10: "Installing over SSH works for Linux only. On a Mac, install Solenta from solenta.app on that Mac.",
  11: "There is no Solenta build for this processor yet; Linux builds are x86_64 only.",
  12: "The download failed on the remote computer. Check that it can reach github.com.",
  13: "The remote computer has neither curl nor wget to download Solenta with.",
  14: "The download did not match the release checksum, so nothing was installed.",
  15: "The download could not be unpacked on the remote computer.",
};
function installHostCommand(url, sha256) {
  if (!/^https:\/\/[\w./%:-]+$/.test(url)) throw new Error("Unexpected release download URL.");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Unexpected release checksum.");
  return `sh -c '
[ "$(uname -s)" = Linux ] || exit 10
case "$(uname -m)" in x86_64|amd64) ;; *) exit 11 ;; esac
tmp="$HOME/.solenta-download.tar.gz"
if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$tmp" "${url}" || exit 12
elif command -v wget >/dev/null 2>&1; then wget -qO "$tmp" "${url}" || exit 12
else exit 13; fi
got="$(sha256sum "$tmp" 2>/dev/null | cut -d " " -f 1)"
if [ "$got" != "${sha256}" ]; then rm -f "$tmp"; exit 14; fi
rm -rf "$HOME/.solenta-new" && mkdir -p "$HOME/.solenta-new"
tar -xzf "$tmp" -C "$HOME/.solenta-new" 2>/dev/null || exit 15
rm -f "$tmp"
src=""
for d in "$HOME"/.solenta-new/*/; do
  if [ -x "$d/solenta" ] || [ -x "$d/solenta-nightly" ]; then src="\${d%/}"; fi
done
[ -n "$src" ] || exit 15
pkill -TERM -f "$HOME/solenta/solenta[a-z-]* --headless" 2>/dev/null
i=0
while pgrep -f "$HOME/solenta/solenta[a-z-]* --headless" >/dev/null 2>&1 && [ "$i" -lt 15 ]; do i=$((i+1)); sleep 1; done
if ps -eo args 2>/dev/null | grep "^$HOME/solenta/solenta" | grep -qv -- "--type="; then echo restart; fi
rm -rf "$HOME/solenta.old"
if [ -d "$HOME/solenta" ]; then mv "$HOME/solenta" "$HOME/solenta.old"; fi
mv "$src" "$HOME/solenta" && rm -rf "$HOME/.solenta-new"
bin="$HOME/solenta/solenta"; [ -x "$bin" ] || bin="$HOME/solenta/solenta-nightly"
ldd "$bin" 2>/dev/null | sed -n "s/^[[:space:]]*\\([^[:space:]]*\\) => not found.*/missing \\1/p" | sort -u
echo installed'`;
}

// Missing shared object -> Debian/Ubuntu package. apt resolves the t64
// renames (libasound2 -> libasound2t64) on its own.
const APT_PACKAGES = {
  "libnss3.so": "libnss3", "libnssutil3.so": "libnss3", "libsmime3.so": "libnss3", "libnspr4.so": "libnspr4",
  "libgtk-3.so.0": "libgtk-3-0", "libgdk-3.so.0": "libgtk-3-0", "libgbm.so.1": "libgbm1",
  "libasound.so.2": "libasound2", "libatk-1.0.so.0": "libatk1.0-0", "libatk-bridge-2.0.so.0": "libatk-bridge2.0-0",
  "libatspi.so.0": "libatspi2.0-0", "libcups.so.2": "libcups2", "libdrm.so.2": "libdrm2",
  "libxkbcommon.so.0": "libxkbcommon0", "libXcomposite.so.1": "libxcomposite1", "libXdamage.so.1": "libxdamage1",
  "libXrandr.so.2": "libxrandr2", "libXfixes.so.3": "libxfixes3", "libpango-1.0.so.0": "libpango-1.0-0",
  "libcairo.so.2": "libcairo2", "libdbus-1.so.3": "libdbus-1-3", "libexpat.so.1": "libexpat1",
  "libXext.so.6": "libxext6", "libX11.so.6": "libx11-6", "libxcb.so.1": "libxcb1",
  "libglib-2.0.so.0": "libglib2.0-0", "libgio-2.0.so.0": "libglib2.0-0", "libgobject-2.0.so.0": "libglib2.0-0",
};

async function linuxReleaseAsset(deps = {}) {
  const updater = deps.updater || require("./updater.js");
  const { tag, channel } = updater.buildStamp();
  // A dev tree has no tag: fall back to the newest release of its channel.
  const release = tag
    ? await updater.fetchTag(tag, deps.fetch)
    : await updater.fetchLatest(channel || "prod", deps.fetch);
  const asset = release ? updater.pickAsset(release, "linux", "x64") : null;
  if (!asset) throw new Error(`No Linux build was published for ${tag || "the latest release"}.`);
  const sha = /^sha256:([0-9a-f]{64})$/.exec(String(asset.digest || ""));
  if (!sha) throw new Error("The Linux build carries no checksum, so it cannot be installed safely.");
  return { url: String(asset.browser_download_url), sha256: sha[1], tag: String(release.tag_name || tag || "") };
}

async function installRemoteSolenta(input, deps = {}) {
  const { host } = validateConnection({ host: input && input.host, token: "" });
  const asset = await linuxReleaseAsset(deps);
  const stdout = await new Promise((resolve, reject) => {
    (deps.execFile || execFile)("ssh", [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=10",
      host,
      installHostCommand(asset.url, asset.sha256),
    ], { timeout: 10 * 60_000, maxBuffer: 256 * 1024 }, (err, out, stderr) => {
      if (!err) return resolve(String(out));
      if (err.killed) return reject(new Error(`Timed out installing Solenta on ${host}.`));
      if (err.code === 255) return reject(new Error(explainSshFailure(host, String(stderr || ""), err.code)));
      reject(new Error(INSTALL_EXITS[err.code] || `Installing on ${host} failed: ${String(stderr || "").trim() || `exit ${err.code}`}`));
    });
  });
  const lines = stdout.split(/\r?\n/);
  if (!lines.includes("installed")) throw new Error(`Installing on ${host} did not finish.`);
  const missingLibraries = lines.filter((l) => l.startsWith("missing ")).map((l) => l.slice(8));
  const packages = [...new Set(missingLibraries.map((lib) => APT_PACKAGES[lib]).filter(Boolean))];
  return {
    tag: asset.tag,
    missingLibraries,
    aptCommand: packages.length ? `sudo apt install ${packages.join(" ")}` : null,
    restartNeeded: lines.includes("restart"),
  };
}

// After the token check: which Solenta and which agents the host has, for
// the Connections row. One extra socket; null when the host is too old to
// answer or slow, never an error.
function inspectHost(port, token, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const replies = new Map();
    const done = (value) => {
      clearTimeout(timer);
      ws.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    ws.once("open", () => ws.send(JSON.stringify({ kind: "auth", token })));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return done(null);
      }
      if (msg.kind === "auth-ok") {
        ws.send(JSON.stringify({ kind: "invoke", id: 1, channel: "app:status", args: [] }));
        ws.send(JSON.stringify({ kind: "invoke", id: 2, channel: "providers:list", args: [] }));
        return;
      }
      if (msg.kind !== "reply") return;
      replies.set(msg.id, msg.error ? null : msg.result);
      if (replies.size < 2) return;
      const build = replies.get(1) && replies.get(1).build;
      const providers = Array.isArray(replies.get(2)) ? replies.get(2) : [];
      done({
        version: build ? String(build.version || "") : "",
        platform: build ? String(build.platform || "") : "",
        agents: providers.map((p) => ({
          id: String(p.id),
          name: String(p.name || p.id),
          available: p.available === true,
          ...(p.auth ? { auth: String(p.auth) } : {}),
          ...(p.account ? { account: p.account } : {}),
        })),
      });
    });
    ws.once("error", () => done(null));
    ws.once("close", () => done(null));
  });
}

/** -1, 0 or 1 comparing dotted numeric versions ("0.25.0" vs "0.24.3"). */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function localVersion() {
  try {
    return String(require("../package.json").version || "");
  } catch {
    return "";
  }
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

// Never probe before ssh owns the forwarded port: until then another local
// process could hold it and would receive the token. "Local forwarding
// listening" is logged BEFORE bind(), so it proves nothing; with
// ExitOnForwardFailure, ssh only enters the session once every bind worked.
async function waitForHost(child, token) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.failure) throw child.failure;
    if (!child.ready) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    try {
      await probeToken(child.backPort, token);
      return;
    } catch (err) {
      if (!/SSH tunnel is not ready/.test(err.message)) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw child.failure || new Error("Timed out waiting for the remote Solenta host.");
}

async function openRemoteConnection(input, deps = {}) {
  const { host, label, remotePort, remember, token: typed } = validateConnection(input);
  const key = `${host}:${remotePort}`;
  const tokens = tokenStoreFor(deps);
  // Typed, then the host's own token file over SSH (always current), then
  // the keychain copy for hosts whose token file cannot be read.
  // Always prepare the host, even with a typed token: it is what starts
  // Solenta there when nothing is listening yet.
  const fileToken = await readRemoteToken(host, remotePort, deps);
  let token = typed || fileToken;
  let fromKeychain = false;
  if (!token) {
    token = tokens.get(key);
    fromKeychain = !!token;
  }
  if (!token) {
    throw new Error(`No web token found on ${host}. In Solenta there, open Settings > Connections, add a device and paste its token here.`);
  }
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
    front: null, backPort: null, sockets: new Set(),
  };
  active.set(key, entry);
  const spawnFn = deps.spawn || spawn;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const title = `${label} · Solenta`;
  // The window talks to a front port this process holds for the window's
  // whole life, piped to ssh's current forward only once ssh owns it. ssh
  // gets a fresh port per spawn, so no port is ever released and re-bound
  // while the page (or the probe) could send its token to a squatter.
  const startFront = () => new Promise((resolve, reject) => {
    const front = net.createServer((sock) => {
      const back = entry.backPort;
      if (!back) return sock.destroy();
      const up = net.connect(back, "127.0.0.1");
      entry.sockets.add(sock);
      const drop = () => {
        entry.sockets.delete(sock);
        sock.destroy();
        up.destroy();
      };
      sock.on("error", drop).on("close", drop);
      up.on("error", drop).on("close", drop);
      sock.pipe(up).pipe(sock);
    });
    entry.front = front;
    front.once("error", reject);
    front.listen(0, "127.0.0.1", () => resolve(front.address().port));
  });

  const startTunnel = async () => {
    const backPort = await freeLoopbackPort();
    const child = spawnFn("ssh", sshArgs(host, backPort, remotePort), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    entry.child = child;
    child.backPort = backPort;
    child.ready = false;
    child.failure = null;
    let stderr = "";
    let partial = "";
    const onLine = (line) => {
      if (/^debug\d: Entering interactive session/.test(line)) child.ready = true;
      if (/^debug\d: /.test(line)) return;
      stderr = `${stderr}${line}\n`.slice(-1000);
      // The forward is up but nothing listens on the remote port. Connect
      // never starts the host (#245): say so instead of timing out.
      if (/open failed: connect failed/.test(line) && !child.failure) {
        child.failure = new Error(`Nothing is listening on port ${remotePort} on ${host}. Start Solenta there with --serve-web${remotePort === DEFAULT_REMOTE_PORT ? "" : `=${remotePort}`} (add --headless on a server without a display), then connect again.`);
      }
    };
    child.stderr?.on("data", (chunk) => {
      const lines = (partial + String(chunk)).split(/\r?\n/);
      partial = lines.pop();
      lines.forEach(onLine);
    });
    child.once("error", (err) => { child.failure = err; });
    child.once("close", (code) => {
      if (partial) onLine(partial);
      partial = "";
      if (entry.backPort === backPort) entry.backPort = null;
      child.failure = new Error(explainSshFailure(host, stderr, code));
      if (entry.win && !entry.closing && !entry.reconnecting) void reconnect(child.failure);
    });
    return child;
  };

  // Respawn ssh behind the same front port so the window's origin is
  // unchanged; the page's wire client reconnects and resyncs on its own.
  const reconnect = async (failure) => {
    entry.reconnecting = true;
    let last = failure;
    for (const delay of RECONNECT_DELAYS_MS) {
      if (entry.win.isDestroyed()) return;
      entry.win.setTitle(`${label} · Reconnecting… · Solenta`);
      await sleep(delay);
      if (entry.closing) return;
      let child = null;
      try {
        child = await startTunnel();
        await waitForHost(child, token);
        entry.backPort = child.backPort;
        entry.reconnecting = false;
        if (!entry.win.isDestroyed()) entry.win.setTitle(title);
        return;
      } catch (err) {
        last = err;
        child?.kill();
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
    try {
      const port = await startFront();
      const child = await startTunnel();
      await waitForHost(child, token);
      entry.backPort = child.backPort;
      // Runs while the window loads; only the Connections row waits for it.
      const inspected = (deps.inspectHost || inspectHost)(port, token).catch(() => null);
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
        closeEntry(entry);
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
      const info = await inspected;
      const mine = deps.localVersion ?? localVersion();
      const remote = info && info.version
        ? { ...info, outdated: Boolean(mine) && compareVersions(info.version, mine) < 0 }
        : null;
      return { host, remotePort, tokenSaved, remote, localVersion: mine };
    } catch (err) {
      active.delete(key);
      if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
      closeEntry(entry);
      if (fromKeychain && /rejected this token/.test(err.message)) {
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

function closeEntry(entry) {
  entry.backPort = null;
  entry.child?.kill();
  entry.front?.close();
  for (const sock of entry.sockets) sock.destroy();
  entry.sockets.clear();
}

function forgetRemoteConnection(input, deps = {}) {
  const { host, remotePort } = validateConnection({ ...input, token: "" });
  tokenStoreFor(deps).delete(`${host}:${remotePort}`);
}

function closeRemoteConnections() {
  for (const entry of active.values()) {
    entry.closing = true;
    closeEntry(entry);
  }
  active.clear();
}

module.exports = {
  validateConnection,
  sshArgs,
  explainSshFailure,
  readRemoteToken,
  prepareHostCommand,
  installHostCommand,
  installRemoteSolenta,
  inspectHost,
  compareVersions,
  probeToken,
  createTokenStore,
  openRemoteConnection,
  forgetRemoteConnection,
  closeRemoteConnections,
};
