"use strict";

const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { WebSocket } = require("ws");
const { PROMPT_TIMEOUT_MS } = require("./sshAskpass.js");

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

// Plain http sends the token unencrypted, so it is only allowed where the
// network is the user's own: loopback, private and link-local ranges,
// Tailscale's 100.64/10 (WireGuard-encrypted), and LAN-style names.
function isPrivateHostname(hostname) {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return !h.includes(".") || /\.(local|lan|home\.arpa|internal|ts\.net)$/.test(h);
}

// Direct route (#1824): a Solenta Web address, or the pairing link from
// Add device on that computer, which carries the token as ?token=.
function parseDirectUrl(raw) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("Enter an address like https://mini.tailnet.ts.net or http://192.168.1.20:4620.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("The address must start with https:// or http://.");
  }
  if (u.username || u.password) throw new Error("Leave the user name out of the address.");
  if (u.protocol === "http:" && !isPrivateHostname(u.hostname)) {
    throw new Error(`Plain http:// would send the token unencrypted to ${u.hostname}. Use an https:// address, such as the one Expose over Tailscale gives on that computer.`);
  }
  return {
    url: u.origin,
    hostname: u.hostname.replace(/^\[|\]$/g, ""),
    port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
    linkToken: (u.searchParams.get("token") || "").trim(),
  };
}

function validateConnection(input) {
  const host = typeof input?.host === "string" ? input.host.trim() : "";
  const label = typeof input?.label === "string" ? input.label.trim() : "";
  const token = typeof input?.token === "string" ? input.token.trim() : "";
  if (typeof input?.url === "string" && input.url.trim()) {
    const direct = parseDirectUrl(input.url);
    const typed = token || direct.linkToken;
    if (typed.length > 1024) throw new Error("Enter the device token from that computer.");
    return {
      key: direct.url,
      url: direct.url,
      host: direct.hostname,
      label: label.slice(0, 60) || direct.hostname,
      token: typed,
      remotePort: direct.port,
      remember: input?.remember !== false,
    };
  }
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
    key: `${host}:${remotePort}`,
    url: null,
    host,
    label: label.slice(0, 60) || host,
    token,
    remotePort,
    remember: input?.remember !== false,
  };
}

// In-app prompts (#1818): main sets { env(host), forget(host) } once the
// askpass relay is up. Unset (tests, Windows) keeps BatchMode.
let sshAskpass = null;
function setSshAskpass(value) {
  sshAskpass = value;
}

function askpassFor(deps) {
  if (process.platform === "win32") return null;
  return deps.askpass !== undefined ? deps.askpass : sshAskpass;
}

// Env for an ssh child: askpass only for the ssh processes spawned here.
function sshEnv(host, deps = {}) {
  const askpass = askpassFor(deps);
  return askpass ? { ...process.env, ...askpass.env(host) } : undefined;
}

// The web token goes over this ssh: unknown host keys are asked about in
// the app, changed ones still fail, even if ~/.ssh/config relaxes checking
// for this host. One password try so a wrong one fails fast.
function sshAuthOptions(interactive) {
  return interactive
    ? ["-o", "StrictHostKeyChecking=ask", "-o", "NumberOfPasswordPrompts=1"]
    : ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"];
}

