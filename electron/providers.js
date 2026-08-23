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
 * - grok: `--reasoning-effort` (alias `--effort`) errors on unknown; live CLI
 *   (1.0.3) accepts xhigh|high|medium|low. grok-4.6 is the default; grok-4.5
 *   remains listed. No max.
 * - codex: no dedicated flag; config override `-c model_reasoning_effort=<level>`.
 *   Live API rejects bogus with enum none|minimal|low|medium|high|xhigh|max;
 *   contract intersection (no none/minimal) is low|medium|high|xhigh|max.
 *   Live web search is `--search` (issue #174), gated by thread.webSearch.
 * - kimi: no effort flag, but [thinking].effort in config.toml (low/high/max
 *   on the k3 family) → efforts listed with effortVia "config"; kimi.js flips
 *   the config around the spawn.
 * - opencode: no effort flag in --help → empty efforts.
 * - cursor: effort is baked into the model id (e.g. gpt-5.3-codex-high);
 *   empty efforts. Live CLI 2026.07.09-a3815c0. defaultBin is cursor-agent
 *   because grok also ships `agent` on PATH.
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
 * @property {number} [contextTokens] - context window size, ONLY where the
 *   vendor copy above states it; never guessed (the context ring hides itself
 *   without it)
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
 * @property {"config"} [effortVia] - efforts applied outside argv (kimi:
 *   config.toml flip in kimi.js); absent means buildArgs emits the flag
 * @property {boolean} [supportsSearch] - CLI accepts `codex exec --search`
 *   (live web search). Absent/false hides the composer Search pill.
 * @property {"claude-stream" | "codex-json" | "kimi-stream" | "opencode-json" | "cursor-stream" | "simulate"} kind
 * @property {(opts: {
 *   prompt: string,
 *   sessionId?: string | null,
 *   permissionMode?: string,
 *   model?: string | null,
 *   reasoningEffort?: string | null,
 *   webSearch?: boolean,
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
        contextTokens: 1_000_000,
      },
      {
        id: "claude-opus-5",
        label: "Opus",
        description: "Best for hard multi-step work",
        vendor: "Anthropic",
        recommended: true,
        contextTokens: 1_000_000,
      },
      {
        id: "claude-sonnet-5",
        label: "Sonnet",
        description: "Balanced quality and speed",
        vendor: "Anthropic",
        contextTokens: 1_000_000,
      },
      {
        id: "claude-haiku-4-5",
        label: "Haiku",
        description: "Cheapest and fastest replies",
        vendor: "Anthropic",
        contextTokens: 200_000,
      },
    ],
    // claude --help / live warning: low, medium, high, xhigh, max
    efforts: ["low", "medium", "high", "xhigh", "max"],
    kind: "claude-stream",
    buildArgs({ sessionId, permissionMode, model, reasoningEffort }) {
      // NO trailing prompt: the runner delivers it on stdin (stream-json
      // input), which is what lets the CLI route permission prompts to us
      // as control_request/control_response instead of silently denying.
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--permission-prompt-tool",
        "stdio",
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
      // Takes exactly one value; kept away from other values so it cannot
      // swallow them (variadic flags have bitten this project twice).
      maybeEmitEffort(
        ["low", "medium", "high", "xhigh", "max"],
        reasoningEffort,
        (level) => {
          args.push("--effort", level);
        },
      );
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
    supportsSearch: true,
    kind: "codex-json",
    buildArgs({ prompt, sessionId, model, reasoningEffort, webSearch }) {
      const codexEfforts = ["low", "medium", "high", "xhigh", "max"];
      const args = sessionId
        ? [
            "exec",
            "resume",
            String(sessionId),
            "--json",
            "--skip-git-repo-check",
          ]
        : ["exec", "--json", "--skip-git-repo-check"];
      if (model) {
        args.push("-m", String(model));
      }
      maybeEmitEffort(codexEfforts, reasoningEffort, (level) => {
        // Single-arg form for -c: one key=value token, never open-ended.
        args.push("-c", `model_reasoning_effort=${level}`);
      });
      if (webSearch === true) {
        args.push("--search");
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
    // Live `grok models` (1.0.3) + ~/.grok/models_cache.json. Ids, labels,
    // descriptions, and context_window copied from the cache; 4.6 is default.
    models: ["grok-4.6", "grok-4.5"],
    modelInfo: [
      {
        id: "grok-4.6",
        label: "Grok 4.6",
        description: "SpaceXAI's latest frontier model",
        vendor: "xAI",
        recommended: true,
        contextTokens: 500000,
      },
      {
        id: "grok-4.5",
        label: "Grok 4.5",
        description: "xAI coding agent with tool use",
        vendor: "xAI",
        contextTokens: 500000,
      },
    ],
    // Live CLI: unknown effort level 'bogus'; use one of: xhigh, high, medium, low
    efforts: ["low", "medium", "high", "xhigh"],
    kind: "claude-stream",
    /**
     * Grok CLI: options first, then -p/--single <PROMPT> last so the prompt
     * token cannot be eaten by a following flag. Output format is
     * streaming-messages-json (NDJSON identical to claude stream-json).
     * Effort via --reasoning-effort <level> (alias --effort).
     * No --verbose and no --mcp-config (memory uses ensureGrokMcpConfig).
     *
     * Permission modes: headless -p has NO prompt channel (no
     * --permission-prompt-tool / stream-json input like claude), so any mode
     * that would ask auto-cancels the gated tool and the run dies with
     * `errors: ["cancelled"]` — Solenta then shows "Run stopped" (#549).
     * grok 1.0.5 treats `--permission-mode auto` as `default` (init event
     * reports default; bash is "User cancelled"). Map asking modes to
     * bypassPermissions + --always-approve, which 1.0.5 actually honors
     * (issue #578). plan passes through; explicit bypassPermissions is
     * already unprompted so the extra flag is not added.
     */
    buildArgs({ prompt, sessionId, permissionMode, model, reasoningEffort }) {
      const mode = String(permissionMode || "default");
      const asking = mode === "default" || mode === "acceptEdits";
      const headlessMode = asking ? "bypassPermissions" : mode;
      const args = [
        "--output-format",
        "streaming-messages-json",
        "--permission-mode",
        headlessMode,
      ];
      if (asking) args.push("--always-approve");
      if (model) {
        args.push("-m", String(model));
      }
      if (sessionId) {
        args.push("--resume", String(sessionId));
      }
      maybeEmitEffort(
        ["low", "medium", "high", "xhigh"],
        reasoningEffort,
        (level) => {
          args.push("--reasoning-effort", level);
        },
      );
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
        contextTokens: 1000000,
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
    // From ~/.kimi-code/config.toml. Ids are the [models."..."] ALIAS KEYS:
    // -m takes the alias, and a bare model value fails loudly (verified:
    // `-m k3` → config.invalid "not configured in config.toml", while
    // `-m kimi-code/k3` runs). Labels from display_name.
    models: [
      "kimi-code/k3",
      "kimi-code/k3-256k",
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
    ],
    modelInfo: [
      {
        id: "kimi-code/k3",
        label: "K3",
        description: "Default Kimi coding model (1M context)",
        vendor: "Moonshot",
        recommended: true,
        contextTokens: 1000000,
      },
      {
        id: "kimi-code/k3-256k",
        label: "K3-256k",
        description: "K3 with a 256k context window",
        vendor: "Moonshot",
        contextTokens: 256000,
      },
      {
        id: "kimi-code/kimi-for-coding",
        label: "K2.7 Coding",
        description: "Coding-tuned Kimi (K2.7)",
        vendor: "Moonshot",
      },
      {
        id: "kimi-code/kimi-for-coding-highspeed",
        label: "K2.7 Coding Highspeed",
        description: "Faster coding-tuned Kimi (K2.7)",
        vendor: "Moonshot",
      },
    ],
    // From per-model support_efforts in ~/.kimi-code/config.toml (k3 family).
    // kimi has NO CLI effort flag (verified 0.31.1: --effort etc. all
    // rejected); effortVia "config" means kimi.js flips [thinking].effort in
    // config.toml around the spawn instead of emitting argv.
    efforts: ["low", "high", "max"],
    effortVia: "config",
    kind: "kimi-stream",
    /**
     * Kimi HAS per-session resume: the stream's meta resume hint carries a
     * session_id and -S <id> resumes it (verified live; recalled the prior
     * turn). Never emit -c: it continues the last session in the working
     * directory, which is shared by every no-worktree thread in a project
     * (issue #220). The leftover store sentinel "cwd" is treated as no
     * session, not as -S cwd.
     *
     * Permission flags: -p CANNOT combine with -y or --auto ("error: Cannot
     * combine --prompt with --yolo/--auto", verified live). Prompt mode runs
     * tools unprompted regardless, so no flag is emitted and the permission
     * mode is effectively ignored by kimi one-shot turns.
     *
     * Prompt is the last argv element (-p value).
     */
    buildArgs({ prompt, sessionId, model, reasoningEffort }) {
      const args = ["--output-format", "stream-json"];
      if (model) {
        args.push("-m", String(model));
      }
      if (sessionId && sessionId !== "cwd") {
        args.push("-S", String(sessionId));
      }
      // Effort goes via config.toml (effortVia "config"), NEVER argv: kimi
      // 0.31.1 rejects every effort-shaped flag with "unknown option".
      maybeEmitEffort([], reasoningEffort, () => {
        args.push("--effort", "should-not-appear");
      });
      args.push("-p", String(prompt ?? ""));
      return args;
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    binEnv: "CODER_CURSOR_BIN",
    // Never "agent": grok also ships `agent` on PATH.
    defaultBin: "cursor-agent",
    supportsResume: true,
    // Live cursor-agent --list-models (2026.07.09-a3815c0). Ids, labels,
    // descriptions, vendors, and contextTokens copied from the catalog;
    // auto is recommended. Effort is baked into the model id.
    models: [
      "auto",
      "gpt-5.3-codex-low",
      "gpt-5.3-codex-low-fast",
      "gpt-5.3-codex",
      "gpt-5.3-codex-fast",
      "gpt-5.3-codex-high",
      "gpt-5.3-codex-high-fast",
      "gpt-5.3-codex-xhigh",
      "gpt-5.3-codex-xhigh-fast",
      "gpt-5.2",
      "cursor-grok-4.6-high-fast",
      "composer-2.5",
      "claude-opus-5-thinking-high",
      "claude-opus-5-thinking-high-fast",
      "gpt-5.6-sol-high",
      "gpt-5.6-sol-high-fast",
      "gpt-5.6-sol-xhigh",
      "gpt-5.6-sol-xhigh-fast",
      "claude-fable-5-thinking-high",
      "claude-fable-5-thinking-xhigh",
      "cursor-grok-4.5-high",
      "cursor-grok-4.5-high-fast",
      "gemini-3.7-flash-high",
      "claude-sonnet-5-thinking-high",
      "claude-sonnet-5-thinking-xhigh",
      "gpt-5.6-luna-high",
      "cursor-grok-4.6-low",
      "cursor-grok-4.6-low-fast",
      "cursor-grok-4.6-medium",
      "cursor-grok-4.6-medium-fast",
      "cursor-grok-4.6-high",
      "cursor-grok-4.6-xhigh",
      "cursor-grok-4.6-xhigh-fast",
      "composer-2.5-fast",
      "claude-opus-5-low",
      "claude-opus-5-low-fast",
      "claude-opus-5-medium",
      "claude-opus-5-medium-fast",
      "claude-opus-5-high",
      "claude-opus-5-high-fast",
      "claude-opus-5-thinking-low",
      "claude-opus-5-thinking-low-fast",
      "claude-opus-5-thinking-medium",
      "claude-opus-5-thinking-medium-fast",
      "claude-opus-5-thinking-xhigh",
      "claude-opus-5-thinking-xhigh-fast",
      "claude-opus-5-thinking-max",
      "claude-opus-5-thinking-max-fast",
      "claude-opus-4-8-low",
      "claude-opus-4-8-low-fast",
      "claude-opus-4-8-medium",
      "claude-opus-4-8-medium-fast",
      "claude-opus-4-8-high",
      "claude-opus-4-8-high-fast",
      "claude-opus-4-8-xhigh",
      "claude-opus-4-8-xhigh-fast",
      "claude-opus-4-8-max",
      "claude-opus-4-8-max-fast",
      "claude-opus-4-8-thinking-low",
      "claude-opus-4-8-thinking-low-fast",
      "claude-opus-4-8-thinking-medium",
      "claude-opus-4-8-thinking-medium-fast",
      "claude-opus-4-8-thinking-high",
      "claude-opus-4-8-thinking-high-fast",
      "claude-opus-4-8-thinking-xhigh",
      "claude-opus-4-8-thinking-xhigh-fast",
      "claude-opus-4-8-thinking-max",
      "claude-opus-4-8-thinking-max-fast",
      "gpt-5.6-sol-none",
      "gpt-5.6-sol-none-fast",
      "gpt-5.6-sol-low",
      "gpt-5.6-sol-low-fast",
      "gpt-5.6-sol-medium",
      "gpt-5.6-sol-medium-fast",
      "gpt-5.6-sol-max",
      "gpt-5.6-sol-max-fast",
      "gpt-5.5-none",
      "gpt-5.5-none-fast",
      "gpt-5.5-low",
      "gpt-5.5-low-fast",
      "gpt-5.5-medium",
      "gpt-5.5-medium-fast",
      "gpt-5.5-high",
      "gpt-5.5-high-fast",
      "gpt-5.5-extra-high",
      "gpt-5.5-extra-high-fast",
      "claude-fable-5-low",
      "claude-fable-5-medium",
      "claude-fable-5-high",
      "claude-fable-5-xhigh",
      "claude-fable-5-max",
      "claude-fable-5-thinking-low",
      "claude-fable-5-thinking-medium",
      "claude-fable-5-thinking-max",
      "cursor-grok-4.5-low",
      "cursor-grok-4.5-low-fast",
      "cursor-grok-4.5-medium",
      "cursor-grok-4.5-medium-fast",
      "gemini-3.7-flash-low",
      "gemini-3.7-flash-medium",
      "gpt-5.6-terra-none",
      "gpt-5.6-terra-none-fast",
      "gpt-5.6-terra-low",
      "gpt-5.6-terra-low-fast",
      "gpt-5.6-terra-medium",
      "gpt-5.6-terra-medium-fast",
      "gpt-5.6-terra-high",
      "gpt-5.6-terra-high-fast",
      "gpt-5.6-terra-xhigh",
      "gpt-5.6-terra-xhigh-fast",
      "gpt-5.6-terra-max",
      "gpt-5.6-terra-max-fast",
      "claude-sonnet-5-low",
      "claude-sonnet-5-medium",
      "claude-sonnet-5-high",
      "claude-sonnet-5-xhigh",
      "claude-sonnet-5-max",
      "claude-sonnet-5-thinking-low",
      "claude-sonnet-5-thinking-medium",
      "claude-sonnet-5-thinking-max",
      "claude-4.6-sonnet-medium",
      "claude-4.6-sonnet-medium-thinking",
      "claude-opus-4-7-low",
      "claude-opus-4-7-low-fast",
      "claude-opus-4-7-medium",
      "claude-opus-4-7-medium-fast",
      "claude-opus-4-7-high",
      "claude-opus-4-7-high-fast",
      "claude-opus-4-7-xhigh",
      "claude-opus-4-7-xhigh-fast",
      "claude-opus-4-7-max",
      "claude-opus-4-7-max-fast",
      "claude-opus-4-7-thinking-low",
      "claude-opus-4-7-thinking-low-fast",
      "claude-opus-4-7-thinking-medium",
      "claude-opus-4-7-thinking-medium-fast",
      "claude-opus-4-7-thinking-high",
      "claude-opus-4-7-thinking-high-fast",
      "claude-opus-4-7-thinking-xhigh",
      "claude-opus-4-7-thinking-xhigh-fast",
      "claude-opus-4-7-thinking-max",
      "claude-opus-4-7-thinking-max-fast",
      "gpt-5.4-low",
      "gpt-5.4-medium",
      "gpt-5.4-medium-fast",
      "gpt-5.4-high",
      "gpt-5.4-high-fast",
      "gpt-5.4-xhigh",
      "gpt-5.4-xhigh-fast",
      "claude-4.6-opus-high",
      "claude-4.6-opus-max",
      "claude-4.6-opus-high-thinking",
      "claude-4.6-opus-max-thinking",
      "claude-4.5-opus-high",
      "claude-4.5-opus-high-thinking",
      "gpt-5.2-low",
      "gpt-5.2-low-fast",
      "gpt-5.2-fast",
      "gpt-5.2-high",
      "gpt-5.2-high-fast",
      "gpt-5.2-xhigh",
      "gpt-5.2-xhigh-fast",
      "gpt-5.6-luna-none",
      "gpt-5.6-luna-none-fast",
      "gpt-5.6-luna-low",
      "gpt-5.6-luna-low-fast",
      "gpt-5.6-luna-medium",
      "gpt-5.6-luna-medium-fast",
      "gpt-5.6-luna-high-fast",
      "gpt-5.6-luna-xhigh",
      "gpt-5.6-luna-xhigh-fast",
      "gpt-5.6-luna-max",
      "gpt-5.6-luna-max-fast",
      "gemini-3.6-flash-minimal",
      "gemini-3.6-flash-low",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-high",
      "gemini-3.1-pro",
      "gpt-5.4-mini-none",
      "gpt-5.4-mini-low",
      "gpt-5.4-mini-medium",
      "gpt-5.4-mini-high",
      "gpt-5.4-mini-xhigh",
      "gpt-5.4-nano-none",
      "gpt-5.4-nano-low",
      "gpt-5.4-nano-medium",
      "gpt-5.4-nano-high",
      "gpt-5.4-nano-xhigh",
      "claude-4.5-sonnet",
      "claude-4.5-sonnet-thinking",
      "gpt-5.1-low",
      "gpt-5.1",
      "gpt-5.1-high",
      "gemini-3-flash",
      "gemini-3.5-flash",
      "claude-4-sonnet",
      "claude-4-sonnet-thinking",
      "gpt-5-mini",
      "kimi-k3-low",
      "kimi-k3-high",
      "kimi-k3-max",
      "kimi-k2.7-code",
      "glm-5.2-high",
      "glm-5.2-max",
    ],
    modelInfo: [
      {
        id: "auto",
        label: "Auto",
        description: "Cursor picks a model for the task",
        vendor: "Cursor",
        recommended: true,
      },
      { id: "gpt-5.3-codex-low", label: "Codex 5.3 Low", description: "Codex 5.3 Low", vendor: "OpenAI" },
      { id: "gpt-5.3-codex-low-fast", label: "Codex 5.3 Low Fast", description: "Codex 5.3 Low Fast", vendor: "OpenAI" },
      { id: "gpt-5.3-codex", label: "Codex 5.3", description: "Codex 5.3", vendor: "OpenAI" },
      { id: "gpt-5.3-codex-fast", label: "Codex 5.3 Fast", description: "Codex 5.3 Fast", vendor: "OpenAI" },
      { id: "gpt-5.3-codex-high", label: "Codex 5.3 High", description: "Codex 5.3 High", vendor: "OpenAI" },
      { id: "gpt-5.3-codex-high-fast", label: "Codex 5.3 High Fast", description: "Codex 5.3 High Fast", vendor: "OpenAI" },
      { id: "gpt-5.3-codex-xhigh", label: "Codex 5.3 Extra High", description: "Codex 5.3 Extra High", vendor: "OpenAI" },
      { id: "gpt-5.3-codex-xhigh-fast", label: "Codex 5.3 Extra High Fast", description: "Codex 5.3 Extra High Fast", vendor: "OpenAI" },
      { id: "gpt-5.2", label: "GPT-5.2", description: "GPT-5.2", vendor: "OpenAI" },
      { id: "cursor-grok-4.6-high-fast", label: "Cursor Grok 4.6 Fast", description: "Cursor Grok 4.6 Fast", vendor: "xAI" },
      { id: "composer-2.5", label: "Composer 2.5", description: "Composer 2.5", vendor: "Cursor" },
      { id: "claude-opus-5-thinking-high", label: "Claude Opus 5 1M Thinking", description: "Claude Opus 5 1M Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-thinking-high-fast", label: "Claude Opus 5 1M Thinking Fast", description: "Claude Opus 5 1M Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "gpt-5.6-sol-high", label: "GPT-5.6 Sol 1M High", description: "GPT-5.6 Sol 1M High", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-sol-high-fast", label: "GPT-5.6 Sol High Fast", description: "GPT-5.6 Sol High Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-sol-xhigh", label: "GPT-5.6 Sol 1M Extra High", description: "GPT-5.6 Sol 1M Extra High", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-sol-xhigh-fast", label: "GPT-5.6 Sol Extra High Fast", description: "GPT-5.6 Sol Extra High Fast", vendor: "OpenAI" },
      { id: "claude-fable-5-thinking-high", label: "Claude Fable 5 1M Thinking (NO ZDR)", description: "Claude Fable 5 1M Thinking (NO ZDR)", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-fable-5-thinking-xhigh", label: "Claude Fable 5 1M Extra High Thinking (NO ZDR)", description: "Claude Fable 5 1M Extra High Thinking (NO ZDR)", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "cursor-grok-4.5-high", label: "Cursor Grok 4.5", description: "Cursor Grok 4.5", vendor: "xAI" },
      { id: "cursor-grok-4.5-high-fast", label: "Cursor Grok 4.5 Fast", description: "Cursor Grok 4.5 Fast", vendor: "xAI" },
      { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash", description: "Gemini 3.7 Flash", vendor: "Google" },
      { id: "claude-sonnet-5-thinking-high", label: "Claude Sonnet 5 1M Thinking", description: "Claude Sonnet 5 1M Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-sonnet-5-thinking-xhigh", label: "Claude Sonnet 5 1M Extra High Thinking", description: "Claude Sonnet 5 1M Extra High Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "gpt-5.6-luna-high", label: "GPT-5.6 Luna 1M High", description: "GPT-5.6 Luna 1M High", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "cursor-grok-4.6-low", label: "Cursor Grok 4.6 Low", description: "Cursor Grok 4.6 Low", vendor: "xAI" },
      { id: "cursor-grok-4.6-low-fast", label: "Cursor Grok 4.6 Low Fast", description: "Cursor Grok 4.6 Low Fast", vendor: "xAI" },
      { id: "cursor-grok-4.6-medium", label: "Cursor Grok 4.6 Medium", description: "Cursor Grok 4.6 Medium", vendor: "xAI" },
      { id: "cursor-grok-4.6-medium-fast", label: "Cursor Grok 4.6 Medium Fast", description: "Cursor Grok 4.6 Medium Fast", vendor: "xAI" },
      { id: "cursor-grok-4.6-high", label: "Cursor Grok 4.6", description: "Cursor Grok 4.6", vendor: "xAI" },
      { id: "cursor-grok-4.6-xhigh", label: "Cursor Grok 4.6 Extra High", description: "Cursor Grok 4.6 Extra High", vendor: "xAI" },
      { id: "cursor-grok-4.6-xhigh-fast", label: "Cursor Grok 4.6 Extra High Fast", description: "Cursor Grok 4.6 Extra High Fast", vendor: "xAI" },
      { id: "composer-2.5-fast", label: "Composer 2.5 Fast", description: "Composer 2.5 Fast", vendor: "Cursor" },
      { id: "claude-opus-5-low", label: "Claude Opus 5 1M Low", description: "Claude Opus 5 1M Low", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-low-fast", label: "Claude Opus 5 1M Low Fast", description: "Claude Opus 5 1M Low Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-medium", label: "Claude Opus 5 1M Medium", description: "Claude Opus 5 1M Medium", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-medium-fast", label: "Claude Opus 5 1M Medium Fast", description: "Claude Opus 5 1M Medium Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-high", label: "Claude Opus 5 1M", description: "Claude Opus 5 1M", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-high-fast", label: "Claude Opus 5 1M Fast", description: "Claude Opus 5 1M Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-thinking-low", label: "Claude Opus 5 1M Low Thinking", description: "Claude Opus 5 1M Low Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-thinking-low-fast", label: "Claude Opus 5 1M Low Thinking Fast", description: "Claude Opus 5 1M Low Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-thinking-medium", label: "Claude Opus 5 1M Medium Thinking", description: "Claude Opus 5 1M Medium Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-thinking-medium-fast", label: "Claude Opus 5 1M Medium Thinking Fast", description: "Claude Opus 5 1M Medium Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-thinking-xhigh", label: "Claude Opus 5 1M Extra High Thinking", description: "Claude Opus 5 1M Extra High Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-thinking-xhigh-fast", label: "Claude Opus 5 1M Extra High Thinking Fast", description: "Claude Opus 5 1M Extra High Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-thinking-max", label: "Claude Opus 5 1M Max Thinking", description: "Claude Opus 5 1M Max Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-5-thinking-max-fast", label: "Claude Opus 5 1M Max Thinking Fast", description: "Claude Opus 5 1M Max Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-low", label: "Claude Opus 4.8 1M Low", description: "Claude Opus 4.8 1M Low", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-low-fast", label: "Claude Opus 4.8 1M Low Fast", description: "Claude Opus 4.8 1M Low Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-medium", label: "Claude Opus 4.8 1M Medium", description: "Claude Opus 4.8 1M Medium", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-medium-fast", label: "Claude Opus 4.8 1M Medium Fast", description: "Claude Opus 4.8 1M Medium Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-high", label: "Claude Opus 4.8 1M", description: "Claude Opus 4.8 1M", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-high-fast", label: "Claude Opus 4.8 1M Fast", description: "Claude Opus 4.8 1M Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-xhigh", label: "Claude Opus 4.8 1M Extra High", description: "Claude Opus 4.8 1M Extra High", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-xhigh-fast", label: "Claude Opus 4.8 1M Extra High Fast", description: "Claude Opus 4.8 1M Extra High Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-max", label: "Claude Opus 4.8 1M Max", description: "Claude Opus 4.8 1M Max", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-max-fast", label: "Claude Opus 4.8 1M Max Fast", description: "Claude Opus 4.8 1M Max Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-thinking-low", label: "Claude Opus 4.8 1M Low Thinking", description: "Claude Opus 4.8 1M Low Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-thinking-low-fast", label: "Claude Opus 4.8 1M Low Thinking Fast", description: "Claude Opus 4.8 1M Low Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-thinking-medium", label: "Claude Opus 4.8 1M Medium Thinking", description: "Claude Opus 4.8 1M Medium Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-thinking-medium-fast", label: "Claude Opus 4.8 1M Medium Thinking Fast", description: "Claude Opus 4.8 1M Medium Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-thinking-high", label: "Claude Opus 4.8 1M Thinking", description: "Claude Opus 4.8 1M Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-thinking-high-fast", label: "Claude Opus 4.8 1M Thinking Fast", description: "Claude Opus 4.8 1M Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-thinking-xhigh", label: "Claude Opus 4.8 1M Extra High Thinking", description: "Claude Opus 4.8 1M Extra High Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-thinking-xhigh-fast", label: "Claude Opus 4.8 1M Extra High Thinking Fast", description: "Claude Opus 4.8 1M Extra High Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-thinking-max", label: "Claude Opus 4.8 1M Max Thinking", description: "Claude Opus 4.8 1M Max Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-8-thinking-max-fast", label: "Claude Opus 4.8 1M Max Thinking Fast", description: "Claude Opus 4.8 1M Max Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "gpt-5.6-sol-none", label: "GPT-5.6 Sol 1M None", description: "GPT-5.6 Sol 1M None", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-sol-none-fast", label: "GPT-5.6 Sol None Fast", description: "GPT-5.6 Sol None Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-sol-low", label: "GPT-5.6 Sol 1M Low", description: "GPT-5.6 Sol 1M Low", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-sol-low-fast", label: "GPT-5.6 Sol Low Fast", description: "GPT-5.6 Sol Low Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-sol-medium", label: "GPT-5.6 Sol 1M", description: "GPT-5.6 Sol 1M", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-sol-medium-fast", label: "GPT-5.6 Sol Fast", description: "GPT-5.6 Sol Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-sol-max", label: "GPT-5.6 Sol 1M Max", description: "GPT-5.6 Sol 1M Max", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-sol-max-fast", label: "GPT-5.6 Sol Max Fast", description: "GPT-5.6 Sol Max Fast", vendor: "OpenAI" },
      { id: "gpt-5.5-none", label: "GPT-5.5 1M None", description: "GPT-5.5 1M None", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.5-none-fast", label: "GPT-5.5 None Fast", description: "GPT-5.5 None Fast", vendor: "OpenAI" },
      { id: "gpt-5.5-low", label: "GPT-5.5 1M Low", description: "GPT-5.5 1M Low", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.5-low-fast", label: "GPT-5.5 Low Fast", description: "GPT-5.5 Low Fast", vendor: "OpenAI" },
      { id: "gpt-5.5-medium", label: "GPT-5.5 1M", description: "GPT-5.5 1M", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.5-medium-fast", label: "GPT-5.5 Fast", description: "GPT-5.5 Fast", vendor: "OpenAI" },
      { id: "gpt-5.5-high", label: "GPT-5.5 1M High", description: "GPT-5.5 1M High", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.5-high-fast", label: "GPT-5.5 High Fast", description: "GPT-5.5 High Fast", vendor: "OpenAI" },
      { id: "gpt-5.5-extra-high", label: "GPT-5.5 1M Extra High", description: "GPT-5.5 1M Extra High", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.5-extra-high-fast", label: "GPT-5.5 Extra High Fast", description: "GPT-5.5 Extra High Fast", vendor: "OpenAI" },
      { id: "claude-fable-5-low", label: "Claude Fable 5 1M Low (NO ZDR)", description: "Claude Fable 5 1M Low (NO ZDR)", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-fable-5-medium", label: "Claude Fable 5 1M Medium (NO ZDR)", description: "Claude Fable 5 1M Medium (NO ZDR)", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-fable-5-high", label: "Claude Fable 5 1M (NO ZDR)", description: "Claude Fable 5 1M (NO ZDR)", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-fable-5-xhigh", label: "Claude Fable 5 1M Extra High (NO ZDR)", description: "Claude Fable 5 1M Extra High (NO ZDR)", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-fable-5-max", label: "Claude Fable 5 1M Max (NO ZDR)", description: "Claude Fable 5 1M Max (NO ZDR)", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-fable-5-thinking-low", label: "Claude Fable 5 1M Low Thinking (NO ZDR)", description: "Claude Fable 5 1M Low Thinking (NO ZDR)", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-fable-5-thinking-medium", label: "Claude Fable 5 1M Medium Thinking (NO ZDR)", description: "Claude Fable 5 1M Medium Thinking (NO ZDR)", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-fable-5-thinking-max", label: "Claude Fable 5 1M Max Thinking (NO ZDR)", description: "Claude Fable 5 1M Max Thinking (NO ZDR)", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "cursor-grok-4.5-low", label: "Cursor Grok 4.5 Low", description: "Cursor Grok 4.5 Low", vendor: "xAI" },
      { id: "cursor-grok-4.5-low-fast", label: "Cursor Grok 4.5 Low Fast", description: "Cursor Grok 4.5 Low Fast", vendor: "xAI" },
      { id: "cursor-grok-4.5-medium", label: "Cursor Grok 4.5 Medium", description: "Cursor Grok 4.5 Medium", vendor: "xAI" },
      { id: "cursor-grok-4.5-medium-fast", label: "Cursor Grok 4.5 Medium Fast", description: "Cursor Grok 4.5 Medium Fast", vendor: "xAI" },
      { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash Low", description: "Gemini 3.7 Flash Low", vendor: "Google" },
      { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash Medium", description: "Gemini 3.7 Flash Medium", vendor: "Google" },
      { id: "gpt-5.6-terra-none", label: "GPT-5.6 Terra 1M None", description: "GPT-5.6 Terra 1M None", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-terra-none-fast", label: "GPT-5.6 Terra None Fast", description: "GPT-5.6 Terra None Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-terra-low", label: "GPT-5.6 Terra 1M Low", description: "GPT-5.6 Terra 1M Low", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-terra-low-fast", label: "GPT-5.6 Terra Low Fast", description: "GPT-5.6 Terra Low Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-terra-medium", label: "GPT-5.6 Terra 1M", description: "GPT-5.6 Terra 1M", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-terra-medium-fast", label: "GPT-5.6 Terra Fast", description: "GPT-5.6 Terra Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-terra-high", label: "GPT-5.6 Terra 1M High", description: "GPT-5.6 Terra 1M High", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-terra-high-fast", label: "GPT-5.6 Terra High Fast", description: "GPT-5.6 Terra High Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-terra-xhigh", label: "GPT-5.6 Terra 1M Extra High", description: "GPT-5.6 Terra 1M Extra High", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-terra-xhigh-fast", label: "GPT-5.6 Terra Extra High Fast", description: "GPT-5.6 Terra Extra High Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-terra-max", label: "GPT-5.6 Terra 1M Max", description: "GPT-5.6 Terra 1M Max", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-terra-max-fast", label: "GPT-5.6 Terra Max Fast", description: "GPT-5.6 Terra Max Fast", vendor: "OpenAI" },
      { id: "claude-sonnet-5-low", label: "Claude Sonnet 5 1M Low", description: "Claude Sonnet 5 1M Low", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-sonnet-5-medium", label: "Claude Sonnet 5 1M Medium", description: "Claude Sonnet 5 1M Medium", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-sonnet-5-high", label: "Claude Sonnet 5 1M", description: "Claude Sonnet 5 1M", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-sonnet-5-xhigh", label: "Claude Sonnet 5 1M Extra High", description: "Claude Sonnet 5 1M Extra High", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-sonnet-5-max", label: "Claude Sonnet 5 1M Max", description: "Claude Sonnet 5 1M Max", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-sonnet-5-thinking-low", label: "Claude Sonnet 5 1M Low Thinking", description: "Claude Sonnet 5 1M Low Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-sonnet-5-thinking-medium", label: "Claude Sonnet 5 1M Medium Thinking", description: "Claude Sonnet 5 1M Medium Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-sonnet-5-thinking-max", label: "Claude Sonnet 5 1M Max Thinking", description: "Claude Sonnet 5 1M Max Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-4.6-sonnet-medium", label: "Claude Sonnet 4.6 1M", description: "Claude Sonnet 4.6 1M", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-4.6-sonnet-medium-thinking", label: "Claude Sonnet 4.6 1M Thinking", description: "Claude Sonnet 4.6 1M Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-low", label: "Claude Opus 4.7 1M Low", description: "Claude Opus 4.7 1M Low", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-low-fast", label: "Claude Opus 4.7 1M Low Fast", description: "Claude Opus 4.7 1M Low Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-medium", label: "Claude Opus 4.7 1M Medium", description: "Claude Opus 4.7 1M Medium", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-medium-fast", label: "Claude Opus 4.7 1M Medium Fast", description: "Claude Opus 4.7 1M Medium Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-high", label: "Claude Opus 4.7 1M High", description: "Claude Opus 4.7 1M High", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-high-fast", label: "Claude Opus 4.7 1M High Fast", description: "Claude Opus 4.7 1M High Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-xhigh", label: "Claude Opus 4.7 1M", description: "Claude Opus 4.7 1M", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-xhigh-fast", label: "Claude Opus 4.7 1M Fast", description: "Claude Opus 4.7 1M Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-max", label: "Claude Opus 4.7 1M Max", description: "Claude Opus 4.7 1M Max", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-max-fast", label: "Claude Opus 4.7 1M Max Fast", description: "Claude Opus 4.7 1M Max Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-thinking-low", label: "Claude Opus 4.7 1M Low Thinking", description: "Claude Opus 4.7 1M Low Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-thinking-low-fast", label: "Claude Opus 4.7 1M Low Thinking Fast", description: "Claude Opus 4.7 1M Low Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-thinking-medium", label: "Claude Opus 4.7 1M Medium Thinking", description: "Claude Opus 4.7 1M Medium Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-thinking-medium-fast", label: "Claude Opus 4.7 1M Medium Thinking Fast", description: "Claude Opus 4.7 1M Medium Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-thinking-high", label: "Claude Opus 4.7 1M High Thinking", description: "Claude Opus 4.7 1M High Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-thinking-high-fast", label: "Claude Opus 4.7 1M High Thinking Fast", description: "Claude Opus 4.7 1M High Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-thinking-xhigh", label: "Claude Opus 4.7 1M Thinking", description: "Claude Opus 4.7 1M Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-thinking-xhigh-fast", label: "Claude Opus 4.7 1M Thinking Fast", description: "Claude Opus 4.7 1M Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-thinking-max", label: "Claude Opus 4.7 1M Max Thinking", description: "Claude Opus 4.7 1M Max Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-opus-4-7-thinking-max-fast", label: "Claude Opus 4.7 1M Max Thinking Fast", description: "Claude Opus 4.7 1M Max Thinking Fast", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "gpt-5.4-low", label: "GPT-5.4 1M Low", description: "GPT-5.4 1M Low", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.4-medium", label: "GPT-5.4 1M", description: "GPT-5.4 1M", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.4-medium-fast", label: "GPT-5.4 Fast", description: "GPT-5.4 Fast", vendor: "OpenAI" },
      { id: "gpt-5.4-high", label: "GPT-5.4 1M High", description: "GPT-5.4 1M High", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.4-high-fast", label: "GPT-5.4 High Fast", description: "GPT-5.4 High Fast", vendor: "OpenAI" },
      { id: "gpt-5.4-xhigh", label: "GPT-5.4 1M Extra High", description: "GPT-5.4 1M Extra High", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.4-xhigh-fast", label: "GPT-5.4 Extra High Fast", description: "GPT-5.4 Extra High Fast", vendor: "OpenAI" },
      { id: "claude-4.6-opus-high", label: "Claude Opus 4.6 1M", description: "Claude Opus 4.6 1M", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-4.6-opus-max", label: "Claude Opus 4.6 1M Max", description: "Claude Opus 4.6 1M Max", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-4.6-opus-high-thinking", label: "Claude Opus 4.6 1M Thinking", description: "Claude Opus 4.6 1M Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-4.6-opus-max-thinking", label: "Claude Opus 4.6 1M Max Thinking", description: "Claude Opus 4.6 1M Max Thinking", vendor: "Anthropic", contextTokens: 1000000 },
      { id: "claude-4.5-opus-high", label: "Claude Opus 4.5", description: "Claude Opus 4.5", vendor: "Anthropic" },
      { id: "claude-4.5-opus-high-thinking", label: "Claude Opus 4.5 Thinking", description: "Claude Opus 4.5 Thinking", vendor: "Anthropic" },
      { id: "gpt-5.2-low", label: "GPT-5.2 Low", description: "GPT-5.2 Low", vendor: "OpenAI" },
      { id: "gpt-5.2-low-fast", label: "GPT-5.2 Low Fast", description: "GPT-5.2 Low Fast", vendor: "OpenAI" },
      { id: "gpt-5.2-fast", label: "GPT-5.2 Fast", description: "GPT-5.2 Fast", vendor: "OpenAI" },
      { id: "gpt-5.2-high", label: "GPT-5.2 High", description: "GPT-5.2 High", vendor: "OpenAI" },
      { id: "gpt-5.2-high-fast", label: "GPT-5.2 High Fast", description: "GPT-5.2 High Fast", vendor: "OpenAI" },
      { id: "gpt-5.2-xhigh", label: "GPT-5.2 Extra High", description: "GPT-5.2 Extra High", vendor: "OpenAI" },
      { id: "gpt-5.2-xhigh-fast", label: "GPT-5.2 Extra High Fast", description: "GPT-5.2 Extra High Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-luna-none", label: "GPT-5.6 Luna 1M None", description: "GPT-5.6 Luna 1M None", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-luna-none-fast", label: "GPT-5.6 Luna None Fast", description: "GPT-5.6 Luna None Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-luna-low", label: "GPT-5.6 Luna 1M Low", description: "GPT-5.6 Luna 1M Low", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-luna-low-fast", label: "GPT-5.6 Luna Low Fast", description: "GPT-5.6 Luna Low Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-luna-medium", label: "GPT-5.6 Luna 1M", description: "GPT-5.6 Luna 1M", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-luna-medium-fast", label: "GPT-5.6 Luna Fast", description: "GPT-5.6 Luna Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-luna-high-fast", label: "GPT-5.6 Luna High Fast", description: "GPT-5.6 Luna High Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-luna-xhigh", label: "GPT-5.6 Luna 1M Extra High", description: "GPT-5.6 Luna 1M Extra High", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-luna-xhigh-fast", label: "GPT-5.6 Luna Extra High Fast", description: "GPT-5.6 Luna Extra High Fast", vendor: "OpenAI" },
      { id: "gpt-5.6-luna-max", label: "GPT-5.6 Luna 1M Max", description: "GPT-5.6 Luna 1M Max", vendor: "OpenAI", contextTokens: 1000000 },
      { id: "gpt-5.6-luna-max-fast", label: "GPT-5.6 Luna Max Fast", description: "GPT-5.6 Luna Max Fast", vendor: "OpenAI" },
      { id: "gemini-3.6-flash-minimal", label: "Gemini 3.6 Flash Minimal", description: "Gemini 3.6 Flash Minimal", vendor: "Google" },
      { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash Low", description: "Gemini 3.6 Flash Low", vendor: "Google" },
      { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash Medium", description: "Gemini 3.6 Flash Medium", vendor: "Google" },
      { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash", description: "Gemini 3.6 Flash", vendor: "Google" },
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", description: "Gemini 3.1 Pro", vendor: "Google" },
      { id: "gpt-5.4-mini-none", label: "GPT-5.4 Mini None", description: "GPT-5.4 Mini None", vendor: "OpenAI" },
      { id: "gpt-5.4-mini-low", label: "GPT-5.4 Mini Low", description: "GPT-5.4 Mini Low", vendor: "OpenAI" },
      { id: "gpt-5.4-mini-medium", label: "GPT-5.4 Mini", description: "GPT-5.4 Mini", vendor: "OpenAI" },
      { id: "gpt-5.4-mini-high", label: "GPT-5.4 Mini High", description: "GPT-5.4 Mini High", vendor: "OpenAI" },
      { id: "gpt-5.4-mini-xhigh", label: "GPT-5.4 Mini Extra High", description: "GPT-5.4 Mini Extra High", vendor: "OpenAI" },
      { id: "gpt-5.4-nano-none", label: "GPT-5.4 Nano None", description: "GPT-5.4 Nano None", vendor: "OpenAI" },
      { id: "gpt-5.4-nano-low", label: "GPT-5.4 Nano Low", description: "GPT-5.4 Nano Low", vendor: "OpenAI" },
      { id: "gpt-5.4-nano-medium", label: "GPT-5.4 Nano", description: "GPT-5.4 Nano", vendor: "OpenAI" },
      { id: "gpt-5.4-nano-high", label: "GPT-5.4 Nano High", description: "GPT-5.4 Nano High", vendor: "OpenAI" },
      { id: "gpt-5.4-nano-xhigh", label: "GPT-5.4 Nano Extra High", description: "GPT-5.4 Nano Extra High", vendor: "OpenAI" },
      { id: "claude-4.5-sonnet", label: "Claude Sonnet 4.5", description: "Claude Sonnet 4.5", vendor: "Anthropic" },
      { id: "claude-4.5-sonnet-thinking", label: "Claude Sonnet 4.5 Thinking", description: "Claude Sonnet 4.5 Thinking", vendor: "Anthropic" },
      { id: "gpt-5.1-low", label: "GPT-5.1 Low", description: "GPT-5.1 Low", vendor: "OpenAI" },
      { id: "gpt-5.1", label: "GPT-5.1", description: "GPT-5.1", vendor: "OpenAI" },
      { id: "gpt-5.1-high", label: "GPT-5.1 High", description: "GPT-5.1 High", vendor: "OpenAI" },
      { id: "gemini-3-flash", label: "Gemini 3 Flash", description: "Gemini 3 Flash", vendor: "Google" },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", description: "Gemini 3.5 Flash", vendor: "Google" },
      { id: "claude-4-sonnet", label: "Claude Sonnet 4", description: "Claude Sonnet 4", vendor: "Anthropic" },
      { id: "claude-4-sonnet-thinking", label: "Claude Sonnet 4 Thinking", description: "Claude Sonnet 4 Thinking", vendor: "Anthropic" },
      { id: "gpt-5-mini", label: "GPT-5 Mini", description: "GPT-5 Mini", vendor: "OpenAI" },
      { id: "kimi-k3-low", label: "Kimi K3 Low", description: "Kimi K3 Low", vendor: "Moonshot" },
      { id: "kimi-k3-high", label: "Kimi K3 High", description: "Kimi K3 High", vendor: "Moonshot" },
      { id: "kimi-k3-max", label: "Kimi K3", description: "Kimi K3", vendor: "Moonshot" },
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", description: "Kimi K2.7 Code", vendor: "Moonshot" },
      { id: "glm-5.2-high", label: "GLM 5.2", description: "GLM 5.2", vendor: "Zhipu" },
      { id: "glm-5.2-max", label: "GLM 5.2 Max", description: "GLM 5.2 Max", vendor: "Zhipu" },
    ],
    // Effort is baked into Cursor model ids; never --effort / --reasoning-effort.
    efforts: [],
    kind: "cursor-stream",
    /**
     * Cursor Agent CLI (verified 2026.07.09-a3815c0). `-p`/`--print` is a
     * BOOLEAN flag (not grok's `-p <prompt>`); the prompt is remaining
     * positional args, last. Headless stream is
     * `-p --output-format stream-json --stream-partial-output --trust
     * --force --approve-mcps`. Plan is read-only: `--mode plan` and no
     * `--force`. Never `--effort`/`--reasoning-effort` (effort is baked
     * into the model id) and never Cursor's own `--worktree` (Solenta
     * owns worktrees / cwd). defaultBin is cursor-agent because grok
     * also ships `agent` on PATH.
     */
    buildArgs({ prompt, sessionId, permissionMode, model, reasoningEffort }) {
      const plan = String(permissionMode || "") === "plan";
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--trust",
      ];
      if (!plan) {
        args.push("--force");
      }
      args.push("--approve-mcps");
      if (plan) {
        args.push("--mode", "plan");
      }
      if (model) {
        args.push("--model", String(model));
      }
      if (typeof sessionId === "string" && sessionId.length > 0) {
        args.push("--resume", String(sessionId));
      }
      maybeEmitEffort([], reasoningEffort, () => {
        args.push("--effort", "should-not-appear");
      });
      args.push(String(prompt ?? ""));
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
 * Resolved `which` hits, keyed by bin + PATH (issue #124).
 *
 * ponytail: positive results only, and never invalidated. `which` is
 * execFileSync on the main-process event loop, and runner.js calls it on every
 * run start, so N concurrent runs paid N PATH walks. An installed CLI does not
 * move mid-session, so caching a hit is safe; a MISS is deliberately not
 * cached, because a user who installs a provider CLI while the app is open
 * must be able to use it without a restart. Drop the cache (or add a TTL) if a
 * moved-binary stale path ever bites.
 *
 * @type {Map<string, string>}
 */
const whichCache = new Map();

/**
 * PATH lookup command for a platform. Windows has no `which`; `where` is the
 * built-in equivalent and, unlike `which`, prints EVERY match (one per line)
 * in PATH order — so the first line is the one the shell would pick.
 *
 * Only the LOCAL host matters here. A project across a boundary (ssh remote
 * or WSL-side) never reaches this code: assertProviderBinary returns early on
 * crossesBoundary(), because the CLI lives on the other side where that
 * side's own `which` is the correct question.
 *
 * @param {NodeJS.Platform} platform
 */
function whichCommand(platform) {
  return platform === "win32" ? "where" : "which";
}

/**
 * Default which: absolute/relative path via existsSync, else a PATH lookup.
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string | null}
 */
function defaultWhich(bin, env = process.env, platform = process.platform) {
  if (!bin) return null;
  if (path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    try {
      return fs.existsSync(bin) ? bin : null;
    } catch {
      return null;
    }
  }
  // `\0` as an escape, never a raw NUL byte: a literal NUL makes grep
  // treat this entire file as binary, so every search silently reports no
  // match rather than failing loudly (#441).
  const key = `${bin}\0${platform}\0${env.PATH || ""}`;
  const hit = whichCache.get(key);
  if (hit) return hit;
  try {
    const out = execFileSync(whichCommand(platform), [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    // `where` prints EVERY match, one per line, in PATH order; `which` prints
    // one. Taking the first non-empty line is correct for both.
    const first = String(out || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) whichCache.set(key, first);
    return first || null;
  } catch {
    return null;
  }
}

/** Test hook: forget cached `which` hits. */
function clearWhichCache() {
  whichCache.clear();
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
      supportsSearch: entry.supportsSearch === true,
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
      supportsSearch: false,
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
  clearWhichCache,
  listProviders,
};
