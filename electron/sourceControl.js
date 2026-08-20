"use strict";

/**
 * Forge CLI discovery (issue #608).
 *
 * Probes each known provider up front and returns readiness as data — present,
 * version, signed-in-as — so Settings and git actions do not have to parse
 * stderr after a failed push/PR. Cached until an explicit Rescan or a
 * mid-session auth miss (worktrees.isGhAuthFailure) busts it.
 *
 * GitHub CLI 2.81.0 added `gh auth status --json`. Older gh still creates
 * PRs here, so a working text parse keeps status "available"; "outdated" is
 * only when we cannot tell who is signed in AND the binary is below 2.81,
 * so the hint says to upgrade instead of "auth failed".
 */

const { execFile } = require("node:child_process");

const PROBE_TIMEOUT_MS = 8_000;
const GH_AUTH_JSON_MIN = [2, 81, 0];

/** @type {import('../src/shared/ipc').SourceControlDiscovery | null} */
let cache = null;
/** @type {Promise<import('../src/shared/ipc').SourceControlDiscovery> | null} */
let inflight = null;
let generation = 0;

function invalidateDiscoveryCache() {
  cache = null;
  inflight = null;
  generation += 1;
}

/**
 * @param {string} text
 * @returns {{ raw: string, parts: [number, number, number] } | null}
 */
function parseCliVersion(text) {
  const m = String(text || "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return {
    raw: `${m[1]}.${m[2]}.${m[3] || "0"}`,
    parts: [Number(m[1]), Number(m[2]), Number(m[3] || 0)],
  };
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 */
function versionGte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

/**
 * @param {string} text
 * @returns {{ status: "authenticated" | "unauthenticated", detail: string } | null}
 */
function parseGhAuthText(text) {
  const s = String(text || "");
  const logged = s.match(/Logged in to \S+ account (\S+)/i);
  if (logged && logged[1]) {
    return { status: "authenticated", detail: logged[1] };
  }
  if (
    /not logged into any GitHub|to get started with GitHub CLI|gh auth login/i.test(
      s,
    )
  ) {
    return {
      status: "unauthenticated",
      detail: "Not signed in. Run gh auth login.",
    };
  }
  return null;
}

/**
 * `gh auth status --json hosts` (CLI 2.81+). `--json` always exits 0, so
 * readiness is `state === "success"` on the active account, not the exit code.
 * @param {string} stdout
 * @returns {{ status: "authenticated" | "unauthenticated", detail: string } | null}
 */
function parseGhAuthJson(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout || "").trim());
  } catch {
    return null;
  }
  const hosts = data && data.hosts;
  if (!hosts || typeof hosts !== "object") return null;
  /** @type {any[]} */
  const accounts = [];
  for (const rows of Object.values(hosts)) {
    if (Array.isArray(rows)) accounts.push(...rows);
  }
  const active =
    accounts.find((a) => a && a.active) ||
    accounts.find((a) => a && String(a.state).toLowerCase() === "success") ||
    accounts[0];
  if (
    active &&
    String(active.state).toLowerCase() === "success" &&
    active.login
  ) {
    return { status: "authenticated", detail: String(active.login) };
  }
  return {
    status: "unauthenticated",
    detail: "Not signed in. Run gh auth login.",
  };
}

/**
 * @param {string} text
 * @returns {{ status: "authenticated" | "unauthenticated", detail: string } | null}
 */
function parseGlabAuthText(text) {
  const s = String(text || "");
  const logged =
    s.match(/Logged in to \S+ as (\S+)/i) || s.match(/Logged in as (\S+)/i);
  if (logged && logged[1]) {
    return { status: "authenticated", detail: String(logged[1]).replace(/[()]/g, "") };
  }
  if (/no token|not authenticated|auth login/i.test(s)) {
    return {
      status: "unauthenticated",
      detail: "Not signed in. Run glab auth login.",
    };
  }
  return null;
}

/**
 * @param {string} stdout
 * @returns {{ status: "authenticated" | "unauthenticated", detail: string } | null}
 */
function parseAzAccountJson(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout || "").trim());
  } catch {
    return null;
  }
  const name =
    (data && data.user && data.user.name) ||
    (data && data.name) ||
    null;
  if (name) {
    return { status: "authenticated", detail: String(name) };
  }
  return null;
}

