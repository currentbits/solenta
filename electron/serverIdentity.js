"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WIRE_PROTOCOL = 1;
const DESCRIPTOR_PATH = "/.well-known/solenta";
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;

// Publish a completed file without replacing another initializer's winner.
// Corruption is an error: silently rotating identity could bind old credentials
// to an unrelated data directory after an accidental restore or truncation.
function loadOrCreateComputerId(dataDir) {
  if (!dataDir) throw new Error("A data directory is required for computer identity.");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "computer-id");
  try {
    const id = fs.readFileSync(file, "utf8").trim();
    if (!ID_PATTERN.test(id)) throw new Error("The computer identity file is invalid. Restore it before starting Solenta.");
    return id;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const temp = path.join(dataDir, `.computer-id-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(temp, `${crypto.randomUUID()}\n`, { flag: "wx", mode: 0o600 });
    try { fs.linkSync(temp, file); } catch (err) { if (err.code !== "EEXIST") throw err; }
  } finally {
    try { fs.unlinkSync(temp); } catch (err) { if (err.code !== "ENOENT") throw err; }
  }
  return loadOrCreateComputerId(dataDir);
}

function computerDescriptor(dataDir, opts = {}) {
  const pkg = opts.pkg || require("../package.json");
  const descriptor = {
    kind: "solenta",
    computerId: loadOrCreateComputerId(dataDir),
    protocol: { min: WIRE_PROTOCOL, max: WIRE_PROTOCOL },
    runtimeKind: opts.runtimeKind || (process.env.SOLENTA_SERVER === "1" ? "server" : "desktop"),
    capabilities: ["wire", "computer-identity"],
  };
  for (const field of ["version", "releaseTag", "buildSha"]) {
    if (typeof pkg[field] === "string" && pkg[field]) descriptor[field] = pkg[field];
  }
  return descriptor;
}

// Whitelist public fields even when a newer server includes private extras.
function parseComputerDescriptor(value) {
  if (!value || value.kind !== "solenta" || !ID_PATTERN.test(value.computerId) ||
    !value.protocol || !Number.isInteger(value.protocol.min) || !Number.isInteger(value.protocol.max) ||
    value.protocol.min < 1 || value.protocol.max < value.protocol.min ||
    !["server", "desktop"].includes(value.runtimeKind)) {
    throw new Error("The remote computer returned an invalid Solenta identity.");
  }
  if (value.protocol.min > WIRE_PROTOCOL || value.protocol.max < WIRE_PROTOCOL) {
    throw new Error("The remote computer uses an incompatible Solenta wire protocol. Update Solenta before connecting.");
  }
  const out = { kind: "solenta", computerId: value.computerId, protocol: { min: value.protocol.min, max: value.protocol.max }, runtimeKind: value.runtimeKind };
  for (const field of ["version", "releaseTag", "buildSha"]) {
    if (typeof value[field] === "string" && value[field].length <= 200) out[field] = value[field];
  }
  if (Array.isArray(value.capabilities)) out.capabilities = value.capabilities.filter((v) => typeof v === "string" && v.length <= 100).slice(0, 100);
  return out;
}

function confirmComputer(publicDescriptor, authenticated, expectedId) {
  if (!publicDescriptor && !authenticated && !expectedId) return null;
  const confirmed = parseComputerDescriptor(authenticated);
  if ((publicDescriptor && publicDescriptor.computerId !== confirmed.computerId) ||
      (expectedId && expectedId !== confirmed.computerId)) {
    throw new Error("Computer identity mismatch. This address belongs to a different computer; the saved connection was preserved.");
  }
  return confirmed;
}

module.exports = { loadOrCreateComputerId, computerDescriptor, parseComputerDescriptor, confirmComputer, WIRE_PROTOCOL, DESCRIPTOR_PATH };
