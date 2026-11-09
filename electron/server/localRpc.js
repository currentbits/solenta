"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { WebSocket } = require("ws");
const { parseComputerDescriptor, confirmComputer, DESCRIPTOR_PATH } = require("../serverIdentity");

async function publicDescriptor(port, expectedComputerId, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: DESCRIPTOR_PATH, timeout }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error("The local endpoint did not provide a Solenta identity. No credential was sent.")); return; }
      let raw = "";
      response.on("data", chunk => { raw += chunk; if (raw.length > 65536) req.destroy(new Error("The local endpoint identity response was too large.")); });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const computer = parseComputerDescriptor(JSON.parse(raw));
          if (computer.computerId !== expectedComputerId || computer.runtimeKind !== "server") throw new Error("The local endpoint belongs to a different computer or runtime. No credential was sent.");
          resolve(computer);
        } catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Timed out verifying the local server identity.")));
    req.on("error", reject);
  });
}
async function invokeLocal(port, dataDir, channel, args = [], timeout = 5000) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Use this server's actual --port.");
  const expectedComputerId = fs.readFileSync(path.join(dataDir, "computer-id"), "utf8").trim();
  const computer = await publicDescriptor(port, expectedComputerId, timeout);
  const token = fs.readFileSync(path.join(dataDir, "web-token"), "utf8").trim();
  return new Promise((resolve, reject) => {
    let authenticatedComputer, finished = false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { maxPayload: 4 * 1024 * 1024, followRedirects: false });
    const done = (error, value) => {
      if (finished) return; finished = true;
      clearTimeout(timer); ws.terminate(); error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => done(new Error("Timed out authenticating the local Solenta server.")), timeout);
    ws.on("error", error => done(error));
    ws.on("open", () => ws.send(JSON.stringify({ kind: "auth", token, computerId: expectedComputerId, protocol: 1 })));
    ws.on("message", raw => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return done(new Error("Invalid server response.")); }
      try {
        if (msg.kind === "auth-ok") {
          authenticatedComputer = confirmComputer(computer, msg.computer, expectedComputerId);
          ws.send(JSON.stringify({ kind: "invoke", id: 1, channel, args }));
        }
        if (msg.kind === "reply" && msg.id === 1) {
          if (msg.error) return done(new Error(msg.error));
          if (!authenticatedComputer) throw new Error("Server replied before authentication.");
          if (channel === "app:status") confirmComputer(authenticatedComputer, msg.result?.computer, expectedComputerId);
          done(null, msg.result);
        }
      } catch (error) { done(error); }
    });
    ws.on("close", () => done(new Error("Server closed before readiness was verified.")));
  });
}
function requestStatus(port, dataDir, timeout = 5000) { return invokeLocal(port, dataDir, "app:status", [], timeout); }
module.exports = { publicDescriptor, invokeLocal, requestStatus };
