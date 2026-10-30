import { useEffect, useId, useState, type ReactNode } from "react";
import { BEST_EFFORT_NOTE } from "../../modelPicker";
import { resolveCoderApi } from "../../coderApi";
import type {
  AppSettings,
  CoderApi,
  FetchedModel,
  LocalModelServer,
  ModelInfo,
  ProviderInfo,
  ProviderInstance,
  ProviderModelPrefs,
} from "../../shared/ipc";
import { parseMcpArgv } from "../../parseMcpArgv";
import { accountLine, addChatGptAccount } from "../../providerAccounts";
import base from "../SettingsModal.module.css";
import styles from "./ProvidersPane.module.css";
import type { SettingsModalProps } from "../SettingsModal";

/**
 * Settings › Providers (#1714), after Cline Desktop's provider settings: a
 * searchable list grouped Configured / Available / Custom, and a detail view
 * per provider with sign-in, typed key fields, environment and models.
 *
 * Keys are written into provider-instance env, so they are stored like every
 * other provider secret. A base provider's own env is the instance whose id
 * equals the provider id (electron/providerInstances.js BASE_ENV_PROVIDERS).
 */

type SignIn = NonNullable<SettingsModalProps["onProviderSignIn"]>;

interface KeyField {
  env: string;
  label: string;
  secret?: boolean;
  placeholder: string;
}

/** Env vars each CLI is verified to read (binary strings + vendor docs). */
const KEY_FIELDS: Record<string, KeyField[]> = {
  claude: [
    { env: "ANTHROPIC_API_KEY", label: "API key", secret: true, placeholder: "sk-ant-…" },
    { env: "ANTHROPIC_BASE_URL", label: "Base URL", placeholder: "https://api.anthropic.com" },
  ],
  // Codex has no base-URL env var (openai_base_url is config.toml only).
  codex: [{ env: "OPENAI_API_KEY", label: "API key", secret: true, placeholder: "sk-…" }],
  cursor: [{ env: "CURSOR_API_KEY", label: "API key", secret: true, placeholder: "key_…" }],
  grok: [{ env: "XAI_API_KEY", label: "API key", secret: true, placeholder: "xai-…" }],
};

const COMPAT_KEY_ENV = "SOLENTA_OPENAI_COMPAT_API_KEY";
const COMPAT_FIELDS: KeyField[] = [
  { env: COMPAT_KEY_ENV, label: "API key", secret: true, placeholder: "sk-…" },
];

const KEY_URLS: Record<string, string> = {
  claude: "https://console.anthropic.com/settings/keys",
  codex: "https://platform.openai.com/api-keys",
  cursor: "https://cursor.com/dashboard?tab=integrations",
  grok: "https://console.x.ai",
};

/** Base providers whose own env the runner applies (BASE_ENV_PROVIDERS). */
const BASE_ENV = new Set(["claude", "codex", "cursor", "grok"]);
/** Same table as electron/providerAuth.js INSTALL_COMMANDS / LOGOUT_ARGS. */
const INSTALLABLE = new Set(["claude", "codex", "cursor"]);
const LOGOUT = new Set(["claude", "codex", "cursor", "opencode"]);
const CLI_NAMES: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor-agent",
  opencode: "opencode",
  grok: "grok",
  kimi: "kimi",
  muse: "muse",
};

type AuthKind = "oauth" | "local" | "api-key";
const AUTH_KIND_LABEL: Record<AuthKind, string> = {
  oauth: "Sign in",
  local: "Local CLI",
  "api-key": "API key",
};

function baseId(p: ProviderInfo): string {
  return p.baseProvider ?? p.id;
}

function findInstanceFor(
  p: ProviderInfo,
  instances: readonly ProviderInstance[],
): ProviderInstance | null {
  const b = baseId(p);
  const id = p.instanceId ?? b;
  return instances.find((i) => i.id === id && i.provider === b) ?? null;
}

function fieldsFor(p: ProviderInfo, inst: ProviderInstance | null): KeyField[] {
  if (inst?.openaiCompatible) return COMPAT_FIELDS;
  if (p.bestEffort) return [];
  // Named instances apply their env on any provider that has them.
  if (p.instanceId || BASE_ENV.has(p.id)) return KEY_FIELDS[baseId(p)] ?? [];
  return [];
}

function hasKey(p: ProviderInfo, inst: ProviderInstance | null): boolean {
  return fieldsFor(p, inst).some((f) => f.secret && inst?.env[f.env]);
}

function isCustom(p: ProviderInfo, inst: ProviderInstance | null): boolean {
  return p.bestEffort === true || inst?.openaiCompatible != null;
}

/** Usable for runs: signed in, a key, or an installed CLI nothing says is signed out. */
function isConfigured(p: ProviderInfo, inst: ProviderInstance | null): boolean {
  if (isCustom(p, inst)) return p.available || inst?.openaiCompatible != null;
  if (!p.available) return false;
  return p.auth === "signedIn" || p.auth === "unknown" || hasKey(p, inst);
}

function authKind(p: ProviderInfo, inst: ProviderInstance | null): AuthKind {
  if (inst?.openaiCompatible) return "api-key";
  if (p.bestEffort || p.auth === "unknown") return "local";
  return "oauth";
}

/** Rows the list shows: every provider except the simulator. The local
 * servers' opencode instances live under the Local group instead. */
