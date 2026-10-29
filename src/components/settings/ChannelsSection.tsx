import { useCallback, useEffect, useState } from "react";
import { resolveCoderApi } from "../../coderApi";
import type {
  AppSettings,
  ChannelKind,
  ChannelState,
  ChannelStatus,
  CoderApi,
  ProjectInfo,
  SlackSettings,
} from "../../shared/ipc";
import styles from "../SettingsModal.module.css";

type ChannelApi = Pick<
  CoderApi["settings"],
  "channelStatus" | "connectChannel" | "disconnectChannel"
>;

export interface ChannelsSectionProps {
  active: boolean;
  settings: AppSettings | null;
  projects?: ProjectInfo[];
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  /** Test seam; defaults to window.coder.settings. */
  api?: ChannelApi;
}

interface TokenField {
  key: "botToken" | "appToken";
  has: "hasToken" | "hasAppToken";
  label: string;
  placeholder: string;
  /** data-<kind>-<attr> hook */
  attr: string;
}

interface ChannelCopy {
  kind: ChannelKind;
  label: string;
  intro: string;
  tokens: TokenField[];
  idsLabel: string;
  idsPlaceholder: string;
  idsNote: string;
}

const BOT_FIELD = { key: "botToken", has: "hasToken", label: "Bot token", attr: "token" } as const;

/** One entry per chat channel (#1718), in display order. */
const CHANNELS: ChannelCopy[] = [
  {
    kind: "telegram",
    label: "Telegram",
    intro:
      "Start and continue threads by messaging your own Telegram bot. Results, " +
      "approvals and questions come back to the chat. Create a bot with " +
      "@BotFather and paste its token here. Message the bot directly: group " +
      "chats are ignored, so agent output never reaches other members.",
    tokens: [{ ...BOT_FIELD, placeholder: "123456789:AA…" }],
    idsLabel: "Allowed sender IDs",
    idsPlaceholder: "123456789",
    idsNote:
      "Required. Numeric Telegram user IDs, comma separated. Messages from " +
      "anyone else are ignored and get no reply. Their IDs show up in the " +
      "Solenta log, so you can copy yours from there.",
  },
  {
    kind: "slack",
    label: "Slack",
    intro:
      "Start and continue threads by sending your own Slack app a direct " +
      "message. Results, approvals and questions come back to the DM. Create " +
      "an app with Socket Mode on, an app-level token with connections:write, " +
      "a bot token with chat:write and im:history, the message.im event and " +
      "Interactivity. DMs only; group/channel messages are ignored.",
    tokens: [
      { key: "appToken", has: "hasAppToken", label: "App-level token", placeholder: "xapp-…", attr: "app-token" },
      { ...BOT_FIELD, placeholder: "xoxb-…" },
    ],
    idsLabel: "Allowed member IDs",
    idsPlaceholder: "U012AB3CD",
    idsNote:
      "Required. Slack member IDs (profile → ⋯ → Copy member ID), comma " +
      "separated. Messages from anyone else are ignored and get no reply.",
  },
  {
    kind: "discord",
    label: "Discord",
    intro:
      "Start and continue threads by sending your own Discord bot a direct " +
      "message. Results, approvals and questions come back to the DM. Add a " +
      "bot to an application in the Discord Developer Portal, paste its " +
      "token, and share a server with it so you can DM it. DMs only; " +
      "group/channel messages are ignored.",
    tokens: [{ ...BOT_FIELD, placeholder: "MTA…" }],
    idsLabel: "Allowed user IDs",
    idsPlaceholder: "123456789012345678",
    idsNote:
      "Required. Numeric Discord user IDs (Developer Mode on, then right-click " +
      "your name → Copy User ID), comma separated. Messages from anyone else " +
      "are ignored and get no reply.",
  },
];

