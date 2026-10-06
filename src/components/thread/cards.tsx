import { Fragment, useEffect, useMemo, useState } from "react";
import type {
  PendingPermissionInfo,
  PermissionDecision,
  ProviderInfo,
  SpecArtifact,
  SpecStage,
  ThreadDetail,
  ThreadInfo,
  BtwCard as BtwCardInfo,
} from "../../shared/ipc";
import { SPEC_ARTIFACTS, FELT_ESTIMATE_BUCKETS_MS } from "../../shared/ipc";
import { resolveCoderApi } from "../../coderApi";
import { TEACH_AUTONOMY_LABELS } from "../../teach";
import type { TeachAutonomy } from "../../shared/ipc";
import {
  comparePeerLabel,
  compareSteps,
  extractSteps,
  formatDivergenceHeadline,
  isThreadDone,
  sameThreadRuns,
  truncateStepValue,
  useDivergenceCardEnabled,
  type ComparePeer,
  type DivergenceField,
} from "../../divergence";
import { Markdown } from "../Markdown";
import styles from "../ThreadView.module.css";

/**
 * Plan approval (ExitPlanMode): the plan rendered as markdown in the prompt
 * panel, approve or send the agent back to planning (with optional notes),
 * or take the plan elsewhere: a new thread, or a file in the checkout.
 */
