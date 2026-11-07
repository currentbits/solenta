import { useEffect, useState } from "react";
import {
  PERMISSION_MODE_LABELS,
  providerPermissionModes,
  snapToHonouredPermissionMode,
} from "../../format";
import {
  CUSTOM_MODEL_ID,
  effortDisplayLabel,
  effortHint,
  effortsForModel,
  profileSummary,
} from "../../modelPicker";
import type {
  AgentProfile,
  AppSettings,
  AutoApprove,
  GovernanceAction,
  GovernanceRule,
  PermissionMode,
  PromptSnippet,
  ProviderInfo,
  ReasoningEffort,
  SubagentPool,
  SubagentPoolEntry,
} from "../../shared/ipc";
import styles from "../SettingsModal.module.css";
import { BudgetFields } from "../BudgetFields";
import { AutoApproveMatrix } from "../AutoApproveMatrix";
import {
  autoApproveBestEffort,
  autoApproveForMode,
  enforcesAutoApprove,
  modeForAutoApprove,
} from "../../autoApprove";
import { budgetToDraft, draftToBudget, type BudgetDraft } from "../../budget";
import type { SettingsModalProps } from "../SettingsModal";

export interface ProfileDraft {
  id: string | null;
  name: string;
  provider: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  ultracode?: boolean;
  /** Plan-mode model (#1716); only kept for supportsPlanModel providers. */
  planModel?: string | null;
  /** Not editable here; carried through so an edit does not drop it. */
  planReasoningEffort?: ReasoningEffort | null;
  permissionMode: PermissionMode;
  customModel: boolean;
  defaultAction: "ask" | "allow";
  rules: GovernanceRule[];
  /** Default hard cap (#286), as typed. */
  budget: BudgetDraft;
  /** Auto-approve toggles (#1721); null = none, the mode decides. */
  autoApprove: AutoApprove | null;
}

/** Per-profile rule cap; the store rejects more (#262). */
const MAX_POLICY_RULES = 40;

function defaultProviderId(providers: readonly ProviderInfo[]): string {
  return providers.find((p) => p.available)?.id ?? providers[0]?.id ?? "";
}

const EMPTY_POOL: SubagentPool = {
  defaultAlias: null,
  force: false,
  entries: [],
};

export interface PoolDraft {
  originalAlias: string | null;
  alias: string;
  provider: string;
  model: string | null;
  description: string;
  customModel: boolean;
  allowEscalation: boolean;
}

function emptyPoolDraft(providers: readonly ProviderInfo[]): PoolDraft {
  return {
    originalAlias: null,
    alias: "",
    provider: defaultProviderId(providers),
    model: null,
    description: "",
    customModel: false,
    allowEscalation: false,
  };
}

function draftFromPoolEntry(
  entry: SubagentPoolEntry,
  providers: readonly ProviderInfo[],
): PoolDraft {
  const provider = providers.find((p) => p.id === entry.provider);
  const known =
    entry.model != null &&
    (provider?.modelInfo.some((m) => m.id === entry.model) ?? false);
  return {
    originalAlias: entry.alias,
    alias: entry.alias,
    provider: entry.provider,
    model: entry.model,
    description: entry.description,
    customModel: entry.model != null && !known,
    allowEscalation: entry.allowEscalation === true,
  };
}

function emptyDraft(providers: readonly ProviderInfo[]): ProfileDraft {
  const providerId = defaultProviderId(providers);
  const selected = providers.find((p) => p.id === providerId);
  return {
    id: null,
    name: "",
    provider: providerId,
    model: null,
    reasoningEffort: null,
    permissionMode: snapToHonouredPermissionMode(
      providerPermissionModes(selected),
      "default",
    ),
    customModel: false,
    defaultAction: "ask",
    rules: [],
    budget: budgetToDraft(null),
    autoApprove: null,
  };
}

function draftFromProfile(
  profile: AgentProfile,
  providers: readonly ProviderInfo[],
): ProfileDraft {
  const provider = providers.find((p) => p.id === profile.provider);
  const known =
    profile.model != null &&
    (provider?.modelInfo.some((m) => m.id === profile.model) ?? false);
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    ultracode: profile.ultracode,
    planModel: profile.planModel ?? null,
    planReasoningEffort: profile.planReasoningEffort ?? null,
    permissionMode: snapToHonouredPermissionMode(
      providerPermissionModes(provider),
      profile.permissionMode,
    ),
    customModel: profile.model != null && !known,
    defaultAction: profile.policy?.defaultAction ?? "ask",
    rules: profile.policy?.rules.map((r) => ({ ...r })) ?? [],
    budget: budgetToDraft(profile.budget),
    autoApprove: profile.autoApprove ?? null,
  };
}

