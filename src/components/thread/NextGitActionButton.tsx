import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BlastRadiusInfo,
  CoderApi,
  DiffResult,
  GitSyncInfo,
  MergeMethod,
  MergeOptionsResult,
  PrChecksResult,
  PrInfo,
  PrTemplateResult,
  SourceControlDiscovery,
  ThreadInfo,
} from "../../shared/ipc";
import { isEmptyDiff } from "../../diffView";
import { createPrPrompt, isPrTooLargeMessage, splitPrPrompt } from "../../prUi";
import { CreatePrDialog } from "../CreatePrDialog";
import {
  blastRadiusLabel,
  blastRadiusTitle,
  isCiWorkflowBlockMessage,
} from "../../blastRadius";
import { suggestNextGitAction } from "../../nextGitAction";
import { forgeReadiness } from "../../sourceControl";
import styles from "../ThreadView.module.css";

const PUSH_FLASH_MS = 3000;

const CHECKS_POLL_MS = 8000;

const NO_LINE_TOTALS = { added: 0, removed: 0 };

const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  squash: "Squash",
  merge: "Merge commit",
  rebase: "Rebase",
};

type PrMergeOpts = {
  ciWorkflowApproved?: boolean;
  method?: MergeMethod;
  auto?: boolean;
};

function coderGit(): CoderApi["git"] | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { coder?: CoderApi }).coder?.git;
}

/** Sum of per-file +/− lines for the header commit button (#1429). */
export function diffLineTotals(
  files: readonly { additions?: number; deletions?: number }[],
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.additions || 0;
    removed += f.deletions || 0;
  }
  return { added, removed };
}