export function PlanPrompt({
  pending,
  onRespond,
  onImplement,
  onSave,
}: {
  pending: PendingPermissionInfo;
  onRespond: (
    requestId: string,
    decision: PermissionDecision,
    answers?: undefined,
    updatedCommand?: undefined,
    inputValues?: undefined,
    feedback?: string,
  ) => void | Promise<void>;
  onImplement?: (plan: string) => void | Promise<void>;
  onSave?: (plan: string) => Promise<string>;
}) {
  const [sent, setSent] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [implementing, setImplementing] = useState(false);
  const plan = pending.plan ?? "";
  const answer = (decision: PermissionDecision) => {
    if (sent) return;
    setSent(true);
    const notes = decision === "deny" ? feedback.trim() : "";
    void onRespond(
      pending.requestId,
      decision,
      undefined,
      undefined,
      undefined,
      notes || undefined,
    );
  };
  const save = async () => {
    if (!onSave || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      setSaved(await onSave(plan));
    } catch (err) {
      setSaveError(err instanceof Error && err.message ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const implement = async () => {
    if (!onImplement || implementing) return;
    setImplementing(true);
    try {
      await onImplement(plan);
    } finally {
      setImplementing(false);
    }
  };
  return (
    <div
      className={styles.permissionCard}
      role="alertdialog"
      aria-label="Plan approval"
    >
      <div className={styles.permissionHead}>Agent proposed a plan</div>
      <div className={styles.planBody}>
        <Markdown text={plan} />
      </div>
      <textarea
        className={styles.planFeedback}
        rows={2}
        value={feedback}
        disabled={sent}
        placeholder="Notes for the next draft (optional, sent with Keep planning)"
        aria-label="Notes for Keep planning"
        data-plan-feedback=""
        onChange={(e) => setFeedback(e.target.value)}
      />
      <div className={styles.permissionActions}>
        <button
          type="button"
          className={styles.permissionAllow}
          disabled={sent}
          onClick={() => answer("allow")}
        >
          Approve plan
        </button>
        <button
          type="button"
          className={styles.permissionDeny}
          disabled={sent}
          onClick={() => answer("deny")}
          data-keep-planning=""
        >
          Keep planning
        </button>
        {onImplement ? (
          <button
            type="button"
            className={styles.retryBtn}
            disabled={implementing || !plan}
            onClick={() => void implement()}
            data-implement-plan=""
          >
            Implement in a new thread
          </button>
        ) : null}
        {onSave ? (
          <button
            type="button"
            className={styles.retryBtn}
            disabled={saving || saved != null || !plan}
            onClick={() => void save()}
            data-save-plan=""
          >
            Save plan to file
          </button>
        ) : null}
      </div>
      {saved ? (
        <div className={styles.planSaved} data-plan-saved="">
          Saved to <code>{saved}</code>
        </div>
      ) : null}
      {saveError ? (
        <div className={styles.permissionGuardrail} data-plan-save-error="">
          {saveError}
        </div>
      ) : null}
    </div>
  );
}

type PermissionRespond = (
  requestId: string,
  decision: PermissionDecision,
  answers?: Record<string, string>,
  updatedCommand?: string,
) => void | Promise<void>;

/**
 * Tool permission (#509): the proposed command is an editable field.
 * Approving sends the edited command, not the original. Non-command tools
 * (Edit/Write/…) keep the JSON preview. Same component the inbox (#291)
 * should reuse — the IPC already accepts updatedCommand.
 *
 * Codex command asks set commandEditable=false: the JSON-RPC reply cannot
 * rewrite the command (issue #1171). Accept all hides when acceptAlways
 * is false.
 */
export function PermissionPrompt({
  pending,
  onRespond,
}: {
  pending: PendingPermissionInfo;
  onRespond: PermissionRespond;
}) {
  const original = pending.command ?? null;
  const hasCommand = original !== null;
  const editable = hasCommand && pending.commandEditable !== false;
  const acceptAlways = pending.acceptAlways !== false;
  const [command, setCommand] = useState(original ?? "");
  const [sent, setSent] = useState(false);
  const edited =
    editable && original !== null && command.trim() !== original.trim();
  const empty = editable && command.trim() === "";

  const answer = (decision: PermissionDecision) => {
    if (sent) return;
    if (decision !== "deny" && empty) return;
    setSent(true);
    void onRespond(
      pending.requestId,
      decision,
      undefined,
      editable ? command : undefined,
    );
  };

  return (
    <div
      className={styles.permissionCard}
      role="alertdialog"
      aria-label="Permission request"
      data-permission-card=""
      data-edited={edited || undefined}
    >
      <div className={styles.permissionHead}>
        Agent wants to use <strong>{pending.toolName}</strong>
        {edited ? (
          <span className={styles.permissionEdited} data-permission-edited="">
            edited
          </span>
        ) : null}
      </div>
      {pending.guardrail ? (
        <div className={styles.permissionGuardrail}>
          ⚠ {pending.guardrail.reason} ({pending.guardrail.rule})
        </div>
      ) : null}
      {hasCommand ? (
        <>
          <textarea
            className={`${styles.permissionInput} ${styles.permissionCommand}`}
            data-permission-command=""
            aria-label="Proposed command"
            value={command}
            rows={Math.min(8, Math.max(2, command.split("\n").length))}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            readOnly={!editable}
            onChange={(ev) => {
              if (editable) setCommand(ev.target.value);
            }}
          />
          {edited ? (
            <div className={styles.permissionWas} data-permission-was="">
              <span>was: {original}</span>
              <button
                type="button"
                className={styles.permissionReset}
                data-permission-reset=""
                onClick={() => {
                  if (original !== null) setCommand(original);
                }}
              >
                Reset
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <pre className={styles.permissionInput}>{pending.input}</pre>
      )}
      <div className={styles.permissionActions}>
        <button
          type="button"
          className={styles.permissionAllow}
          disabled={sent || empty}
          onClick={() => answer("allow")}
        >
          Accept
        </button>
        {acceptAlways ? (
          <button
            type="button"
            className={styles.permissionAllow}
            disabled={sent || empty}
            onClick={() => answer("allowAlways")}
          >
            Accept all
          </button>
        ) : null}
        <button
          type="button"
          className={styles.permissionDeny}
          disabled={sent}
          onClick={() => answer("deny")}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

/**
 * The thread's plan overview (issue #75): the agent's live steps, mirrored
 * from its todo list, plus the plan it had approved. Unlike PlanPrompt this
 * outlives the approval — it is what the thread intends to do, at a glance.
 */
export function ExternalApprovalCard({ thread }: { thread: ThreadInfo }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prompt = String(thread.pendingExternalPrompt || "").trim();
  const label = thread.pairingLabel || "An external MCP client";

  const act = async (kind: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      const api = resolveCoderApi();
      if (kind === "approve") await api.pairing.approve({ threadId: thread.id });
      else await api.pairing.reject({ threadId: thread.id });
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className={styles.planCard}
      data-external-approval=""
      data-page-block=""
    >
      <div className={styles.planCardHead}>
        <span className={styles.planCardTitle}>Pairing launch</span>
      </div>
      <p className={styles.planProgress}>
        {label} wants to start this task. It will run in a managed worktree
        after you approve.
      </p>
      {prompt ? (
        <pre className={styles.planBody} data-external-prompt="">
          {prompt}
        </pre>
      ) : null}
      {error ? (
        <p className={styles.pairingError} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.permissionActions}>
        <button
          type="button"
          className={styles.permissionAllow}
          data-external-approve=""
          disabled={busy}
          onClick={() => void act("approve")}
        >
          Approve
        </button>
        <button
          type="button"
          className={styles.permissionDeny}
          data-external-reject=""
          disabled={busy}
          onClick={() => void act("reject")}
        >
          Don&apos;t run
        </button>
      </div>
    </div>
  );
}

export function PlanCard({ thread }: { thread: ThreadInfo }) {
  const steps = thread.planSteps ?? [];
  // No steps yet means the prose IS the overview, so it starts expanded.
  const [open, setOpen] = useState(steps.length === 0);
  const done = steps.filter((s) => s.status === "done").length;
  return (
    <div className={styles.planCard} data-plan-card="" data-page-block="">
      <div className={styles.planCardHead}>
        <span className={styles.planCardTitle}>Plan</span>
        {steps.length > 0 && (
          <span
            className={styles.planProgress}
            title={`${done} of ${steps.length} steps done`}
          >
            {done}/{steps.length}
          </span>
        )}
        {thread.plan && (
          <button
            type="button"
            className={styles.planToggle}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide full plan" : "Show full plan"}
          </button>
        )}
      </div>
      {steps.length > 0 && (
        <ol className={styles.planStepList}>
          {steps.map((s, i) => (
            <li
              key={`${i}-${s.step}`}
              className={styles.planStep}
              data-plan-step={s.status}
            >
              {s.step}
            </li>
          ))}
        </ol>
      )}
      {thread.plan && open && (
        <div className={styles.planBody}>
          <Markdown text={thread.plan} />
        </div>
      )}
    </div>
  );
}

const SPEC_STAGES: SpecStage[] = [...SPEC_ARTIFACTS, "build"];

function specStepStatus(
  stage: SpecStage,
  current: SpecStage,
): "done" | "doing" | "todo" {
  const i = SPEC_STAGES.indexOf(stage);
  const j = SPEC_STAGES.indexOf(current);
  if (i < j) return "done";
  if (i === j) return "doing";
  return "todo";
}

/**
 * Spec mode card (issue #269): the gated requirements → design → tasks →
 * build strip, the current artifact, and the approve / request-changes gate.
 */
export function SpecCard({
  thread,
  onReviewSpec,
  onDispatchSpec,
  onConvergeSpec,
  onStopSpec,
  onSpecArtifact,
}: {
  thread: ThreadInfo;
  onReviewSpec?: (
    threadId: string,
    decision: "approve" | "revise",
    feedback?: string,
  ) => void | Promise<void>;
  onDispatchSpec?: (threadId: string) => void | Promise<void>;
  onConvergeSpec?: (threadId: string) => void | Promise<void>;
  onStopSpec?: (threadId: string) => void | Promise<void>;
  onSpecArtifact?: (
    threadId: string,
    stage: SpecArtifact,
  ) => Promise<{ path: string; text: string | null }>;
}) {
  const spec = thread.spec;
  const [artifact, setArtifact] = useState<{
    path: string;
    text: string | null;
  } | null>(null);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");

  const stage = spec?.stage;
  const awaitingApproval = spec?.awaitingApproval ?? false;

  useEffect(() => {
    setRevising(false);
    setFeedback("");
    if (!onSpecArtifact || stage == null || stage === "build") {
      setArtifact(null);
      return;
    }
    let live = true;
    setArtifact(null);
    void onSpecArtifact(thread.id, stage)
      .then((result) => {
        if (live) setArtifact(result);
      })
      .catch(() => {
        if (live) setArtifact(null);
      });
    return () => {
      live = false;
    };
  }, [thread.id, stage, awaitingApproval, onSpecArtifact]);

  if (!spec) return null;

  const artifactBody =
    artifact &&
    (artifact.text != null ? (
      <div className={styles.planBody}>
        <Markdown text={artifact.text} />
      </div>
    ) : (
      <p className={styles.specStatus}>
        {artifact.path} not written yet
      </p>
    ));

  return (
    <div className={styles.specCard} data-spec-card="" data-page-block="">
      <div className={styles.specCardHead}>
        <span className={styles.specCardTitle}>Spec</span>
        <span className={styles.specStatus}>{spec.stage}</span>
        {onStopSpec && (
          <button
            type="button"
            className={styles.btn}
            data-spec-exit-btn=""
            onClick={() => void onStopSpec(thread.id)}
          >
            Exit spec mode
          </button>
        )}
      </div>
      <ol className={styles.specStageList}>
        {SPEC_STAGES.map((step) => (
          <li
            key={step}
            className={styles.specStage}
            data-spec-stage={step}
            data-plan-step={specStepStatus(step, spec.stage)}
          >
            {step}
          </li>
        ))}
      </ol>
      {spec.stage === "build" ? (
        <>
          <p className={styles.specStatus}>The spec is approved.</p>
          {(onDispatchSpec || onConvergeSpec) && (
            <div className={styles.permissionActions}>
              {onDispatchSpec && (
                <button
                  type="button"
                  className={styles.permissionAllow}
                  data-spec-dispatch-btn=""
                  onClick={() => void onDispatchSpec(thread.id)}
                >
                  Dispatch
                </button>
              )}
              {onConvergeSpec && (
                <button
                  type="button"
                  className={styles.btn}
                  data-spec-converge-btn=""
                  onClick={() => void onConvergeSpec(thread.id)}
                >
                  Converge
                </button>
              )}
            </div>
          )}
        </>
      ) : spec.awaitingApproval ? (
        <>
          {artifactBody}
          {onReviewSpec && (
            <>
              {revising && (
                <textarea
                  className={styles.notesInput}
                  data-spec-feedback=""
                  aria-label="Revision feedback"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="What should change?"
                />
              )}
              <div className={styles.permissionActions}>
                <button
                  type="button"
                  className={styles.permissionAllow}
                  onClick={() => void onReviewSpec(thread.id, "approve")}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className={styles.permissionDeny}
                  onClick={() => {
                    if (!revising) {
                      setRevising(true);
                      return;
                    }
                    const text = feedback.trim();
                    void onReviewSpec(
                      thread.id,
                      "revise",
                      text === "" ? undefined : text,
                    );
                  }}
                >
                  Request changes
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {artifactBody}
          <p className={styles.specStatus}>
            The agent is working on this stage.
          </p>
        </>
      )}
    </div>
  );
}

const TEACH_STAGES: TeachAutonomy[] = ["hint", "review", "pair"];

function teachStepStatus(
  step: TeachAutonomy,
  current: TeachAutonomy,
): "todo" | "doing" | "done" {
  const i = TEACH_STAGES.indexOf(step);
  const j = TEACH_STAGES.indexOf(current);
  if (i < j) return "done";
  if (i === j) return "doing";
  return "todo";
}

/**
 * `/btw` side-question card (issue #471). Lives on the thread, not a new
 * thread and not the live turn. Dismiss drops it; promote queues a follow-up.
 */
export function BtwSideCard({
  threadId,
  card,
  onDismiss,
  onPromote,
}: {
  threadId: string;
  card: BtwCardInfo;
  onDismiss?: (threadId: string, id: string) => void | Promise<void>;
  onPromote?: (threadId: string, id: string) => void | Promise<void>;
}) {
  const statusLabel =
    card.status === "running"
      ? "asking"
      : card.status === "error"
        ? "failed"
        : "answered";
  return (
    <div
      className={styles.specCard}
      data-btw-card=""
      data-page-block=""
      data-btw-status={card.status}
    >
      <div className={styles.specCardHead}>
        <span className={styles.specCardTitle}>Side question</span>
        <span className={styles.specStatus}>{statusLabel}</span>
      </div>
      <p className={styles.btwQuestion}>{card.question}</p>
      {card.status === "running" ? (
        <p className={styles.specStatus}>Answering from the repo map…</p>
      ) : null}
      {card.answer ? (
        <div className={styles.btwAnswer}>
          <Markdown text={card.answer} />
        </div>
      ) : null}
      {card.error && !card.answer ? (
        <p className={styles.specStatus}>{card.error}</p>
      ) : null}
      <div className={styles.permissionActions}>
        {onPromote && (
          <button
            type="button"
            className={styles.permissionAllow}
            data-btw-promote-btn=""
            onClick={() => void onPromote(threadId, card.id)}
          >
            Promote to follow-up
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            className={styles.permissionDeny}
            data-btw-dismiss-btn=""
            onClick={() => void onDismiss(threadId, card.id)}
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Teach mode card (issue #373): autonomy ladder, review-my-code, turn off.
 */
export function AskCard({
  thread,
  onStopAsk,
  promoteWorktree,
}: {
  thread: ThreadInfo;
  onStopAsk?: (
    threadId: string,
    opts?: { worktree?: boolean },
  ) => void | Promise<void>;
  promoteWorktree: boolean;
}) {
  if (!thread.ask) return null;
  return (
    <div className={styles.specCard} data-ask-card="" data-page-block="">
      <div className={styles.specCardHead}>
        <span className={styles.specCardTitle}>Ask</span>
        <span className={styles.specStatus}>read-only</span>
      </div>
      <p className={styles.specStatus}>
        Answers from the repo map and memory. No tools, no worktree, no
        agent credits. Start work when you want a real thread.
      </p>
      <div className={styles.permissionActions}>
        {onStopAsk && (
          <button
            type="button"
            className={styles.permissionAllow}
            data-ask-start-work-btn=""
            onClick={() =>
              void onStopAsk(
                thread.id,
                promoteWorktree ? { worktree: true } : undefined,
              )
            }
          >
            Start work
          </button>
        )}
        {onStopAsk && (
          <button
            type="button"
            className={styles.permissionDeny}
            data-ask-stop-btn=""
            onClick={() => void onStopAsk(thread.id)}
          >
            Turn off
          </button>
        )}
      </div>
    </div>
  );
}

export function TeachCard({
  thread,
  onStopTeach,
  onRequestTeachReview,
}: {
  thread: ThreadInfo;
  onStopTeach?: (threadId: string) => void | Promise<void>;
  onRequestTeachReview?: (threadId: string) => void | Promise<void>;
}) {
  const teach = thread.teach;
  if (!teach) return null;
  const n = teach.reviewsPassed;
  const reviewLabel = n === 1 ? "1 review passed" : `${n} reviews passed`;
  return (
    <div className={styles.specCard} data-teach-card="" data-page-block="">
      <div className={styles.specCardHead}>
        <span className={styles.specCardTitle}>Teach</span>
        <span className={styles.specStatus}>{reviewLabel}</span>
      </div>
      <ol className={styles.specStageList}>
        {TEACH_STAGES.map((step) => (
          <li
            key={step}
            className={styles.specStage}
            data-teach-autonomy={step}
            data-plan-step={teachStepStatus(step, teach.autonomy)}
          >
            {TEACH_AUTONOMY_LABELS[step]}
          </li>
        ))}
      </ol>
      <p className={styles.specStatus}>
        Hints, not solutions. The agent leaves TODO(human) markers for you
        to fill, then reviews your code.
      </p>
      <div className={styles.permissionActions}>
        {onRequestTeachReview && (
          <button
            type="button"
            className={styles.permissionAllow}
            data-teach-review-btn=""
            onClick={() => void onRequestTeachReview(thread.id)}
          >
            Review my code
          </button>
        )}
        {onStopTeach && (
          <button
            type="button"
            className={styles.permissionDeny}
            data-teach-stop-btn=""
            onClick={() => void onStopTeach(thread.id)}
          >
            Turn off
          </button>
        )}
      </div>
    </div>
  );
}

const FELT_BUCKET_LABELS = ["15 min", "30 min", "1 h", "2 h", "4 h+"];

/**
 * Felt-estimate card (issue #401): one tap, asked once when a run completes.
 * The estimate feeds the felt-vs-actual section of the fleet view; Skip
 * records a decline so the card never nags twice.
 */
export function FeltEstimateCard({
  thread,
  onSetFeltEstimate,
}: {
  thread: ThreadInfo;
  onSetFeltEstimate?: (
    threadId: string,
    savedMs: number | null,
  ) => void | Promise<void>;
}) {
  if (!onSetFeltEstimate) return null;
  if (thread.status !== "done" || thread.feltEstimate != null) return null;
  return (
    <div className={styles.specCard} data-felt-card="" data-page-block="">
      <div className={styles.specCardHead}>
        <span className={styles.specCardTitle}>How much time did this save you?</span>
      </div>
      <p className={styles.specStatus}>
        One tap. We compare your gut with the actual clock in the Fleet view.
      </p>
      <div className={styles.permissionActions}>
        {FELT_ESTIMATE_BUCKETS_MS.map((ms, i) => (
          <button
            key={ms}
            type="button"
            className={styles.permissionAllow}
            data-felt-estimate-btn={ms}
            onClick={() => void onSetFeltEstimate(thread.id, ms)}
          >
            {FELT_BUCKET_LABELS[i]}
          </button>
        ))}
        <button
          type="button"
          className={styles.permissionDeny}
          data-felt-skip-btn=""
          onClick={() => void onSetFeltEstimate(thread.id, null)}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function fieldValue(
  step: { type: string; name: string; input: string; output: string; decision: string } | null,
  field: DivergenceField,
): string {
  if (!step) return "—";
  if (field === "type") return step.type;
  if (field === "name") return step.name;
  if (field === "input") return truncateStepValue(step.input);
  if (field === "output") return truncateStepValue(step.output);
  return step.decision;
}

/**
 * First-divergence report for two runs of the same task (issue #393).
 * Hidden until there is a sibling fork or a second completed run.
 */
export function DivergenceCard({
  detail,
  peers,
  providers,
  onPeekThread,
}: {
  detail: ThreadDetail;
  peers: ComparePeer[];
  providers: ProviderInfo[];
  onPeekThread?: (id: string) => Promise<ThreadDetail>;
}) {
  const runs = useMemo(
    () => sameThreadRuns(detail.messages, detail.thread.status),
    [detail.messages, detail.thread.status],
  );
  const earlierRuns = runs.length >= 2 ? runs.slice(0, -1) : [];
  const latestRun = runs.length >= 2 ? runs[runs.length - 1]! : null;
  const targets = useMemo(() => {
    const list: { key: string; label: string }[] = [];
    if (onPeekThread) {
      for (const p of peers) list.push({ key: `peer:${p.id}`, label: p.label });
    }
    for (const r of earlierRuns) {
      list.push({ key: `run:${r.runId}`, label: r.label });
    }
    return list;
  }, [onPeekThread, peers, earlierRuns]);

  const [selected, setSelected] = useState("");
  const [peeked, setPeeked] = useState<ThreadDetail | null>(null);
  const [peekError, setPeekError] = useState<string | null>(null);
  const [peeking, setPeeking] = useState(false);
  const [open, setOpen] = useState(true);
  const enabled = useDivergenceCardEnabled();

  useEffect(() => {
    if (targets.length === 0) {
      setSelected("");
      return;
    }
    if (!targets.some((t) => t.key === selected)) {
      setSelected(targets[0]!.key);
    }
  }, [targets, selected]);

  const peerId = selected.startsWith("peer:") ? selected.slice(5) : null;
  const runId = selected.startsWith("run:") ? selected.slice(4) : null;

  useEffect(() => {
    if (!enabled || !peerId || !onPeekThread) {
      setPeeked(null);
      setPeekError(null);
      setPeeking(false);
      return;
    }
    let live = true;
    setPeeking(true);
    setPeekError(null);
    void onPeekThread(peerId)
      .then((d) => {
        if (!live) return;
        setPeeked(d);
        setPeeking(false);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPeeked(null);
        setPeeking(false);
        setPeekError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [enabled, peerId, onPeekThread]);

  if (!enabled || targets.length === 0) return null;

  const leftLabel = peerId
    ? comparePeerLabel(detail.thread, peers, providers)
    : (latestRun?.label ?? "This run");
  const rightMeta = targets.find((t) => t.key === selected);
  const rightLabel = rightMeta?.label ?? "other run";

  let report = null;
  if (peerId) {
    if (peeked) {
      report = compareSteps(
        extractSteps(detail.messages),
        extractSteps(peeked.messages),
        {
          leftDone: isThreadDone(detail.thread.status),
          rightDone: isThreadDone(peeked.thread.status),
        },
      );
    }
  } else if (runId && latestRun) {
    report = compareSteps(
      extractSteps(detail.messages, latestRun.runId),
      extractSteps(detail.messages, runId),
    );
  }

  const headline = peekError
    ? peekError
    : peeking
      ? "Comparing…"
      : report
        ? formatDivergenceHeadline(report, leftLabel, rightLabel)
        : "Comparing…";
  const hit = report?.first ?? null;
  const showFields = open && hit != null;

  return (
    <section className={styles.divergenceCard} data-divergence-card="">
      <div className={styles.divergenceHead}>
        <span className={styles.divergenceTitle}>Divergence</span>
        <label className={styles.divergencePick}>
          <span className={styles.divergencePickLabel}>Compare with</span>
          <select
            className={styles.divergenceSelect}
            data-divergence-peer=""
            aria-label="Compare with"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {targets.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p
        className={styles.divergenceHeadline}
        data-divergence-headline=""
        data-divergence-pending={report?.pending ? "1" : undefined}
        role={peekError ? "alert" : undefined}
      >
        {headline}
      </p>
      {hit && (
        <button
          type="button"
          className={styles.divergenceToggle}
          data-divergence-toggle=""
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide fields" : "Show fields"}
        </button>
      )}
      {showFields && (
        <div className={styles.divergenceFields} data-divergence-fields="">
          <span className={styles.divergenceColHead} />
          <span className={styles.divergenceColHead}>{leftLabel}</span>
          <span className={styles.divergenceColHead}>{rightLabel}</span>
          {(
            [
              "type",
              "name",
              "input",
              "output",
              "decision",
            ] as DivergenceField[]
          ).map((field) => {
            const differs = hit.fields.includes(field);
            return (
              <Fragment key={field}>
                <span
                  className={styles.divergenceFieldName}
                  data-divergence-field={field}
                  data-differs={differs ? "1" : undefined}
                >
                  {field}
                </span>
                <span
                  className={styles.divergenceValue}
                  data-divergence-left={field}
                >
                  {fieldValue(hit.left, field)}
                </span>
                <span
                  className={styles.divergenceValue}
                  data-divergence-right={field}
                >
                  {fieldValue(hit.right, field)}
                </span>
              </Fragment>
            );
          })}
        </div>
      )}
    </section>
  );
}