export function AgentsPane({
  settings,
  providers,
  saving,
  setError,
  draft,
  setDraft,
  poolDraft,
  setPoolDraft,
  persistProfiles,
  persistPool,
  onSaveSettings,
  onRefreshProviders,
}: {
  settings: AppSettings | null;
  providers: ProviderInfo[];
  saving: boolean;
  setError: (error: string | null) => void;
  draft: ProfileDraft | null;
  setDraft: (draft: ProfileDraft | null) => void;
  poolDraft: PoolDraft | null;
  setPoolDraft: (draft: PoolDraft | null) => void;
  persistProfiles: (next: AgentProfile[]) => Promise<boolean>;
  persistPool: (next: SubagentPool) => Promise<boolean>;
  onSaveSettings: SettingsModalProps["onSaveSettings"];
  onRefreshProviders?: () => void;
}) {
  // Mounted only while this pane shows: opening it re-probes sign-in state.
  useEffect(() => {
    onRefreshProviders?.();
  }, []);

  const submitDraft = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError("Name is required");
      return;
    }
    if (name.length > 40) {
      setError("Name must be 40 characters or fewer");
      return;
    }
    const selected = providers.find((p) => p.id === draft.provider);
    const model = draft.customModel
      ? draft.model?.trim() || null
      : draft.model;
    const allowed = effortsForModel(selected, model);
    const reasoningEffort =
      allowed.length > 0 &&
      draft.reasoningEffort != null &&
      allowed.includes(draft.reasoningEffort)
        ? draft.reasoningEffort
        : null;
    const nextProfile: AgentProfile = {
      id: draft.id ?? crypto.randomUUID(),
      name,
      provider: draft.provider,
      model,
      reasoningEffort,
      ultracode: draft.ultracode === true && (selected?.baseProvider ?? selected?.id) === "claude" && Boolean(selected?.modelInfo.find((m) => m.id === model)?.efforts?.includes("xhigh")),
      permissionMode: snapToHonouredPermissionMode(
        providerPermissionModes(selected),
        draft.permissionMode,
      ),
    };
    if (draft.autoApprove) nextProfile.autoApprove = draft.autoApprove;
    if (selected?.supportsPlanModel && draft.planModel) {
      nextProfile.planModel = draft.planModel;
      if (
        draft.planReasoningEffort &&
        effortsForModel(selected, draft.planModel).includes(draft.planReasoningEffort)
      ) {
        nextProfile.planReasoningEffort = draft.planReasoningEffort;
      }
    }
    const rules = draft.rules
      .map((r) => ({ ...r, match: r.match.trim() }))
      .filter((r) => r.match !== "");
    // Absent policy = today's behavior; only store one that changes something.
    if (rules.length > 0 || draft.defaultAction !== "ask") {
      nextProfile.policy = { defaultAction: draft.defaultAction, rules };
    }
    try {
      const budget = draftToBudget(draft.budget);
      if (budget) nextProfile.budget = budget;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    const list = settings?.agentProfiles ?? [];
    const next = draft.id
      ? list.map((p) => (p.id === draft.id ? nextProfile : p))
      : [...list, nextProfile];
    if (await persistProfiles(next)) setDraft(null);
  };

  const submitPoolDraft = async () => {
    if (!poolDraft) return;
    const alias = poolDraft.alias.trim().toLowerCase();
    if (!alias) {
      setError("Alias is required");
      return;
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(alias)) {
      setError('Alias must be a lowercase slug (e.g. "fast"), 1-32 characters');
      return;
    }
    const description = poolDraft.description.replace(/\s+/g, " ").trim();
    if (!description) {
      setError("Description is required");
      return;
    }
    if (description.length > 160) {
      setError("Description must be 160 characters or fewer");
      return;
    }
    const model = poolDraft.customModel
      ? poolDraft.model?.trim() || null
      : poolDraft.model;
    const nextEntry: SubagentPoolEntry = {
      alias,
      provider: poolDraft.provider,
      model,
      description,
      ...(poolDraft.allowEscalation ? { allowEscalation: true } : {}),
    };
    const current = settings?.subagentPool ?? EMPTY_POOL;
    const withoutOld = poolDraft.originalAlias
      ? current.entries.filter((e) => e.alias !== poolDraft.originalAlias)
      : current.entries;
    if (withoutOld.some((e) => e.alias === alias)) {
      setError(`Alias "${alias}" is already in the pool`);
      return;
    }
    const entries = poolDraft.originalAlias
      ? current.entries.map((e) =>
          e.alias === poolDraft.originalAlias ? nextEntry : e,
        )
      : [...current.entries, nextEntry];
    let defaultAlias = current.defaultAlias;
    if (poolDraft.originalAlias && defaultAlias === poolDraft.originalAlias) {
      defaultAlias = alias;
    }
    if (defaultAlias == null && entries.length === 1) defaultAlias = alias;
    if (await persistPool({ ...current, defaultAlias, entries })) {
      setPoolDraft(null);
    }
  };

  return (
    <>
      <section className={styles.section} data-agent-profiles="">
        <h3 className={styles.sectionLabel}>Agent profiles</h3>
        <p className={styles.note}>
          Named combinations of provider, model, effort, and permission
          mode. Pick one from the composer or the Planboard orchestrator
          picker.
        </p>
        {(settings?.agentProfiles ?? []).length === 0 && draft == null && (
          <p className={styles.note}>No profiles yet.</p>
        )}
        {(settings?.agentProfiles ?? []).map((profile, index, list) => (
          <div
            key={profile.id}
            className={`${styles.memoryRow} ${styles.profileRow}`}
          >
            <div className={styles.profileMeta}>
              <div className={styles.profileName}>{profile.name}</div>
              <p className={styles.note}>
                {profileSummary(profile, providers)}
              </p>
            </div>
            <div className={styles.fieldRow}>
              <button
                type="button"
                className={styles.btn}
                aria-label={`Move ${profile.name} up`}
                disabled={saving || index === 0}
                onClick={() => {
                  const next = [...list];
                  const above = next[index - 1]!;
                  next[index - 1] = profile;
                  next[index] = above;
                  void persistProfiles(next);
                }}
              >
                ↑
              </button>
              <button
                type="button"
                className={styles.btn}
                aria-label={`Move ${profile.name} down`}
                disabled={saving || index === list.length - 1}
                onClick={() => {
                  const next = [...list];
                  const below = next[index + 1]!;
                  next[index + 1] = profile;
                  next[index] = below;
                  void persistProfiles(next);
                }}
              >
                ↓
              </button>
              <button
                type="button"
                className={styles.btn}
                disabled={saving}
                onClick={() => {
                  setError(null);
                  setDraft(draftFromProfile(profile, providers));
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className={styles.btn}
                disabled={saving}
                onClick={() => {
                  if (draft?.id === profile.id) setDraft(null);
                  void persistProfiles(
                    list.filter((p) => p.id !== profile.id),
                  );
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {draft ? (
          <ProfileForm
            draft={draft}
            providers={providers}
            saving={saving}
            onChange={setDraft}
            onCancel={() => {
              setDraft(null);
              setError(null);
            }}
            onSubmit={() => void submitDraft()}
          />
        ) : (
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={styles.btn}
              data-add-profile=""
              disabled={saving || settings == null || providers.length === 0}
              onClick={() => {
                setError(null);
                setDraft(emptyDraft(providers));
              }}
            >
              Add profile
            </button>
          </div>
        )}
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="orch-default-profile">
            Default orchestrator
          </label>
          <select
            id="orch-default-profile"
            className={styles.input}
            data-orch-default-profile=""
            value={settings?.defaultOrchestratorProfileId ?? ""}
            disabled={
              saving ||
              settings == null ||
              (settings?.agentProfiles ?? []).length === 0
            }
            onChange={(e) => {
              setError(null);
              void onSaveSettings({
                defaultOrchestratorProfileId: e.target.value || null,
              }).catch((err) => {
                setError(
                  err instanceof Error && err.message
                    ? err.message
                    : "Failed to save settings",
                );
              });
            }}
          >
            <option value="">Inherit current thread</option>
            {(settings?.agentProfiles ?? []).map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <p className={styles.note}>
            {(settings?.agentProfiles ?? []).length === 0
              ? "Add a profile above, then pick which one Planboard Orchestrator: Default uses."
              : "The Planboard's Orchestrator: Default option uses this agent. Empty inherits the currently selected thread."}
          </p>
        </div>
      </section>

      <PromptSnippetsSection
        snippets={settings?.promptSnippets ?? []}
        disabled={saving || settings == null}
        onPersist={async (promptSnippets) => {
          setError(null);
          try {
            await onSaveSettings({ promptSnippets });
            return true;
          } catch (err) {
            setError(
              err instanceof Error && err.message
                ? err.message
                : "Failed to save settings",
            );
            return false;
          }
        }}
      />

      <section className={styles.section} data-subagent-pool="">
        <h3 className={styles.sectionLabel}>Worker model pool</h3>
        <p className={styles.note}>
          Described candidates the lead picks per spawn. Workers default
          to the cheap alias. Does not route the thread you are talking
          to.
        </p>
        {(settings?.subagentPool?.entries ?? []).length === 0 &&
          poolDraft == null && (
            <p className={styles.note}>
              No pool. Workers inherit the lead&apos;s provider.
            </p>
          )}
        {(settings?.subagentPool?.entries ?? []).map((item) => {
          const current = settings?.subagentPool ?? EMPTY_POOL;
          const isDefault = current.defaultAlias === item.alias;
          return (
            <div
              key={item.alias}
              className={`${styles.memoryRow} ${styles.profileRow}`}
              data-pool-entry={item.alias}
            >
              <div className={styles.profileMeta}>
                <div className={styles.profileName}>
                  {item.alias}
                  {isDefault ? " (default)" : ""}
                </div>
                <p className={styles.note}>
                  {item.description} ({item.provider} / {item.model ?? "default"})
                  {item.allowEscalation ? " · may exceed the lead's permissions" : ""}
                </p>
              </div>
              <div className={styles.fieldRow}>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={saving}
                  onClick={() => {
                    setError(null);
                    setPoolDraft(draftFromPoolEntry(item, providers));
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={saving}
                  onClick={() => {
                    if (poolDraft?.originalAlias === item.alias) {
                      setPoolDraft(null);
                    }
                    const nextEntries = current.entries.filter(
                      (e) => e.alias !== item.alias,
                    );
                    const defaultAlias =
                      current.defaultAlias === item.alias
                        ? (nextEntries[0]?.alias ?? null)
                        : current.defaultAlias;
                    void persistPool({
                      defaultAlias,
                      force: defaultAlias != null && current.force,
                      entries: nextEntries,
                    });
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
        {(settings?.subagentPool?.entries ?? []).length > 0 && (
          <>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="pool-default">
                Default worker
              </label>
              <select
                id="pool-default"
                className={styles.input}
                data-pool-default=""
                value={settings?.subagentPool?.defaultAlias ?? ""}
                disabled={saving || settings == null}
                onChange={(e) => {
                  const current = settings?.subagentPool ?? EMPTY_POOL;
                  const defaultAlias = e.target.value || null;
                  void persistPool({
                    ...current,
                    defaultAlias,
                    force: defaultAlias != null && current.force,
                  });
                }}
              >
                <option value="">Inherit lead&apos;s provider</option>
                {(settings?.subagentPool?.entries ?? []).map((item) => (
                  <option key={item.alias} value={item.alias}>
                    {item.alias}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-pool-force=""
                  checked={settings?.subagentPool?.force === true}
                  disabled={
                    saving ||
                    settings == null ||
                    !settings.subagentPool?.defaultAlias
                  }
                  onChange={(e) => {
                    const current = settings?.subagentPool ?? EMPTY_POOL;
                    void persistPool({
                      ...current,
                      force: e.target.checked,
                    });
                  }}
                />
                <span>Pin every worker to the default</span>
              </label>
              <p className={styles.note}>
                When pinned, the lead cannot pick a different alias.
              </p>
            </div>
          </>
        )}
        {poolDraft ? (
          <PoolForm
            draft={poolDraft}
            providers={providers}
            saving={saving}
            onChange={setPoolDraft}
            onCancel={() => {
              setPoolDraft(null);
              setError(null);
            }}
            onSubmit={() => void submitPoolDraft()}
          />
        ) : (
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={styles.btn}
              data-add-pool-entry=""
              disabled={saving || settings == null || providers.length === 0}
              onClick={() => {
                setError(null);
                setPoolDraft(emptyPoolDraft(providers));
              }}
            >
              Add candidate
            </button>
          </div>
        )}
      </section>
    </>
  );
}

/** Prompt snippets (issue #189): name + text, inserted in the composer via `@name`. */
function PromptSnippetsSection({
  snippets,
  disabled,
  onPersist,
}: {
  snippets: PromptSnippet[];
  disabled: boolean;
  onPersist: (next: PromptSnippet[]) => Promise<boolean>;
}) {
  /** `original` is the name being edited; null adds a new snippet. */
  const [draft, setDraft] = useState<
    { original: string | null; name: string; text: string } | null
  >(null);

  const submit = async () => {
    if (!draft) return;
    const row = { name: draft.name.trim(), text: draft.text };
    const next =
      draft.original == null
        ? [...snippets, row]
        : snippets.map((sn) => (sn.name === draft.original ? row : sn));
    if (await onPersist(next)) setDraft(null);
  };

  return (
    <section className={styles.section} data-prompt-snippets="">
      <h3 className={styles.sectionLabel}>Prompt snippets</h3>
      <p className={styles.note}>
        Reusable text for the composer. Type <code>@name</code> and pick the
        snippet to insert its text.
      </p>
      {snippets.length === 0 && draft == null && (
        <p className={styles.note}>No snippets yet.</p>
      )}
      {snippets.map((sn) => (
        <div key={sn.name} className={`${styles.memoryRow} ${styles.profileRow}`}>
          <div className={styles.profileMeta}>
            <div className={styles.profileName}>@{sn.name}</div>
            <p className={styles.note}>
              {sn.text.length > 80 ? `${sn.text.slice(0, 80)}…` : sn.text}
            </p>
          </div>
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={styles.btn}
              disabled={disabled}
              onClick={() => setDraft({ original: sn.name, ...sn })}
            >
              Edit
            </button>
            <button
              type="button"
              className={styles.btn}
              disabled={disabled}
              onClick={() => {
                if (draft?.original === sn.name) setDraft(null);
                void onPersist(snippets.filter((x) => x.name !== sn.name));
              }}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
      {draft ? (
        <div className={styles.section}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="snippet-name">
              Name
            </label>
            <input
              id="snippet-name"
              className={styles.input}
              value={draft.name}
              disabled={disabled}
              autoComplete="off"
              placeholder="run-tests"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="snippet-text">
              Text
            </label>
            <textarea
              id="snippet-text"
              className={styles.textarea}
              rows={4}
              value={draft.text}
              disabled={disabled}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
          </div>
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={styles.btn}
              disabled={disabled}
              onClick={() => void submit()}
            >
              Save snippet
            </button>
            <button
              type="button"
              className={styles.btn}
              disabled={disabled}
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.fieldRow}>
          <button
            type="button"
            className={styles.btn}
            data-add-snippet=""
            disabled={disabled}
            onClick={() => setDraft({ original: null, name: "", text: "" })}
          >
            Add snippet
          </button>
        </div>
      )}
    </section>
  );
}

function ProfileForm({
  draft,
  providers,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: ProfileDraft;
  providers: ProviderInfo[];
  saving: boolean;
  onChange: (draft: ProfileDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const selected = providers.find((p) => p.id === draft.provider);
  const modelInfo = selected?.modelInfo ?? [];
  const efforts = effortsForModel(selected, draft.model);
  const permissionModes = providerPermissionModes(selected);
  const modelValue = draft.customModel ? CUSTOM_MODEL_ID : (draft.model ?? "");
  const providerMissing =
    draft.provider !== "" &&
    !providers.some((p) => p.id === draft.provider);

  const setProvider = (nextId: string) => {
    const next = providers.find((p) => p.id === nextId);
    const modelOk =
      draft.model != null &&
      (next?.modelInfo.some((m) => m.id === draft.model) ?? false);
    const nextModel = modelOk ? draft.model : null;
    const effortOk =
      draft.reasoningEffort != null &&
      effortsForModel(next, nextModel).includes(draft.reasoningEffort);
    onChange({
      ...draft,
      provider: nextId,
      model: modelOk ? draft.model : null,
      customModel: false,
      reasoningEffort: effortOk ? draft.reasoningEffort : null,
      // Model ids are per-CLI: the plan model cannot follow a provider switch.
      planModel: null,
      planReasoningEffort: null,
      permissionMode: draft.autoApprove
        ? modeForAutoApprove(
            draft.autoApprove,
            nextId,
            providerPermissionModes(next),
            draft.permissionMode,
          )
        : snapToHonouredPermissionMode(
            providerPermissionModes(next),
            draft.permissionMode,
          ),
    });
  };

  return (
    <div className={styles.section}>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="profile-name">
          Name
        </label>
        <input
          id="profile-name"
          className={styles.input}
          value={draft.name}
          disabled={saving}
          autoComplete="off"
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="profile-provider">
          Provider
        </label>
        <select
          id="profile-provider"
          className={styles.input}
          value={draft.provider}
          disabled={saving}
          onChange={(e) => setProvider(e.target.value)}
        >
          {providerMissing && (
            <option value={draft.provider}>{draft.provider}</option>
          )}
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {!p.available ? " (not installed)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="profile-model">
          Model
        </label>
        <select
          id="profile-model"
          className={styles.input}
          value={modelValue}
          disabled={saving}
          onChange={(e) => {
            const value = e.target.value;
            if (value === CUSTOM_MODEL_ID) {
              onChange({ ...draft, customModel: true });
              return;
            }
            const nextModel = value === "" ? null : value;
            const nextEfforts = effortsForModel(selected, nextModel);
            onChange({
              ...draft,
              customModel: false,
              model: nextModel,
              reasoningEffort:
                draft.reasoningEffort != null &&
                nextEfforts.includes(draft.reasoningEffort)
                  ? draft.reasoningEffort
                  : null,
            });
          }}
        >
          <option value="">Default</option>
          {modelInfo.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value={CUSTOM_MODEL_ID}>Custom...</option>
        </select>
        {draft.customModel && (
          <>
            <label className={styles.fieldLabel} htmlFor="profile-model-custom">
              Model id
            </label>
            <input
              id="profile-model-custom"
              className={styles.input}
              value={draft.model ?? ""}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              placeholder="Model id"
              onChange={(e) =>
                onChange({ ...draft, model: e.target.value || null })
              }
            />
          </>
        )}
      </div>
      {efforts.length > 0 && (
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="profile-effort">
            Effort
          </label>
          <select
            id="profile-effort"
            className={styles.input}
            value={draft.reasoningEffort ?? ""}
            disabled={saving}
            onChange={(e) =>
              onChange({
                ...draft,
                reasoningEffort: (e.target.value || null) as
                  | ReasoningEffort
                  | null,
              })
            }
          >
            <option value="">Default</option>
            {efforts.map((level) => {
              const hint = effortHint(level);
              return (
              <option key={level} value={level}>
                {hint
                  ? `${effortDisplayLabel(level)} (${hint})`
                  : effortDisplayLabel(level)}
              </option>
              );
            })}
          </select>
        </div>
      )}
      {(selected?.baseProvider ?? selected?.id) === "claude" && selected?.supportsUltracode === true && selected?.modelInfo.find((m) => m.id === draft.model)?.efforts?.includes("xhigh") && (
        <label className={styles.field}><input type="checkbox" checked={draft.ultracode === true} disabled={saving} onChange={(e) => onChange({ ...draft, ultracode: e.target.checked })} /> Ultracode (xhigh effort plus dynamic workflows)</label>
      )}
      {selected?.supportsPlanModel && (
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="profile-plan-model">
            Plan with…
          </label>
          <select
            id="profile-plan-model"
            className={styles.input}
            value={draft.planModel ?? ""}
            disabled={saving}
            title="Plan-mode turns run on this model; leaving plan mode continues the same session on the model above"
            onChange={(e) =>
              onChange({ ...draft, planModel: e.target.value || null })
            }
          >
            <option value="">Same model</option>
            {draft.planModel &&
              !modelInfo.some((m) => m.id === draft.planModel) && (
                <option value={draft.planModel}>{draft.planModel}</option>
              )}
            {modelInfo.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="profile-permission">
          Permission mode
        </label>
        <select
          id="profile-permission"
          className={styles.input}
          value={snapToHonouredPermissionMode(
            permissionModes,
            draft.permissionMode,
          )}
          disabled={saving || permissionModes.length <= 1}
          title={
            permissionModes.length <= 1
              ? `${selected?.name ?? "This CLI"} always runs tools unprompted`
              : undefined
          }
          onChange={(e) =>
            onChange({
              ...draft,
              permissionMode: e.target.value as PermissionMode,
              // A mode pick means "this mode", same as the composer.
              autoApprove: null,
            })
          }
        >
          {permissionModes.map((mode) => (
            <option key={mode} value={mode}>
              {PERMISSION_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>
      {permissionModes.length > 1 && (
        <div className={styles.field} data-profile-auto-approve="">
          <AutoApproveMatrix
            value={draft.autoApprove ?? autoApproveForMode(draft.permissionMode)}
            disabled={saving}
            note={
              enforcesAutoApprove(draft.provider)
                ? null
                : autoApproveBestEffort(
                    selected?.name ?? "This CLI",
                    draft.permissionMode,
                  )
            }
            onChange={(next) =>
              onChange({
                ...draft,
                autoApprove: next,
                permissionMode: modeForAutoApprove(
                  next,
                  draft.provider,
                  permissionModes,
                  draft.permissionMode,
                ),
              })
            }
          />
        </div>
      )}
      <PolicyFields draft={draft} saving={saving} onChange={onChange} />
      <div className={styles.field} data-profile-budget="">
        <span className={styles.fieldLabel}>Default budget cap</span>
        <BudgetFields
          draft={draft.budget}
          disabled={saving}
          onChange={(budget) => onChange({ ...draft, budget })}
        />
        <span className={styles.fieldNote}>
          Copied onto a thread when this profile is applied. Hitting a limit
          stops the run and asks. Blank means no limit.
        </span>
      </div>
      <div className={styles.fieldRow}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={saving}
          onClick={onSubmit}
        >
          {draft.id ? "Update" : "Add"}
        </button>
        <button
          type="button"
          className={styles.btn}
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const POLICY_LISTS: Array<{
  kind: GovernanceRule["kind"];
  label: string;
  placeholder: string;
}> = [
  { kind: "tool", label: "Tools", placeholder: "WebFetch" },
  { kind: "bash", label: "Bash", placeholder: "npm publish*" },
  { kind: "write", label: "Write paths", placeholder: "/etc/*" },
  { kind: "network", label: "Network", placeholder: "*.example.com" },
];

const GOVERNANCE_ACTIONS: GovernanceAction[] = ["block", "deny", "ask", "allow"];

/** Permission matrix rows for a profile (#262), one list per rule kind. */
function PolicyFields({
  draft,
  saving,
  onChange,
}: {
  draft: ProfileDraft;
  saving: boolean;
  onChange: (draft: ProfileDraft) => void;
}) {
  const setRule = (i: number, patch: Partial<GovernanceRule>) =>
    onChange({
      ...draft,
      rules: draft.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    });
  const full = draft.rules.length >= MAX_POLICY_RULES;
  return (
    <>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="profile-default-action">
          Default action
        </label>
        <select
          id="profile-default-action"
          className={styles.input}
          value={draft.defaultAction}
          disabled={saving}
          onChange={(e) =>
            onChange({
              ...draft,
              defaultAction: e.target.value as ProfileDraft["defaultAction"],
            })
          }
        >
          <option value="ask">Ask</option>
          <option value="allow">Allow</option>
        </select>
      </div>
      {POLICY_LISTS.map((list) => (
        <div key={list.kind} className={styles.field} data-policy-list={list.kind}>
          <span className={styles.fieldLabel}>{list.label}</span>
          {draft.rules.map((rule, i) =>
            rule.kind !== list.kind ? null : (
              <div key={i} className={styles.fieldRow} data-policy-rule="">
                <input
                  className={styles.input}
                  aria-label={`${list.label} match`}
                  value={rule.match}
                  maxLength={200}
                  disabled={saving}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={list.placeholder}
                  onChange={(e) => setRule(i, { match: e.target.value })}
                />
                <select
                  className={styles.input}
                  aria-label={`Action for ${rule.match || list.label}`}
                  value={rule.action}
                  disabled={saving}
                  onChange={(e) =>
                    setRule(i, { action: e.target.value as GovernanceAction })
                  }
                >
                  {GOVERNANCE_ACTIONS.map((action) => (
                    <option key={action} value={action}>
                      {action}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={styles.btn}
                  aria-label={`Remove ${rule.match || list.label} rule`}
                  disabled={saving}
                  onClick={() =>
                    onChange({
                      ...draft,
                      rules: draft.rules.filter((_, j) => j !== i),
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ),
          )}
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={styles.btn}
              data-policy-add={list.kind}
              disabled={saving || full}
              onClick={() =>
                onChange({
                  ...draft,
                  rules: [
                    ...draft.rules,
                    { kind: list.kind, match: "", action: "deny" },
                  ],
                })
              }
            >
              Add rule
            </button>
          </div>
        </div>
      ))}
      <p className={styles.note}>
        Built-in Solenta guardrails still apply and cannot be lifted. Rules
        gate Claude&apos;s permission prompts, which Accept edits and Bypass
        modes skip. On macOS, any Write path or Network rule also runs the
        agent (every provider, local projects) under Seatbelt: writes are
        confined to the worktree plus allow/ask paths, and network rules
        filter egress through Solenta&apos;s proxy.
      </p>
    </>
  );
}

function PoolForm({
  draft,
  providers,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: PoolDraft;
  providers: ProviderInfo[];
  saving: boolean;
  onChange: (draft: PoolDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const selected = providers.find((p) => p.id === draft.provider);
  const modelInfo = selected?.modelInfo ?? [];
  const modelValue = draft.customModel ? CUSTOM_MODEL_ID : (draft.model ?? "");
  const providerMissing =
    draft.provider !== "" &&
    !providers.some((p) => p.id === draft.provider);

  const setProvider = (nextId: string) => {
    const next = providers.find((p) => p.id === nextId);
    const modelOk =
      draft.model != null &&
      (next?.modelInfo.some((m) => m.id === draft.model) ?? false);
    onChange({
      ...draft,
      provider: nextId,
      model: modelOk ? draft.model : null,
      customModel: false,
    });
  };

  return (
    <div className={styles.section}>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="pool-alias">
          Alias
        </label>
        <input
          id="pool-alias"
          className={styles.input}
          value={draft.alias}
          disabled={saving}
          autoComplete="off"
          spellCheck={false}
          placeholder="fast"
          onChange={(e) => onChange({ ...draft, alias: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="pool-description">
          Description
        </label>
        <input
          id="pool-description"
          className={styles.input}
          value={draft.description}
          disabled={saving}
          autoComplete="off"
          placeholder="Fast and cheap. Good for small edits."
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="pool-provider">
          Provider
        </label>
        <select
          id="pool-provider"
          className={styles.input}
          value={draft.provider}
          disabled={saving}
          onChange={(e) => setProvider(e.target.value)}
        >
          {providerMissing && (
            <option value={draft.provider}>{draft.provider}</option>
          )}
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {!p.available ? " (not installed)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="pool-model">
          Model
        </label>
        <select
          id="pool-model"
          className={styles.input}
          value={modelValue}
          disabled={saving}
          onChange={(e) => {
            const value = e.target.value;
            if (value === CUSTOM_MODEL_ID) {
              onChange({ ...draft, customModel: true });
              return;
            }
            onChange({
              ...draft,
              customModel: false,
              model: value === "" ? null : value,
            });
          }}
        >
          <option value="">Default</option>
          {modelInfo.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value={CUSTOM_MODEL_ID}>Custom...</option>
        </select>
        {draft.customModel && (
          <>
            <label className={styles.fieldLabel} htmlFor="pool-model-custom">
              Model id
            </label>
            <input
              id="pool-model-custom"
              className={styles.input}
              value={draft.model ?? ""}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              placeholder="Model id"
              onChange={(e) =>
                onChange({ ...draft, model: e.target.value || null })
              }
            />
          </>
        )}
      </div>
      <div className={styles.field}>
        <label className={styles.fieldRow}>
          <input
            type="checkbox"
            data-pool-allow-escalation=""
            checked={draft.allowEscalation}
            disabled={saving}
            onChange={(e) =>
              onChange({ ...draft, allowEscalation: e.target.checked })
            }
          />
          <span>Allow more permissions than the lead</span>
        </label>
        <p className={styles.note}>
          Workers can never run in a higher permission mode than the thread
          that forks them. Headless CLIs such as Grok and Kimi only run in
          full access, so they need this to work under a lead that asks first.
        </p>
      </div>
      <div className={styles.fieldRow}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          data-submit-pool=""
          disabled={saving}
          onClick={onSubmit}
        >
          {draft.originalAlias ? "Update" : "Add"}
        </button>
        <button
          type="button"
          className={styles.btn}
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
