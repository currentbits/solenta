import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ProviderInfo,
  WorkflowPhaseSpec,
  WorkflowTemplateInfo,
} from "../shared/ipc";
import type { WorkflowSaveInput } from "../useCoder";
import styles from "./WorkflowsModal.module.css";

interface WorkflowsModalProps {
  open: boolean;
  onClose: () => void;
  workflows: WorkflowTemplateInfo[];
  providers: ProviderInfo[];
  /** Prefer selecting this template id when opening. */
  initialSelectedId?: string | null;
  onSave: (template: WorkflowSaveInput) => Promise<WorkflowTemplateInfo>;
  onRemove: (id: string) => Promise<void>;
}

type Draft = {
  /** Source template id when editing an existing row; null for brand-new. */
  sourceId: string | null;
  name: string;
  phases: WorkflowPhaseSpec[];
  builtin: boolean;
};

function defaultPhase(providers: ProviderInfo[]): WorkflowPhaseSpec {
  const preferred =
    providers.find((p) => p.id === "claude") ??
    providers.find((p) => p.available) ??
    providers[0];
  return {
    name: "phase",
    agentCount: 1,
    instruction: "Describe what this phase should do",
    provider: preferred?.id ?? "claude",
    model: null,
  };
}

function draftFromTemplate(t: WorkflowTemplateInfo): Draft {
  return {
    sourceId: t.id,
    name: t.name,
    phases: t.phases.map((p) => ({ ...p })),
    builtin: t.builtin,
  };
}

function emptyDraft(providers: ProviderInfo[]): Draft {
  return {
    sourceId: null,
    name: "New workflow",
    phases: [defaultPhase(providers)],
    builtin: false,
  };
}

