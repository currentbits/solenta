"use strict";

/**
 * Model catalog updates between app releases (#1529).
 *
 * CI (scripts/catalog-publish.js) signs a dump of the PROVIDERS models /
 * modelInfo with Ed25519 and uploads catalog.json + catalog.json.sig to the
 * fixed `catalog` release. The app verifies against the embedded public key
 * and swaps the data into PROVIDERS only when its rev beats both the bundled
 * CATALOG_REV and anything applied earlier. A verified copy is cached in
 * userData so the next launch starts from it. Never blocks startup; every
 * failure keeps the bundled catalog.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PROVIDERS, CATALOG_REV } = require("./providers.js");

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2VLT5PRuSm+mbvm1nFDgoUNG5lW12L0QLgpyzVNuyHY=
-----END PUBLIC KEY-----`;
const BASE_URL =
  "https://github.com/currentbits/solenta/releases/download/catalog";
const FETCH_TIMEOUT_MS = 10_000;
/** ModelInfo data fields; anything else in the file is dropped. */
const FIELDS = [
  "id",
  "label",
  "description",
  "vendor",
  "recommended",
  "contextTokens",
  "efforts",
  "inputModalities",
  "fast",
  "minCli",
];

let appliedRev = 0;

function pick(m) {
  const out = {};
  for (const k of FIELDS) if (m[k] !== undefined) out[k] = m[k];
  return out;
}

/** The signed payload: rev plus every provider's models / modelInfo. */
function dumpCatalog(rev = CATALOG_REV, providers = PROVIDERS) {
  const out = {};
  for (const p of providers) {
    out[p.id] = { models: p.models.slice(), modelInfo: p.modelInfo.map(pick) };
  }
  return { rev, providers: out };
}

function verifyCatalog(body, sigB64, publicKey = PUBLIC_KEY) {
  try {
    return crypto.verify(
      null,
      Buffer.from(String(body)),
      publicKey,
      Buffer.from(String(sigB64).trim(), "base64"),
    );
  } catch {
    return false;
  }
}

const isStr = (v) => typeof v === "string" && v.length > 0;
const isStrList = (v) => Array.isArray(v) && v.every(isStr);

function validModelInfo(m) {
  return (
    m &&
    isStr(m.id) &&
    typeof m.label === "string" &&
    typeof m.description === "string" &&
    typeof m.vendor === "string" &&
    (m.efforts === undefined || isStrList(m.efforts)) &&
    (m.inputModalities === undefined || isStrList(m.inputModalities)) &&
    (m.contextTokens === undefined || Number.isFinite(m.contextTokens)) &&
    (m.minCli === undefined || isStr(m.minCli))
  );
}

/**
 * Apply an already-verified body. A provider with a malformed block keeps
 * its bundled data; unknown provider ids are ignored.
 * @returns {boolean} true when the rev was new enough to apply
 */
function applyCatalog(body, { bundledRev = CATALOG_REV, providers = PROVIDERS } = {}) {
  let json;
  try {
    json = JSON.parse(String(body));
  } catch {
    return false;
  }
  if (
    !json ||
    !Number.isInteger(json.rev) ||
    json.rev <= Math.max(bundledRev, appliedRev) ||
    !json.providers ||
    typeof json.providers !== "object"
  ) {
    return false;
  }
  for (const p of providers) {
    const next = json.providers[p.id];
    if (
      !next ||
      !isStrList(next.models) ||
      !Array.isArray(next.modelInfo) ||
      !next.modelInfo.every(validModelInfo)
    ) {
      continue;
    }
    p.models = next.models.slice();
    p.modelInfo = next.modelInfo.map(pick);
  }
  appliedRev = json.rev;
  return true;
}

async function fetchText(fetchImpl, url) {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "solenta-catalog" },
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/**
 * Apply the cached copy now, then refresh from the release in the
 * background. The returned promise never rejects.
 *
 * @param {string} userDataPath
 * @param {{ fetch?: typeof fetch, baseUrl?: string, publicKey?: string, providers?: object[] }} [deps]
 * @returns {Promise<boolean>} true when a fetched catalog was applied
 */
function initRemoteCatalog(userDataPath, deps = {}) {
  const file = path.join(userDataPath, "catalog.json");
  const publicKey = deps.publicKey || PUBLIC_KEY;
  const applyOpts = deps.providers ? { providers: deps.providers } : {};
  try {
    const body = fs.readFileSync(file, "utf8");
    if (verifyCatalog(body, fs.readFileSync(`${file}.sig`, "utf8"), publicKey)) {
      applyCatalog(body, applyOpts);
    }
  } catch {
    // No cache yet.
  }
  // node:test must not reach GitHub; tests inject fetch.
  if (!deps.fetch && process.env.NODE_TEST_CONTEXT) return Promise.resolve(false);
  const fetchImpl = deps.fetch || fetch;
  const base = deps.baseUrl || BASE_URL;
  return (async () => {
    const [body, sig] = await Promise.all([
      fetchText(fetchImpl, `${base}/catalog.json`),
      fetchText(fetchImpl, `${base}/catalog.json.sig`),
    ]);
    if (!verifyCatalog(body, sig, publicKey) || !applyCatalog(body, applyOpts)) return false;
    fs.writeFileSync(file, body);
    fs.writeFileSync(`${file}.sig`, sig);
    return true;
  })().catch(() => false);
}

/** Test hook. */
function resetAppliedRev() {
  appliedRev = 0;
}

module.exports = {
  PUBLIC_KEY,
  BASE_URL,
  dumpCatalog,
  verifyCatalog,
  applyCatalog,
  initRemoteCatalog,
  resetAppliedRev,
};
