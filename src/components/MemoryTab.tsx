import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryEntryInfo } from "../shared/ipc";
import { formatRelativeAge } from "../format";
import styles from "./MemoryTab.module.css";
import {
  actionErrorFor,
  afterCollapse,
  beginConfirmDelete,
  cancelConfirmDelete,
  cancelEdit,
  clearActionError,
  clearAllCardActions,
  clearEntryActions,
  draftFor,
  emptyCardActions,
  isConfirmDelete,
  isEditing,
  memoryCardState,
  setActionError,
  setDraft,
  startEdit,
} from "../memoryCard";

const MEMORY_NOT_RUNNING = "Memory server is not running.";
const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 3;
const RECENT_LIMIT = 20;

type StoreType = "knowledge" | "convention" | "task" | "strategy";

export interface MemoryTabProps {
  /** Project PATH of the selected thread (falls back to slug). The memory
   *  server canonicalizes a path to the repo-root basename — the same key
   *  agents store under — while a display slug like "owner/solenta" resolves
   *  to a scope no agent ever writes to. */
  projectSlug: string | null;
  searchMemory: (input: {
    query: string;
    project?: string;
  }) => Promise<MemoryEntryInfo[]>;
  recentMemory: (input?: {
    limit?: number;
    project?: string;
  }) => Promise<MemoryEntryInfo[]>;
  getMemory: (input: { id: string }) => Promise<MemoryEntryInfo>;
  updateMemory: (input: {
    id: string;
    title: string;
    body: string;
  }) => Promise<{ id: string }>;
  removeMemory: (input: { id: string }) => Promise<void>;
  storeMemory: (input: {
    type: MemoryEntryInfo["type"];
    title: string;
    body: string;
    project?: string;
  }) => Promise<{ id: string }>;
}

function isNotRunningError(err: unknown): boolean {
  if (err instanceof Error && err.message === MEMORY_NOT_RUNNING) return true;
  return String(err).includes(MEMORY_NOT_RUNNING);
}

function typeBadgeClass(type: MemoryEntryInfo["type"]): string {
  if (type === "convention") return styles.badgeConvention;
  if (type === "strategy") return styles.badgeStrategy;
  if (type === "knowledge") return styles.badgeKnowledge;
  if (type === "task") return styles.badgeTask;
  return styles.badgeRun;
}

