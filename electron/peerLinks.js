"use strict";

/**
 * Linked computers (#1832), T3's peer links: another Solenta this one's
 * agents can fork workers onto, whatever runs this one: the desktop app or
 * the headless server. Each link is that computer's Solenta Web address plus
 * a Full access device token, kept in <userData>/peers.json (0600; a server
 * has no keychain). The host hub keeps a socket to each, out of the window's
 * lists; thread_fork host, the finish wake-up and the crew relay all ride it.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {{
 *   userDataPath: string,
 *   hub: { setPeers: (peers: object[]) => object[] },
 *   remote?: { parseDirectUrl: Function, probeToken: Function },
 * }} deps
 */
function createPeerLinks({ userDataPath, hub, remote = require("./remoteConnections.js") }) {
  const file = path.join(userDataPath, "peers.json");

  function load() {
    try {
      const rows = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(rows) ? rows.filter((r) => r && typeof r.url === "string" && typeof r.token === "string") : [];
    } catch {
      return [];
    }
  }

  function save(rows) {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rows, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    hub.setPeers(rows);
  }

  /** Never hands tokens out. */
  function list() {
    return load().map(({ url, label }) => ({ key: url, url, label }));
  }

  /**
   * @param {{ link?: string, label?: string, token?: string }} input
   *   link: the device link from "Let other devices in" on that computer
   */
  async function link(input) {
    const parsed = remote.parseDirectUrl(String((input && input.link) || ""));
    const token = String((input && input.token) || parsed.linkToken || "").trim();
    if (!token) {
      throw new Error("Paste the device link (it carries the token), or the address plus a device token. On that computer: Settings → Connections → Let other devices in, add a device with Full access.");
    }
    await remote.probeToken(parsed.url, token, {
      timeoutMs: 10_000,
      unreachable: `Nothing answered at ${parsed.url}. On that computer turn on Serve Solenta Web, and Expose over Tailscale or Allow devices on my network.`,
    });
    const label = String((input && input.label) || "").trim() || parsed.hostname;
    save([...load().filter((r) => r.url !== parsed.url), { url: parsed.url, label, token }]);
    return list();
  }

  function unlink(input) {
    const key = String((input && input.key) || "");
    save(load().filter((r) => r.url !== key));
    return list();
  }

  /** Boot: connect to every saved link. */
  function start() {
    hub.setPeers(load());
  }

  return { list, link, unlink, start };
}

module.exports = { createPeerLinks };
