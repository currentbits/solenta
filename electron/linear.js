"use strict";

/**
 * Linear ticket adapter (issue #169). Parse a pasted Linear URL or ENG-123
 * identifier, then fetch via the GraphQL API. Never throws; failures come
 * back as `{ ok: false, reason }`.
 *
 * Auth is a Linear personal API key (Settings → Git, or LINEAR_API_KEY).
 * There is no `gh`-style CLI for Linear, so this is the one ticket backend
 * that talks HTTP instead of spawning a binary.
 */

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_TIMEOUT_MS = 30_000;

const ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    identifier
    number
    title
    description
    url
  }
}`;

/**
 * Team-key + number, e.g. ENG-123. Linear team keys are letters then
 * optional alphanumerics; the number is a positive integer.
 * @param {string} s
 * @returns {{ identifier: string, team: string, number: number } | null}
 */
function parseIdentifier(s) {
  const m = String(s || "")
    .trim()
    .match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/);
  if (!m) return null;
  const number = Number(m[2]);
  if (!Number.isInteger(number) || number <= 0) return null;
  const team = m[1].toUpperCase();
  return { identifier: `${team}-${number}`, team, number };
}

/**
 * Parse a pasted Linear issue reference.
 * Accepts `https://linear.app/<workspace>/issue/ENG-123/...` or `ENG-123`.
 *
 * @param {unknown} text
 * @returns {{ source: "linear", identifier: string, team: string, number: number, workspace?: string } | null}
 */
function parseLinearIssueRef(text) {
  const s = String(text || "").trim();
  if (!s) return null;

  const url = s.match(
    /^https?:\/\/(?:www\.)?linear\.app\/([^/#?\s]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#].*)?$/i,
  );
  if (url) {
    const parsed = parseIdentifier(url[2]);
    if (!parsed) return null;
    return { source: "linear", workspace: url[1], ...parsed };
  }

  const parsed = parseIdentifier(s);
  if (!parsed) return null;
  return { source: "linear", ...parsed };
}

/**
 * Settings key, then LINEAR_API_KEY. Empty string is unset.
 * @param {{ linearApiKey?: unknown }} [opts]
 * @returns {string}
 */
function resolveLinearApiKey(opts) {
  const fromOpts =
    opts && opts.linearApiKey != null ? String(opts.linearApiKey).trim() : "";
  if (fromOpts) return fromOpts;
  const fromEnv =
    process.env.LINEAR_API_KEY != null
      ? String(process.env.LINEAR_API_KEY).trim()
      : "";
  return fromEnv;
}

/**
 * One-line error text, capped, never empty.
 * @param {unknown} text
 * @param {string} fallback
 * @returns {string}
 */
function linearErr(text, fallback) {
  const s = String(text || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!s) return fallback;
  return s.length > 200 ? s.slice(0, 200) : s;
}

/**
 * POST the issue query. `opts.linearGraphql` short-circuits the network
 * (tests). `opts.fetch` swaps the HTTP client.
 *
 * @param {string} apiKey
 * @param {string} identifier
 * @param {{ linearGraphql?: Function, fetch?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<unknown>}
 */
async function postIssueQuery(apiKey, identifier, opts) {
  if (opts && typeof opts.linearGraphql === "function") {
    return opts.linearGraphql({ apiKey, identifier });
  }
  const fetchFn = (opts && opts.fetch) || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("fetch is not available");
  }
  const timeoutMs =
    opts && Number.isFinite(opts.timeoutMs)
      ? Number(opts.timeoutMs)
      : LINEAR_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: ISSUE_QUERY,
        variables: { id: identifier },
      }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw === "" ? "{}" : raw);
    } catch {
      throw new Error("linear returned unparseable issue JSON");
    }
    if (res.status === 401 || res.status === 403) {
      const err = new Error("auth");
      err.code = "auth";
      throw err;
    }
    if (!res.ok) {
      throw new Error(
        linearErr(
          (json && json.errors && json.errors[0] && json.errors[0].message) ||
            raw,
          `linear HTTP ${res.status}`,
        ),
      );
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch one Linear issue. Never throws.
 *
 * @param {{ identifier: string, number: number }} parsed
 * @param {{ linearApiKey?: unknown, linearGraphql?: Function, fetch?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true, issue: { number: number, title: string, body: string, url: string, source: "linear", identifier: string } } | { ok: false, reason: string }>}
 */
async function fetchLinearIssue(parsed, opts) {
  try {
    const identifier = parsed && parsed.identifier;
    if (!identifier) {
      return { ok: false, reason: "invalid issue reference" };
    }
    const apiKey = resolveLinearApiKey(opts);
    if (!apiKey) {
      return { ok: false, reason: "linear api key missing" };
    }

    let payload;
    try {
      payload = await postIssueQuery(apiKey, identifier, opts);
    } catch (err) {
      if (err && err.code === "auth") {
        return { ok: false, reason: "auth" };
      }
      if (err && err.name === "AbortError") {
        return { ok: false, reason: "linear request timed out" };
      }
      const msg = err && err.message ? String(err.message) : String(err);
      if (/unparseable issue JSON/i.test(msg)) {
        return { ok: false, reason: msg };
      }
      return { ok: false, reason: linearErr(msg, "linear request failed") };
    }

    const errors = payload && Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.length > 0) {
      const msg = errors
        .map((e) => (e && e.message != null ? String(e.message) : ""))
        .filter(Boolean)
        .join("; ");
      if (/not found|entity not found/i.test(msg)) {
        return { ok: false, reason: "issue not found" };
      }
      if (/unauthor|unauthent|forbidden|invalid api key/i.test(msg)) {
        return { ok: false, reason: "auth" };
      }
      return { ok: false, reason: linearErr(msg, "linear request failed") };
    }

    const data = payload && payload.data && payload.data.issue;
    if (!data) {
      return { ok: false, reason: "issue not found" };
    }

    const title = data.title != null ? String(data.title) : "";
    const url = data.url != null ? String(data.url) : "";
    const id =
      data.identifier != null ? String(data.identifier) : identifier;
    const number = Number(
      data.number != null ? data.number : parsed.number,
    );
    if (!title || !url || !Number.isInteger(number) || number <= 0) {
      return { ok: false, reason: "linear returned incomplete issue JSON" };
    }

    return {
      ok: true,
      issue: {
        number,
        title,
        body: data.description == null ? "" : String(data.description),
        url,
        source: "linear",
        identifier: id,
      },
    };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    return { ok: false, reason: msg || "issue fetch failed" };
  }
}

module.exports = {
  parseLinearIssueRef,
  fetchLinearIssue,
  resolveLinearApiKey,
  LINEAR_GRAPHQL_URL,
  LINEAR_TIMEOUT_MS,
  ISSUE_QUERY,
};