export function WorkflowsModal({
  open,
  onClose,
  workflows,
  providers,
  initialSelectedId = null,
  onSave,
  onRemove,
}: WorkflowsModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const wasOpen = useRef(false);

  // Reset selection only when the modal opens (not on every workflows refresh).
  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    setError(null);
    setConfirmDelete(false);
    setSaving(false);
    setIsNew(false);
    const preferred =
      (initialSelectedId &&
        workflows.find((w) => w.id === initialSelectedId)) ||
      workflows[0] ||
      null;
    if (preferred) {
      setSelectedId(preferred.id);
      setDraft(draftFromTemplate(preferred));
    } else {
      setSelectedId(null);
      setDraft(emptyDraft(providers));
      setIsNew(true);
    }
  }, [open, initialSelectedId, workflows, providers]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const selected = useMemo(
    () => workflows.find((w) => w.id === selectedId) ?? null,
    [workflows, selectedId],
  );

  if (!open) return null;

  const pickTemplate = (t: WorkflowTemplateInfo) => {
    setSelectedId(t.id);
    setDraft(draftFromTemplate(t));
    setIsNew(false);
    setError(null);
    setConfirmDelete(false);
  };

  const startNew = () => {
    setSelectedId(null);
    setDraft(emptyDraft(providers));
    setIsNew(true);
    setError(null);
    setConfirmDelete(false);
  };

  const updatePhase = (index: number, patch: Partial<WorkflowPhaseSpec>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const phases = prev.phases.map((p, i) =>
        i === index ? { ...p, ...patch } : p,
      );
      return { ...prev, phases };
    });
  };

  const movePhase = (index: number, dir: -1 | 1) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = index + dir;
      if (next < 0 || next >= prev.phases.length) return prev;
      const phases = [...prev.phases];
      const [row] = phases.splice(index, 1);
      phases.splice(next, 0, row!);
      return { ...prev, phases };
    });
  };

  const addPhase = () => {
    setDraft((prev) => {
      if (!prev || prev.phases.length >= 6) return prev;
      return {
        ...prev,
        phases: [...prev.phases, defaultPhase(providers)],
      };
    });
  };

  const removePhase = (index: number) => {
    setDraft((prev) => {
      if (!prev || prev.phases.length <= 1) return prev;
      return {
        ...prev,
        phases: prev.phases.filter((_, i) => i !== index),
      };
    });
  };

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    try {
      const payload: WorkflowSaveInput = {
        name: draft.name,
        phases: draft.phases,
      };
      // Existing non-new rows pass id so updates / builtin-copy work.
      if (!isNew && draft.sourceId) {
        payload.id = draft.sourceId;
      }
      const saved = await onSave(payload);
      setSelectedId(saved.id);
      setDraft(draftFromTemplate(saved));
      setIsNew(false);
      setConfirmDelete(false);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to save workflow";
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const removeSelected = async () => {
    if (!selected || selected.builtin || saving) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRemove(selected.id);
      setConfirmDelete(false);
      const remaining = workflows.filter((w) => w.id !== selected.id);
      const next = remaining[0] ?? null;
      if (next) {
        setSelectedId(next.id);
        setDraft(draftFromTemplate(next));
        setIsNew(false);
      } else {
        startNew();
      }
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to remove workflow";
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Manage workflows"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Manage workflows</h2>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          <aside className={styles.listPane}>
            <div className={styles.listScroll}>
              {workflows.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={styles.listItem}
                  data-active={
                    !isNew && selectedId === t.id ? "true" : undefined
                  }
                  onClick={() => pickTemplate(t)}
                >
                  <span className={styles.listName}>{t.name}</span>
                  {t.builtin && (
                    <span className={styles.builtinTag}>builtin</span>
                  )}
                </button>
              ))}
              {isNew && (
                <button
                  type="button"
                  className={styles.listItem}
                  data-active="true"
                >
                  <span className={styles.listName}>
                    {draft?.name || "New workflow"}
                  </span>
                </button>
              )}
            </div>
            <div className={styles.listActions}>
              <button
                type="button"
                className={styles.newBtn}
                onClick={startNew}
                disabled={saving}
              >
                New workflow
              </button>
              <button
                type="button"
                className={styles.deleteBtn}
                data-confirm={confirmDelete ? "true" : undefined}
                disabled={
                  saving || !selected || selected.builtin || isNew
                }
                onClick={() => void removeSelected()}
              >
                {confirmDelete
                  ? "Confirm delete"
                  : selected?.builtin
                    ? "Builtin (locked)"
                    : "Delete"}
              </button>
            </div>
          </aside>

          <div className={styles.editor}>
            {!draft ? (
              <div className={styles.emptyEditor}>
                Select or create a workflow template.
              </div>
            ) : (
              <>
                <div className={styles.editorScroll}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="wf-name">
                      Name
                    </label>
                    <input
                      id="wf-name"
                      className={styles.input}
                      value={draft.name}
                      onChange={(e) =>
                        setDraft((prev) =>
                          prev ? { ...prev, name: e.target.value } : prev,
                        )
                      }
                      disabled={saving}
                    />
                    {draft.builtin && (
                      <p className={styles.hint}>
                        Builtin template. Saving creates a copy you can edit
                        freely.
                      </p>
                    )}
                  </div>

                  <div className={styles.phasesHead}>
                    <span className={styles.label}>
                      Phases ({draft.phases.length}/6)
                    </span>
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={addPhase}
                      disabled={saving || draft.phases.length >= 6}
                    >
                      Add phase
                    </button>
                  </div>

                  {draft.phases.map((phase, index) => {
                    const providerInfo = providers.find(
                      (p) => p.id === phase.provider,
                    );
                    const models = providerInfo?.models ?? [];
                    const showModel = models.length > 0;
                    return (
                      <section key={index} className={styles.phaseCard}>
                        <div className={styles.phaseTop}>
                          <span className={styles.phaseTitle}>
                            Phase {index + 1}
                          </span>
                          <div className={styles.phaseTools}>
                            <button
                              type="button"
                              className={styles.iconBtn}
                              aria-label="Move phase up"
                              disabled={saving || index === 0}
                              onClick={() => movePhase(index, -1)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className={styles.iconBtn}
                              aria-label="Move phase down"
                              disabled={
                                saving || index === draft.phases.length - 1
                              }
                              onClick={() => movePhase(index, 1)}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                              aria-label="Remove phase"
                              disabled={saving || draft.phases.length <= 1}
                              onClick={() => removePhase(index)}
                            >
                              ×
                            </button>
                          </div>
                        </div>

                        <div className={styles.field}>
                          <label className={styles.label}>Name</label>
                          <input
                            className={styles.input}
                            value={phase.name}
                            onChange={(e) =>
                              updatePhase(index, { name: e.target.value })
                            }
                            disabled={saving}
                          />
                        </div>

                        <div className={showModel ? styles.row3 : styles.row2}>
                          <div className={styles.field}>
                            <span className={styles.label}>Agents</span>
                            <div className={styles.stepper}>
                              <button
                                type="button"
                                className={styles.iconBtn}
                                aria-label="Decrease agent count"
                                disabled={saving || phase.agentCount <= 1}
                                onClick={() =>
                                  updatePhase(index, {
                                    agentCount: Math.max(
                                      1,
                                      phase.agentCount - 1,
                                    ),
                                  })
                                }
                              >
                                −
                              </button>
                              <span className={styles.stepValue}>
                                {phase.agentCount}
                              </span>
                              <button
                                type="button"
                                className={styles.iconBtn}
                                aria-label="Increase agent count"
                                disabled={saving || phase.agentCount >= 4}
                                onClick={() =>
                                  updatePhase(index, {
                                    agentCount: Math.min(
                                      4,
                                      phase.agentCount + 1,
                                    ),
                                  })
                                }
                              >
                                +
                              </button>
                            </div>
                          </div>

                          <div className={styles.field}>
                            <label className={styles.label}>Provider</label>
                            <select
                              className={styles.select}
                              value={phase.provider}
                              onChange={(e) => {
                                const nextId = e.target.value;
                                const next = providers.find(
                                  (p) => p.id === nextId,
                                );
                                const nextModels = next?.models ?? [];
                                const modelStillValid =
                                  phase.model != null &&
                                  nextModels.includes(phase.model);
                                updatePhase(index, {
                                  provider: nextId,
                                  model: modelStillValid ? phase.model : null,
                                });
                              }}
                              disabled={saving}
                            >
                              {providers.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                  {!p.available ? " (not installed)" : ""}
                                </option>
                              ))}
                            </select>
                          </div>

                          {showModel && (
                            <div className={styles.field}>
                              <label className={styles.label}>Model</label>
                              <select
                                className={styles.select}
                                value={phase.model ?? ""}
                                onChange={(e) =>
                                  updatePhase(index, {
                                    model:
                                      e.target.value === ""
                                        ? null
                                        : e.target.value,
                                  })
                                }
                                disabled={saving}
                              >
                                <option value="">Default</option>
                                {models.map((m) => (
                                  <option key={m} value={m}>
                                    {m}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                        </div>

                        <div className={styles.field}>
                          <label className={styles.label}>Instruction</label>
                          <textarea
                            className={styles.textarea}
                            value={phase.instruction}
                            onChange={(e) =>
                              updatePhase(index, {
                                instruction: e.target.value,
                              })
                            }
                            disabled={saving}
                            rows={3}
                          />
                        </div>
                      </section>
                    );
                  })}
                </div>

                <footer className={styles.footer}>
                  {error ? (
                    <div className={styles.errorInline} role="alert">
                      {error}
                    </div>
                  ) : (
                    <div className={styles.errorInline} />
                  )}
                  <div className={styles.footerActions}>
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={onClose}
                      disabled={saving}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={() => void save()}
                      disabled={saving}
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </footer>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
