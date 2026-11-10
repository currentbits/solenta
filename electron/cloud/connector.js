"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { fork, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const VERSION = "2026.10.7";
const TARGETS = {
  "darwin-x64": ["cloudflared-darwin-amd64.tgz", "02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848"],
  "darwin-arm64": ["cloudflared-darwin-arm64.tgz", "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd"],
  "linux-x64": ["cloudflared-linux-amd64", "1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872"],
  "linux-arm64": ["cloudflared-linux-arm64", "3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775"],
};
function spawnOwned(binary, args, options) {
  const owner = fork(path.join(__dirname, "connectorChild.js"), [], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, execArgv: [],
  });
  owner.send({ binary, args, env: options.env }, error => { if (error) owner.emit("error", new Error("Connector owner could not start.")); });
  return owner;
}
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function ensureBinary({ cacheDir, platform = process.platform, arch = process.arch, fetch = globalThis.fetch }) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error("Cloud hosting supports macOS and Linux on Intel and ARM.");
  const [asset, expected] = target, cached = path.join(cacheDir, `${VERSION}-${asset}`);
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  let valid = false;
  try { valid = await digest(cached) === expected; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!valid) {
    let url = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${asset}`, response;
    const signal = AbortSignal.timeout(120_000);
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await fetch(url, { redirect: "manual", signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const next = new URL(response.headers.get("location"), url);
      if (next.protocol !== "https:" || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(next.hostname)) throw new Error("Connector download redirected to an unexpected host.");
      await response.body?.cancel(); url = next.toString();
    }
    if (!response.ok) throw new Error("Connector download failed.");
    const temporary = `${cached}.${randomUUID()}.tmp`;
    let fd, size = 0;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      for await (const chunk of response.body) {
        size += chunk.length; if (size > 128 * 1024 * 1024) throw new Error("Connector download is too large.");
        hash.update(chunk); fs.writeFileSync(fd, chunk);
      }
      if (hash.digest("hex") !== expected) throw new Error("Connector checksum did not match the pinned release.");
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, cached);
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  }
  if (!asset.endsWith(".tgz")) { fs.chmodSync(cached, 0o700); return cached; }
  const binary = `${cached}.bin`, temporary = `${binary}.${randomUUID()}.tmp`;
  try {
    // Extract to stdout so archive paths can never overwrite another file.
    const { stdout } = await run("tar", ["-xOzf", cached, "cloudflared"], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024, timeout: 30_000 });
    fs.writeFileSync(temporary, stdout, { mode: 0o700, flag: "wx" }); fs.renameSync(temporary, binary);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  return binary;
}
function createConnector({ cacheDir, fetch, install = ensureBinary, spawn = spawnOwned, setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout }) {
  let child, timer, wanted = false, state = "stopped", attempts = 0, generation = 0, beforeStart, token;
  async function launch(epoch) {
    if (!wanted || epoch !== generation) return;
    try {
      const binary = await install({ cacheDir, fetch });
      if (!wanted || epoch !== generation) return;
      await beforeStart?.();
      if (!wanted || epoch !== generation) return;
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, TUNNEL_TOKEN: token };
      attempts++; state = "running";
      const current = spawn(binary, ["tunnel", "--no-autoupdate", "--loglevel", "error", "run"], { env, stdio: "ignore", windowsHide: true });
      child = current;
      const startedAt = Date.now();
      let ended = false;
      const exit = () => {
        if (ended) return; ended = true;
        if (child === current) child = null;
        if (!wanted || epoch !== generation) return;
        if (Date.now() - startedAt >= 60_000) attempts = 0;
        retry(epoch);
      };
      current.once("exit", exit); current.once("error", exit);
    } catch { attempts++; retry(epoch); }
  }
  function retry(epoch) {
    if (attempts >= 5) { state = "failed"; return; }
    state = "retrying";
    timer = schedule(() => launch(epoch), Math.min(30_000, 1000 * 2 ** (attempts - 1))); timer.unref?.();
  }
  return {
    status: () => ({ state, supported: Boolean(TARGETS[`${process.platform}-${process.arch}`]) }),
    async start(input) {
      if (wanted && token === input.token && state !== "failed") return;
      if (typeof input.token !== "string" || !input.token || input.token.length > 16384) throw new Error("Invalid connector credential.");
      generation++; cancel(timer); child?.kill("SIGTERM"); child = null;
      token = input.token; beforeStart = input.beforeStart; wanted = true; attempts = 0; state = "starting";
      await launch(generation);
    },
    async close() { wanted = false; generation++; cancel(timer); child?.kill("SIGTERM"); child = null; token = null; state = "stopped"; },
  };
}
module.exports = { ensureBinary, createConnector, VERSION, TARGETS };