function listRows(providers: readonly ProviderInfo[]): ProviderInfo[] {
  return providers.filter((p) => p.id !== "simulate" && !LOCAL_REFS.has(p.id));
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function resolveApi(): CoderApi | null {
  try {
    const existing = (window as unknown as { coder?: CoderApi }).coder;
    if (existing && typeof existing.providers?.fetchModels === "function") return existing;
    const api = resolveCoderApi();
    return typeof api.providers?.fetchModels === "function" ? api : null;
  } catch {
    return null;
  }
}

type LocalKind = LocalModelServer["kind"];
type View =
  | { kind: "list" }
  | { kind: "detail"; id: string }
  | { kind: "add" }
  | { kind: "local"; id: LocalKind };

export function ProvidersPane({
  settings,
  providers,
  saving,
  setError,
  onSaveSettings,
  onRefreshProviders,
  onProviderSignIn,
}: {
  settings: AppSettings | null;
  providers: ProviderInfo[];
  saving: boolean;
  setError: (error: string | null) => void;
  onSaveSettings: SettingsModalProps["onSaveSettings"];
  onRefreshProviders?: () => void;
  onProviderSignIn?: SignIn;
}) {
  // Mounted only while this pane shows: opening it re-probes sign-in state.
  useEffect(() => {
    onRefreshProviders?.();
  }, []);
  const [view, setView] = useState<View>({ kind: "list" });
  const instances = settings?.providerInstances ?? [];
  const [local, setLocal] = useState<LocalModelServer[] | null>(null);
  const detectLocal = async (urls?: Partial<Record<LocalKind, string>>) => {
    const api = resolveApi();
    if (typeof api?.providers.detectLocal !== "function") return setLocal([]);
    // A saved instance's host (a LAN Ollama) is where its server lives.
    const saved = (kind: LocalKind) =>
      urls?.[kind] ?? localInstanceOf(instances, kind)?.openaiCompatible?.baseUrl ?? null;
    try {
      setLocal(await api.providers.detectLocal({ ollamaUrl: saved("ollama"), lmstudioUrl: saved("lmstudio") }));
    } catch {
      setLocal([]);
    }
  };
  useEffect(() => {
    void detectLocal();
  }, []);

  const persistInstances = async (next: ProviderInstance[]) => {
    setError(null);
    try {
      await onSaveSettings({ providerInstances: next });
      onRefreshProviders?.();
      return true;
    } catch (err) {
      setError(errorText(err, "Failed to save settings"));
      return false;
    }
  };

  const persistModels = async (ref: string, pref: ProviderModelPrefs) => {
    setError(null);
    const all = { ...(settings?.providerModels ?? {}) };
    if (pref.favorites.length || pref.custom.length) all[ref] = pref;
    else delete all[ref];
    try {
      await onSaveSettings({ providerModels: all });
      onRefreshProviders?.();
    } catch (err) {
      setError(errorText(err, "Failed to save settings"));
    }
  };

  const signIn = (id: string, opts?: Parameters<SignIn>[1]) => {
    if (!onProviderSignIn) return Promise.resolve();
    setError(null);
    return onProviderSignIn(id, opts).catch((err) => {
      setError(errorText(err, "Could not start sign in"));
    });
  };

  if (view.kind === "add") {
    return (
      <AddProviderView
        instances={instances}
        providers={providers}
        saving={saving || settings == null}
        setError={setError}
        persistInstances={persistInstances}
        onBack={() => {
          setError(null);
          setView({ kind: "list" });
        }}
        onAdded={(ref) => setView(ref ? { kind: "detail", id: ref } : { kind: "list" })}
        onConnectChatGpt={
          onProviderSignIn && providers.some((p) => p.id === "codex" && p.available)
            ? async () => {
                const { list, ref } = addChatGptAccount(instances);
                if (!(await persistInstances(list))) return;
                const codexName = providers.find((p) => p.id === "codex")?.name ?? "Codex";
                await signIn(ref, { name: `${codexName} (${list[list.length - 1]!.name})` });
              }
            : undefined
        }
      />
    );
  }

  if (view.kind === "local") {
    const kind = view.id;
    return (
      <LocalDetail
        kind={kind}
        server={local?.find((l) => l.kind === kind) ?? null}
        inst={localInstanceOf(instances, kind)}
        opencode={providers.find((p) => p.id === "opencode")}
        saving={saving || settings == null}
        onDetect={(url) => detectLocal({ [kind]: url })}
        onSave={(next) =>
          persistInstances(
            instances.some((i) => i.id === next.id)
              ? instances.map((i) => (i.id === next.id ? next : i))
              : [...instances, next],
          )
        }
        onOpenProvider={() => setView({ kind: "detail", id: `opencode:${kind}` })}
        onBack={() => {
          setError(null);
          setView({ kind: "list" });
        }}
      />
    );
  }

  const selected =
    view.kind === "detail" ? providers.find((p) => p.id === view.id) : undefined;
  if (selected) {
    return (
      <ProviderDetail
        key={selected.id}
        provider={selected}
        instances={instances}
        prefs={settings?.providerModels?.[selected.id] ?? { favorites: [], custom: [] }}
        saving={saving || settings == null}
        setError={setError}
        persistInstances={persistInstances}
        persistModels={(pref) => persistModels(selected.id, pref)}
        onSignIn={onProviderSignIn ? signIn : undefined}
        onBack={() => {
          setError(null);
          setView({ kind: "list" });
        }}
      />
    );
  }

  return (
    <ProviderList
      providers={listRows(providers)}
      instances={instances}
      local={local}
      onOpen={(id) => {
        setError(null);
        setView({ kind: "detail", id });
      }}
      onOpenLocal={(id) => {
        setError(null);
        setView({ kind: "local", id });
      }}
      onAdd={() => {
        setError(null);
        setView({ kind: "add" });
      }}
      addDisabled={settings == null}
      secretsUnencrypted={settings?.secretStorage?.encryption === "unavailable"}
    />
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function Chevron({ open }: { open?: boolean }) {
  return (
    <svg
      className={styles.chevron}
      data-open={open ? "true" : undefined}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function Group({
  id,
  title,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const contentId = useId();
  return (
    <div className={styles.group} data-provider-group={id}>
      <button
        type="button"
        className={styles.groupHead}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={onToggle}
      >
        <Chevron open={open} />
        {title}
      </button>
      <div id={contentId} hidden={!open} className={styles.rows}>
        {children}
      </div>
    </div>
  );
}

function ProviderList({
  providers,
  instances,
  local,
  onOpen,
  onOpenLocal,
  onAdd,
  addDisabled,
  secretsUnencrypted = false,
}: {
  providers: ProviderInfo[];
  instances: readonly ProviderInstance[];
  local: LocalModelServer[] | null;
  onOpen: (id: string) => void;
  onOpenLocal: (id: LocalKind) => void;
  onAdd: () => void;
  addDisabled: boolean;
  secretsUnencrypted?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const q = query.trim().toLowerCase();
  const shown = q
    ? providers.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
    : providers;
  const withInst = shown.map((p) => ({ p, inst: findInstanceFor(p, instances) }));
  const custom = withInst.filter(({ p, inst }) => isCustom(p, inst));
  const builtIn = withInst.filter(({ p, inst }) => !isCustom(p, inst));
  const configured = builtIn.filter(({ p, inst }) => isConfigured(p, inst));
  const available = builtIn.filter(({ p, inst }) => !isConfigured(p, inst));
  const configuredCount = providers.filter((p) => isConfigured(p, findInstanceFor(p, instances))).length;
  const localShown = LOCAL_KINDS.filter(
    (k) => !q || LOCAL_NAMES[k].toLowerCase().includes(q) || k.includes(q) || "local".includes(q),
  );
  const toggle = (id: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows = (list: typeof withInst) =>
    list.map(({ p, inst }) => (
      <button
        key={p.id}
        type="button"
        className={styles.row}
        data-provider-row={p.id}
        onClick={() => onOpen(p.id)}
      >
        <span className={styles.rowName}>{p.name}</span>
        <span className={styles.rowHint} data-auth-state={isConfigured(p, inst) ? "configured" : authKind(p, inst)}>
          {isConfigured(p, inst)
            ? "Configured"
            : !p.available && !isCustom(p, inst)
              ? "Not installed"
              : AUTH_KIND_LABEL[authKind(p, inst)]}
        </span>
        <Chevron />
      </button>
    ));

  return (
    <section className={base.section} data-providers-list="">
      <div className={styles.listHead}>
        <p className={styles.count} data-provider-count="">
          {configuredCount === 0
            ? "Connect a provider to start using models."
            : `${configuredCount} configured · ${providers.length - configuredCount} available`}
        </p>
        <button
          type="button"
          className={`${base.btn} ${base.btnPrimary}`}
          data-add-provider=""
          disabled={addDisabled}
          onClick={onAdd}
        >
          + Add provider
        </button>
      </div>
      {secretsUnencrypted ? (
        <p className={base.note} role="alert" data-secrets-unencrypted="">
          Secrets are stored unencrypted on this machine.
        </p>
      ) : null}
      <input
        className={base.input}
        type="search"
        placeholder="Search providers"
        aria-label="Search providers"
        data-provider-search=""
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setCollapsed(new Set());
        }}
      />
      {shown.length === 0 && localShown.length === 0 && (
        <p className={base.note}>No providers match &quot;{query.trim()}&quot;.</p>
      )}
      {configured.length > 0 && (
        <Group id="configured" title="Configured" open={!collapsed.has("configured")} onToggle={() => toggle("configured")}>
          {rows(configured)}
        </Group>
      )}
      {available.length > 0 && (
        <Group id="available" title="Available" open={!collapsed.has("available")} onToggle={() => toggle("available")}>
          {rows(available)}
        </Group>
      )}
      {localShown.length > 0 && (
        <Group id="local" title="Local" open={!collapsed.has("local")} onToggle={() => toggle("local")}>
          {localShown.map((k) => {
            const server = local?.find((l) => l.kind === k);
            return (
              <button key={k} type="button" className={styles.row} data-local-row={k} onClick={() => onOpenLocal(k)}>
                <span className={styles.rowName}>{LOCAL_NAMES[k]}</span>
                <span className={styles.rowHint} data-local-state={server ? (server.running ? "running" : "stopped") : "checking"}>
                  {localStatus(server)}
                </span>
                <Chevron />
              </button>
            );
          })}
        </Group>
      )}
      {custom.length > 0 && (
        <Group id="custom" title="Custom" open={!collapsed.has("custom")} onToggle={() => toggle("custom")}>
          {rows(custom)}
        </Group>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

/** Env with `patch` applied; null or "" removes a key. */
function patchEnv(env: Record<string, string>, patch: Record<string, string | null>) {
  const next = { ...env };
  for (const [k, v] of Object.entries(patch)) {
    if (v) next[k] = v;
    else delete next[k];
  }
  return next;
}

/**
 * The instance list with `ref`'s env patched. A base provider's env is the
 * overlay instance (id === provider), created on first key and dropped when
 * its env empties.
 */
function withEnv(
  instances: readonly ProviderInstance[],
  p: ProviderInfo,
  patch: Record<string, string | null>,
): ProviderInstance[] {
  const current = findInstanceFor(p, instances);
  if (current) {
    const env = patchEnv(current.env, patch);
    if (!p.instanceId && Object.keys(env).length === 0 && !(current.extraArgs ?? []).length) {
      return instances.filter((i) => i !== current);
    }
    return instances.map((i) => (i === current ? { ...i, env } : i));
  }
  const env = patchEnv({}, patch);
  if (Object.keys(env).length === 0) return [...instances];
  return [...instances, { id: p.id, name: p.name.slice(0, 40), provider: p.id, configDir: null, env }];
}

/**
 * Extra launch arguments (#1780) with a base provider's overlay instance
 * patched. Same overlay lifecycle as withEnv: created on first non-empty
 * value, dropped when both env and extraArgs are empty.
 */
function withExtraArgs(
  instances: readonly ProviderInstance[],
  p: ProviderInfo,
  extraArgs: string[],
): ProviderInstance[] {
  const current = findInstanceFor(p, instances);
  if (current) {
    if (!p.instanceId && extraArgs.length === 0 && Object.keys(current.env).length === 0) {
      return instances.filter((i) => i !== current);
    }
    return instances.map((i) => (i === current ? { ...i, extraArgs } : i));
  }
  if (extraArgs.length === 0) return [...instances];
  return [
    ...instances,
    { id: p.id, name: p.name.slice(0, 40), provider: p.id, configDir: null, env: {}, extraArgs },
  ];
}

function SecretField({
  field,
  value,
  disabled,
  keyUrl,
  providerName,
  onCommit,
}: {
  field: KeyField;
  value: string;
  disabled: boolean;
  keyUrl?: string;
  providerName: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const id = useId();
  return (
    <div className={styles.keyField}>
      <div className={styles.keyFieldHead}>
        <label className={base.fieldLabel} htmlFor={id}>
          {field.label}
          <span className={styles.envName}>{field.env}</span>
        </label>
        {field.secret && keyUrl && (
          <a className={styles.link} href={keyUrl} target="_blank" rel="noreferrer" data-key-link="">
            Get a {providerName} API key ↗
          </a>
        )}
      </div>
      <div className={styles.inputFrame}>
        <input
          id={id}
          className={`${styles.frameInput} ${base.monoInput}`}
          data-provider-field={field.env}
          type={field.secret && !shown ? "password" : field.secret ? "text" : "url"}
          value={draft}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          placeholder={field.placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim() !== value) onCommit(draft.trim());
          }}
        />
        {field.secret && (
          <>
            <button
              type="button"
              className={styles.iconBtn}
              data-secret-toggle=""
              aria-label={shown ? `Hide ${field.label}` : `Show ${field.label}`}
              title={shown ? "Hide" : "Show"}
              onClick={() => setShown((s) => !s)}
            >
              {shown ? "Hide" : "Show"}
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              data-secret-copy=""
              aria-label={`Copy ${field.label}`}
              disabled={!draft}
              onClick={() =>
                void navigator.clipboard?.writeText(draft).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ProviderDetail({
  provider: p,
  instances,
  prefs,
  saving,
  setError,
  persistInstances,
  persistModels,
  onSignIn,
  onBack,
}: {
  provider: ProviderInfo;
  instances: readonly ProviderInstance[];
  prefs: ProviderModelPrefs;
  saving: boolean;
  setError: (error: string | null) => void;
  persistInstances: (next: ProviderInstance[]) => Promise<boolean>;
  persistModels: (pref: ProviderModelPrefs) => Promise<void>;
  onSignIn?: (id: string, opts?: Parameters<SignIn>[1]) => Promise<void>;
  onBack: () => void;
}) {
  const inst = findInstanceFor(p, instances);
  const b = baseId(p);
  const fields = fieldsFor(p, inst);
  const keyed = hasKey(p, inst);
  const configured = isConfigured(p, inst);
  const [keyOpen, setKeyOpen] = useState(keyed);
  const [pending, setPending] = useState(false);
  const [instanceDraft, setInstanceDraft] = useState<InstanceDraft | null>(null);

  const commit = (env: string, value: string) =>
    void persistInstances(withEnv(instances, p, { [env]: value || null }));
  const disconnect = () =>
    void persistInstances(withEnv(instances, p, Object.fromEntries(fields.map((f) => [f.env, null]))));
  const run = (opts?: Parameters<SignIn>[1]) => {
    if (!onSignIn) return;
    setPending(true);
    void onSignIn(p.id, opts).finally(() => setPending(false));
  };

  const custom = isCustom(p, inst);
  const canLogout = p.auth === "signedIn" && LOGOUT.has(b) && onSignIn != null;

  const authCard = custom ? (
    p.bestEffort ? (
      <div className={styles.card} data-auth-card="custom-cli">
        <p className={styles.cardTitle}>{p.available ? "Custom CLI" : "Command not found"}</p>
        <p className={base.note} data-auth-state="bestEffort">
          {BEST_EFFORT_NOTE}
        </p>
      </div>
    ) : (
      <div className={styles.card} data-auth-card="compat">
        <p className={styles.cardTitle}>OpenAI-compatible, run through OpenCode</p>
        <p className={base.note}>{inst?.openaiCompatible?.baseUrl}</p>
      </div>
    )
  ) : !p.available ? (
    <div className={styles.card} data-auth-card="missing">
      <p className={styles.cardTitle}>{p.name} is not installed</p>
      <p className={base.note}>
        {INSTALLABLE.has(b)
          ? "Install types the install command into a terminal for you to review."
          : `Install the ${CLI_NAMES[b] ?? b} CLI, then reopen this page.`}
      </p>
      {INSTALLABLE.has(b) && onSignIn && (
        <div className={base.fieldRow}>
          <button
            type="button"
            className={`${base.btn} ${base.btnPrimary}`}
            data-provider-install={p.id}
            disabled={pending}
            onClick={() => run({ install: true })}
          >
            Install
          </button>
        </div>
      )}
    </div>
  ) : p.auth === "signedIn" ? (
    <div className={styles.card} data-auth-card="signed-in">
      <p className={styles.cardTitle}>Signed in via {CLI_NAMES[b] ?? b}</p>
      <p className={base.note} data-auth-state="signedIn">
        {accountLine(p) ?? "The CLI reports a signed-in account."}
      </p>
    </div>
  ) : keyed ? (
    <div className={styles.card} data-auth-card="api-key">
      <p className={styles.cardTitle}>Using an API key</p>
      <p className={base.note}>Runs of {p.name} on this machine authenticate with the key below.</p>
    </div>
  ) : (
    <div className={styles.card} data-auth-card="sign-in">
      <p className={styles.cardTitle}>
        {p.auth === "unknown" ? "Uses your local CLI sign-in" : `Sign in to ${p.name}`}
      </p>
      <p className={base.note} data-auth-state={p.auth ?? "checking"}>
        {p.auth === "unknown"
          ? `${CLI_NAMES[b] ?? b} has no status command, so Solenta cannot tell whether it is signed in.`
          : p.auth == null
            ? "Checking sign-in…"
            : "Opens a terminal with the CLI's own login command."}
      </p>
      {onSignIn && p.auth != null && (
        <div className={base.fieldRow}>
          <button
            type="button"
            className={`${base.btn} ${base.btnPrimary}`}
            data-provider-signin={p.id}
            disabled={pending}
            onClick={() => run()}
          >
            Sign in
          </button>
        </div>
      )}
    </div>
  );

  return (
    <section className={base.section} data-provider-detail={p.id}>
      <div className={styles.detailHead}>
        <button type="button" className={styles.back} data-provider-back="" aria-label="Back to providers" onClick={onBack}>
          ←
        </button>
        <h4 className={styles.detailTitle}>{p.name}</h4>
        <span className={styles.badge} data-provider-badge="" data-on={configured ? "true" : undefined}>
          {configured ? "Configured" : "Not configured"}
        </span>
        <span className={styles.spacer} />
        {keyed && (
          <button type="button" className={base.btn} data-provider-disconnect="" disabled={saving} onClick={disconnect}>
            Disconnect
          </button>
        )}
        {!keyed && canLogout && (
          <button
            type="button"
            className={base.btn}
            data-provider-signout=""
            title="Types the CLI's logout command into a terminal"
            disabled={pending}
            onClick={() => run({ logout: true })}
          >
            Sign out
          </button>
        )}
      </div>

      {authCard}

      {fields.length > 0 && (
        <div className={styles.keys}>
          {!keyed && !custom ? (
            <button
              type="button"
              className={styles.disclosure}
              aria-expanded={keyOpen}
              data-use-api-key=""
              onClick={() => setKeyOpen((o) => !o)}
            >
              <Chevron open={keyOpen} />
              Use an API key instead
            </button>
          ) : null}
          {(keyed || custom || keyOpen) &&
            fields.map((f) => (
              <SecretField
                key={f.env}
                field={f}
                value={inst?.env[f.env] ?? ""}
                disabled={saving}
                keyUrl={KEY_URLS[b]}
                providerName={p.name.replace(/ Code$/, "")}
                onCommit={(v) => commit(f.env, v)}
              />
            ))}
          {(keyed || custom || keyOpen) && (
            <p className={base.note}>
              Saved when a field loses focus, and stored like other provider keys.
              {p.instanceId || custom ? "" : " Applies to local runs only."}
            </p>
          )}
        </div>
      )}

      {p.instanceId && inst ? (
        <InstanceSection
          provider={p}
          inst={inst}
          instances={instances}
          draft={instanceDraft}
          setDraft={setInstanceDraft}
          saving={saving}
          setError={setError}
          persistInstances={persistInstances}
          onDeleted={onBack}
        />
      ) : !custom && BASE_ENV.has(p.id) ? (
        <EnvSection
          env={inst?.env ?? {}}
          hidden={fields.map((f) => f.env)}
          saving={saving}
          setError={setError}
          onSave={(env) => {
            const keep = Object.fromEntries(
              fields.flatMap((f) => (inst?.env[f.env] ? [[f.env, inst.env[f.env]!]] : [])),
            );
            const cleared = Object.fromEntries(Object.keys(inst?.env ?? {}).map((k) => [k, null]));
            return persistInstances(withEnv(instances, p, { ...cleared, ...keep, ...env }));
          }}
        />
      ) : null}

      {!custom && BASE_ENV.has(p.id) && (
        <ExtraArgsSection
          extraArgs={inst?.extraArgs ?? []}
          saving={saving}
          setError={setError}
          onSave={(extraArgs) => persistInstances(withExtraArgs(instances, p, extraArgs))}
        />
      )}

      {!p.bestEffort && (
        <ModelsPanel
          provider={p}
          prefs={prefs}
          canFetch={inst?.openaiCompatible != null || keyed}
          saving={saving}
          persistModels={persistModels}
        />
      )}
    </section>
  );
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Arbitrary env rows for a base provider; the typed fields are left out. */
function EnvSection({
  env,
  hidden,
  saving,
  setError,
  onSave,
}: {
  env: Record<string, string>;
  hidden: string[];
  saving: boolean;
  setError: (error: string | null) => void;
  onSave: (env: Record<string, string>) => Promise<boolean>;
}) {
  const initial = () =>
    Object.entries(env)
      .filter(([k]) => !hidden.includes(k))
      .map(([key, value]) => ({ key, value }));
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(initial);
  const count = initial().length;
  return (
    <div className={styles.keys} data-provider-env="">
      <button
        type="button"
        className={styles.disclosure}
        aria-expanded={open}
        onClick={() => {
          setRows(initial());
          setOpen((o) => !o);
        }}
      >
        <Chevron open={open} />
        Environment{count > 0 ? ` (${count})` : ""}
      </button>
      {open && (
        <>
          {rows.map((row, i) => (
            <div key={i} className={base.fieldRow} data-provider-env-row="">
              <input
                className={`${base.input} ${base.monoInput}`}
                aria-label="Variable name"
                value={row.key}
                disabled={saving}
                autoComplete="off"
                spellCheck={false}
                placeholder="HTTPS_PROXY"
                onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
              />
              <input
                className={`${base.input} ${base.monoInput}`}
                aria-label={`Value of ${row.key || "variable"}`}
                type="password"
                value={row.value}
                disabled={saving}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
              />
              <button
                type="button"
                className={base.btn}
                aria-label={`Remove ${row.key || "variable"}`}
                disabled={saving}
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          <div className={base.fieldRow}>
            <button
              type="button"
              className={base.btn}
              disabled={saving}
              onClick={() => setRows([...rows, { key: "", value: "" }])}
            >
              Add variable
            </button>
            <button
              type="button"
              className={`${base.btn} ${base.btnPrimary}`}
              data-provider-env-save=""
              disabled={saving}
              onClick={() => {
                const out: Record<string, string> = {};
                for (const r of rows) {
                  const key = r.key.trim();
                  if (!key) continue;
                  if (!ENV_KEY_RE.test(key)) {
                    setError(`"${key}" is not a valid variable name`);
                    return;
                  }
                  out[key] = r.value;
                }
                void onSave(out);
              }}
            >
              Save environment
            </button>
          </div>
          <p className={base.note}>
            Extra variables for this CLI&apos;s local runs. Values are stored like other provider
            keys and never logged.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Extra launch arguments (#1780) for a base provider with no named
 * instance picked: a single argv-text field, saved through the same
 * overlay instance (id === provider) as EnvSection's env.
 */
function ExtraArgsSection({
  extraArgs,
  saving,
  setError,
  onSave,
}: {
  extraArgs: readonly string[];
  saving: boolean;
  setError: (error: string | null) => void;
  onSave: (extraArgs: string[]) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(extraArgs.length > 0);
  const [draft, setDraft] = useState(() => argvText(extraArgs));
  return (
    <div className={styles.keys} data-provider-extra-args="">
      <button
        type="button"
        className={styles.disclosure}
        aria-expanded={open}
        onClick={() => {
          setDraft(argvText(extraArgs));
          setOpen((o) => !o);
        }}
      >
        <Chevron open={open} />
        Extra launch arguments{extraArgs.length > 0 ? ` (${extraArgs.length})` : ""}
      </button>
      {open && (
        <>
          <input
            className={`${base.input} ${base.monoInput}`}
            aria-label="Extra launch arguments"
            value={draft}
            disabled={saving}
            autoComplete="off"
            spellCheck={false}
            placeholder="--add-dir ../shared"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className={base.fieldRow}>
            <button
              type="button"
              className={`${base.btn} ${base.btnPrimary}`}
              data-provider-extra-args-save=""
              disabled={saving}
              onClick={() => {
                const parsed = parseMcpArgv(draft);
                if (!parsed.ok) return setError(parsed.error);
                void onSave(parsed.args);
              }}
            >
              Save
            </button>
          </div>
          <p className={base.note}>
            Appended to every launch, e.g. --add-dir ../shared. Flags the app
            controls itself (output format, resume, session id) are rejected.
          </p>
        </>
      )}
    </div>
  );
}

function ModelGlyph({ title, children }: { title: string; children: ReactNode }) {
  return (
    <span className={styles.cap} role="img" aria-label={title} title={title}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </span>
  );
}

function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}

function ModelsPanel({
  provider: p,
  prefs,
  canFetch,
  saving,
  persistModels,
}: {
  provider: ProviderInfo;
  prefs: ProviderModelPrefs;
  canFetch: boolean;
  saving: boolean;
  persistModels: (pref: ProviderModelPrefs) => Promise<void>;
}) {
  const [live, setLive] = useState<FetchedModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setFetchError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // A compat provider addresses models as `<id>/<model>`; the live list does not.
  const prefix = p.baseProvider === "opencode" && p.instanceId ? `${p.instanceId}/` : "";
  const catalog: ModelInfo[] = p.modelInfo.length
    ? p.modelInfo
    : p.models.map((id) => ({ id, label: id, description: "", vendor: "" }));
  const rows: ModelInfo[] = live
    ? [
        ...live.map((m) => ({
          id: prefix + m.id,
          label: m.label,
          description: "",
          vendor: "",
          ...(m.contextTokens ? { contextTokens: m.contextTokens } : {}),
          ...(catalog.find((c) => c.id === prefix + m.id) ?? {}),
        })),
        ...catalog.filter((c) => prefs.custom.includes(c.id) && !live.some((m) => prefix + m.id === c.id)),
      ]
    : catalog;
  const fav = new Set(prefs.favorites);
  const q = query.trim().toLowerCase();
  const shown = rows
    .filter((m) => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
    .sort((a, b) => Number(fav.has(b.id)) - Number(fav.has(a.id)));

  const refresh = async () => {
    setFetchError(null);
    if (!canFetch) {
      setLive(null);
      setFetchError("Add an API key to list models live. Showing the catalog.");
      return;
    }
    const api = resolveApi();
    if (!api) return;
    setLoading(true);
    try {
      setLive(await api.providers.fetchModels({ provider: p.id }));
    } catch (err) {
      setFetchError(errorText(err, "Could not list models"));
    } finally {
      setLoading(false);
    }
  };

  const toggleFav = (id: string) =>
    void persistModels({
      ...prefs,
      favorites: fav.has(id) ? prefs.favorites.filter((f) => f !== id) : [...prefs.favorites, id],
    });

  const addModel = () => {
    const raw = (adding ?? "").trim();
    if (!raw) return;
    const id = prefix && !raw.startsWith(prefix) ? prefix + raw : raw;
    setAdding(null);
    if (prefs.custom.includes(id) || catalog.some((m) => m.id === id)) return;
    void persistModels({ ...prefs, custom: [...prefs.custom, id] });
  };

  return (
    <div className={styles.models} data-models="">
      <div className={styles.modelsHead}>
        <span className={styles.modelsTitle}>Models</span>
        <button
          type="button"
          className={styles.iconBtn}
          data-models-refresh=""
          aria-label="Refresh models"
          title={canFetch ? "List models from the provider's API" : "Needs an API key"}
          disabled={loading}
          onClick={() => void refresh()}
        >
          <svg className={loading ? styles.spin : undefined} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" />
          </svg>
        </button>
        <span className={styles.modelsSource}>{live ? "Live from the API" : "Catalog"}</span>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.iconBtn}
          data-model-add=""
          aria-label="Add model"
          title="Add a model id"
          disabled={saving}
          onClick={() => setAdding("")}
        >
          +
        </button>
      </div>
      {adding != null && (
        <div className={styles.modelsAdd}>
          <input
            className={`${base.input} ${base.monoInput}`}
            data-model-add-input=""
            aria-label="New model ID"
            autoFocus
            placeholder="Model ID"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addModel();
              if (e.key === "Escape") {
                e.stopPropagation();
                setAdding(null);
              }
            }}
          />
          <button type="button" className={`${base.btn} ${base.btnPrimary}`} disabled={!adding.trim()} onClick={addModel}>
            Add
          </button>
          <button type="button" className={base.btn} onClick={() => setAdding(null)}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p className={styles.modelsError} role="status" data-models-error="">
          {error}
        </p>
      )}
      {rows.length > 0 && (
        <div className={styles.modelsSearch}>
          <input
            className={base.input}
            type="search"
            data-models-search=""
            aria-label="Search models"
            placeholder="Search models by name or ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      <div className={styles.modelList}>
        {rows.length === 0 ? (
          <p className={styles.modelsEmpty}>
            {loading ? "Loading models…" : "No models listed. Refresh, or add a model id with +."}
          </p>
        ) : shown.length === 0 ? (
          <p className={styles.modelsEmpty}>No models match &quot;{query.trim()}&quot;.</p>
        ) : (
          shown.map((m) => (
            <div key={m.id} className={styles.modelRow} data-model-row={m.id}>
              <div className={styles.modelMain}>
                <div className={styles.modelName}>
                  <span className={styles.modelLabel}>{m.label}</span>
                  {prefs.custom.includes(m.id) && <span className={styles.tag}>Custom</span>}
                  {m.recommended && <span className={styles.tag}>Recommended</span>}
                  {m.inputModalities?.includes("image") && (
                    <ModelGlyph title="Image input">
                      <rect x="3" y="4" width="18" height="16" rx="2" />
                      <circle cx="9" cy="10" r="2" />
                      <path d="m21 16-5-5-9 9" />
                    </ModelGlyph>
                  )}
                  {(m.efforts?.length ?? 0) > 0 && (
                    <ModelGlyph title={`Reasoning effort: ${m.efforts!.join(", ")}`}>
                      <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3Z" />
                    </ModelGlyph>
                  )}
                  {m.contextTokens ? (
                    <span className={styles.ctx} title="Context window">
                      {formatTokens(m.contextTokens)}
                    </span>
                  ) : null}
                </div>
                {m.description && <p className={styles.modelDesc}>{m.description}</p>}
                <button
                  type="button"
                  className={styles.modelId}
                  data-model-copy={m.id}
                  title="Copy model ID"
                  onClick={() =>
                    void navigator.clipboard?.writeText(m.id).then(() => {
                      setCopied(m.id);
                      setTimeout(() => setCopied((c) => (c === m.id ? null : c)), 1500);
                    })
                  }
                >
                  {m.id}
                  <span className={styles.copied}>{copied === m.id ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <button
                type="button"
                className={styles.star}
                data-model-fav={m.id}
                data-on={fav.has(m.id) ? "true" : undefined}
                aria-pressed={fav.has(m.id)}
                aria-label={fav.has(m.id) ? `Unfavourite ${m.label}` : `Favourite ${m.label}`}
                disabled={saving}
                onClick={() => toggleFav(m.id)}
              >
                {fav.has(m.id) ? "★" : "☆"}
              </button>
              {prefs.custom.includes(m.id) && (
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={`Remove ${m.id}`}
                  data-model-remove={m.id}
                  disabled={saving}
                  onClick={() =>
                    void persistModels({
                      favorites: prefs.favorites.filter((f) => f !== m.id),
                      custom: prefs.custom.filter((c) => c !== m.id),
                    })
                  }
                >
                  ×
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Named instances and custom CLIs (moved from Agents, #453 / #458)
// ---------------------------------------------------------------------------

/** CLIs that take a separate config folder per instance (#453). */
const INSTANCE_PROVIDERS: Record<string, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

interface InstanceDraft {
  id: string | null;
  name: string;
  provider: string;
  configDir: string;
  env: Array<{ key: string; value: string }>;
  /** generic (#458): argv text, parsed by parseMcpArgv on submit. */
  command: string;
  fullAccess: string;
  cwd: string;
  transcript: NonNullable<ProviderInstance["transcript"]>;
  /** Extra launch arguments (#1780): argv text, parsed by parseMcpArgv on submit. */
  extraArgs: string;
}

function emptyInstanceDraft(providers: readonly ProviderInfo[], provider?: string): InstanceDraft {
  const fallback =
    providers.find((p) => p.available && !p.instanceId && p.id in INSTANCE_PROVIDERS)?.id ??
    "claude";
  return {
    id: null,
    name: "",
    provider: provider ?? fallback,
    configDir: "",
    env: [],
    command: "",
    fullAccess: "",
    cwd: "",
    transcript: "stdout",
    extraArgs: "",
  };
}

/** argv back to text parseMcpArgv reads the same way; JSON when quoting matters. */
function argvText(argv: readonly string[] | undefined): string {
  const list = argv ?? [];
  return list.every((a) => /^[^\s'"\\]+$/.test(a)) ? list.join(" ") : JSON.stringify(list);
}

function draftFromInstance(inst: ProviderInstance): InstanceDraft {
  return {
    id: inst.id,
    name: inst.name,
    provider: inst.provider,
    configDir: inst.configDir ?? "",
    env: Object.entries(inst.env).map(([key, value]) => ({ key, value })),
    command: argvText(inst.command),
    fullAccess: argvText(inst.fullAccessArgs),
    cwd: inst.cwd ?? "",
    transcript: inst.transcript ?? "stdout",
    extraArgs: argvText(inst.extraArgs),
  };
}

/** Draft to instance, or an error message. */
function instanceFromDraft(draft: InstanceDraft, prev?: ProviderInstance): ProviderInstance | string {
  const name = draft.name.trim();
  if (!name) return "Name is required";
  const env: Record<string, string> = {};
  for (const row of draft.env) {
    const key = row.key.trim();
    if (!key) continue;
    if (!ENV_KEY_RE.test(key)) return `"${key}" is not a valid variable name`;
    env[key] = row.value;
  }
  const extraArgs = parseMcpArgv(draft.extraArgs);
  if (!extraArgs.ok) return extraArgs.error;
  const next: ProviderInstance = {
    ...(prev?.openaiCompatible ? { openaiCompatible: prev.openaiCompatible } : {}),
    id: draft.id ?? crypto.randomUUID().slice(0, 8),
    name,
    provider: draft.provider,
    configDir: draft.configDir.trim() || null,
    env,
    extraArgs: extraArgs.args,
  };
  if (draft.provider === "generic") {
    const command = parseMcpArgv(draft.command);
    const fullAccess = parseMcpArgv(draft.fullAccess);
    if (!command.ok || !fullAccess.ok) {
      return !command.ok ? command.error : (fullAccess as { error: string }).error;
    }
    if (command.args.length === 0) return "Command is required";
    next.configDir = null;
    next.command = command.args;
    next.fullAccessArgs = fullAccess.args;
    next.cwd = draft.cwd.trim() || null;
    next.transcript = draft.transcript;
  }
  return next;
}

function InstanceSection({
  provider: p,
  inst,
  instances,
  draft,
  setDraft,
  saving,
  setError,
  persistInstances,
  onDeleted,
}: {
  provider: ProviderInfo;
  inst: ProviderInstance;
  instances: readonly ProviderInstance[];
  draft: InstanceDraft | null;
  setDraft: (d: InstanceDraft | null) => void;
  saving: boolean;
  setError: (error: string | null) => void;
  persistInstances: (next: ProviderInstance[]) => Promise<boolean>;
  onDeleted: () => void;
}) {
  const label = inst.provider === "generic" ? "Custom CLI" : inst.openaiCompatible ? "Provider" : "Instance";
  return (
    <div className={styles.keys} data-provider-instance={inst.id}>
      <span className={base.sectionLabel}>{label}</span>
      <p className={base.note}>
        {inst.provider === "generic"
          ? (inst.command ?? []).join(" ")
          : inst.openaiCompatible
            ? `${inst.openaiCompatible.models.length} configured model${inst.openaiCompatible.models.length === 1 ? "" : "s"}${inst.openaiCompatible.modelsUrl ? ` · lists from ${inst.openaiCompatible.modelsUrl}` : ""}`
            : `${INSTANCE_PROVIDERS[inst.provider] ?? "Config folder"}: ${inst.configDir ?? "the CLI's usual folder"}`}
      </p>
      {draft ? (
        <InstanceForm
          draft={draft}
          providers={[p]}
          saving={saving}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null);
            setError(null);
          }}
          onSubmit={() => {
            const next = instanceFromDraft(draft, inst);
            if (typeof next === "string") return setError(next);
            void persistInstances(instances.map((i) => (i.id === inst.id ? next : i))).then(
              (ok) => ok && setDraft(null),
            );
          }}
        />
      ) : (
        <div className={base.fieldRow}>
          {!inst.openaiCompatible && (
            <button
              type="button"
              className={base.btn}
              data-instance-edit={inst.id}
              disabled={saving}
              onClick={() => {
                setError(null);
                setDraft(draftFromInstance(inst));
              }}
            >
              Edit
            </button>
          )}
          <button
            type="button"
            className={base.btn}
            data-instance-delete={inst.id}
            disabled={saving}
            onClick={() => {
              void persistInstances(instances.filter((i) => i.id !== inst.id)).then(
                (ok) => ok && onDeleted(),
              );
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/** Add or edit a named provider instance (#453). */
function InstanceForm({
  draft,
  providers,
  saving,
  onChange,
  onCancel,
  onSubmit,
  lockProvider,
}: {
  draft: InstanceDraft;
  providers: ProviderInfo[];
  saving: boolean;
  onChange: (draft: InstanceDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
  lockProvider?: boolean;
}) {
  const bases = providers.filter((p) => !p.instanceId && p.id in INSTANCE_PROVIDERS);
  const dirVar = INSTANCE_PROVIDERS[draft.provider] ?? "config folder";
  const generic = draft.provider === "generic";
  const setRow = (i: number, patch: Partial<{ key: string; value: string }>) =>
    onChange({
      ...draft,
      env: draft.env.map((row, j) => (j === i ? { ...row, ...patch } : row)),
    });
  return (
    <div className={base.section} data-instance-form="">
      {draft.id == null && !lockProvider && (
        <div className={base.field}>
          <label className={base.fieldLabel} htmlFor="instance-provider">
            Provider
          </label>
          <select
            id="instance-provider"
            className={base.input}
            value={draft.provider}
            disabled={saving}
            onChange={(e) => onChange({ ...draft, provider: e.target.value })}
          >
            {bases.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {!p.available ? " (not installed)" : ""}
              </option>
            ))}
            <option value="generic">Custom CLI (best effort)</option>
          </select>
        </div>
      )}
      <div className={base.field}>
        <label className={base.fieldLabel} htmlFor="instance-name">
          Name
        </label>
        <input
          id="instance-name"
          className={base.input}
          value={draft.name}
          maxLength={40}
          disabled={saving}
          autoComplete="off"
          placeholder={generic ? "Goose" : "work"}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </div>
      {generic ? (
        <>
          <div className={base.field}>
            <label className={base.fieldLabel} htmlFor="instance-command">
              Command
            </label>
            <input
              id="instance-command"
              className={base.input}
              value={draft.command}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              placeholder="goose run -t"
              onChange={(e) => onChange({ ...draft, command: e.target.value })}
            />
            <p className={base.note}>
              Runs in the thread&apos;s worktree with the prompt appended as the
              last argument. Its plain output becomes the reply: no work log,
              usage or resume, and each turn starts a new process. Put keys in
              Environment, not here.
            </p>
          </div>
          <div className={base.field}>
            <label className={base.fieldLabel} htmlFor="instance-full-access">
              Full access flags
            </label>
            <input
              id="instance-full-access"
              className={base.input}
              value={draft.fullAccess}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              placeholder="--yolo"
              onChange={(e) => onChange({ ...draft, fullAccess: e.target.value })}
            />
            <p className={base.note}>
              Added when the thread is set to Full access. Empty leaves
              permissions to the CLI and hides the permission picker.
            </p>
          </div>
          <div className={base.field}>
            <label className={base.fieldLabel} htmlFor="instance-cwd">
              Working folder
            </label>
            <input
              id="instance-cwd"
              className={base.input}
              value={draft.cwd}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              placeholder="packages/app"
              onChange={(e) => onChange({ ...draft, cwd: e.target.value })}
            />
            <p className={base.note}>
              A relative path is inside the thread&apos;s worktree. Empty runs
              in the worktree itself.
            </p>
          </div>
          <div className={base.field}>
            <label className={base.fieldLabel} htmlFor="instance-transcript">
              Output
            </label>
            <select
              id="instance-transcript"
              className={base.input}
              value={draft.transcript}
              disabled={saving}
              onChange={(e) =>
                onChange({ ...draft, transcript: e.target.value as InstanceDraft["transcript"] })
              }
            >
              <option value="stdout">Plain output (pipes)</option>
              <option value="pty">Terminal (PTY)</option>
              <option value="acp">Agent Client Protocol (ACP)</option>
            </select>
            <p className={base.note}>
              Terminal is for CLIs that hold output or refuse to run without
              one. Colours and spinner redraws are stripped, and errors
              appear in the reply. ACP is for agents that speak the Agent
              Client Protocol over stdio, like goose acp: tool calls show as
              steps, Default asks before each one, and an agent that can
              reload its session resumes it.
            </p>
          </div>
        </>
      ) : draft.provider in INSTANCE_PROVIDERS ? (
        <div className={base.field}>
          <label className={base.fieldLabel} htmlFor="instance-dir">
            Config folder
          </label>
          <input
            id="instance-dir"
            className={base.input}
            value={draft.configDir}
            disabled={saving}
            autoComplete="off"
            spellCheck={false}
            placeholder={draft.provider === "codex" ? "~/.codex-work" : "~/.claude-work"}
            onChange={(e) => onChange({ ...draft, configDir: e.target.value })}
          />
          <p className={base.note}>
            Sets {dirVar} for this instance, so it keeps its own sign-in,
            settings and sessions. Empty uses the CLI&apos;s usual folder.
          </p>
        </div>
      ) : null}
      {!generic && (
        <div className={base.field}>
          <label className={base.fieldLabel} htmlFor="instance-extra-args">
            Extra launch arguments
          </label>
          <input
            id="instance-extra-args"
            className={base.input}
            value={draft.extraArgs}
            disabled={saving}
            autoComplete="off"
            spellCheck={false}
            placeholder="--add-dir ../shared"
            onChange={(e) => onChange({ ...draft, extraArgs: e.target.value })}
          />
          <p className={base.note}>
            Appended to every launch, e.g. --add-dir ../shared. Flags the app
            controls itself (output format, resume, session id) are rejected.
          </p>
        </div>
      )}
      <div className={base.field}>
        <span className={base.fieldLabel}>Environment</span>
        {draft.env.map((row, i) => (
          <div key={i} className={base.fieldRow} data-instance-env-row="">
            <input
              className={base.input}
              aria-label="Variable name"
              value={row.key}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              placeholder="ANTHROPIC_BASE_URL"
              onChange={(e) => setRow(i, { key: e.target.value })}
            />
            <input
              className={base.input}
              aria-label={`Value of ${row.key || "variable"}`}
              type="password"
              value={row.value}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setRow(i, { value: e.target.value })}
            />
            <button
              type="button"
              className={base.btn}
              aria-label={`Remove ${row.key || "variable"}`}
              disabled={saving}
              onClick={() => onChange({ ...draft, env: draft.env.filter((_, j) => j !== i) })}
            >
              Remove
            </button>
          </div>
        ))}
        <div className={base.fieldRow}>
          <button
            type="button"
            className={base.btn}
            data-instance-add-env=""
            disabled={saving}
            onClick={() => onChange({ ...draft, env: [...draft.env, { key: "", value: "" }] })}
          >
            Add variable
          </button>
        </div>
        <p className={base.note}>
          Applies only to this instance&apos;s runs. Values are stored like
          other provider keys and never logged.
        </p>
      </div>
      <div className={base.fieldRow}>
        <button
          type="button"
          className={`${base.btn} ${base.btnPrimary}`}
          disabled={saving}
          onClick={onSubmit}
        >
          {draft.id ? "Update" : "Add"}
        </button>
        <button type="button" className={base.btn} disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local models (#1717): Ollama and LM Studio as OpenAI-compatible instances
// ---------------------------------------------------------------------------

const LOCAL_KINDS: LocalKind[] = ["ollama", "lmstudio"];
const LOCAL_NAMES: Record<LocalKind, string> = { ollama: "Ollama", lmstudio: "LM Studio" };
const LOCAL_DEFAULTS: Record<LocalKind, string> = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234",
};
/** Picker refs of the instances "Use with Solenta" saves. */
const LOCAL_REFS = new Set(LOCAL_KINDS.map((k) => `opencode:${k}`));
/** Below this, agentic coding (system prompt + tools + files) truncates. */
const MIN_CONTEXT = 32_000;

function localInstanceOf(instances: readonly ProviderInstance[], kind: LocalKind): ProviderInstance | null {
  return instances.find((i) => i.id === kind && i.provider === "opencode" && i.openaiCompatible) ?? null;
}

function localStatus(server: LocalModelServer | undefined | null): string {
  if (!server) return "Checking…";
  if (!server.running) return "Not running";
  const n = server.models.length;
  return `Running (${n} model${n === 1 ? "" : "s"})`;
}

/**
 * The opencode instance for a local server. No API key: opencode's
 * openai-compatible provider treats options.apiKey as optional, and neither
 * server checks one. A re-save keeps the instance's env and headers.
 */
function localInstance(
  kind: LocalKind,
  baseUrl: string,
  models: string[],
  prev: ProviderInstance | null = null,
): ProviderInstance {
  const prevDefault = prev?.openaiCompatible?.defaultModel;
  return {
    id: kind,
    name: LOCAL_NAMES[kind],
    provider: "opencode",
    configDir: null,
    env: prev?.env ?? {},
    openaiCompatible: {
      baseUrl,
      modelsUrl: null,
      models,
      defaultModel: prevDefault && models.includes(prevDefault) ? prevDefault : (models[0] ?? null),
      headers: prev?.openaiCompatible?.headers ?? {},
    },
  };
}

function LocalDetail({
  kind,
  server,
  inst,
  opencode,
  saving,
  onDetect,
  onSave,
  onOpenProvider,
  onBack,
}: {
  kind: LocalKind;
  server: LocalModelServer | null;
  inst: ProviderInstance | null;
  opencode: ProviderInfo | undefined;
  saving: boolean;
  onDetect: (url: string) => Promise<void>;
  onSave: (next: ProviderInstance) => Promise<boolean>;
  onOpenProvider: () => void;
  onBack: () => void;
}) {
  const name = LOCAL_NAMES[kind];
  const [url, setUrl] = useState(server?.url ?? LOCAL_DEFAULTS[kind]);
  useEffect(() => {
    if (server) setUrl(server.url);
  }, [server?.url]);
  const [checking, setChecking] = useState(false);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [saved, setSaved] = useState(false);
  const models = server?.running ? server.models : [];
  const savedIds = inst?.openaiCompatible?.models ?? [];
  const chosen = picked ?? new Set(inst ? savedIds : models.map((m) => m.id));
  const ids = models.map((m) => m.id).filter((id) => chosen.has(id));
  const urlId = useId();

  const check = async () => {
    setChecking(true);
    try {
      await onDetect(url.trim() || LOCAL_DEFAULTS[kind]);
    } finally {
      setChecking(false);
    }
  };
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
    setSaved(false);
  };

  return (
    <section className={base.section} data-local-detail={kind}>
      <div className={styles.detailHead}>
        <button type="button" className={styles.back} data-provider-back="" aria-label="Back to providers" onClick={onBack}>
          ←
        </button>
        <h4 className={styles.detailTitle}>{name}</h4>
        <span className={styles.badge} data-local-badge="" data-on={server?.running ? "true" : undefined}>
          {localStatus(server)}
        </span>
        <span className={styles.spacer} />
        {inst && (
          <button type="button" className={base.btn} data-local-open-provider="" onClick={onOpenProvider}>
            Provider settings
          </button>
        )}
      </div>

      <div className={base.field}>
        <label className={base.fieldLabel} htmlFor={urlId}>
          Server
        </label>
        <div className={base.fieldRow}>
          <input
            id={urlId}
            className={`${base.input} ${base.monoInput}`}
            data-local-url=""
            type="url"
            value={url}
            autoComplete="off"
            spellCheck={false}
            placeholder={LOCAL_DEFAULTS[kind]}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void check();
            }}
          />
          <button type="button" className={base.btn} data-local-check="" disabled={checking} onClick={() => void check()}>
            {checking ? "Checking…" : "Check"}
          </button>
        </div>
        <p className={base.note}>Another machine on your network works too, e.g. http://192.168.1.20:11434.</p>
      </div>

      {opencode && !opencode.available && (
        <p className={base.fieldError} role="note">
          OpenCode is not installed. Local models run through the opencode CLI.
        </p>
      )}

      {server && !server.running ? (
        <div className={styles.card} data-local-setup={kind}>
          <p className={styles.cardTitle}>{name} is not running at {server.url}</p>
          {kind === "ollama" ? (
            <ol className={base.note}>
              <li>
                Install it from{" "}
                <a className={styles.link} href="https://ollama.com/download" target="_blank" rel="noreferrer">
                  ollama.com/download ↗
                </a>
              </li>
              <li>
                Pull a coding model: <code>ollama pull qwen3-coder</code>
              </li>
              <li>
                Start it from the menu bar app, or <code>ollama serve</code>, then Check.
              </li>
            </ol>
          ) : (
            <ol className={base.note}>
              <li>
                Install it from{" "}
                <a className={styles.link} href="https://lmstudio.ai" target="_blank" rel="noreferrer">
                  lmstudio.ai ↗
                </a>{" "}
                and download a model.
              </li>
              <li>
                In the Developer tab choose Start server, or run <code>lms server start</code>, then Check.
              </li>
            </ol>
          )}
        </div>
      ) : null}

      {server?.running && (
        <div className={styles.models} data-local-models="">
          <div className={styles.modelsHead}>
            <span className={styles.modelsTitle}>Models</span>
            <span className={styles.modelsSource}>Installed on {server.url}</span>
          </div>
          <div className={styles.modelList}>
            {models.length === 0 ? (
              <p className={styles.modelsEmpty}>
                {kind === "ollama" ? (
                  <>
                    No models yet. Run <code>ollama pull qwen3-coder</code>, then Check.
                  </>
                ) : (
                  "No models loaded. Load one in LM Studio, then Check."
                )}
              </p>
            ) : (
              models.map((m) => (
                <label key={m.id} className={styles.modelRow} data-local-model={m.id}>
                  <input type="checkbox" checked={chosen.has(m.id)} disabled={saving} onChange={() => toggle(m.id)} />
                  <div className={styles.modelMain}>
                    <div className={styles.modelName}>
                      <span className={styles.modelLabel}>{m.label}</span>
                      {m.contextTokens ? (
                        <span className={styles.ctx} title="Context window">
                          {formatTokens(m.contextTokens)}
                        </span>
                      ) : null}
                    </div>
                    {m.contextTokens && m.contextTokens < MIN_CONTEXT ? (
                      <p className={`${styles.modelDesc} ${styles.danger}`} data-context-warning="">
                        {formatTokens(m.contextTokens)} context: agent runs will likely fail or get cut off. Use a
                        model or setting with 32K or more.
                      </p>
                    ) : null}
                  </div>
                </label>
              ))
            )}
          </div>
        </div>
      )}

      {server?.running && (
        <p className={base.note} data-local-context-hint="">
          {kind === "ollama" ? (
            <>
              Ollama serves less context than a model supports unless told otherwise, and tool calls need room.
              Start it with <code>OLLAMA_CONTEXT_LENGTH=32768 ollama serve</code>, or set <code>num_ctx</code> in a
              Modelfile.
            </>
          ) : (
            "Set the context length to 32K or more when loading a model in LM Studio; tool calls need the room."
          )}
        </p>
      )}

      {server?.running && models.length > 0 && (
        <div className={base.fieldRow}>
          <button
            type="button"
            className={`${base.btn} ${base.btnPrimary}`}
            data-local-use=""
            disabled={saving || ids.length === 0}
            onClick={() =>
              void onSave(localInstance(kind, server.baseUrl, ids, inst)).then((ok) => {
                if (ok) {
                  setPicked(null);
                  setSaved(true);
                }
              })
            }
          >
            {inst ? "Update models" : "Use with Solenta"}
          </button>
          {saved && (
            <span className={base.note} role="status" data-local-saved="">
              Saved. Pick {name} in the model picker.
            </span>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Add provider
// ---------------------------------------------------------------------------

type AddKind = "compat" | "instance" | "generic";

const ADD_KINDS: Array<{ id: AddKind; title: string; hint: string }> = [
  {
    id: "compat",
    title: "OpenAI-compatible provider",
    hint: "Any /v1/chat/completions endpoint: a gateway, a hosted model, a local server. Runs through OpenCode.",
  },
  {
    id: "instance",
    title: "Another Claude Code or Codex account",
    hint: "The same CLI with its own config folder, sign-in and environment.",
  },
  {
    id: "generic",
    title: "Custom CLI",
    hint: "Any agent CLI, run best effort with the prompt as its last argument.",
  },
];

function AddProviderView({
  instances,
  providers,
  saving,
  setError,
  persistInstances,
  onBack,
  onAdded,
  onConnectChatGpt,
}: {
  instances: readonly ProviderInstance[];
  providers: ProviderInfo[];
  saving: boolean;
  setError: (error: string | null) => void;
  persistInstances: (next: ProviderInstance[]) => Promise<boolean>;
  onBack: () => void;
  onAdded: (ref: string | null) => void;
  onConnectChatGpt?: () => Promise<void>;
}) {
  const [kind, setKind] = useState<AddKind>("compat");
  const [draft, setDraft] = useState<InstanceDraft>(() => emptyInstanceDraft(providers));
  return (
    <section className={base.section} data-add-provider-view="">
      <div className={styles.detailHead}>
        <button type="button" className={styles.back} data-provider-back="" aria-label="Back to providers" onClick={onBack}>
          ←
        </button>
        <h4 className={styles.detailTitle}>Add provider</h4>
      </div>
      <div className={styles.kinds} role="radiogroup" aria-label="Provider kind">
        {ADD_KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            role="radio"
            aria-checked={kind === k.id}
            className={styles.kind}
            data-add-kind={k.id}
            data-on={kind === k.id ? "true" : undefined}
            onClick={() => {
              setError(null);
              setKind(k.id);
              setDraft(emptyInstanceDraft(providers, k.id === "generic" ? "generic" : undefined));
            }}
          >
            <span className={styles.kindTitle}>{k.title}</span>
            <span className={base.note}>{k.hint}</span>
          </button>
        ))}
      </div>
      {kind === "compat" ? (
        <CompatForm
          instances={instances}
          opencode={providers.find((p) => p.id === "opencode")}
          saving={saving}
          onCancel={onBack}
          onSave={async (inst) => {
            if (await persistInstances([...instances, inst])) onAdded(`opencode:${inst.id}`);
          }}
        />
      ) : (
        <>
          {kind === "instance" && onConnectChatGpt && (
            <div className={base.fieldRow}>
              <button
                type="button"
                className={base.btn}
                data-connect-chatgpt=""
                disabled={saving}
                onClick={() => void onConnectChatGpt().then(() => onAdded(null))}
              >
                Connect ChatGPT account
              </button>
              <span className={base.note}>A Codex instance with its own CODEX_HOME, then codex login.</span>
            </div>
          )}
          <InstanceForm
            draft={draft}
            providers={providers}
            saving={saving}
            lockProvider={kind === "generic"}
            onChange={setDraft}
            onCancel={onBack}
            onSubmit={() => {
              const next = instanceFromDraft(draft);
              if (typeof next === "string") return setError(next);
              void persistInstances([...instances, next]).then(
                (ok) => ok && onAdded(`${next.provider}:${next.id}`),
              );
            }}
          />
        </>
      )}
    </section>
  );
}

/** "My Provider" → "my-provider", the id rules electron enforces. */
function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function CompatForm({
  instances,
  opencode,
  saving,
  onCancel,
  onSave,
}: {
  instances: readonly ProviderInstance[];
  opencode: ProviderInfo | undefined;
  saving: boolean;
  onCancel: () => void;
  onSave: (inst: ProviderInstance) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [idText, setIdText] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelsUrl, setModelsUrl] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const id = slug(idText || name);
  const models = [...new Set(modelsText.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean))];
  const taken = instances.some((i) => i.id === id) || ["claude", "codex", "cursor", "grok", "opencode", "kimi", "muse"].includes(id);
  const canSave = id && name.trim() && baseUrl.trim() && (models.length > 0 || modelsUrl.trim()) && !taken;

  const submit = async () => {
    setFormError(null);
    for (const u of [baseUrl, modelsUrl].filter((v) => v.trim())) {
      if (!/^https?:\/\/\S+$/.test(u.trim())) return setFormError(`${u.trim()} is not an http(s) URL`);
    }
    const hdrs: Record<string, string> = {};
    for (const h of headers) {
      const k = h.key.trim();
      if (!k) continue;
      if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) return setFormError(`"${k}" is not a valid header name`);
      hdrs[k] = h.value;
    }
    await onSave({
      id,
      name: name.trim(),
      provider: "opencode",
      configDir: null,
      env: apiKey.trim() ? { [COMPAT_KEY_ENV]: apiKey.trim() } : {},
      openaiCompatible: {
        baseUrl: baseUrl.trim(),
        modelsUrl: modelsUrl.trim() || null,
        models,
        defaultModel: models.includes(defaultModel) ? defaultModel : (models[0] ?? null),
        headers: hdrs,
      },
    });
  };

  return (
    <div className={base.section} data-compat-form="">
      {opencode && !opencode.available && (
        <p className={base.fieldError} role="note">
          OpenCode is not installed. The provider saves, but runs need the opencode CLI.
        </p>
      )}
      <div className={styles.grid2}>
        <div className={base.field}>
          <label className={base.fieldLabel} htmlFor="compat-name">Name</label>
          <input id="compat-name" className={base.input} value={name} maxLength={40} placeholder="My Provider" autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className={base.field}>
          <label className={base.fieldLabel} htmlFor="compat-id">Provider ID</label>
          <input id="compat-id" className={`${base.input} ${base.monoInput}`} value={idText} placeholder={slug(name) || "my-provider"} autoComplete="off" spellCheck={false} onChange={(e) => setIdText(e.target.value)} />
          <p className={base.note}>
            {taken ? <span className={styles.danger}>That ID is already used.</span> : <>Models appear as <code>{id || "my-provider"}/&lt;model&gt;</code>.</>}
          </p>
        </div>
      </div>
      <div className={base.field}>
        <label className={base.fieldLabel} htmlFor="compat-base">Base URL</label>
        <input id="compat-base" className={`${base.input} ${base.monoInput}`} type="url" value={baseUrl} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
      </div>
      <div className={base.field}>
        <label className={base.fieldLabel} htmlFor="compat-models-url">Models list URL (optional)</label>
        <input id="compat-models-url" className={`${base.input} ${base.monoInput}`} type="url" value={modelsUrl} placeholder={baseUrl ? `${baseUrl.replace(/\/+$/, "")}/models` : "https://api.example.com/v1/models"} autoComplete="off" spellCheck={false} onChange={(e) => setModelsUrl(e.target.value)} />
        <p className={base.note}>Refresh reads an OpenAI-style <code>{"{ data: [...] }"}</code> or a bare array. Empty uses the base URL&apos;s /models.</p>
      </div>
      <div className={base.field}>
        <label className={base.fieldLabel} htmlFor="compat-models">Model IDs</label>
        <input id="compat-models" className={`${base.input} ${base.monoInput}`} value={modelsText} placeholder="llama-4-maverick, qwen3-coder" autoComplete="off" spellCheck={false} onChange={(e) => setModelsText(e.target.value)} />
        <p className={base.note}>Comma or space separated. Add at least one, or a models list URL.</p>
      </div>
      {models.length > 1 && (
        <div className={base.field}>
          <label className={base.fieldLabel} htmlFor="compat-default">Default model</label>
          <select id="compat-default" className={base.input} value={models.includes(defaultModel) ? defaultModel : models[0]} onChange={(e) => setDefaultModel(e.target.value)}>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      )}
      <div className={base.field}>
        <label className={base.fieldLabel} htmlFor="compat-key">API key (optional)</label>
        <div className={styles.inputFrame}>
          <input id="compat-key" className={`${styles.frameInput} ${base.monoInput}`} type={showKey ? "text" : "password"} value={apiKey} placeholder="sk-…" autoComplete="off" spellCheck={false} onChange={(e) => setApiKey(e.target.value)} />
          <button type="button" className={styles.iconBtn} aria-label={showKey ? "Hide API key" : "Show API key"} onClick={() => setShowKey((s) => !s)}>
            {showKey ? "Hide" : "Show"}
          </button>
        </div>
        <p className={base.note}>Stored like other provider keys; OpenCode reads it from the run&apos;s environment.</p>
      </div>
      <div className={base.field}>
        <span className={base.fieldLabel}>Custom headers</span>
        {headers.map((h, i) => (
          <div key={i} className={base.fieldRow} data-compat-header="">
            <input className={`${base.input} ${base.monoInput}`} aria-label="Header name" value={h.key} placeholder="X-Team" onChange={(e) => setHeaders(headers.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))} />
            <input className={`${base.input} ${base.monoInput}`} aria-label={`Value of ${h.key || "header"}`} value={h.value} onChange={(e) => setHeaders(headers.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))} />
            <button type="button" className={base.btn} aria-label={`Remove ${h.key || "header"}`} onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <div className={base.fieldRow}>
          <button type="button" className={base.btn} data-compat-add-header="" onClick={() => setHeaders([...headers, { key: "", value: "" }])}>
            Add header
          </button>
        </div>
        <p className={base.note}>Headers are plain settings. Put a secret in the API key instead.</p>
      </div>
      {formError && <p className={base.fieldError} role="alert">{formError}</p>}
      <div className={base.fieldRow}>
        <button type="button" className={`${base.btn} ${base.btnPrimary}`} data-compat-save="" disabled={!canSave || saving} onClick={() => void submit()}>
          Add provider
        </button>
        <button type="button" className={base.btn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