// Turn ssh's stderr into an instruction. Without askpass (Windows) first
// contact and password logins have to be settled in a terminal once.
function explainSshFailure(host, stderr, code) {
  const text = stderr.trim();
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(text)) {
    return `The SSH host key for ${host} changed. Solenta will not send the web token until you verify the new key and update known_hosts.`;
  }
  if (/Host key verification failed/.test(text)) {
    return process.platform === "win32"
      ? `${host} is not in known_hosts yet. Run "ssh ${host}" in a terminal once to verify its host key, then connect again.`
      : `Solenta could not verify the SSH host key for ${host}. Connect again and choose Trust when Solenta shows its fingerprint.`;
  }
  if (/Permission denied/.test(text)) {
    return process.platform === "win32"
      ? `SSH refused the login to ${host}. Connections need key-based login (an SSH key or agent); passwords cannot be entered here.`
      : `SSH refused the login to ${host}. Check the user name and password, or the SSH key or agent, then connect again.`;
  }
  if (/Could not resolve hostname/.test(text)) {
    return `Cannot find ${host}. Check the name, or add it as a Host in ~/.ssh/config.`;
  }
  if (/Connection refused/.test(text)) {
    return `${host} is not accepting SSH. On a Mac, turn on Remote Login in System Settings > General > Sharing; on Linux, start sshd.`;
  }
  if (/timed out|No route to host|Network is unreachable/i.test(text)) {
    return `${host} did not answer. Check that it is awake and on your network or tailnet.`;
  }
  return text || `SSH exited (${code ?? "unknown"}).`;
}

// explainSshFailure, and a refused password is not offered to ssh again.
function sshFailure(host, stderr, code, deps = {}) {
  if (/Permission denied/.test(stderr)) askpassFor(deps)?.forget?.(host);
  return explainSshFailure(host, stderr, code);
}

