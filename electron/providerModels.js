"use strict";

/**
 * Live model listing for Settings › Providers (#1714). Runs in main so the
 * key never leaves the process that stores it: the renderer names a provider
 * ref, and the key and base URL come from that ref's saved instance env.
 *
 * Anthropic: GET {base}/v1/models with x-api-key + anthropic-version.
 * Everything else: OpenAI-compatible GET {base}/models with a Bearer key,
 * reading `{ data: [...] }` or a bare array.
 */

const {
  parseProviderRef,
  findInstance,
  OPENAI_COMPAT_KEY_ENV,
  defaultAccountFor,
} = require("./providerInstances.js");

const TIMEOUT_MS = 10_000;

/**
 * Where each base provider lists models and which env var holds the key.
 * Only the ones with a public models endpoint; the rest show the catalog.
 */
const ENDPOINTS = {
  claude: { kind: "anthropic", keyEnv: "ANTHROPIC_API_KEY", baseEnv: "ANTHROPIC_BASE_URL", base: "https://api.anthropic.com" },
  codex: { kind: "openai", keyEnv: "OPENAI_API_KEY", base: "https://api.openai.com/v1" },
  grok: { kind: "openai", keyEnv: "XAI_API_KEY", base: "https://api.x.ai/v1" },
};

/**
 * @typedef {{ url: string, headers: Record<string, string>, kind: "anthropic" | "openai" }} ModelsRequest
 */

/**
 * The request for a provider ref, or a readable reason there is none.
 * @param {{ providerInstances?: unknown } | null | undefined} settings
 * @param {string} ref
 * @returns {ModelsRequest | { error: string }}
 */
function modelsRequest(settings, ref) {
  const { provider, instance } = parseProviderRef(ref);
  const inst = findInstance(settings, provider, instance || defaultAccountFor(settings, provider) || provider);
  const env = (inst && inst.env) || {};
  const oc = inst && inst.openaiCompatible;
  if (oc) {
    const key = env[OPENAI_COMPAT_KEY_ENV];
    const url = oc.modelsUrl || `${oc.baseUrl.replace(/\/+$/, "")}/models`;
    return {
      kind: "openai",
      url,
      headers: { ...oc.headers, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    };
  }
  const ep = ENDPOINTS[/** @type {keyof typeof ENDPOINTS} */ (provider)];
  if (!ep) return { error: "This provider has no models endpoint. Showing its catalog." };
  const key = env[ep.keyEnv];
  if (!key) return { error: `Add an API key to list models live. Showing the catalog.` };
  const base = ((ep.baseEnv && env[ep.baseEnv]) || ep.base).replace(/\/+$/, "");
  if (ep.kind === "anthropic") {
    return {
      kind: "anthropic",
      url: `${base}/v1/models?limit=1000`,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    };
  }
  return { kind: "openai", url: `${base}/models`, headers: { Authorization: `Bearer ${key}` } };
}

/**
 * @param {unknown} body
 * @returns {import('../src/shared/ipc').FetchedModel[]}
 */
function parseModels(body) {
  const rec = /** @type {Record<string, unknown>} */ (body && typeof body === "object" ? body : {});
  const rows = Array.isArray(body) ? body : Array.isArray(rec.data) ? rec.data : Array.isArray(rec.models) ? rec.models : null;
  if (!rows) throw new Error("The models endpoint returned an unexpected shape");
  /** @type {import('../src/shared/ipc').FetchedModel[]} */
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const r = /** @type {Record<string, unknown>} */ (typeof row === "string" ? { id: row } : row || {});
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id || id.length > 100 || seen.has(id)) continue;
    seen.add(id);
    const label =
      (typeof r.display_name === "string" && r.display_name) ||
      (typeof r.name === "string" && r.name) ||
      id;
    const ctx = Number(r.context_length ?? r.context_window ?? r.max_input_tokens);
    out.push({ id, label, ...(Number.isFinite(ctx) && ctx > 0 ? { contextTokens: ctx } : {}) });
  }
  return out;
}

/**
 * @param {{ providerInstances?: unknown } | null | undefined} settings
 * @param {string} ref
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<import('../src/shared/ipc').FetchedModel[]>}
 */
async function fetchProviderModels(settings, ref, opts = {}) {
  let discoveryError;
  if (parseProviderRef(ref).provider === "claude" && (!opts.fetch || opts.runInitialize)) {
    try {
      const models = await require("./claudeModels.js").refresh(settings, ref, { ...opts, force: true });
      if (models) return models.modelInfo.map(({ id, label, contextTokens }) => ({ id, label, ...(contextTokens ? { contextTokens } : {}) }));
    } catch (err) { discoveryError = err; }
  }
  const req = modelsRequest(settings, ref);
  if ("error" in req) throw discoveryError || new Error(req.error);
  const fetchImpl = opts.fetch || fetch;
  // A plain ref'd timer, not AbortSignal.timeout: that one is unref'd.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(req.url, {
      headers: { accept: "application/json", ...req.headers },
      signal: ctl.signal,
    });
  } catch (err) {
    const e = /** @type {{ name?: string, message?: string }} */ (err);
    if (ctl.signal.aborted) {
      throw new Error(`${new URL(req.url).host} did not answer within ${Math.round((opts.timeoutMs ?? TIMEOUT_MS) / 1000)}s`);
    }
    throw new Error(`Could not reach ${new URL(req.url).host}: ${(e && e.message) || "network error"}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? "the API key was rejected"
        : res.status === 404
          ? "no models endpoint at that URL"
          : "request failed";
    throw new Error(`Models list failed (${res.status}): ${hint}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("The models endpoint did not return JSON");
  }
  return parseModels(body);
}

module.exports = { fetchProviderModels, modelsRequest, parseModels, ENDPOINTS };
