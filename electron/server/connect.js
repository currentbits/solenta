#!/usr/bin/env node
"use strict";

const path = require("node:path");
const os = require("node:os");
const { invokeLocal } = require("./localRpc");
const { createOAuth } = require("../cloud/oauth");
const { fetchJSON } = require("../cloud/http");

function parseArgs(argv) {
  const out = { action: "status", port: 4620, dataDir: path.join(os.homedir(), ".solenta", "data") };
  let action = false;
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++i];
    if (flag === "--port") out.port = Number(value());
    else if (flag === "--data-dir") out.dataDir = path.resolve(value());
    else if (flag === "--help") out.help = true;
    else if (!action && ["login", "link", "status", "unlink", "logout"].includes(flag)) { out.action = flag; action = true; }
    else throw new Error("Use solenta-connect [login|link|status|unlink|logout] [--port N] [--data-dir DIR].");
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error("--port must be 1-65535. Use the running server's actual port.");
  return out;
}
async function main(argv, deps = {}) {
  const options = parseArgs(argv);
  const output = deps.output ?? (text => process.stdout.write(text));
  if (options.help) { output("solenta-connect [login|link|status|unlink|logout] [--port N] [--data-dir DIR]\nUses the already running Solenta server in this data directory. No SSH is needed.\n"); return; }
  const invoke = deps.invoke ?? invokeLocal;
  const call = (action, extra = {}) => invoke(options.port, options.dataDir, "cloud:admin", [{ action, ...extra }], 180_000);
  const status = await call("status");
  if (options.action === "status") return status;
  async function login() {
    const origin = status.account?.brokerOrigin;
    if (!origin) throw new Error("Solenta Cloud is not configured in this running server.");
    const config = await fetchJSON(deps.fetch ?? fetch, `${origin}/v1/config`);
    if (config.origin !== origin || config.protocol !== 1) throw new Error("Cloud login configuration does not match this server.");
    const oauth = (deps.createOAuth ?? createOAuth)({ issuer: config.issuer, clientId: config.clientId, fetch: deps.fetch });
    output(status.account?.storage === "plaintext" ? "Cloud credentials are stored unencrypted in a private 0600 file on this host.\n" : "Cloud credentials will use this runtime's secure storage.\n");
    const auth = await oauth.login({ headless: true, onCode: code => output(`Open ${code.verificationUri}\nEnter code: ${code.userCode}\n`) });
    return call("accept-login", { oauth: auth });
  }
  if (options.action === "login") return login();
  if (options.action === "link") { if (!status.account?.signedIn) await login(); return call("link"); }
  return call(options.action);
}
if (require.main === module) main(process.argv.slice(2)).then(result => { if (result !== undefined) console.log(JSON.stringify(result)); }, error => {
  process.stderr.write(`${String(error.message || "Cloud command failed.").slice(0, 500)}\n`); process.exitCode = 1;
});
module.exports = { main, parseArgs };