function sshArgs(host, localPort, remotePort, interactive = false) {
  return [
    // -v only for the "Entering interactive session" readiness line; debug
    // lines are filtered out of every message shown to the user.
    "-v", "-N", "-T",
    ...sshAuthOptions(interactive),
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
// every start). Nothing running: macOS `open -n`s the app headless (a GUI
// process spawned by sshd has no window server), Linux starts the tarball
// headless (no display needed, and no renderer to sandbox). Already running
// with web access off: launch the same build with --handoff-only, which
// passes --serve-web to it via second-instance and never boots itself. A
// build without that flag predates the macOS single-instance lock and would
// boot a second writer on the same store, so it is refused (exit 5).
// Both channels keep productName "Solenta", so one userData path. sh -c,
// single-quoted, so a fish or zsh login shell on the host does not change
// the syntax: no single quotes inside. `ps`, not pgrep, on macOS: pgrep
// misses GUI apps from some contexts.
const NOT_INSTALLED_EXIT = 3;
const DID_NOT_START_EXIT = 4;
const TOO_OLD_EXIT = 5;
const HEADLESS_LOG = "$HOME/.solenta-headless.log";
const NO_SERVER_BUILD_EXIT = 6;
const SERVER_LOCK_EXIT = 7;
const SERVER_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const SERVER_MATCH = "/.solenta/server/[^ ]*/app/electron/server/index.js";

// Nothing installed (#1829): set up this version's headless server, T3-style.
// Side by side under ~/.solenta/server/<version>, checked against the sha256
// this computer passes in (so the download's transport does not matter),
// one installer at a time per version. Data lives in ~/.solenta/data, apart
// from a desktop Solenta's. No single quotes: this runs inside sh -c '...'.
function provisionServerLines(p, server) {
  const v = String(server.version);
  if (!/^[\w.+-]+$/.test(v)) throw new Error("Unexpected server version.");
  const arms = SERVER_TARGETS.filter((t) => server.byTarget[t]).map((t) => {
    const { url, sha256 } = server.byTarget[t];
    if (!/^https?:\/\/[\w./%:+-]+$/.test(url) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Unexpected server download.");
    return `    ${t}) url="${url}"; sum=${sha256} ;;`;
  });
  return `
  base="$HOME/.solenta/server"; dir="$base/${v}"
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) t=darwin-arm64 ;; Darwin-x86_64) t=darwin-x64 ;;
    Linux-x86_64|Linux-amd64) t=linux-x64 ;; Linux-aarch64|Linux-arm64) t=linux-arm64 ;;
    *) exit ${NO_SERVER_BUILD_EXIT} ;;
  esac
  url=""
  case "$t" in
${arms.join("\n")}
  esac
  [ -n "$url" ] || exit ${NO_SERVER_BUILD_EXIT}
  if [ ! -f "$dir/.install-complete" ]; then
    mkdir -p "$base"
    i=0
    until mkdir "$base/.lock-${v}" 2>/dev/null; do i=$((i+1)); [ "$i" -gt 600 ] && exit ${SERVER_LOCK_EXIT}; sleep 1; done
    trap "rm -rf \"$base/.lock-${v}\"" EXIT
    if [ ! -f "$dir/.install-complete" ]; then
      tmp="$base/.staging-$$"; rm -rf "$tmp"; mkdir -p "$tmp"
      if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$tmp/s.tgz" "$url" || exit 12
      elif command -v wget >/dev/null 2>&1; then wget -q -O "$tmp/s.tgz" "$url" || exit 12
      else exit 13; fi
      got="$( (sha256sum "$tmp/s.tgz" 2>/dev/null || shasum -a 256 "$tmp/s.tgz") | cut -d" " -f1)"
      [ "$got" = "$sum" ] || { rm -rf "$tmp"; exit 14; }
      tar -xzf "$tmp/s.tgz" -C "$tmp" || { rm -rf "$tmp"; exit 15; }
      rm -rf "$dir"; mv "$tmp/solenta-server" "$dir"; rm -rf "$tmp"
      echo ${v} > "$dir/.install-complete"
    fi
  fi
  mkdir -p "$HOME/.solenta/data"
  nohup "$dir/bin/solenta-server" --port ${p} --data-dir "$HOME/.solenta/data" >"${HEADLESS_LOG}" 2>&1 </dev/null &`;
}

/**
 * @param {number} port
 * @param {{ version: string, byTarget: Record<string, { url: string, sha256: string }> } | null} [server]
 *   this version's headless server downloads, when published (#1829)
 */
function prepareHostCommand(port, server = null) {
  const p = Number(port);
  return `sh -c '
tok() {
  if pgrep -f "${SERVER_MATCH}" >/dev/null 2>&1; then cat "$HOME/.solenta/data/web-token" 2>/dev/null; return; fi
  cat "$HOME/Library/Application Support/Solenta/web-token" 2>/dev/null || cat "\${XDG_CONFIG_HOME:-$HOME/.config}/Solenta/web-token" 2>/dev/null || cat "$HOME/.solenta/data/web-token" 2>/dev/null
}
up() { command -v curl >/dev/null 2>&1 || return 0; curl -s -o /dev/null -m 2 "http://127.0.0.1:${p}/"; }
running() {
  if [ "$(uname -s)" = Darwin ]; then ps -axo comm= | grep -E "/Contents/MacOS/Solenta( Nightly)?$" | head -n 1; return; fi
  for n in solenta solenta-nightly; do
    pid="$(pgrep -x "$n" 2>/dev/null | head -n 1)"
    if [ -n "$pid" ]; then readlink "/proc/$pid/exe"; return; fi
  done
}
if ! up; then
  app=""
  exe="$(running)"
  if [ -n "$exe" ]; then
    case "$exe" in
      */Contents/MacOS/*) app="\${exe%/Contents/MacOS/*}"; res="$app/Contents/Resources/app" ;;
      *) res="$(dirname "$exe")/resources/app" ;;
    esac
    grep -q -- --handoff-only "$res/electron/main.js" 2>/dev/null || exit ${TOO_OLD_EXIT}
    if [ -n "$app" ]; then
      open -n -g -a "$app" --args --serve-web=${p} --handoff-only || exit ${DID_NOT_START_EXIT}
    else
      nohup "$exe" --headless --serve-web=${p} --handoff-only --no-sandbox >"${HEADLESS_LOG}" 2>&1 </dev/null &
    fi
  else
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
      if [ -n "$bin" ]; then
        nohup "$bin" --headless --serve-web=${p} --no-sandbox >"${HEADLESS_LOG}" 2>&1 </dev/null &
      else${server ? provisionServerLines(p, server) : `
        exit ${NOT_INSTALLED_EXIT}`}
      fi
    fi
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

/**
 * This build's headless server downloads (#1829), from its GitHub release:
 * `solenta-server-<version>-<os>-<arch>.tar.gz` with the sha256 GitHub
 * stamps on each asset. Null when none are published (older releases, a
 * dev tree): connect then needs Solenta installed there, as before.
 */
const serverDownloadsByTag = new Map();
async function serverDownloads(deps = {}) {
  if (deps.serverDownloads !== undefined) return deps.serverDownloads;
  const updater = deps.updater || require("./updater.js");
  // Only a tagged release has a server built from exactly this code.
  const { tag } = updater.buildStamp();
  if (!tag) return null;
  if (serverDownloadsByTag.has(tag)) return serverDownloadsByTag.get(tag);
  try {
    const release = await updater.fetchTag(tag, deps.fetch);
    const byTarget = {};
    let version = null;
    for (const a of (release && release.assets) || []) {
      const m = /^solenta-server-(.+)-(darwin-arm64|darwin-x64|linux-x64|linux-arm64)\.tar\.gz$/.exec(String(a.name || ""));
      const sha = /^sha256:([0-9a-f]{64})$/.exec(String(a.digest || ""));
      if (!m || !sha) continue;
      version = m[1];
      byTarget[m[2]] = { url: String(a.browser_download_url), sha256: sha[1] };
    }
    const found = version ? { version, byTarget } : null;
    serverDownloadsByTag.set(tag, found);
    return found;
  } catch {
    // Offline or rate-limited: connect still works where Solenta is installed.
    return null;
  }
}

// "" when the host has no token file; throws on ssh failures (exit 255) so
// host-key and login problems surface before any tunnel is opened, and when
// Solenta is missing on the host or would not start.
async function readRemoteToken(host, remotePort = DEFAULT_REMOTE_PORT, deps = {}) {
  const env = sshEnv(host, deps);
  const server = await serverDownloads(deps);
  return new Promise((resolve, reject) => {
    (deps.execFile || execFile)("ssh", [
      "-T",
      ...sshAuthOptions(!!env),
      "-o", "ConnectTimeout=10",
      host,
      prepareHostCommand(remotePort, server),
    ], { timeout: server ? 15 * 60_000 : 90_000, maxBuffer: 64 * 1024, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      if (err && (err.code === 255 || err.killed)) {
        return reject(new Error(err.killed
          ? `Timed out preparing Solenta on ${host}.`
          : sshFailure(host, String(stderr || ""), err.code, deps)));
      }
      if (err && err.code === NOT_INSTALLED_EXIT) {
        return reject(new Error(`Solenta is not installed on ${host}. Install it there first: the app in /Applications on a Mac, or the Linux tarball unpacked to ~/solenta or on PATH as "solenta".`));
      }
      if (err && err.code === DID_NOT_START_EXIT) {
        // The log tail can hold the serve banner; never put its token in UI text.
        const tail = String(stderr || "").split("\n").filter((l) => !/token/i.test(l)).join("\n").trim();
        return reject(new Error(`Solenta did not start on ${host}. On a Mac someone must be logged in to the desktop; on Linux see ~/.solenta-headless.log there. If Solenta was already open there, restart it and connect again.${tail ? `\n${tail}` : ""}`));
      }
      if (err && err.code === NO_SERVER_BUILD_EXIT) {
        return reject(new Error(`There is no Solenta server build for ${host}'s system. Builds exist for macOS and Linux on Intel and ARM; install Solenta there yourself.`));
      }
      if (err && err.code === SERVER_LOCK_EXIT) {
        return reject(new Error(`Another connect is still setting Solenta up on ${host}. Try again in a minute.`));
      }
      if (err && INSTALL_EXITS[err.code] && server) {
        return reject(new Error(`Setting up Solenta on ${host} failed: ${INSTALL_EXITS[err.code]}`));
      }
      if (err && err.code === TOO_OLD_EXIT) {
        return reject(new Error(`Solenta is open on ${host} with web access off, and that version cannot turn it on remotely. On ${host}, turn on Settings > Connections > Serve Solenta Web, or update Solenta there, then connect again.`));
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
  const env = sshEnv(host, deps);
  const stdout = await new Promise((resolve, reject) => {
    (deps.execFile || execFile)("ssh", [
      "-T",
      ...sshAuthOptions(!!env),
      "-o", "ConnectTimeout=10",
      host,
      installHostCommand(asset.url, asset.sha256),
    ], { timeout: 10 * 60_000, maxBuffer: 256 * 1024, ...(env ? { env } : {}) }, (err, out, stderr) => {
      if (!err) return resolve(String(out));
      if (err.killed) return reject(new Error(`Timed out installing Solenta on ${host}.`));
      if (err.code === 255) return reject(new Error(sshFailure(host, String(stderr || ""), err.code, deps)));
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

// ws:// for a forwarded loopback port, ws(s):// for a direct address.
function wsUrlFor(target) {
  return typeof target === "number"
    ? `ws://127.0.0.1:${target}/ws`
    : `${target.replace(/^http/, "ws")}/ws`;
}

// After the token check: which Solenta and which agents the host has, for
// the Connections row. One extra socket; null when the host is too old to
// answer or slow, never an error. `target` is a loopback port or an origin.
function inspectHost(target, token, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrlFor(target));
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

// Checks the token on a loopback port (the SSH forward) or a direct
// origin. A direct host that never answers fails with `unreachable`.
function probeToken(target, token, opts = {}) {
  const unreachable = opts.unreachable || "SSH tunnel is not ready.";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrlFor(target));
    let opened = false;
    let settled = false;
    const timer = setTimeout(() => done(new Error(unreachable)), opts.timeoutMs ?? 1_000);
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
      done(new Error(typeof target === "number"
        ? "The forwarded port is not a Solenta Web host."
        : `${target} is not a Solenta Web host.`));
    });
    ws.once("close", () => done(new Error(opened
      ? "The remote Solenta host rejected this token."
      : unreachable)));
    ws.once("error", () => done(new Error(unreachable)));
  });
}

// Never probe before ssh owns the forwarded port: until then another local
// process could hold it and would receive the token. "Local forwarding
// listening" is logged BEFORE bind(), so it proves nothing; with
// ExitOnForwardFailure, ssh only enters the session once every bind worked.
async function waitForHost(child, token) {
  // An in-app password or host-key prompt may hold ssh before it is ready.
  const deadline = Date.now() + 15_000 + (child.interactive ? PROMPT_TIMEOUT_MS : 0);
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

// ssh -L to the host's web port. Sets child.ready once ssh owns the
// forward and child.failure on exit; onClose runs after the failure is set.
function spawnTunnel(spawnFn, host, backPort, remotePort, onClose, deps = {}) {
  const env = sshEnv(host, deps);
  const child = spawnFn("ssh", sshArgs(host, backPort, remotePort, !!env), {
    stdio: ["ignore", "ignore", "pipe"],
    ...(env ? { env } : {}),
  });
  child.interactive = !!env;
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
    child.failure = new Error(sshFailure(host, stderr, code, deps));
    onClose?.();
  });
  return child;
}

// The isolated desktop window for one host's Solenta Web. Links leaving
// `origin` open in the browser. Destroyed again if the page will not load.
async function createHostWindow({ origin, title, token, deps, onClosed }) {
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
  win.solentaRemote = true;
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
  win.on("closed", onClosed);
  // Web hosts accept a query token and scrub it after boot.
  try {
    await win.loadURL(`${origin}/?token=${encodeURIComponent(token)}`);
  } catch {
    if (!win.isDestroyed()) win.destroy();
    throw new Error("Unable to load the remote Solenta window.");
  }
  return win;
}

// Already connected (or connecting): bring its window forward instead.
function focusOpen(key) {
  const prior = active.get(key);
  if (!prior) return null;
  if (prior.win && !prior.win.isDestroyed()) {
    prior.win.show();
    prior.win.focus();
  }
  return prior.promise;
}

// A keychain token the host no longer accepts is deleted, and the user is
// asked for the current one.
function savedTokenRejected(err, fromKeychain, tokens, key) {
  if (!fromKeychain || !/rejected this token/.test(err.message)) return err;
  try { tokens.delete(key); } catch { /* best effort */ }
  return new Error("The remote Solenta host rejected the saved token. Enter its current token.");
}

// After the window opened: keep (or drop) the proven token and report
// which Solenta the host runs.
async function connectedResult(conn, token, inspected, deps) {
  let tokenSaved = false;
  try {
    const tokens = tokenStoreFor(deps);
    if (conn.remember) tokenSaved = tokens.set(conn.key, token);
    else tokens.delete(conn.key);
  } catch {
    // The window is open; a failed save only means asking next time.
  }
  const info = await inspected;
  const mine = deps.localVersion ?? localVersion();
  const remote = info && info.version
    ? { ...info, outdated: Boolean(mine) && compareVersions(info.version, mine) < 0 }
    : null;
  return {
    host: conn.host,
    remotePort: conn.remotePort,
    ...(conn.url ? { url: conn.url } : {}),
    tokenSaved,
    remote,
    localVersion: mine,
  };
}

const DIRECT_PROBE_MS = 10_000;

function unreachableText(url) {
  return `Nothing answered at ${url}. On that computer, open Settings > Connections > Let other devices in and turn on Serve Solenta Web, plus Expose over Tailscale or Allow devices on my network, and check that this computer is on the same network or tailnet.`;
}

// Direct route (#1824): no SSH, so nothing starts Solenta on the host; it
// must already serve its web UI at `url`. The token is a device token.
async function openDirectConnection(conn, deps) {
  const { url, key, label } = conn;
  const tokens = tokenStoreFor(deps);
  let token = conn.token;
  let fromKeychain = false;
  if (!token) {
    token = tokens.get(key);
    fromKeychain = !!token;
  }
  if (!token) {
    throw new Error(`Enter a device token for ${label}. On that computer, open Settings > Connections > Let other devices in, add a device with Full access, and paste its link or token here.`);
  }
  const prior = focusOpen(key);
  if (prior) return prior;
  const entry = { child: null, win: null, promise: null, closing: false, front: null, backPort: null, sockets: new Set() };
  active.set(key, entry);
  entry.promise = (async () => {
    try {
      await (deps.probeToken || probeToken)(url, token, { timeoutMs: DIRECT_PROBE_MS, unreachable: unreachableText(url) });
      const inspected = (deps.inspectHost || inspectHost)(url, token).catch(() => null);
      const win = await createHostWindow({
        origin: url,
        title: `${label} · Solenta`,
        token,
        deps,
        onClosed: () => {
          entry.closing = true;
          active.delete(key);
        },
      });
      entry.win = win;
      win.show();
      return await connectedResult(conn, token, inspected, deps);
    } catch (err) {
      active.delete(key);
      if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
      throw savedTokenRejected(err, fromKeychain, tokens, key);
    }
  })();
  return entry.promise;
}

async function openRemoteConnection(input, deps = {}) {
  const conn = validateConnection(input);
  if (conn.url) return openDirectConnection(conn, deps);
  const { host, label, remotePort, token: typed, key } = conn;
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
  const prior = focusOpen(key);
  if (prior) return prior;

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
    const child = spawnTunnel(spawnFn, host, backPort, remotePort, () => {
      if (entry.backPort === backPort) entry.backPort = null;
      if (entry.win && !entry.closing && !entry.reconnecting) void reconnect(child.failure);
    }, deps);
    entry.child = child;
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
      const win = await createHostWindow({
        origin: `http://127.0.0.1:${port}`,
        title,
        token,
        deps,
        onClosed: () => {
          entry.closing = true;
          active.delete(key);
          closeEntry(entry);
        },
      });
      entry.win = win;
      win.show();
      return await connectedResult(conn, token, inspected, deps);
    } catch (err) {
      active.delete(key);
      if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
      closeEntry(entry);
      throw savedTokenRejected(err, fromKeychain, tokens, key);
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
  tokenStoreFor(deps).delete(validateConnection({ ...input, token: "" }).key);
}

function closeRemoteConnections() {
  for (const entry of active.values()) {
    entry.closing = true;
    closeEntry(entry);
  }
  active.clear();
}

// One invoke on the host's web API over a tunnel of its own, no window.
// The reply can be large (Teleport back, #1702), hence the raised maxPayload.
function wsInvoke(wsUrl, token, channel, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { maxPayload: 128 * 1024 * 1024 });
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => done(new Error("The remote Solenta host did not answer in time.")), timeoutMs);
    ws.once("open", () => ws.send(JSON.stringify({ kind: "auth", token })));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return done(new Error("The remote Solenta host sent an unreadable reply."));
      }
      if (msg.kind === "auth-ok") {
        ws.send(JSON.stringify({ kind: "invoke", id: 1, channel, args }));
        return;
      }
      if (msg.kind !== "reply" || msg.id !== 1) return;
      if (!msg.error) return done(null, msg.result);
      done(new Error(/^No handler registered/.test(String(msg.error))
        ? "Solenta on the remote host is too old for this. Update it there, then try again."
        : String(msg.error)));
    });
    ws.once("error", (err) => done(err));
    ws.once("close", () => done(new Error("The remote Solenta host closed the connection.")));
  });
}

