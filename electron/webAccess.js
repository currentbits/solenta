"use strict";

/**
 * Solenta Web at runtime (#1512 I2): the Settings switch, device tokens,
 * and the optional Tailscale Serve helper. main.js owns one instance; the
 * web:* IPC handlers (desktop only) call into it.
 *
 * Binding: loopback unless the user turns on "Allow devices on my network"
 * (or passes --serve-host). Tailscale Serve proxies to loopback, so it never
 * needs the LAN bind.
 */

const os = require("node:os");
const { execFile } = require("node:child_process");

const LOOPBACK = "127.0.0.1";
const ANY = "0.0.0.0";
const TAILSCALE_BINS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
const TAILSCALE_TIMEOUT_MS = 20_000;

function defaultExec(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: TAILSCALE_TIMEOUT_MS, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

function isLoopback(host) {
  return host === LOOPBACK || host === "localhost" || host === "::1";
}

function isWildcard(host) {
  return host === ANY || host === "::" || host === "";
}

/**
 * @param {string} host  bind address
 * @param {number} port
 * @param {ReturnType<typeof os.networkInterfaces>} ifaces
 * @returns {{ kind: "local" | "lan", url: string }[]}
 */
function listenUrls(host, port, ifaces) {
  if (isLoopback(host)) return [{ kind: "local", url: `http://${LOOPBACK}:${port}` }];
  if (!isWildcard(host)) return [{ kind: "lan", url: `http://${host}:${port}` }];
  const urls = [{ kind: "local", url: `http://${LOOPBACK}:${port}` }];
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) {
      if (a.internal || (a.family !== "IPv4" && a.family !== 4)) continue;
      urls.push({ kind: "lan", url: `http://${a.address}:${port}` });
    }
  }
  return urls;
}

/** Proxy targets in `tailscale serve status --json`, keyed by "host:port". */
function serveProxies(json) {
  const out = [];
  for (const [hostPort, web] of Object.entries((json && json.Web) || {})) {
    for (const [mount, h] of Object.entries((web && web.Handlers) || {})) {
      if (h && typeof h.Proxy === "string") out.push({ hostPort, mount, proxy: h.Proxy });
    }
  }
  return out;
}

