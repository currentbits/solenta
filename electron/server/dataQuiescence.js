"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

// No bearer/token crosses the socket. The nonce proof identifies the configured
// writer; an unverified or unresponsive listener also fails closed. Only a
// refused loopback connection proves that the listener has gone away.
function probeMemoryListener(config, timeout = 500) {
  return new Promise((resolve) => {
    const nonce = crypto.randomBytes(24).toString("hex");
    let finished = false;
    const done = (state) => { if (finished) return; finished = true; clearTimeout(timer); req.destroy(); resolve(state); };
    const req = http.get({ host: "127.0.0.1", port: config.port, path: `/health?nonce=${nonce}`, agent: false }, (response) => {
      let raw = "";
      response.on("data", (chunk) => { raw += chunk; if (raw.length > 65536) done("unknown"); });
      response.on("error", () => done("unknown"));
      response.on("end", () => {
        try {
          const proof = JSON.parse(raw).proof;
          const expected = crypto.createHmac("sha256", config.token).update(nonce).digest("hex");
          done(response.statusCode === 200 && typeof proof === "string" && /^[0-9a-f]{64}$/.test(proof) && crypto.timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(expected, "hex")) ? "serving" : "unknown");
        } catch { done("unknown"); }
      });
    });
    const timer = setTimeout(() => done("unknown"), timeout);
    req.on("error", (error) => done(error.code === "ECONNREFUSED" ? "closed" : "unknown"));
  });
}
async function waitDataQuiescent(dataDir, { timeout = 15000, interval = 100, probe = probeMemoryListener } = {}) {
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(dataDir, "memory-server.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return; throw new Error("Cannot verify the memory writer configuration; no data snapshot or restoration was attempted."); }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.token !== "string") throw new Error("Cannot verify the memory writer configuration; no data snapshot or restoration was attempted.");
  const deadline = Date.now() + timeout;
  do {
    if (await probe(config, Math.min(500, Math.max(1, deadline - Date.now()))) === "closed") return;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, Math.min(interval, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);
  throw new Error("The memory writer is still serving or could not be proven stopped. No data snapshot or restoration was attempted. Stop its owning app or supervisor, then retry; an adopted server was not killed.");
}
module.exports = { waitDataQuiescent, probeMemoryListener };