/**
 * Invoke one IPC channel on a saved remote host. Same token sources and
 * host prep as Connect: the host's token file over SSH, then the keychain.
 */
async function invokeRemote(input, channel, args, deps = {}) {
  const { child, token, wsUrl } = await openHostTunnel(input, deps);
  try {
    return await wsInvoke(wsUrl, token, channel, args, deps.timeoutMs ?? 10 * 60_000);
  } finally {
    child.kill();
  }
}

/**
 * A ready tunnel to a saved host's web API, no window: the host is prepared
 * (started if needed) and the token proven. `onClose` runs when ssh exits.
 * The caller owns `child` and kills it when done.
 */
async function openHostTunnel(input, deps = {}, onClose) {
  const conn = validateConnection({ host: input && input.host, remotePort: input && input.remotePort, url: input && input.url, label: input && input.label, token: "" });
  if (conn.url) {
    // Direct route: no tunnel to own, so `child` only satisfies the shape.
    // A linked computer (#1832) carries its own token: no keychain on a server.
    const token = (input && typeof input.token === "string" && input.token) || tokenStoreFor(deps).get(conn.key);
    if (!token) {
      throw new Error(`No web token found for ${conn.label}. Connect to it once from Settings > Connections with its device token.`);
    }
    await (deps.probeToken || probeToken)(conn.url, token, { timeoutMs: DIRECT_PROBE_MS, unreachable: unreachableText(conn.url) });
    return { child: { backPort: null, kill() {} }, token, wsUrl: wsUrlFor(conn.url) };
  }
  const { host, remotePort } = conn;
  const token = (await readRemoteToken(host, remotePort, deps)) || tokenStoreFor(deps).get(`${host}:${remotePort}`);
  if (!token) {
    throw new Error(`No web token found on ${host}. Connect to it once from Settings > Connections.`);
  }
  const child = spawnTunnel(deps.spawn || spawn, host, await freeLoopbackPort(), remotePort, onClose, deps);
  try {
    await waitForHost(child, token);
  } catch (err) {
    child.kill();
    throw err;
  }
  return { child, token, wsUrl: wsUrlFor(child.backPort) };
}

module.exports = {
  validateConnection,
  sshArgs,
  sshEnv,
  setSshAskpass,
  explainSshFailure,
  readRemoteToken,
  prepareHostCommand,
  installHostCommand,
  installRemoteSolenta,
  inspectHost,
  compareVersions,
  probeToken,
  parseDirectUrl,
  createTokenStore,
  openRemoteConnection,
  forgetRemoteConnection,
  closeRemoteConnections,
  invokeRemote,
  openHostTunnel,
};