function pointsAtPort(proxy, port) {
  return new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`).test(proxy);
}

function errorText(err) {
  const msg = [err && err.stderr, err && err.stdout, err && err.message]
    .map((s) => String(s || "").trim())
    .find(Boolean);
  return msg || "tailscale failed";
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import("./webDevices.js").createWebDevices>} deps.devices
 * @param {(opts: { host: string, port: number, authorize: Function }) => Promise<any>} deps.startServer
 * @param {number} deps.defaultPort
 * @param {typeof defaultExec} [deps.exec]
 * @param {() => ReturnType<typeof os.networkInterfaces>} [deps.networkInterfaces]
 * @param {(msg: string) => void} [deps.log]
 */
function createWebAccess(deps) {
  const devices = deps.devices;
  const exec = deps.exec || defaultExec;
  const networkInterfaces = deps.networkInterfaces || os.networkInterfaces;
  const log = deps.log || (() => {});
  /** @type {any} */
  let server = null;
  let host = LOOPBACK;
  /** @type {string | null | undefined} undefined = not probed yet */
  let tailscaleBin;

  async function start(opts) {
    await stop();
    host = opts.host || LOOPBACK;
    server = await deps.startServer({
      host,
      port: opts.port ?? deps.defaultPort,
      authorize: (token) => devices.authorize(token),
    });
    return server;
  }

  async function stop() {
    const s = server;
    server = null;
    if (s) await s.close();
  }

  async function tailscale(cmdArgs) {
    if (tailscaleBin === undefined) {
      tailscaleBin = null;
      for (const bin of TAILSCALE_BINS) {
        try {
          await exec(bin, ["version"]);
          tailscaleBin = bin;
          break;
        } catch {
          // not this one
        }
      }
    }
    if (!tailscaleBin) return null;
    return exec(tailscaleBin, cmdArgs);
  }

  /** Detect only. Never installs or logs in. */
  async function tailscaleStatus() {
    const port = server ? server.port : null;
    let st;
    try {
      st = await tailscale(["status", "--json"]);
    } catch (err) {
      // `status` exits non-zero when stopped or logged out.
      return { installed: true, loggedIn: false, host: null, serving: false, url: null, error: errorText(err) };
    }
    if (!st) return { installed: false, loggedIn: false, host: null, serving: false, url: null };
    let json = {};
    try {
      json = JSON.parse(st.stdout);
    } catch {
      // treat as logged out
    }
    const loggedIn = json.BackendState === "Running";
    const dns = String((json.Self && json.Self.DNSName) || "").replace(/\.$/, "");
    const base = { installed: true, loggedIn, host: dns || null, serving: false, url: null };
    if (!loggedIn || port == null) return base;
    try {
      const sv = await tailscale(["serve", "status", "--json"]);
      const ours = serveProxies(JSON.parse(sv.stdout || "{}")).find(
        (p) => p.mount === "/" && pointsAtPort(p.proxy, port),
      );
      if (ours) {
        const [h, p] = ours.hostPort.split(":");
        return { ...base, serving: true, url: p === "443" ? `https://${h}` : `https://${ours.hostPort}` };
      }
    } catch (err) {
      log(`solenta-web: tailscale serve status failed: ${errorText(err)}`);
    }
    return base;
  }

  async function setTailscale(on) {
    const current = await tailscaleStatus();
    if (!current.installed) throw new Error("Tailscale is not installed.");
    if (!current.loggedIn) throw new Error("Tailscale is not running or not logged in.");
    if (on) {
      if (!server) throw new Error("Turn on Solenta Web first.");
      if (current.serving) return current;
      // Refuse to replace someone else's HTTPS root on this machine.
      const sv = await tailscale(["serve", "status", "--json"]);
      const taken = serveProxies(JSON.parse(sv.stdout || "{}")).find(
        (p) => p.mount === "/" && p.hostPort.endsWith(":443"),
      );
      if (taken) {
        throw new Error(`Tailscale Serve already sends HTTPS to ${taken.proxy}. Remove that first.`);
      }
      try {
        await tailscale(["serve", "--bg", "--yes", "--https=443", `http://${LOOPBACK}:${server.port}`]);
      } catch (err) {
        throw new Error(errorText(err));
      }
    } else if (current.serving) {
      try {
        await tailscale(["serve", "--yes", "--https=443", "off"]);
      } catch (err) {
        throw new Error(errorText(err));
      }
    }
    return tailscaleStatus();
  }

  async function status() {
    const saved = devices.server();
    return {
      running: Boolean(server),
      lan: server ? !isLoopback(host) : saved.lan,
      port: server ? server.port : deps.defaultPort,
      urls: server ? listenUrls(host, server.port, networkInterfaces()) : [],
      devices: devices.list(),
      tailscale: await tailscaleStatus(),
    };
  }

  return {
    start,
    stop,
    status,

    /** Boot: start if the user left the switch on. Never throws. */
    async restore() {
      const saved = devices.server();
      if (!saved.enabled) return;
      try {
        await start({ host: saved.lan ? ANY : LOOPBACK });
      } catch (err) {
        log(`solenta-web: cannot start (${err && err.message ? err.message : err})`);
      }
    },

    /** @param {{ enabled: boolean, lan?: boolean }} input */
    async setEnabled(input) {
      const enabled = Boolean(input && input.enabled);
      const lan = input && typeof input.lan === "boolean" ? input.lan : devices.server().lan;
      if (!enabled) {
        // Do not leave a tailnet URL proxying to a closed port.
        try {
          if (server && (await tailscaleStatus()).serving) await setTailscale(false);
        } catch (err) {
          log(`solenta-web: tailscale serve off failed: ${errorText(err)}`);
        }
        await stop();
      } else if (!server || host !== (lan ? ANY : LOOPBACK)) {
        try {
          await start({ host: lan ? ANY : LOOPBACK, port: server ? server.port : undefined });
        } catch (err) {
          const code = err && err.code;
          throw new Error(
            code === "EADDRINUSE"
              ? `Port ${deps.defaultPort} is already in use. Quit the other Solenta first.`
              : String((err && err.message) || err),
          );
        }
      }
      devices.setServer({ enabled, lan });
      return status();
    },

    /** @param {{ name: string }} input */
    async addDevice(input) {
      return devices.add(input);
    },

    /** Revoke, then drop that device's open sockets immediately. */
    async revokeDevice(input) {
      const device = devices.revoke(String((input && input.id) || ""));
      if (server && typeof server.disconnect === "function") server.disconnect(device.id);
      return device;
    },

    /** @param {{ on: boolean }} input */
    async setTailscale(input) {
      return setTailscale(Boolean(input && input.on));
    },

    broadcast(channel, payload) {
      if (server) server.broadcast(channel, payload);
    },

    /** --serve-web's printed token is the Legacy device row. */
    adoptLegacy(token) {
      return devices.adoptLegacy(token);
    },

    isRunning() {
      return Boolean(server);
    },
  };
}

module.exports = {
  createWebAccess,
  listenUrls,
  serveProxies,
  LOOPBACK,
  ANY,
};
