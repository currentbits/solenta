"use strict";

const SENTRY_TIMEOUT_MS = 30_000;

function resolveSentryAuthToken(opts) {
  const fromOpts =
    opts && opts.sentryAuthToken != null ? String(opts.sentryAuthToken).trim() : "";
  if (fromOpts) return fromOpts;
  const fromEnv =
    process.env.SENTRY_AUTH_TOKEN != null ? String(process.env.SENTRY_AUTH_TOKEN).trim() : "";
  return fromEnv;
}

async function fetchProjectIssues(input) {
  const org = String((input && input.org) || "").trim();
  const project = String((input && input.project) || "").trim();
  const environment = input && input.environment != null ? String(input.environment).trim() : "";
  const token = String((input && input.token) || "").trim();
  if (!token) throw new Error("no auth token (Settings → Git)");
  if (input && typeof input.sentryIssues === "function") {
    return input.sentryIssues({ org, project, environment, token });
  }
  const fetchFn = (input && input.fetch) || globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("fetch is not available");
  const query = environment ? `is:unresolved environment:${environment}` : "is:unresolved";
  const params = new URLSearchParams({
    sort: "new",
    limit: "50",
    statsPeriod: "",
    query,
  });
  const qs = params.toString().replace(/\+/g, "%20");
  const url = `https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?${qs}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SENTRY_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (res.status === 401 || res.status === 403) {
      const err = new Error("auth");
      err.code = "auth";
      throw err;
    }
    if (!res.ok) throw new Error(`sentry HTTP ${res.status}`);
    let json;
    try {
      json = JSON.parse(raw === "" ? "[]" : raw);
    } catch {
      throw new Error("sentry returned unparseable issues JSON");
    }
    return Array.isArray(json) ? json : [];
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  resolveSentryAuthToken,
  fetchProjectIssues,
  SENTRY_TIMEOUT_MS,
};
