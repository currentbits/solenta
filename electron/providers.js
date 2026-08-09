"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * Data-driven provider registry for agent CLIs.
 *
 * Effort support (verified against installed CLIs / contract correction):
 * - claude: `--effort <level>` exactly low|medium|high|xhigh|max. Unknown values
 *   are a silent warning + default (not an error), so our boundary must reject.
 * - grok: `--reasoning-effort` (alias `--effort`) errors on unknown; grok-4.5
 *   accepts only low|medium|high.
 * - codex: no dedicated flag; config override `-c model_reasoning_effort=<level>`.
 *   Live API rejects bogus with enum none|minimal|low|medium|high|xhigh|max;
 *   contract intersection (no none/minimal) is low|medium|high|xhigh|max.
 * - kimi / opencode: no effort flag in --help → empty efforts.
 *
 * Prompt is always the LAST argv element for every provider so an effort flag
 * cannot swallow it (claude and grok both take the prompt positionally /
 * as the value of a trailing -p pair).
 *
 * @typedef {object} ModelInfo
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {string} vendor
 * @property {boolean} [recommended]
 *
 * @typedef {object} ProviderEntry
 * @property {string} id
 * @property {string} name
 * @property {string} binEnv - env var that overrides the binary
 * @property {string} defaultBin
 * @property {boolean} supportsResume
 * @property {string[]} models
 * @property {ModelInfo[]} modelInfo
 * @property {Array<"low"|"medium"|"high"|"xhigh"|"max">} efforts
 * @property {"claude-stream" | "codex-json" | "kimi-stream" | "opencode-json" | "simulate"} kind
 * @property {(opts: {
 *   prompt: string,
 *   sessionId?: string | null,
 *   permissionMode?: string,
 *   model?: string | null,
 *   reasoningEffort?: string | null,
 * }) => string[]} buildArgs
 */

/**
 * Push an effort flag only when the provider lists that level.
 * Never invents flags for empty-effort providers.
 * @param {string[]} allowed
 * @param {string | null | undefined} reasoningEffort
 * @param {(level: string) => void} emit
 */