function message(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/** "123, 456 789" → ["123", "456", "789"]. Main validates each id. */
function parseIds(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

function statusText(s: ChannelState | null): string {
  if (!s || s.state === "off") return "Not connected";
  if (s.state === "connecting") return "Connecting…";
  if (s.state === "error") return `Error: ${s.error ?? "unknown"}`;
  return s.botUsername ? `Connected as @${s.botUsername}` : "Connected";
}

/** Chat channels (#1718): start and continue threads from Telegram, Slack or Discord. */
export function ChannelsSection(props: ChannelsSectionProps) {
  const { active, api } = props;
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const channelApi = useCallback(
    (): ChannelApi => api ?? resolveCoderApi().settings,
    [api],
  );

  useEffect(() => {
    if (!active) return;
    // Inside the chain: a client without the method just shows no status.
    Promise.resolve()
      .then(() => channelApi().channelStatus())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [active]);

  return (
    <>
      {CHANNELS.map((copy) => (
        <ChannelCard
          key={copy.kind}
          {...props}
          copy={copy}
          channelApi={channelApi}
          status={status?.[copy.kind] ?? null}
          onStatus={setStatus}
        />
      ))}
    </>
  );
}

function ChannelCard({
  active,
  settings,
  projects = [],
  onSaveSettings,
  copy,
  channelApi,
  status,
  onStatus,
}: ChannelsSectionProps & {
  copy: ChannelCopy;
  channelApi: () => ChannelApi;
  status: ChannelState | null;
  onStatus: (s: ChannelStatus) => void;
}) {
  const { kind } = copy;
  const saved = settings?.[kind] as SlackSettings | undefined;
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [ids, setIds] = useState("");
  const [projectId, setProjectId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A failed Connect shows here even though main's status may still say off.
  const [failure, setFailure] = useState<ChannelState | null>(null);

  useEffect(() => {
    if (!active) return;
    setIds((saved?.allowedSenderIds ?? []).join(", "));
    setProjectId(saved?.projectId ?? "");
    setProfileId(saved?.agentProfileId ?? "");
    setTokens({});
    setError(null);
    setFailure(null);
    // Re-seed only when the pane opens, not on every settings echo.
  }, [active]);

  const save = async () => {
    const typed: Record<string, string> = {};
    for (const t of copy.tokens) {
      const v = (tokens[t.key] ?? "").trim();
      // Omitted keeps the saved token: the renderer never sees it.
      if (v) typed[t.key] = v;
    }
    await onSaveSettings({
      // No `enabled`: Connect / Disconnect own it, and these props can be stale.
      [kind]: {
        allowedSenderIds: parseIds(ids),
        projectId: projectId || null,
        agentProfileId: profileId || null,
        ...typed,
      },
    });
    setTokens({});
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const shown = failure ?? status;
  const connected = shown?.state === "connected" || shown?.state === "connecting";
  const hook = (name: string) => ({ [`data-${kind}-${name}`]: "" });

  return (
    <section className={styles.section} {...{ [`data-channels-${kind}`]: "" }}>
      <h3 className={styles.sectionLabel}>{copy.label}</h3>
      <p className={styles.note}>{copy.intro}</p>
      <div className={styles.memoryRow}>
        <span
          className={styles.memoryDot}
          data-on={shown?.state === "connected" ? "true" : undefined}
          aria-hidden
        />
        <span {...hook("status")}>{statusText(shown)}</span>
      </div>

      {copy.tokens.map((t) => (
        <div className={styles.field} key={t.key}>
          <label className={styles.fieldLabel} htmlFor={`${kind}-${t.attr}`}>
            {t.label}
          </label>
          <input
            id={`${kind}-${t.attr}`}
            className={styles.input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={saved?.[t.has] ? "Saved. Paste a new token to replace it" : t.placeholder}
            value={tokens[t.key] ?? ""}
            disabled={busy}
            {...hook(t.attr)}
            onChange={(e) => {
              const value = e.target.value;
              setTokens((prev) => ({ ...prev, [t.key]: value }));
            }}
          />
        </div>
      ))}

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={`${kind}-allowed-ids`}>
          {copy.idsLabel}
        </label>
        <input
          id={`${kind}-allowed-ids`}
          className={styles.input}
          spellCheck={false}
          placeholder={copy.idsPlaceholder}
          value={ids}
          disabled={busy}
          {...hook("allowed-ids")}
          onChange={(e) => setIds(e.target.value)}
        />
        <p className={styles.note}>{copy.idsNote}</p>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={`${kind}-project`}>
          Default project
        </label>
        <select
          id={`${kind}-project`}
          className={styles.input}
          value={projectId}
          disabled={busy}
          {...hook("project")}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">Choose a project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={`${kind}-profile`}>
          Agent profile
        </label>
        <select
          id={`${kind}-profile`}
          className={styles.input}
          value={profileId}
          disabled={busy}
          {...hook("profile")}
          onChange={(e) => setProfileId(e.target.value)}
        >
          <option value="">Project default</option>
          {(settings?.agentProfiles ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p className={styles.note}>
          Chat threads use this profile's or the project's permission mode,
          never a more permissive one.
        </p>
      </div>

      <div className={styles.fieldRow}>
        <button
          type="button"
          className={styles.btn}
          disabled={busy}
          {...hook("save")}
          onClick={() => void run(save)}
        >
          Save
        </button>
        {connected ? (
          <button
            type="button"
            className={styles.btn}
            disabled={busy}
            {...hook("disconnect")}
            onClick={() =>
              void run(async () => {
                setFailure(null);
                onStatus(await channelApi().disconnectChannel({ channel: kind }));
              })
            }
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={busy}
            {...hook("connect")}
            onClick={() =>
              void run(async () => {
                await save();
                try {
                  setFailure(null);
                  onStatus(await channelApi().connectChannel({ channel: kind }));
                } catch (err) {
                  setFailure({ state: "error", botUsername: null, error: message(err) });
                  throw err;
                }
              })
            }
          >
            Connect
          </button>
        )}
      </div>
      {error ? (
        <p className={styles.fieldError} role="alert" {...hook("error")}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
