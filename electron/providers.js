"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * Data-driven provider registry for agent CLIs.
 *
 * @typedef {object} ProviderEntry
 * @property {string} id
 * @property {string} name
 * @property {string} binEnv - env var that overrides the binary
 * @property {string} defaultBin
 * @property {boolean} supportsResume
 * @property {string[]} models
 * @property {"claude-stream" | "codex-json" | "kimi-stream" | "text" | "simulate"} kind
 * @property {(opts: { prompt: string, sessionId?: string | null, permissionMode?: string, model?: string | null }) => string[]} buildArgs
 */

/** @type {ProviderEntry[]} */
const PROVIDERS = [
  {
    id: "claude",
    name: "Claude Code",
    binEnv: "CODER_CLAUDE_BIN",
    defaultBin: "claude",
    supportsResume: true,
    models: [
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ],
    kind: "claude-stream",
    buildArgs({ prompt, sessionId, permissionMode, model }) {
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        String(permissionMode || "default"),
      ];
      if (model) {
        args.push("--model", String(model));
      }
      if (sessionId) {
        args.push("--resume", String(sessionId));
      }
      args.push(String(prompt ?? ""));
      return args;
    },
  },
  {
    id: "codex",
    name: "Codex",
    binEnv: "CODER_CODEX_BIN",
    defaultBin: "codex",
    supportsResume: true,
    models: [],
    kind: "codex-json",
    buildArgs({ prompt, sessionId, model }) {
      if (sessionId) {
        const args = [
          "exec",
          "resume",
          String(sessionId),
          "--json",
          "--skip-git-repo-check",
        ];
        if (model) {
          args.push("-m", String(model));
        }
        args.push(String(prompt ?? ""));
        return args;
      }
      const args = ["exec", "--json", "--skip-git-repo-check"];
      if (model) {
        args.push("-m", String(model));
      }
      args.push(String(prompt ?? ""));
      return args;
    },
  },
  {
    id: "grok",
    name: "Grok",
    binEnv: "CODER_GROK_BIN",
    defaultBin: "grok",
    supportsResume: false,
    models: [],
    kind: "text",
    buildArgs({ prompt }) {
      return ["-p", String(prompt ?? "")];
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    binEnv: "CODER_OPENCODE_BIN",
    defaultBin: "opencode",
    supportsResume: false,
    models: [],
    kind: "text",
    buildArgs({ prompt }) {
      return ["run", String(prompt ?? "")];
    },
  },
  {
    id: "kimi",
    name: "Kimi Code",
    binEnv: "CODER_KIMI_BIN",
    defaultBin: "kimi",
    supportsResume: true,
    models: ["k3", "kimi-for-coding", "kimi-for-coding-highspeed"],
    kind: "kimi-stream",
    /**
     * Kimi sessions are per working directory. When thread.sessionId is set we
     * pass -c (continue) instead of a session id and keep sessionId as the
     * sentinel "cwd". Two kimi threads sharing a cwd share history; mitigated
     * by worktree-per-thread.
     */
    buildArgs({ prompt, sessionId, permissionMode, model }) {
      const args = ["-p", String(prompt ?? ""), "--output-format", "stream-json"];
      if (model) {
        args.push("-m", String(model));
      }
      const mode = String(permissionMode || "default");
      if (mode === "acceptEdits") {
        args.push("-y");
      } else if (mode === "bypassPermissions") {
        args.push("--auto");
      }
      // default / plan: no permission flag
      if (sessionId) {
        args.push("-c");
      }
      return args;
    },
  },
];

/** Internal simulate entry (listed only when CODER_SIMULATE=1). */
const SIMULATE_ENTRY = {
  id: "simulate",
  name: "Simulate",
  binEnv: "",
  defaultBin: "",
  supportsResume: false,
  models: [],
  kind: "simulate",
  buildArgs() {
    return [];
  },
};

/**
 * Resolve binary path: env override then default.
 * @param {ProviderEntry} entry
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveBin(entry, env = process.env) {
  if (!entry) return "";
  if (entry.binEnv && env[entry.binEnv]) {
    const override = String(env[entry.binEnv]).trim();
    if (override) return override;
  }
  return entry.defaultBin || "";
}

/**
 * Default which: absolute/relative path via existsSync, else `which` on PATH.
 * @param {string} bin
 * @returns {string | null}
 */
function defaultWhich(bin) {
  if (!bin) return null;
  if (path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    try {
      return fs.existsSync(bin) ? bin : null;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync("which", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} bin
 * @param {(bin: string) => string | null} [whichFn]
 */
function isBinAvailable(bin, whichFn = defaultWhich) {
  if (!bin) return false;
  // Absolute or relative path: filesystem only (ignore which/PATH).
  if (path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    try {
      return fs.existsSync(bin);
    } catch {
      return false;
    }
  }
  return Boolean(whichFn(bin));
}

/**
 * @param {string} id
 * @returns {ProviderEntry | null}
 */
function getProvider(id) {
  if (!id) return null;
  if (id === "simulate") return SIMULATE_ENTRY;
  return PROVIDERS.find((p) => p.id === id) || null;
}

/**
 * All known public provider ids (not including simulate/generic).
 */
function knownProviderIds() {
  return PROVIDERS.map((p) => p.id);
}

/**
 * List providers for IPC (ProviderInfo[]). Availability is computed per call.
 *
 * @param {object} [opts]
 * @param {(bin: string) => string | null} [opts.which] - inject for tests
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {boolean} [opts.includeSimulate] - default: CODER_SIMULATE===1
 * @returns {import('../src/shared/ipc').ProviderInfo[]}
 */
function listProviders(opts = {}) {
  const whichFn = opts.which || defaultWhich;
  const env = opts.env || process.env;
  const includeSimulate =
    opts.includeSimulate != null
      ? Boolean(opts.includeSimulate)
      : env.CODER_SIMULATE === "1";

  /** @type {import('../src/shared/ipc').ProviderInfo[]} */
  const out = [];

  for (const entry of PROVIDERS) {
    const bin = resolveBin(entry, env);
    out.push({
      id: entry.id,
      name: entry.name,
      available: isBinAvailable(bin, whichFn),
      supportsResume: entry.supportsResume,
      models: entry.models.slice(),
    });
  }

  if (includeSimulate) {
    out.push({
      id: SIMULATE_ENTRY.id,
      name: SIMULATE_ENTRY.name,
      available: true,
      supportsResume: false,
      models: [],
    });
  }

  return out;
}

module.exports = {
  PROVIDERS,
  SIMULATE_ENTRY,
  getProvider,
  knownProviderIds,
  resolveBin,
  isBinAvailable,
  defaultWhich,
  listProviders,
};