function maybeEmitEffort(allowed, reasoningEffort, emit) {
  if (reasoningEffort == null || reasoningEffort === "") return;
  const level = String(reasoningEffort);
  if (!Array.isArray(allowed) || !allowed.includes(level)) return;
  emit(level);
}

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
    modelInfo: [
      {
        id: "claude-fable-5",
        label: "Fable",
        description: "Fast everyday coding with strong defaults",
        vendor: "Anthropic",
      },
      {
        id: "claude-opus-5",
        label: "Opus",
        description: "Best for hard multi-step work",
        vendor: "Anthropic",
        recommended: true,
      },
      {
        id: "claude-sonnet-5",
        label: "Sonnet",
        description: "Balanced quality and speed",
        vendor: "Anthropic",
      },
      {
        id: "claude-haiku-4-5",
        label: "Haiku",
        description: "Cheapest and fastest replies",
        vendor: "Anthropic",
      },
    ],
    // claude --help / live warning: low, medium, high, xhigh, max
    efforts: ["low", "medium", "high", "xhigh", "max"],
    kind: "claude-stream",
    buildArgs({ prompt, sessionId, permissionMode, model, reasoningEffort }) {
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
      // Takes exactly one value; placed before trailing prompt so it cannot
      // swallow the prompt (variadic flags have bitten this project twice).
      maybeEmitEffort(
        ["low", "medium", "high", "xhigh", "max"],
        reasoningEffort,
        (level) => {
          args.push("--effort", level);
        },
      );
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
    // From ~/.codex/models_cache.json (codex-cli 0.144.1, visibility=list only;
    // codex-auto-review is visibility=hide and is omitted). Descriptions and
    // display names copied from the cache; vendor is OpenAI (model maker).
    models: [
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4-mini",
    ],
    modelInfo: [
      {
        id: "gpt-5.6-terra",
        label: "GPT-5.6-Terra",
        description: "Balanced agentic coding model for everyday work.",
        vendor: "OpenAI",
      },
      {
        id: "gpt-5.6-luna",
        label: "GPT-5.6-Luna",
        description: "Fast and affordable agentic coding model.",
        vendor: "OpenAI",
      },
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        description:
          "Frontier model for complex coding, research, and real-world work.",
        vendor: "OpenAI",
        recommended: true,
      },
      {
        id: "gpt-5.4-mini",
        label: "GPT-5.4-Mini",
        description:
          "Small, fast, and cost-efficient model for simpler coding tasks.",
        vendor: "OpenAI",
      },
    ],
    // No dedicated flag; -c model_reasoning_effort=. Live API enum
    // none|minimal|low|medium|high|xhigh|max; contract has no none/minimal.
    efforts: ["low", "medium", "high", "xhigh", "max"],
    kind: "codex-json",
    buildArgs({ prompt, sessionId, model, reasoningEffort }) {
      const codexEfforts = ["low", "medium", "high", "xhigh", "max"];
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
        maybeEmitEffort(codexEfforts, reasoningEffort, (level) => {
          // Single-arg form for -c: one key=value token, never open-ended.
          args.push("-c", `model_reasoning_effort=${level}`);
        });
        args.push(String(prompt ?? ""));
        return args;
      }
      const args = ["exec", "--json", "--skip-git-repo-check"];
      if (model) {
        args.push("-m", String(model));
      }
      maybeEmitEffort(codexEfforts, reasoningEffort, (level) => {
        args.push("-c", `model_reasoning_effort=${level}`);
      });
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
    modelInfo: [
      {
        id: "grok-4.5",
        label: "Grok 4.5",
        description: "xAI coding agent with tool use",
        vendor: "xAI",
        recommended: true,
      },
    ],
    // Live CLI: unknown effort level 'bogus'; use one of: high, medium, low
    efforts: ["low", "medium", "high"],
    kind: "claude-stream",
    /**
     * Grok CLI: options first, then -p/--single <PROMPT> last so the prompt
     * token cannot be eaten by a following flag. Output format is
     * streaming-messages-json (NDJSON identical to claude stream-json).
     * Effort via --reasoning-effort <level> (alias --effort).
     * No --verbose and no --mcp-config (memory uses ensureGrokMcpConfig).
     */
    buildArgs({ prompt, sessionId, permissionMode, model, reasoningEffort }) {
      const args = [
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
      maybeEmitEffort(["low", "medium", "high"], reasoningEffort, (level) => {
        args.push("--reasoning-effort", level);
      });
      // -p/--single takes the prompt as its value; keep it last.
      args.push("-p", String(prompt ?? ""));
      return args;
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    binEnv: "CODER_OPENCODE_BIN",
    defaultBin: "opencode",
    supportsResume: true,
    // Live `opencode models` (v1.17.12) lists these free Zen models. Labels and
    // descriptions from `opencode models --verbose` / ~/.cache/opencode/models.json.
    // Ids are provider/model as required by -m. Vendors are the model makers
    // (from catalog descriptions / same model under other providers), not the CLI.
    models: [
      "opencode/big-pickle",
      "opencode/deepseek-v4-flash-free",
      "opencode/laguna-s-2.1-free",
      "opencode/ling-3.0-tiny-free",
      "opencode/longcat-2.0-free",
      "opencode/mimo-v2.5-free",
      "opencode/nemotron-3-ultra-free",
      "opencode/north-mini-code-free",
    ],
    modelInfo: [
      {
        id: "opencode/big-pickle",
        label: "Big Pickle",
        description:
          "Reasoning model for deliberate analysis, multi-step problem solving, and tool use",
        vendor: "OpenCode",
      },
      {
        id: "opencode/deepseek-v4-flash-free",
        label: "DeepSeek V4 Flash Free",
        description:
          "Official DeepSeek V4 Flash release with enhanced agentic capabilities and integrated DSpark speculative decoding",
        vendor: "DeepSeek",
      },
      {
        id: "opencode/laguna-s-2.1-free",
        label: "Laguna S 2.1 Free",
        description:
          "Agentic coding model from Poolside in the XS size class for local deployment",
        vendor: "Poolside",
      },
      {
        id: "opencode/ling-3.0-tiny-free",
        label: "Ling-3.0-tiny Free",
        description:
          "Compact MoE model for responsive agents, instruction following, and multi-turn conversations",
        vendor: "InclusionAI",
      },
      {
        id: "opencode/longcat-2.0-free",
        label: "LongCat-2.0 Free",
        description:
          "Meituan LongCat-2.0, a reasoning model with tool calling and a 1M-token context window",
        vendor: "Meituan",
      },
      {
        id: "opencode/mimo-v2.5-free",
        label: "MiMo V2.5 Free",
        description: "MiMo omni model for text, image, video, audio, and agents",
        vendor: "Xiaomi",
      },
      {
        id: "opencode/nemotron-3-ultra-free",
        label: "Nemotron 3 Ultra Free",
        description:
          "Largest Nemotron 3 model for maximum open-weight reasoning and agent accuracy",
        vendor: "NVIDIA",
      },
      {
        id: "opencode/north-mini-code-free",
        label: "North Mini Code Free",
        description:
          "Cohere coding model for practical software engineering and agentic edits",
        vendor: "Cohere",
        recommended: true,
      },
    ],
    // opencode run --help DOES list --variant (provider-specific reasoning
    // effort, e.g. high, max, minimal), but its accepted values vary per
    // underlying model and are not enumerated anywhere. Left empty until they
    // are verified: advertising a level the model rejects is the bug this
    // feature exists to remove.
    efforts: [],
    kind: "opencode-json",
    /**
     * Custom model ids allowed (format provider/model).
     * Resume via -s <sessionID>; model override via -m provider/model.
     * Prompt is the last argv element.
     */
    buildArgs({ prompt, sessionId, model, reasoningEffort }) {
      const args = ["run", "--format", "json"];
      if (sessionId) {
        args.push("-s", String(sessionId));
      }
      if (model) {
        args.push("-m", String(model));
      }
      // Empty efforts: never emit an effort flag.
      maybeEmitEffort([], reasoningEffort, () => {
        args.push("--variant", "should-not-appear");
      });
      args.push(String(prompt ?? ""));
      return args;
    },
  },
  {
    id: "kimi",
    name: "Kimi Code",
    binEnv: "CODER_KIMI_BIN",
    defaultBin: "kimi",
    supportsResume: true,
    // From `kimi provider list --json` / ~/.kimi-code/config.toml managed
    // provider (4 models). Ids are the `model` field values accepted by -m
    // (aliases also exist as kimi-code/<id>). Labels from display_name.
    models: [
      "k3",
      "k3-256k",
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
    ],
    modelInfo: [
      {
        id: "k3",
        label: "K3",
        description: "Default Kimi coding model (1M context)",
        vendor: "Moonshot",
        recommended: true,
      },
      {
        id: "k3-256k",
        label: "K3-256k",
        description: "K3 with a 256k context window",
        vendor: "Moonshot",
      },
      {
        id: "kimi-for-coding",
        label: "K2.7 Coding",
        description: "Coding-tuned Kimi (K2.7)",
        vendor: "Moonshot",
      },
      {
        id: "kimi-for-coding-highspeed",
        label: "K2.7 Coding Highspeed",
        description: "Faster coding-tuned Kimi (K2.7)",
        vendor: "Moonshot",
      },
    ],
    // kimi --help: no effort / reasoning flag
    efforts: [],
    kind: "kimi-stream",
    /**
     * Kimi sessions are per working directory. When thread.sessionId is set we
     * pass -c (continue) instead of a session id and keep sessionId as the
     * sentinel "cwd". Two kimi threads sharing a cwd share history; mitigated
     * by worktree-per-thread. Prompt is the last argv element (-p value).
     */
    buildArgs({ prompt, sessionId, permissionMode, model, reasoningEffort }) {
      const args = ["--output-format", "stream-json"];
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
      // Empty efforts: never emit an effort flag even if one is passed.
      maybeEmitEffort([], reasoningEffort, () => {
        args.push("--effort", "should-not-appear");
      });
      args.push("-p", String(prompt ?? ""));
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
  modelInfo: [],
  efforts: [],
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
      modelInfo: (entry.modelInfo || []).map((m) => ({ ...m })),
      efforts: (entry.efforts || []).slice(),
    });
  }

  if (includeSimulate) {
    out.push({
      id: SIMULATE_ENTRY.id,
      name: SIMULATE_ENTRY.name,
      available: true,
      supportsResume: false,
      models: [],
      modelInfo: [],
      efforts: [],
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
