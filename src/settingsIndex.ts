import type { SettingsPane } from "./components/SettingsModal";

/**
 * Static index of individual settings for the global "Find a setting" search
 * (#1793), listed as "Pane › Setting" and jumped to with a scroll + flash.
 *
 * Hand-maintained rather than derived from the rendered markup. The obvious
 * markup-derived alternative, mounting every pane off-screen once to scan
 * it, does not work here: several panes fire real side effects the moment
 * they mount (ProvidersPane and AgentsPane re-probe provider sign-in,
 * ProvidersPane also detects local model servers, AdvancedPane's governance
 * audit section fetches the audit log). SettingsModal already deliberately
 * mounts only the active pane for exactly this reason (ChannelsSection,
 * WebAccessSection and IntegrationsSection even take an `active` prop to
 * gate their own effects). A hidden-pass scan would mount all of them on
 * every Settings open, firing those probes whether or not the user ever
 * visits that pane. A short hand list costs a missed entry when a setting
 * is added and the list isn't; that is a smaller, quieter failure than
 * extra sign-in/network calls on every open.
 *
 * `selector` points at the setting's own (pre-existing, already
 * test-covered) data-* attribute or id rather than a new one invented for
 * this feature, so there is nothing new to keep in sync on the markup side.
 * The lookup climbs from that element to its nearest .field/.fieldRow
 * wrapper to scroll to and flash.
 */
export interface SettingsIndexEntry {
  pane: SettingsPane;
  label: string;
  /** CSS selector for the setting's existing control. */
  selector: string;
  /** Short help text, searched alongside the label. */
  help: string;
  /** Extra search terms beyond label/help. */
  keywords?: string;
}