function ageFromIso(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return formatRelativeAge(ms, now);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export function MemoryTab({
  projectSlug,
  searchMemory,
  recentMemory,
  getMemory,
  updateMemory,
  removeMemory,
  storeMemory,
}: MemoryTabProps) {
  const [entries, setEntries] = useState<MemoryEntryInfo[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /**
   * Drafts, edit intent, delete-confirm, and action errors keyed by entry id.
   * Collapse keeps drafts; card A cannot paint on card B by construction.
   */
  const [cardActions, setCardActions] = useState(emptyCardActions);
  const [actionBusy, setActionBusy] = useState(false);
  const [fullBodies, setFullBodies] = useState<Record<string, string>>({});
  /** Ids whose memory.get failed (non-not-running); re-click retries. */
  const [failedIds, setFailedIds] = useState<Record<string, string>>({});
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [formType, setFormType] = useState<StoreType>("knowledge");
  const [formTitle, setFormTitle] = useState("");
  const [formBody, setFormBody] = useState("");
  /** List filter: pass selected thread project into search/recent (off by default). */
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /** Bumped so late awaits do not clobber newer list results. */
  const listGen = useRef(0);
  const expandedRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  /** Latest search box text for Retry after not-running. */
  const queryRef = useRef(query);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    expandedRef.current = expandedId;
  }, [expandedId]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(handle);
  }, []);

  // Memory is project-scoped: when a project is selected the tab shows that
  // project and nothing else. No opt-in toggle; cross-project browsing is not
  // a thing the server offers for a scoped query.
  const listProjectFilter = projectSlug ?? undefined;

  const loadRecent = useCallback(async () => {
    const gen = ++listGen.current;
    setLoading(true);
    try {
      const project = projectSlug ?? undefined;
      const list = await recentMemory({
        limit: RECENT_LIMIT,
        ...(project ? { project } : {}),
      });
      if (!mountedRef.current || listGen.current !== gen) return;
      setEntries(list);
      setFullBodies({});
      setExpandedId(null);
      setFailedIds({});
      setCardActions(clearAllCardActions());
      setListError(null);
      setServerDown(false);
    } catch (err) {
      if (!mountedRef.current || listGen.current !== gen) return;
      if (isNotRunningError(err)) {
        setServerDown(true);
        setEntries([]);
        setListError(null);
      } else {
        setListError(errorMessage(err));
        setEntries([]);
      }
    } finally {
      if (mountedRef.current && listGen.current === gen) {
        setLoading(false);
      }
    }
  }, [recentMemory, projectSlug]);

  const runSearch = useCallback(
    async (q: string) => {
      const gen = ++listGen.current;
      setLoading(true);
      try {
        const project = projectSlug ?? undefined;
        const list = await searchMemory({
          query: q,
          ...(project ? { project } : {}),
        });
        if (!mountedRef.current || listGen.current !== gen) return;
        setEntries(list);
        setFullBodies({});
        setExpandedId(null);
        setFailedIds({});
        setCardActions(clearAllCardActions());
        setListError(null);
        setServerDown(false);
      } catch (err) {
        if (!mountedRef.current || listGen.current !== gen) return;
        if (isNotRunningError(err)) {
          setServerDown(true);
          setEntries([]);
          setListError(null);
        } else {
          setListError(errorMessage(err));
          setEntries([]);
        }
      } finally {
        if (mountedRef.current && listGen.current === gen) {
          setLoading(false);
        }
      }
    },
    [searchMemory, projectSlug],
  );

  /** Retry after not-running: re-run active search when query is long enough. */
  const reloadCurrent = useCallback(() => {
    const trimmed = queryRef.current.trim();
    if (trimmed.length >= MIN_QUERY_LEN) {
      void runSearch(trimmed);
    } else {
      void loadRecent();
    }
  }, [loadRecent, runSearch]);

  // Lazy first open (tab mount with empty query) + debounced search.
  // Empty query → recent; 3+ chars → search after 300ms; 1–2 chars leave list as-is.
  // Project filter toggles also re-run the current list.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      void loadRecent();
      return;
    }
    if (trimmed.length < MIN_QUERY_LEN) return;

    const handle = window.setTimeout(() => {
      void runSearch(trimmed);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, loadRecent, runSearch, listProjectFilter]);

  const toggleExpand = async (id: string) => {
    // Collapse keeps drafts and edit intent (afterCollapse only drops confirm UI).
    // Never wipe cardActions here: that is what silently destroyed mid-edit text.
    if (expandedId === id) {
      setExpandedId(null);
      setCardActions((prev) => afterCollapse(prev, id));
      return;
    }
    setExpandedId(id);
    if (fullBodies[id]) return;

    setExpandingId(id);
    setFailedIds((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const entry = await getMemory({ id });
      if (!mountedRef.current || expandedRef.current !== id) return;
      setFullBodies((prev) => ({ ...prev, [id]: entry.body }));
      setFailedIds((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setServerDown(false);
    } catch (err) {
      if (!mountedRef.current) return;
      if (isNotRunningError(err)) {
        setServerDown(true);
        setExpandedId(null);
      } else if (expandedRef.current === id) {
        setFailedIds((prev) => ({ ...prev, [id]: errorMessage(err) }));
      }
    } finally {
      if (mountedRef.current) setExpandingId(null);
    }
  };

  const handleSave = async () => {
    setFormError(null);
    const title = formTitle.trim();
    const body = formBody.trim();
    if (!title) {
      setFormError("Title is required");
      return;
    }
    if (!body) {
      setFormError("Body is required");
      return;
    }
    setSaving(true);
    try {
      await storeMemory({
        type: formType,
        title,
        body,
        // Always belongs to the current project when there is one.
        ...(projectSlug ? { project: projectSlug } : {}),
      });
      if (!mountedRef.current) return;
      setFormTitle("");
      setFormBody("");
      setFormType("knowledge");
      setServerDown(false);
      setQuery("");
      await loadRecent();
    } catch (err) {
      if (!mountedRef.current) return;
      if (isNotRunningError(err)) {
        setServerDown(true);
      } else {
        setFormError(
          err instanceof Error && err.message
            ? err.message
            : "Failed to store memory",
        );
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  /** Only ever called with the fetched body; the Edit button is disabled without it. */
  const beginEdit = (entry: MemoryEntryInfo, fullBody: string) => {
    setCardActions((prev) => startEdit(prev, entry.id, entry.title, fullBody));
  };

  const saveEdit = async (id: string) => {
    const draft = draftFor(cardActions, id);
    if (!draft) return;
    const title = draft.title.trim();
    const body = draft.body.trim();
    if (!title || !body) {
      setCardActions((prev) =>
        setActionError(prev, id, "Title and body are required"),
      );
      return;
    }
    setActionBusy(true);
    setCardActions((prev) => clearActionError(prev, id));
    try {
      await updateMemory({ id, title, body });
      if (!mountedRef.current) return;
      setCardActions((prev) => clearEntryActions(prev, id));
      setExpandedId(null);
      reloadCurrent();
    } catch (err) {
      if (!mountedRef.current) return;
      if (isNotRunningError(err)) setServerDown(true);
      else
        setCardActions((prev) => setActionError(prev, id, errorMessage(err)));
    } finally {
      if (mountedRef.current) setActionBusy(false);
    }
  };

  const confirmDelete = async (id: string) => {
    setActionBusy(true);
    setCardActions((prev) => clearActionError(prev, id));
    try {
      await removeMemory({ id });
      if (!mountedRef.current) return;
      setCardActions((prev) => clearEntryActions(prev, id));
      setExpandedId(null);
      reloadCurrent();
    } catch (err) {
      if (!mountedRef.current) return;
      if (isNotRunningError(err)) setServerDown(true);
      else
        setCardActions((prev) => setActionError(prev, id, errorMessage(err)));
    } finally {
      if (mountedRef.current) setActionBusy(false);
    }
  };

  if (serverDown) {
    return (
      <div className={styles.downWrap}>
        <p className={styles.downMessage}>{MEMORY_NOT_RUNNING}</p>
        <button
          type="button"
          className={styles.retryBtn}
          onClick={() => {
            setServerDown(false);
            reloadCurrent();
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.searchRow}>
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search shared memory..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search shared memory"
        />
        <span className={styles.filterLabel} title="Memory is scoped to this project">
          {projectSlug ? projectSlug.split("/").filter(Boolean).pop() : "all projects"}
        </span>
      </div>

      <div className={styles.list}>
        {listError && (
          <p className={styles.formError} role="alert">
            {listError}
          </p>
        )}
        {loading && entries.length === 0 ? (
          <p className={styles.empty}>Loading…</p>
        ) : entries.length === 0 && !listError ? (
          <p className={styles.empty}>
            {query.trim().length >= MIN_QUERY_LEN
              ? "No matching memories"
              : "No recent memories"}
          </p>
        ) : (
          entries.map((entry) => {
            const open = expandedId === entry.id;
            const full = fullBodies[entry.id];
            const getError = failedIds[entry.id];
            const draft = draftFor(cardActions, entry.id);
            const cardError = actionErrorFor(cardActions, entry.id);
            const { loadingBody, showError, editing, showActions, canEdit } =
              memoryCardState({
                expanding: expandingId === entry.id,
                hasFull: full != null,
                hasError: getError != null,
                editRequested: isEditing(cardActions, entry.id),
              });
            return (
              <div key={entry.id} className={styles.card} data-expanded={open}>
                {/* The toggle is its own button so the edit form and the
                    Edit/Delete controls are siblings, not nested interactives. */}
                <button
                  type="button"
                  className={styles.cardToggle}
                  onClick={() => void toggleExpand(entry.id)}
                  aria-expanded={open}
                >
                  <div className={styles.cardHead}>
                    <span
                      className={`${styles.badge} ${typeBadgeClass(entry.type)}`}
                    >
                      {entry.type}
                    </span>
                    <span className={styles.age}>
                      {ageFromIso(entry.updatedAt, now)}
                    </span>
                  </div>
                  <div className={styles.cardTitle}>{entry.title}</div>
                  {!open && <div className={styles.excerpt}>{entry.body}</div>}
                </button>
                {open ? (
                  <div className={styles.fullBodyWrap}>
                    {loadingBody ? (
                      <p className={styles.bodyLoading}>Loading…</p>
                    ) : showError ? (
                      <p className={styles.bodyError} role="alert">
                        {getError}
                      </p>
                    ) : editing && draft ? (
                      <div className={styles.editWrap}>
                        <input
                          className={styles.titleInput}
                          value={draft.title}
                          onChange={(e) =>
                            setCardActions((prev) =>
                              setDraft(prev, entry.id, {
                                title: e.target.value,
                                body: draft.body,
                              }),
                            )
                          }
                          aria-label="Edit title"
                        />
                        <textarea
                          className={styles.bodyInput}
                          value={draft.body}
                          onChange={(e) =>
                            setCardActions((prev) =>
                              setDraft(prev, entry.id, {
                                title: draft.title,
                                body: e.target.value,
                              }),
                            )
                          }
                          rows={6}
                          aria-label="Edit body"
                        />
                        <div className={styles.entryActions}>
                          <button
                            type="button"
                            className={styles.saveBtn}
                            disabled={actionBusy}
                            onClick={() => void saveEdit(entry.id)}
                          >
                            {actionBusy ? "Saving…" : "Save correction"}
                          </button>
                          <button
                            type="button"
                            className={styles.retryBtn}
                            disabled={actionBusy}
                            onClick={() =>
                              setCardActions((prev) =>
                                cancelEdit(prev, entry.id),
                              )
                            }
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : full ? (
                      <pre className={styles.fullBody}>{full}</pre>
                    ) : (
                      <p className={styles.bodyLoading}>Loading…</p>
                    )}
                    {showActions && (
                      <div className={styles.entryActions}>
                        {isConfirmDelete(cardActions, entry.id) ? (
                          <>
                            <span className={styles.confirmText}>
                              Delete permanently?
                            </span>
                            <button
                              type="button"
                              className={styles.dangerBtn}
                              disabled={actionBusy}
                              onClick={() => void confirmDelete(entry.id)}
                            >
                              {actionBusy ? "Deleting…" : "Delete"}
                            </button>
                            <button
                              type="button"
                              className={styles.retryBtn}
                              disabled={actionBusy}
                              onClick={() =>
                                setCardActions((prev) =>
                                  cancelConfirmDelete(prev, entry.id),
                                )
                              }
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className={styles.retryBtn}
                              // entry.body is the list excerpt, not the body:
                              // editing without the real body would save the
                              // truncation over the original.
                              disabled={!canEdit}
                              title={
                                canEdit ? undefined : "Body not loaded yet"
                              }
                              onClick={() => beginEdit(entry, full!)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className={styles.retryBtn}
                              onClick={() =>
                                setCardActions((prev) =>
                                  beginConfirmDelete(prev, entry.id),
                                )
                              }
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    {cardError ? (
                      <p className={styles.bodyError} role="alert">
                        {cardError}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {entry.project && (
                  <span className={styles.projectTag} title={entry.project}>
                    {entry.project}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        <div className={styles.formLabel}>Remember something</div>
        <div className={styles.formRow}>
          <select
            className={styles.select}
            value={formType}
            onChange={(e) => setFormType(e.target.value as StoreType)}
            aria-label="Memory type"
          >
            <option value="knowledge">knowledge</option>
            <option value="convention">convention</option>
            <option value="strategy">strategy</option>
            <option value="task">task</option>
          </select>
          <input
            type="text"
            className={styles.titleInput}
            placeholder="Title"
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            aria-label="Memory title"
          />
        </div>
        <textarea
          className={styles.bodyInput}
          placeholder="What should future sessions know?"
          value={formBody}
          onChange={(e) => setFormBody(e.target.value)}
          rows={3}
          aria-label="Memory body"
        />
        <p className={styles.checkboxLabel}>
          {projectSlug
            ? `Saved to ${projectSlug}`
            : "Saved without a project (select a thread to scope it)"}
        </p>
        {formError && (
          <p className={styles.formError} role="alert">
            {formError}
          </p>
        )}
        <button
          type="submit"
          className={styles.saveBtn}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
