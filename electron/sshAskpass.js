"use strict";

// In-app SSH prompts (#1818). Our ssh children run with SSH_ASKPASS pointing
// at a helper that relays each prompt (password, passphrase, unknown host
// key) to this process over loopback, authenticated with a per-launch
// secret that only those children get in their env. The renderer answers.

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

// Under the 90 s prepare timeout so a slow answer still reaches ssh.
const PROMPT_TIMEOUT_MS = 75_000;

const HELPER_SH = `#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec "$SOLENTA_ASKPASS_NODE" "$(dirname "$0")/ssh-askpass.js" "$@"
`;

// Runs under Electron-as-node: one JSON line out, one JSON line back.
const HELPER_JS = `"use strict";
const net = require("node:net");
const sock = net.connect(Number(process.env.SOLENTA_ASKPASS_PORT), "127.0.0.1");
let reply = "";
process.exitCode = 1;
sock.setEncoding("utf8");
sock.on("connect", () => sock.write(JSON.stringify({
  secret: process.env.SOLENTA_ASKPASS_SECRET || "",
  host: process.env.SOLENTA_ASKPASS_HOST || "",
  prompt: process.argv[2] || "",
}) + "\\n"));
sock.on("data", (chunk) => { reply += chunk; });
sock.on("end", () => {
  try {
    const answer = JSON.parse(reply).answer;
    if (typeof answer === "string") {
      process.stdout.write(answer + "\\n");
      process.exitCode = 0;
    }
  } catch {}
});
sock.on("error", () => {});
`;

function classifySshPrompt(prompt) {
  const text = String(prompt);
  if (/fingerprint|continue connecting/i.test(text)) return "hostkey";
  if (/password|passphrase/i.test(text)) return "password";
  return "other";
}

/**
 * Pending prompts for the renderer. send(payload) delivers "ssh:prompt" and
 * returns the webContents it reached; none, all of them destroyed, or the
 * timeout cancel the prompt (null). A password is remembered per host and
 * prompt for later ssh calls (prepare, then tunnel, then reconnects) until
 * forget(host) after ssh refuses it.
 */
function createSshPrompts({ send, timeoutMs = PROMPT_TIMEOUT_MS }) {
  const pending = new Map();
  const remembered = new Map();
  return {
    ask({ host, prompt }) {
      const kind = classifySshPrompt(prompt);
      const key = `${host}\n${prompt}`;
      if (kind === "password" && remembered.has(key)) return Promise.resolve(remembered.get(key));
      return new Promise((resolve) => {
        const id = crypto.randomUUID();
        const finish = (answer) => {
          if (!pending.has(id)) return;
          pending.delete(id);
          clearTimeout(timer);
          if (answer !== null && kind === "password") remembered.set(key, answer);
          resolve(answer);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        pending.set(id, finish);
        const targets = send({ id, host, prompt, kind }) || [];
        let alive = targets.length;
        if (!alive) return finish(null);
        for (const wc of targets) {
          wc.once?.("destroyed", () => {
            if (--alive === 0) finish(null);
          });
        }
      });
    },
    answer(id, answer) {
      const finish = pending.get(id);
      if (finish) finish(typeof answer === "string" ? answer : null);
    },
    forget(host) {
      for (const key of remembered.keys()) {
        if (key.startsWith(`${host}\n`)) remembered.delete(key);
      }
    },
    cancelAll() {
      for (const finish of [...pending.values()]) finish(null);
    },
  };
}

/**
 * Loopback relay plus helper files in dir. env(host) is the env addition
 * for one ssh child. ask({ host, prompt }) resolves the answer or null.
 */
async function startAskpassServer({ dir, ask, nodePath = process.execPath }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const helper = path.join(dir, "ssh-askpass.sh");
  fs.writeFileSync(path.join(dir, "ssh-askpass.js"), HELPER_JS, { mode: 0o600 });
  fs.writeFileSync(helper, HELPER_SH, { mode: 0o700 });
  fs.chmodSync(helper, 0o700);
  const secret = crypto.randomBytes(32).toString("hex");
  const server = net.createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.setTimeout(PROMPT_TIMEOUT_MS + 5_000, () => sock.destroy());
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 16 * 1024) return sock.destroy();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      sock.removeAllListeners("data");
      let req;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        return sock.destroy();
      }
      const given = Buffer.from(String(req.secret || ""));
      if (given.length !== secret.length || !crypto.timingSafeEqual(given, Buffer.from(secret))) {
        return sock.destroy();
      }
      Promise.resolve(ask({ host: String(req.host || ""), prompt: String(req.prompt || "") }))
        .catch(() => null)
        .then((answer) => sock.end(JSON.stringify(typeof answer === "string" ? { answer } : {})));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();
  const port = server.address().port;
  return {
    env: (host) => ({
      SSH_ASKPASS: helper,
      SSH_ASKPASS_REQUIRE: "force",
      // OpenSSH before 8.4 ignores SSH_ASKPASS_REQUIRE and wants a DISPLAY.
      DISPLAY: process.env.DISPLAY || "solenta",
      SOLENTA_ASKPASS_NODE: nodePath,
      SOLENTA_ASKPASS_PORT: String(port),
      SOLENTA_ASKPASS_SECRET: secret,
      SOLENTA_ASKPASS_HOST: host,
    }),
    close: () => server.close(),
  };
}

module.exports = { classifySshPrompt, createSshPrompts, startAskpassServer, PROMPT_TIMEOUT_MS };