export const SETTINGS_INDEX: SettingsIndexEntry[] = [
  // General
  {
    pane: "general",
    label: "Theme",
    selector: "#theme",
    help: "Light, dark, or match the system.",
  },
  {
    pane: "general",
    label: "UI scale",
    selector: "[data-ui-scale]",
    help: "Zoom the whole app in or out.",
    keywords: "zoom size font",
  },
  {
    pane: "general",
    label: "Desktop notifications",
    selector: "[data-notifications]",
    help: "Native notifications for approvals, finished and failed turns.",
    keywords: "alert banner",
  },
  {
    pane: "general",
    label: "Notification sound",
    selector: "[data-notification-sound]",
    help: "Play a sound with desktop notifications.",
    keywords: "chime audio",
  },
  {
    pane: "general",
    label: "Confirm quit with active work",
    selector: "[data-confirm-quit-with-active-work]",
    help: "Warn before quitting while a thread is still running.",
    keywords: "close exit accidental",
  },
  {
    pane: "general",
    label: "Webhook URL",
    selector: "#webhook-url",
    help: "POST a message on done, failed or waiting-for-input turns.",
    keywords: "slack discord ntfy push phone webhook",
  },
  {
    pane: "general",
    label: "Felt-estimate prompt",
    selector: "[data-felt-estimate-prompt]",
    help: "Ask how long a turn felt after it finishes.",
    keywords: "time estimate survey",
  },
  {
    pane: "general",
    label: "Chat width",
    selector: "#chat-width-pref",
    help: "How wide the thread transcript renders.",
    keywords: "layout width",
  },
  {
    pane: "general",
    label: "Show divergence compare on threads",
    selector: "[data-divergence-pref]",
    help: "Surface a diff-against-main card when a thread's branch diverges.",
  },
  {
    pane: "general",
    label: "Speech-to-text",
    selector: "#speech-provider",
    help: "Dictate composer messages with a speech provider.",
    keywords: "voice input dictation microphone",
  },
  {
    pane: "general",
    label: "Update channel",
    selector: "#update-channel",
    help: "Nightly or stable auto-update track.",
    keywords: "version build release",
  },

  // Keyboard
  {
    pane: "keyboard",
    label: "Custom shortcuts",
    selector: "[data-keybindings-json]",
    help: "Remap app shortcuts as raw JSON.",
    keywords: "keybindings hotkeys chord remap keys",
  },
  {
    pane: "keyboard",
    label: "Reset shortcuts",
    selector: "[data-keybindings-reset]",
    help: "Restore every shortcut to its default.",
  },

  // Threads
  {
    pane: "threads",
    label: "Auto-settle quiet threads after",
    selector: "#auto-settle-days",
    help: "Days of inactivity before a thread leaves the attention list.",
    keywords: "settle quiet archive",
  },
  {
    pane: "threads",
    label: "Worktree location",
    selector: "#worktree-root",
    help: "Where isolated per-thread checkouts are created.",
    keywords: "worktree isolate folder",
  },
  {
    pane: "threads",
    label: "Default provider",
    selector: "#default-provider",
    help: "Agent CLI new threads start with.",
    keywords: "claude codex grok kimi cursor opencode",
  },
  {
    pane: "threads",
    label: "Default model",
    selector: "#default-model",
    help: "Model new threads start with, for the default provider.",
  },
  {
    pane: "threads",
    label: "Thread title instructions",
    selector: "#title-instructions",
    help: "Extra guidance for how the agent names new threads.",
  },
  {
    pane: "threads",
    label: "Resume interrupted runs after restart",
    selector: "[data-resume-interrupted-runs]",
    help: "Give a thread one automatic turn to continue after a crash or quit.",
    keywords: "crash restart continue",
  },
  {
    pane: "threads",
    label: "Combine queued follow-ups into one turn",
    selector: "[data-combine-queued-follow-ups]",
    help: "Send messages queued mid-run together, numbered, as one turn.",
    keywords: "queue follow-up batch",
  },
  {
    pane: "threads",
    label: "Let agents report Solenta bugs",
    selector: "[data-agent-bug-reports]",
    help: "Agents can send a redacted bug report when they hit a Solenta defect.",
    keywords: "feedback report bug",
  },

  // Spending
  {
    pane: "spending",
    label: "Daily budget (USD)",
    selector: "#daily-budget",
    help: "Stop new turns once today's spend passes this cap.",
    keywords: "budget cost money cap usd",
  },
  {
    pane: "spending",
    label: "Per-orchestration budget (USD)",
    selector: "#orch-budget",
    help: "Caps the combined spend of an orchestrator thread and its workers.",
    keywords: "orchestration crew worker spend cap",
  },
  {
    pane: "spending",
    label: "Max concurrent runs",
    selector: "#max-concurrent-runs",
    help: "Agent runs allowed at once across all projects; further starts queue.",
    keywords: "concurrency parallel queue runs",
  },
  {
    pane: "spending",
    label: "Model prices",
    selector: "[data-model-prices]",
    help: "Per-token prices used to estimate spend for custom models.",
  },

  // Git
  {
    pane: "git",
    label: "PR size cap (lines changed)",
    selector: "#pr-diff-cap",
    help: "Warn or block PRs that change more than this many lines.",
    keywords: "pull request diff size cap",
  },
  {
    pane: "git",
    label: "Default merge method",
    selector: "#default-merge-method",
    help: "Merge, squash, or rebase when a PR is merged from Solenta.",
  },
  {
    pane: "git",
    label: "Commit message instructions",
    selector: "#commit-message-instructions",
    help: "Extra guidance the agent follows when writing commit messages.",
  },
  {
    pane: "git",
    label: "PR title and body instructions",
    selector: "#pr-instructions",
    help: "Extra guidance the agent follows when writing PR titles and bodies.",
    keywords: "pull request",
  },
  {
    pane: "git",
    label: "Model for commit messages and PR text",
    selector: "#git-text-provider",
    help: "Which provider writes commit messages and PR text.",
  },
  {
    pane: "git",
    label: "Linear API key",
    selector: "#linear-api-key",
    help: "Lets agents read and update Linear tickets.",
    keywords: "linear ticket",
  },
  {
    pane: "git",
    label: "Sentry auth token",
    selector: "#sentry-auth-token",
    help: "Lets agents read Sentry issues linked from a PR.",
    keywords: "sentry error",
  },
  {
    pane: "git",
    label: "Worktrees",
    selector: "[data-worktree-gc]",
    help: "Scan and reclaim disk used by old worktrees.",
    keywords: "gc disk cleanup worktree",
  },
  {
    pane: "git",
    label: "Spotlight",
    selector: "[data-spotlight-settings]",
    help: "Per-project opt-in for Spotlight review.",
    keywords: "lanes preview review",
  },

  // Providers
  {
    pane: "providers",
    label: "Search providers",
    selector: "[data-provider-search]",
    help: "Find a provider by name to sign in, add a key, or configure it.",
    keywords: "anthropic openai xai claude codex grok opencode kimi muse cursor",
  },

  // Agents
  {
    pane: "agents",
    label: "Default orchestrator",
    selector: "#orch-default-profile",
    help: "Profile used when a thread starts an orchestration.",
    keywords: "orchestration lead profile",
  },
  {
    pane: "agents",
    label: "Worker pool",
    selector: "[data-subagent-pool]",
    help: "Candidate providers and models an orchestrator can wake as workers.",
    keywords: "pool worker subagent candidate",
  },
  {
    pane: "agents",
    label: "Prompt snippets",
    selector: "[data-prompt-snippets]",
    help: "Reusable text blocks you can insert into the composer.",
    keywords: "snippet template boilerplate",
  },
  {
    pane: "agents",
    label: "Add profile",
    selector: "[data-add-profile]",
    help: "Create a named profile (provider, model, effort, permission mode).",
  },

  // Memory
  {
    pane: "memory",
    label: "Project tools",
    selector: "[data-project-tools]",
    help: "Code map and config doctor for a project's memory.",
    keywords: "code map config doctor agents.md claude.md",
  },
  {
    pane: "memory",
    label: "Same-named repos",
    selector: "[data-memory-collisions]",
    help: "Projects that share a memory scope because their folder names collide.",
    keywords: "scope collision rename",
  },

  // Skills & MCP
  {
    pane: "skills",
    label: "Browse catalog",
    selector: '[aria-label="Browse catalog"]',
    help: "Curated skills you can add to every agent.",
    keywords: "catalog curated plugin",
  },
  {
    pane: "skills",
    label: "MCP servers",
    selector: '[aria-label="MCP servers"]',
    help: "Add an MCP server (SSE, HTTP, stdio, or a GitHub-hosted config) to every agent.",
    keywords: "mcp server command url bearer token",
  },
  {
    pane: "skills",
    label: "Add skill",
    selector: '[aria-label="Add skill"]',
    help: "Write a skill by hand instead of installing one from the catalog.",
  },

  // Connections
  {
    pane: "connections",
    label: "Use from your phone or browser",
    selector: "[data-web-access]",
    help: "Turn on web access so this Solenta can be reached remotely.",
    keywords: "remote web token phone device qr pair tailscale https lan",
  },
  {
    pane: "connections",
    label: "Open another computer's Solenta",
    selector: "[data-connections]",
    help: "Connect to a Solenta running on a different machine.",
    keywords: "remote ssh host server tunnel workstation",
  },

  // Integrations
  {
    pane: "integrations",
    label: "New pairing",
    selector: "#pairing-name",
    help: "Pair an external MCP client (Claude Desktop, an editor) with this Solenta.",
    keywords: "mcp pairing claude desktop token external agent connect",
  },
  {
    pane: "integrations",
    label: "Telegram",
    selector: "[data-channels-telegram]",
    help: "Start and continue threads by messaging your own Telegram bot.",
    keywords: "chat bot channel phone message",
  },
  {
    pane: "integrations",
    label: "Slack",
    selector: "[data-channels-slack]",
    help: "Start and continue threads from a Slack app.",
    keywords: "chat bot channel message",
  },
  {
    pane: "integrations",
    label: "Discord",
    selector: "[data-channels-discord]",
    help: "Start and continue threads from a Discord bot.",
    keywords: "chat bot channel message",
  },

  // Advanced
  {
    pane: "advanced",
    label: "Guardrails",
    selector: "[data-guardrails-enabled]",
    help: "Safety checks that review risky tool calls before they run.",
    keywords: "safety security protection tools secrets injection",
  },
  {
    pane: "advanced",
    label: "Privacy gateway",
    selector: "[data-privacy-gateway]",
    help: "Redact secrets and personal data from what agents send out.",
    keywords: "redact redaction pii personal data email",
  },
  {
    pane: "advanced",
    label: "OTLP endpoint",
    selector: "#otel-endpoint",
    help: "Where to export OpenTelemetry traces for runs.",
    keywords: "otel opentelemetry otlp traces telemetry export",
  },
  {
    pane: "advanced",
    label: "Governance audit",
    selector: "[data-governance-audit]",
    help: "Read-only tail of the signed audit log of agent actions.",
    keywords: "audit log verdict hmac",
  },
  {
    pane: "advanced",
    label: "Diagnostics",
    selector: "[data-diagnostics]",
    help: "Export logs and app state to attach to a bug report.",
    keywords: "logs export support",
  },
];