/**
 * @param {"github" | "gitlab" | "bitbucket" | "azure-devops"} kind
 * @param {"missing" | "outdated" | "login" | "extension" | "token"} reason
 * @param {string} [platform]
 */
function installHintFor(kind, reason, platform = process.platform) {
  const brew = platform === "darwin";
  const win = platform === "win32";
  if (kind === "github") {
    if (reason === "missing") {
      if (brew) return "brew install gh";
      if (win) return "winget install --id GitHub.cli";
      return "See https://cli.github.com/ to install gh";
    }
    if (reason === "outdated") {
      if (brew) return "brew upgrade gh";
      if (win) return "winget upgrade --id GitHub.cli";
      return "Upgrade GitHub CLI to 2.81.0 or newer";
    }
    return "gh auth login";
  }
  if (kind === "gitlab") {
    if (reason === "missing") {
      if (brew) return "brew install glab";
      if (win) return "winget install --id GitLab.GLab";
      return "See https://gitlab.com/gitlab-org/cli to install glab";
    }
    return "glab auth login";
  }
  if (kind === "azure-devops") {
    if (reason === "missing") {
      if (brew) return "brew install azure-cli";
      if (win) return "winget install --id Microsoft.AzureCLI";
      return "See https://learn.microsoft.com/cli/azure/install-azure-cli";
    }
    if (reason === "extension") return "az extension add --name azure-devops";
    return "az login";
  }
  return 'export SOLENTA_BITBUCKET_ACCESS_TOKEN="your-access-token"';
}

/**
 * @param {object} opts
 * @param {typeof execFile} opts.execFile
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {string} bin
 * @param {string[]} args
 * @returns {Promise<{ ok: boolean, enoent: boolean, timedOut: boolean, stdout: string, stderr: string, combined: string }>}
 */
function runCli(opts, bin, args) {
  const exec = opts.execFile || execFile;
  const env = {
    ...process.env,
    ...(opts.env || {}),
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    AZURE_CORE_NO_COLOR: "1",
  };
  return new Promise((resolve) => {
    exec(
      bin,
      args,
      {
        encoding: "utf8",
        timeout: PROBE_TIMEOUT_MS,
        env,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const out = stdout != null ? String(stdout) : "";
        const errText = stderr != null ? String(stderr) : "";
        if (err && err.code === "ENOENT") {
          resolve({
            ok: false,
            enoent: true,
            timedOut: false,
            stdout: "",
            stderr: "",
            combined: "",
          });
          return;
        }
        const msg = err && err.message ? String(err.message) : "";
        const timedOut = Boolean(
          err &&
            (err.code === "ETIMEDOUT" ||
              (err.killed && /ETIMEDOUT|timed out/i.test(msg))),
        );
        const combined = [out, errText, msg].filter(Boolean).join("\n");
        resolve({
          ok: !err,
          enoent: false,
          timedOut,
          stdout: out.trim(),
          stderr: errText.trim(),
          combined,
        });
      },
    );
  });
}

/**
 * @param {object} opts
 * @returns {Promise<import('../src/shared/ipc').SourceControlProvider>}
 */
