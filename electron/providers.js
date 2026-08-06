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
 * @property {"claude-stream" | "codex-json" | "kimi-stream" | "opencode-json" | "simulate"} kind
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
    supportsResume: true,
    models: ["grok-4.5"],
    kind: "claude-stream",
    /**
     * Grok CLI: -p <prompt> --output-format streaming-messages-json
     * (NDJSON identical to claude stream-json). Permission modes map 1:1.
     * Resume via --resume <sessionId>; model via -m <model>.
     * No --verbose and no --mcp-config (memory uses ensureGrokMcpConfig).
     */
    buildArgs({ prompt, sessionId, permissionMode, model }) {
      const args = [
        "-p",
        String(prompt ?? ""),
        "--output-format",
        "streaming-messages-json",
        "--permission-mode",
        String(permissionMode || "default"),
      ];
      if (model) {
        args.push("-m", String(model));
      }
      if (sessionId) {
        args.push("--resume", String(sessionId));
      }
      return args;
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    binEnv: "CODER_OPENCODE_BIN",
    defaultBin: "opencode",
    supportsResume: true,
    models: [],
    kind: "opencode-json",
    /**
     * Custom model ids allowed (format provider/model).
     * Resume via -s <sessionID>; model override via -m provider/model.
     */
    buildArgs({ prompt, sessionId, model }) {
      const args = ["run", String(prompt ?? ""), "--format", "json"];
      if (sessionId) {
        args.push("-s", String(sessionId));
      }
      if (model) {
        args.push("-m", String(model));
      }
      return args;
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
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
function defaultWhich(bin, env = process.env) {
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
      env,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} bin
 * @param {(bin: string) => string | null} [whichFn]
 * @param {NodeJS.ProcessEnv} [env] - PATH for default which (ignored when whichFn is injected)
 */
function isBinAvailable(bin, whichFn = defaultWhich, env = process.env) {
  if (!bin) return false;
  // Absolute or relative path: filesystem only (ignore which/PATH).
  if (path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    try {
      return fs.existsSync(bin);
    } catch {
      return false;
    }
  }
  if (whichFn === defaultWhich) {
    return Boolean(defaultWhich(bin, env));
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
      available: isBinAvailable(bin, whichFn, env),
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