export function NextGitActionButton({
  thread,
  isWorking,
  remoteProject,
  changesOpen,
  changesNonce,
  syncRefreshNonce,
  onFetchDiff,
  gitSyncInfo,
  onViewChanges,
  onPush,
  onCreatePr,
  loadPrTemplate,
  onPrChecks,
  onPrStatus,
  onPrMerge,
  onStartRun,
  providerName,
  onPushed,
  onMore,
  prRequest,
}: {
  thread: ThreadInfo;
  isWorking: boolean;
  remoteProject: boolean;
  changesOpen: boolean;
  changesNonce: number;
  syncRefreshNonce: number;
  onFetchDiff: () => Promise<DiffResult>;
  gitSyncInfo?: (threadId: string) => Promise<GitSyncInfo>;
  onViewChanges?: () => void;
  onPush: () => Promise<{ remote: string; branch: string }>;
  onCreatePr?: (input: {
    title: string;
    body?: string;
    draft?: boolean;
    allowOversize?: boolean;
  }) => Promise<PrInfo>;
  loadPrTemplate?: () => Promise<PrTemplateResult>;
  onPrChecks?: () => Promise<PrChecksResult>;
  onPrStatus?: () => Promise<PrInfo | null>;
  onPrMerge?: (opts?: PrMergeOpts) => Promise<PrInfo>;
  onStartRun: (prompt: string) => void | Promise<void>;
  providerName: string;
  onPushed: () => void;
  /** Split-button chevron: open Thread details, where every git step lives. */
  onMore?: () => void;
  /** Bumped by Thread details' Create PR: open the same PR dialog. */
  prRequest?: number;
}) {
  const [dirty, setDirty] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const [lineTotals, setLineTotals] = useState(NO_LINE_TOTALS);
  const [sync, setSync] = useState<GitSyncInfo | null>(null);
  const [checks, setChecks] = useState<PrChecksResult | null>(null);
  const [pending, setPending] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  /** Size-cap refusal message while the split/override choice is showing. */
  const [oversizeMsg, setOversizeMsg] = useState<string | null>(null);
  const [blastRadius, setBlastRadius] = useState<BlastRadiusInfo | null>(
    null,
  );
  /** Confirm bar for CI-workflow merge sign-off (issue #510). */
  const [ciSignOff, setCiSignOff] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [mergeOpts, setMergeOpts] = useState<MergeOptionsResult | null>(null);
  const [method, setMethod] = useState<MergeMethod | null>(null);
  /** The CI sign-off bar is confirming an auto-merge, not a merge now. */
  const signOffAuto = useRef(false);
  const lastSubmit = useRef({ title: thread.title, body: "", draft: false });
  const [github, setGithub] = useState<{
    ready: boolean;
    hint: string | null;
  } | null>(null);
  const threadRef = useRef(thread.id);
  threadRef.current = thread.id;
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadForge = useCallback(async (rescan = false) => {
    try {
      const existing = (window as unknown as { coder?: CoderApi }).coder;
      const discover = existing?.sourceControl?.discover;
      if (typeof discover !== "function") return;
      const next: SourceControlDiscovery = await discover(
        rescan ? { rescan: true } : undefined,
      );
      setGithub(forgeReadiness(next, "github"));
    } catch {
      // Probe failed: leave the button on the click-and-fail path.
    }
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimer.current != null) clearTimeout(flashTimer.current);
    };
  }, []);

  useEffect(() => {
    setDirty(false);
    setFileCount(0);
    setLineTotals(NO_LINE_TOTALS);
    setSync(null);
    setChecks(null);
    setPending(false);
    setFlash(null);
    setOversizeMsg(null);
    setBlastRadius(null);
    setCiSignOff(false);
    setComposerOpen(false);
    setComposerError(null);
    setMethod(null);
    signOffAuto.current = false;
    lastSubmit.current = { title: thread.title, body: "", draft: false };
  }, [thread.id]);

  // Repo-allowed merge methods (cached main-side), once per open PR.
  const hasMerge = Boolean(onPrMerge);
  const openPr =
    thread.prNumber != null &&
    thread.prState !== "MERGED" &&
    thread.prState !== "CLOSED";
  useEffect(() => {
    setMergeOpts(null);
    const load = coderGit()?.mergeOptions;
    if (!hasMerge || !openPr || remoteProject || typeof load !== "function") {
      return;
    }
    let live = true;
    load({ threadId: thread.id })
      .then((result) => {
        if (live) setMergeOpts(result);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [thread.id, hasMerge, openPr, remoteProject]);
  const mergeMethods = mergeOpts?.ok ? mergeOpts.methods : null;
  const chosenMethod: MergeMethod | undefined =
    method ?? (mergeOpts?.ok ? mergeOpts.defaultMethod : undefined);

  const loadGit = useCallback(async () => {
    const id = thread.id;
    try {
      const diff = await onFetchDiff();
      if (threadRef.current !== id) return;
      setDirty(!isEmptyDiff(diff));
      setFileCount(diff.files.length);
      setLineTotals(diffLineTotals(diff.files));
      setBlastRadius(diff.blastRadius ?? null);
    } catch {
      if (threadRef.current !== id) return;
      setDirty(false);
      setFileCount(0);
      setLineTotals(NO_LINE_TOTALS);
      setBlastRadius(null);
    }
    if (!gitSyncInfo) {
      if (threadRef.current === id) setSync(null);
      return;
    }
    try {
      const next = await gitSyncInfo(id);
      if (threadRef.current === id) setSync(next);
    } catch {
      if (threadRef.current === id) setSync(null);
    }
  }, [thread.id, onFetchDiff, gitSyncInfo]);

  const loadChecks = useCallback(async () => {
    if (
      !onPrChecks ||
      thread.prNumber == null ||
      thread.prState === "MERGED" ||
      thread.prState === "CLOSED"
    ) {
      setChecks(null);
      return;
    }
    const id = thread.id;
    try {
      const next = await onPrChecks();
      if (threadRef.current === id) setChecks(next);
    } catch {
      if (threadRef.current === id) {
        setChecks({ ok: false, reason: "failed to load checks" });
      }
    }
  }, [thread.id, thread.prNumber, thread.prState, onPrChecks]);

  useEffect(() => {
    // Do not re-poll git on every updatedAt tick: a streaming turn used to
    // re-arm git.diff from the previous spawn's close callback (~65 git/s
    // at idle once anything bumped updatedAt). Status / Changes / sync
    // nonce still refetch. Skip while working — the button is disabled
    // and the run-end status change is the right refresh (#688).
    if (thread.status === "working" || thread.status === "quota-wait") return;
    void loadGit();
    void loadForge(false);
  }, [
    loadGit,
    loadForge,
    changesNonce,
    changesOpen,
    thread.status,
    syncRefreshNonce,
  ]);

  useEffect(() => {
    void loadChecks();
  }, [loadChecks, thread.status]);

  // Find a PR opened outside Create PR (an agent's `gh pr create`, the
  // GitHub site). Only while none is recorded; after each run settles.
  const githubReady = Boolean(github?.ready);
  useEffect(() => {
    if (
      !onPrStatus ||
      remoteProject ||
      !githubReady ||
      !thread.branch ||
      !thread.worktreePath ||
      thread.prNumber != null ||
      thread.status === "working" ||
      thread.status === "quota-wait"
    ) {
      return;
    }
    // Non-GitHub origin or gh failure: stay on Create PR.
    onPrStatus().catch(() => {});
  }, [
    thread.id,
    thread.branch,
    thread.worktreePath,
    thread.prNumber,
    thread.status,
    remoteProject,
    githubReady,
    onPrStatus,
  ]);

  const lastPrRequest = useRef(prRequest ?? 0);
  useEffect(() => {
    if (!prRequest || prRequest === lastPrRequest.current) return;
    lastPrRequest.current = prRequest;
    if (onCreatePr) {
      setComposerError(null);
      setComposerOpen(true);
    } else {
      void onStartRun(createPrPrompt(providerName));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prRequest]);

  const decided = suggestNextGitAction({
    dirty,
    fileCount,
    sync,
    hasWorktree: Boolean(thread.worktreePath),
    remoteProject,
    prNumber: thread.prNumber,
    prUrl: thread.prUrl,
    prState: thread.prState,
    mergeable: thread.prMergeable,
    checks,
    github,
  });
  const action =
    decided.kind === "merge" && !onPrMerge
      ? { ...decided, actionable: false }
      : decided;

  useEffect(() => {
    if (action.kind !== "watch-checks") return;
    // gh checks poll: skip while the window is hidden — the badge can't be
    // seen, and each tick spawns a gh process per open watching thread.
    const id = window.setInterval(() => {
      if (!document.hidden) void loadChecks();
    }, CHECKS_POLL_MS);
    return () => window.clearInterval(id);
  }, [action.kind, loadChecks]);

  const handleClick = async () => {
    if (!action.actionable || pending || isWorking) return;
    if (action.kind === "commit") {
      onViewChanges?.();
      return;
    }
    if (action.kind === "push") {
      setPending(true);
      setFlash(null);
      if (flashTimer.current != null) {
        clearTimeout(flashTimer.current);
        flashTimer.current = null;
      }
      try {
        const result = await onPush();
        setFlash(`Pushed ${result.branch}`);
        onPushed();
        flashTimer.current = setTimeout(() => {
          setFlash(null);
          flashTimer.current = null;
        }, PUSH_FLASH_MS);
        await loadGit();
      } catch {
        // Parent surfaces rejections via the runError banner.
        void loadForge(true);
      } finally {
        setPending(false);
      }
      return;
    }
    if (action.kind === "create-pr") {
      if (onCreatePr) {
        setComposerError(null);
        setComposerOpen(true);
        return;
      }
      void onStartRun(createPrPrompt(providerName));
      return;
    }
    if (action.kind === "watch-checks" || action.kind === "checks-failed") {
      void loadChecks();
      return;
    }
    if (action.kind === "merge") {
      if (!onPrMerge) return;
      if (blastRadius) {
        signOffAuto.current = false;
        setCiSignOff(true);
        return;
      }
      setPending(true);
      try {
        await onPrMerge({ method: chosenMethod });
        await loadGit();
        await loadChecks();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isCiWorkflowBlockMessage(msg)) {
          signOffAuto.current = false;
          setCiSignOff(true);
        } else {
          void loadForge(true);
        }
      } finally {
        setPending(false);
      }
    }
  };

  /** `gh pr merge --auto`: GitHub merges once required checks pass. */
  const enableAutoMerge = async () => {
    if (!onPrMerge || pending || isWorking) return;
    if (blastRadius) {
      signOffAuto.current = true;
      setCiSignOff(true);
      return;
    }
    setPending(true);
    try {
      await onPrMerge({ method: chosenMethod, auto: true });
      showFlash("Auto-merge on");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isCiWorkflowBlockMessage(msg)) {
        signOffAuto.current = true;
        setCiSignOff(true);
      } else {
        void loadForge(true);
      }
    } finally {
      setPending(false);
    }
  };

  const showFlash = (text: string) => {
    if (flashTimer.current != null) clearTimeout(flashTimer.current);
    setFlash(text);
    flashTimer.current = setTimeout(() => {
      setFlash(null);
      flashTimer.current = null;
    }, PUSH_FLASH_MS);
  };

  const approveCiAndMerge = async () => {
    if (!onPrMerge || pending || isWorking) return;
    setPending(true);
    try {
      const auto = signOffAuto.current;
      await onPrMerge({ ciWorkflowApproved: true, method: chosenMethod, auto });
      setCiSignOff(false);
      if (auto) showFlash("Auto-merge on");
      await loadGit();
      await loadChecks();
    } catch {
      void loadForge(true);
    } finally {
      setPending(false);
    }
  };

  const submitPr = async (input: {
    title: string;
    body: string;
    draft: boolean;
    allowOversize?: boolean;
  }) => {
    if (!onCreatePr || pending || isWorking) return;
    lastSubmit.current = {
      title: input.title,
      body: input.body,
      draft: input.draft,
    };
    setPending(true);
    try {
      await onCreatePr(input);
      setComposerOpen(false);
      setComposerError(null);
      setOversizeMsg(null);
      await loadGit();
      await loadChecks();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isPrTooLargeMessage(msg)) {
        setComposerError(msg);
        setOversizeMsg(msg);
      } else {
        setComposerError(msg);
        void loadForge(true);
      }
    } finally {
      setPending(false);
    }
  };

  /** Retry PR creation with the explicit size-cap override (issue #402). */
  const createOversizePr = async () => {
    if (!onCreatePr || pending || isWorking) return;
    await submitPr({ ...lastSubmit.current, allowOversize: true });
  };

  const prDialog = composerOpen ? (
    <CreatePrDialog
      initialTitle={thread.title}
      loadTemplate={loadPrTemplate}
      onGenerate={
        typeof coderGit()?.suggestPrText === "function"
          ? () => coderGit()!.suggestPrText({ threadId: thread.id })
          : undefined
      }
      pending={pending}
      error={composerError}
      oversize={oversizeMsg != null}
      onSubmit={(input) => void submitPr(input)}
      onSplit={() => {
        setComposerOpen(false);
        setOversizeMsg(null);
        void onStartRun(splitPrPrompt(providerName));
      }}
      onCreateAnyway={() => void createOversizePr()}
      onClose={() => {
        if (pending) return;
        setComposerOpen(false);
        setComposerError(null);
      }}
    />
  ) : null;

  // Nothing to suggest: no button, but a PR asked for from Thread details
  // still gets its dialog.
  if (action.kind === "idle") return prDialog;

  const disabled = isWorking || pending || !action.actionable;
  const label = pending
    ? action.kind === "push"
      ? "Pushing…"
      : action.kind === "create-pr"
        ? "Creating PR…"
        : action.kind === "merge"
          ? action.label === "Update from main"
            ? "Updating…"
            : "Merging…"
          : action.label
    : (flash ?? action.label);
  const className = [
    styles.btn,
    // The mock's commit button is a neutral surface so the green/red line
    // counts stay legible; push/PR/merge keep the yellow primary.
    action.primary && action.kind !== "commit" ? styles.btnPrimary : "",
    styles.pushBtn,
    onMore ? styles.gitSplitMain : "",
  ]
    .filter(Boolean)
    .join(" ");
  const dataCreatePr = action.kind === "create-pr" ? "" : undefined;
  const href = action.href;
  const baseTitle =
    action.kind === "merge" && chosenMethod && chosenMethod !== "squash"
      ? action.title.replace(
          /Squash-merge(?= this pull request)|squash-merge$/,
          chosenMethod === "rebase" ? "Rebase-merge" : "Merge",
        )
      : action.title;
  const actionTitle = blastRadius
    ? `${baseTitle} · ${blastRadiusTitle(blastRadius)}`
    : baseTitle;

  const mergeLike = action.kind === "merge" || action.kind === "watch-checks";
  const methodPicker =
    mergeLike && onPrMerge && mergeMethods && mergeMethods.length > 1 ? (
      <select
        className={styles.mergeMethod}
        data-merge-method=""
        aria-label="Merge method"
        value={chosenMethod}
        disabled={isWorking || pending}
        onChange={(event) => setMethod(event.target.value as MergeMethod)}
      >
        {mergeMethods.map((m) => (
          <option key={m} value={m}>
            {MERGE_METHOD_LABEL[m]}
          </option>
        ))}
      </select>
    ) : null;
  // Checks still running: offer to let GitHub merge once they pass.
  const autoMergeButton =
    action.kind === "watch-checks" && onPrMerge && checks?.ok ? (
      <button
        type="button"
        className={styles.btn}
        data-auto-merge=""
        disabled={isWorking || pending}
        title="Merge automatically once required checks pass (gh pr merge --auto)"
        onClick={() => void enableAutoMerge()}
      >
        Auto-merge
      </button>
    ) : null;

  const ciSignOffBar = ciSignOff ? (
    <span
      className={styles.oversizeBar}
      data-ci-signoff=""
      role="alertdialog"
    >
      <span className={styles.oversizeText}>
        {blastRadius
          ? blastRadiusTitle(blastRadius)
          : "This PR changes CI workflow files. Privilege-escalation — a human must sign off."}
      </span>
      <button
        type="button"
        className={styles.oversizeBtn}
        data-ci-signoff-approve=""
        disabled={isWorking || pending}
        onClick={() => void approveCiAndMerge()}
      >
        {signOffAuto.current ? "Sign off & auto-merge" : "Sign off & merge"}
      </button>
      <button
        type="button"
        className={styles.oversizeDismiss}
        data-ci-signoff-cancel=""
        aria-label="Cancel"
        onClick={() => setCiSignOff(false)}
      >
        ×
      </button>
    </span>
  ) : null;

  const moreButton = onMore ? (
      <button
        type="button"
        className={styles.gitMore}
        data-git-more=""
        aria-label="More git actions"
        title="Push, PR, merge and more in Thread details"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onMore}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
  ) : null;

  if (
    href &&
    (action.kind === "watch-checks" || action.kind === "checks-failed")
  ) {
    return (
      <>
      {blastRadius ? (
        <span
          className={styles.blastBadge}
          data-blast-radius="ci-workflow"
          title={blastRadiusTitle(blastRadius)}
        >
          {blastRadiusLabel(blastRadius)}
        </span>
      ) : null}
      <a
        className={className}
        data-next-git-action={action.kind}
        data-forge-blocked={
          github != null && !github.ready && !action.actionable
            ? ""
            : undefined
        }
        href={href}
        target="_blank"
        rel="noreferrer"
        title={actionTitle}
        aria-disabled={disabled ? "true" : undefined}
        onClick={() => {
          void loadChecks();
        }}
      >
        {pending && <span className={styles.pushSpinner} aria-hidden />}
        {label}
      </a>
      {methodPicker}
      {autoMergeButton}
      {moreButton}
      {ciSignOffBar}
      </>
    );
  }

  return (
    <>
      {blastRadius ? (
        <span
          className={styles.blastBadge}
          data-blast-radius="ci-workflow"
          title={blastRadiusTitle(blastRadius)}
        >
          {blastRadiusLabel(blastRadius)}
        </span>
      ) : null}
      {action.kind === "merge" ? methodPicker : null}
      <button
        type="button"
        className={className}
        data-next-git-action={action.kind}
        data-create-pr={dataCreatePr}
        data-forge-blocked={
          github != null && !github.ready && !action.actionable
            ? ""
            : undefined
        }
        disabled={disabled}
        aria-disabled={disabled ? "true" : undefined}
        aria-busy={pending || undefined}
        title={actionTitle}
        onClick={() => void handleClick()}
      >
        {pending && <span className={styles.pushSpinner} aria-hidden />}
        {label}
        {action.kind === "commit" && label === action.label &&
        (lineTotals.added > 0 || lineTotals.removed > 0) ? (
          <span className={styles.gitLines} data-git-line-counts="">
            <span className={styles.gitAdded}>+{lineTotals.added}</span>
            <span className={styles.gitRemoved}>−{lineTotals.removed}</span>
          </span>
        ) : null}
      </button>
      {action.kind === "watch-checks" ? methodPicker : null}
      {autoMergeButton}
      {moreButton}
      {ciSignOffBar}
      {oversizeMsg && !composerOpen ? (
        <span
          className={styles.oversizeBar}
          data-pr-oversize=""
          role="alert"
        >
          <span className={styles.oversizeText}>{oversizeMsg}</span>
          <button
            type="button"
            className={styles.oversizeBtn}
            data-pr-split=""
            onClick={() => {
              setOversizeMsg(null);
              void onStartRun(splitPrPrompt(providerName));
            }}
          >
            Split into stacked PRs
          </button>
          <button
            type="button"
            className={styles.oversizeBtn}
            data-pr-create-anyway=""
            disabled={disabled}
            onClick={() => void createOversizePr()}
          >
            Create anyway
          </button>
          <button
            type="button"
            className={styles.oversizeDismiss}
            aria-label="Dismiss"
            onClick={() => setOversizeMsg(null)}
          >
            ×
          </button>
        </span>
      ) : null}
      {prDialog}
    </>
  );
}