async function probeGithub(opts) {
  const env = opts.env || process.env;
  const bin = (opts.bins && opts.bins.github) || env.CODER_GH_BIN || "gh";
  const versionRun = await runCli(opts, bin, ["--version"]);
  if (versionRun.enoent) {
    return {
      kind: "github",
      label: "GitHub",
      status: "missing",
      installHint: installHintFor("github", "missing", opts.platform),
      version: null,
      auth: {
        status: "unauthenticated",
        detail: "GitHub CLI (gh) is not installed.",
      },
    };
  }
  const parsed = parseCliVersion(versionRun.stdout || versionRun.combined);
  const version = parsed ? parsed.raw : null;
  const canJson = parsed ? versionGte(parsed.parts, GH_AUTH_JSON_MIN) : false;

  let auth = /** @type {import('../src/shared/ipc').SourceControlAuth} */ ({
    status: "unknown",
    detail: null,
  });

  if (canJson) {
    const jsonRun = await runCli(opts, bin, ["auth", "status", "--json", "hosts"]);
    if (jsonRun.timedOut) {
      auth = {
        status: "unknown",
        detail: "Timed out checking GitHub sign-in.",
      };
    } else {
      auth =
        parseGhAuthJson(jsonRun.stdout) ||
        parseGhAuthText(jsonRun.combined) ||
        auth;
      if (auth.status === "unknown") {
        const textRun = await runCli(opts, bin, ["auth", "status"]);
        auth = parseGhAuthText(textRun.combined || textRun.stdout) || auth;
      }
    }
  } else {
    const textRun = await runCli(opts, bin, ["auth", "status"]);
    if (textRun.timedOut) {
      auth = {
        status: "unknown",
        detail: "Timed out checking GitHub sign-in.",
      };
    } else {
      const parsedAuth = parseGhAuthText(textRun.combined || textRun.stdout);
      if (parsedAuth) {
        auth = parsedAuth;
      } else if (parsed && !versionGte(parsed.parts, GH_AUTH_JSON_MIN)) {
        return {
          kind: "github",
          label: "GitHub",
          status: "outdated",
          installHint: installHintFor("github", "outdated", opts.platform),
          version,
          auth: {
            status: "unknown",
            detail: `GitHub CLI ${version} cannot report sign-in status (need 2.81.0 or newer).`,
          },
        };
      } else {
        auth = {
          status: "unknown",
          detail: "Could not verify GitHub sign-in status.",
        };
      }
    }
  }

  const installHint =
    auth.status === "authenticated"
      ? installHintFor("github", "login", opts.platform)
      : auth.status === "unknown" && parsed && !versionGte(parsed.parts, GH_AUTH_JSON_MIN)
        ? installHintFor("github", "outdated", opts.platform)
        : installHintFor("github", "login", opts.platform);

  return {
    kind: "github",
    label: "GitHub",
    status: "available",
    installHint,
    version,
    auth,
  };
}

/**
 * @param {object} opts
 * @returns {Promise<import('../src/shared/ipc').SourceControlProvider>}
 */
async function probeGitlab(opts) {
  const env = opts.env || process.env;
  const bin = (opts.bins && opts.bins.gitlab) || env.CODER_GLAB_BIN || "glab";
  const versionRun = await runCli(opts, bin, ["--version"]);
  if (versionRun.enoent) {
    return {
      kind: "gitlab",
      label: "GitLab",
      status: "missing",
      installHint: installHintFor("gitlab", "missing", opts.platform),
      version: null,
      auth: {
        status: "unauthenticated",
        detail: "GitLab CLI (glab) is not installed.",
      },
    };
  }
  const parsed = parseCliVersion(versionRun.stdout || versionRun.combined);
  const authRun = await runCli(opts, bin, ["auth", "status"]);
  let auth = parseGlabAuthText(authRun.combined || authRun.stdout);
  if (!auth) {
    if (authRun.timedOut) {
      auth = { status: "unknown", detail: "Timed out checking GitLab sign-in." };
    } else if (authRun.ok) {
      auth = { status: "authenticated", detail: "Signed in." };
    } else {
      auth = {
        status: "unauthenticated",
        detail: "Not signed in. Run glab auth login.",
      };
    }
  }
  return {
    kind: "gitlab",
    label: "GitLab",
    status: "available",
    installHint: installHintFor("gitlab", "login", opts.platform),
    version: parsed ? parsed.raw : null,
    auth,
  };
}

/**
 * @param {object} opts
 * @returns {Promise<import('../src/shared/ipc').SourceControlProvider>}
 */
async function probeAzure(opts) {
  const env = opts.env || process.env;
  const bin = (opts.bins && opts.bins.azure) || env.CODER_AZ_BIN || "az";
  const account = await runCli(opts, bin, ["account", "show", "-o", "json"]);
  if (account.enoent) {
    return {
      kind: "azure-devops",
      label: "Azure DevOps",
      status: "missing",
      installHint: installHintFor("azure-devops", "missing", opts.platform),
      version: null,
      auth: {
        status: "unauthenticated",
        detail: "Azure CLI (az) is not installed.",
      },
    };
  }
  if (account.timedOut) {
    return {
      kind: "azure-devops",
      label: "Azure DevOps",
      status: "available",
      installHint: installHintFor("azure-devops", "login", opts.platform),
      version: null,
      auth: { status: "unknown", detail: "Timed out checking Azure sign-in." },
    };
  }
  const parsedAuth = parseAzAccountJson(account.stdout);
  if (!parsedAuth) {
    return {
      kind: "azure-devops",
      label: "Azure DevOps",
      status: "available",
      installHint: installHintFor("azure-devops", "login", opts.platform),
      version: null,
      auth: {
        status: "unauthenticated",
        detail: "Not signed in. Run az login.",
      },
    };
  }
  const ext = await runCli(opts, bin, [
    "extension",
    "show",
    "--name",
    "azure-devops",
    "-o",
    "json",
  ]);
  if (!ext.ok || ext.enoent) {
    return {
      kind: "azure-devops",
      label: "Azure DevOps",
      status: "available",
      installHint: installHintFor("azure-devops", "extension", opts.platform),
      version: null,
      auth: {
        status: "unauthenticated",
        detail:
          "Azure CLI is signed in, but the azure-devops extension is missing.",
      },
    };
  }
  return {
    kind: "azure-devops",
    label: "Azure DevOps",
    status: "available",
    installHint: installHintFor("azure-devops", "login", opts.platform),
    version: null,
    auth: parsedAuth,
  };
}

/**
 * Bitbucket has no CLI here — T3 uses env tokens, and #456 will too.
 * @param {object} opts
 * @returns {import('../src/shared/ipc').SourceControlProvider}
 */
function probeBitbucket(opts) {
  const env = opts.env || process.env;
  const access = String(env.SOLENTA_BITBUCKET_ACCESS_TOKEN || "").trim();
  const email = String(env.SOLENTA_BITBUCKET_EMAIL || "").trim();
  const apiToken = String(env.SOLENTA_BITBUCKET_API_TOKEN || "").trim();
  const hint = installHintFor("bitbucket", "token", opts.platform);
  if (access) {
    return {
      kind: "bitbucket",
      label: "Bitbucket",
      status: "available",
      installHint: hint,
      version: null,
      auth: { status: "authenticated", detail: "Access token is set." },
    };
  }
  if (email && apiToken) {
    return {
      kind: "bitbucket",
      label: "Bitbucket",
      status: "available",
      installHint: hint,
      version: null,
      auth: { status: "authenticated", detail: email },
    };
  }
  return {
    kind: "bitbucket",
    label: "Bitbucket",
    status: "available",
    installHint: hint,
    version: null,
    auth: {
      status: "unauthenticated",
      detail:
        "Set SOLENTA_BITBUCKET_ACCESS_TOKEN, or SOLENTA_BITBUCKET_EMAIL plus SOLENTA_BITBUCKET_API_TOKEN.",
    },
  };
}

/**
 * @param {object} [opts]
 * @returns {Promise<import('../src/shared/ipc').SourceControlDiscovery>}
 */
async function probeAll(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const runOpts = {
    execFile: opts.execFile,
    env,
    bins: opts.bins || {},
    platform,
  };
  const [github, gitlab, azure] = await Promise.all([
    probeGithub(runOpts),
    probeGitlab(runOpts),
    probeAzure(runOpts),
  ]);
  return {
    sourceControlProviders: [github, gitlab, probeBitbucket(runOpts), azure],
    probedAt: opts.now != null ? opts.now : Date.now(),
  };
}

function useProductionCache(opts) {
  if (opts.cache === true) return true;
  if (opts.cache === false) return false;
  return !opts.execFile && !opts.bins && !opts.env;
}

/**
 * @param {{ rescan?: boolean, execFile?: typeof execFile, env?: NodeJS.ProcessEnv, bins?: Record<string, string>, platform?: string, now?: number, cache?: boolean }} [opts]
 * @returns {Promise<import('../src/shared/ipc').SourceControlDiscovery>}
 */
async function discoverSourceControl(opts = {}) {
  const cacheable = useProductionCache(opts);
  if (opts.rescan && cacheable) {
    cache = null;
    generation += 1;
  }
  if (cacheable && cache && !opts.rescan) return cache;
  if (cacheable && inflight && !opts.rescan) return inflight;

  const gen = cacheable ? generation : -1;
  const run = probeAll(opts).then(
    (result) => {
      if (cacheable && gen === generation) {
        cache = result;
        if (inflight === run) inflight = null;
      }
      return result;
    },
    (err) => {
      if (cacheable && inflight === run) inflight = null;
      throw err;
    },
  );
  if (cacheable) inflight = run;
  return run;
}

module.exports = {
  discoverSourceControl,
  invalidateDiscoveryCache,
  parseCliVersion,
  parseGhAuthText,
  parseGhAuthJson,
  parseGlabAuthText,
  parseAzAccountJson,
  installHintFor,
  versionGte,
  GH_AUTH_JSON_MIN,
  PROBE_TIMEOUT_MS,
};
