import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import type { AttachmentInfo, PendingQuestion } from "../shared/ipc";
import type { DroppedFolder } from "../dropFiles";
import { DROP_REJECT_MESSAGE } from "../dropFiles";
import { useFileDrop } from "../useFileDrop";
import {
  composeQuestionAnswerValue,
  questionAllowsCustomAnswer,
  REMOTE_QUESTION_ATTACH_NOTE,
} from "../questionAnswer";
import styles from "./ThreadView.module.css";

export type QuestionAnswerHandler = (
  answers: Record<string, string>,
  attachments?: AttachmentInfo[],
) => void | Promise<void>;

export function QuestionPrompt({
  questions,
  onAnswer,
  onDismiss,
  threadId,
  requestId,
  allowAttachments = false,
  remoteUnsupported = false,
  includeImages = true,
  onPickAttachments,
  onSaveAttachmentImage,
  onLoadAttachmentImage,
  onDropAttachmentFiles,
}: {
  questions: PendingQuestion[];
  onAnswer: QuestionAnswerHandler;
  onDismiss: () => void | Promise<void>;
  threadId: string;
  requestId: string;
  allowAttachments?: boolean;
  remoteUnsupported?: boolean;
  includeImages?: boolean;
  onPickAttachments?: (opts?: {
    includeImages?: boolean;
  }) => Promise<AttachmentInfo[]>;
  onSaveAttachmentImage?: (dataUrl: string) => Promise<AttachmentInfo | null>;
  onLoadAttachmentImage?: (path: string) => Promise<string | null>;
  onDropAttachmentFiles?: (
    files: File[],
    folders?: DroppedFolder[],
  ) => Promise<AttachmentInfo[]>;
}) {
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [attachmentsByQ, setAttachmentsByQ] = useState<
    Record<number, AttachmentInfo[]>
  >({});
  const [pending, setPending] = useState(0);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);
  const [attachContext, setAttachContext] = useState(false);
  const ownerKey = `${threadId}:${requestId}`;
  const [boundOwner, setBoundOwner] = useState(ownerKey);
  if (ownerKey !== boundOwner) {
    setBoundOwner(ownerKey);
    setPicked({});
    setOther({});
    setAttachmentsByQ({});
    setPending(0);
    setErrors({});
    setSent(false);
    setAttachContext(false);
  }

  const attachGen = useRef(0);
  const ownerRef = useRef({ threadId, requestId });
  if (
    ownerRef.current.threadId !== threadId ||
    ownerRef.current.requestId !== requestId
  ) {
    ownerRef.current = { threadId, requestId };
    attachGen.current += 1;
  }

  const acceptItems = useCallback(
    (items: AttachmentInfo[]) =>
      includeImages ? items : items.filter((a) => a.kind !== "image"),
    [includeImages],
  );

  const addToQuestion = useCallback(
    (qi: number, items: AttachmentInfo[]) => {
      const accepted = acceptItems(items);
      if (!accepted.length) return;
      setAttachmentsByQ((prev) => {
        const existing = prev[qi] ?? [];
        const seen = new Set(existing.map((a) => a.path));
        const fresh = accepted.filter((a) => !seen.has(a.path));
        return fresh.length
          ? { ...prev, [qi]: [...existing, ...fresh] }
          : prev;
      });
      setErrors((prev) => {
        if (!prev[qi]) return prev;
        const next = { ...prev };
        delete next[qi];
        return next;
      });
    },
    [acceptItems],
  );

  const stillOwner = useCallback(
    (gen: number, qi: number) =>
      attachGen.current === gen &&
      ownerRef.current.threadId === threadId &&
      ownerRef.current.requestId === requestId &&
      qi >= 0,
    [threadId, requestId],
  );

  const beginAttach = useCallback((qi: number) => {
    setAttachContext(true);
    setPending((n) => n + 1);
    setErrors((prev) => {
      if (!prev[qi]) return prev;
      const next = { ...prev };
      delete next[qi];
      return next;
    });
    return attachGen.current;
  }, []);

  const endAttach = useCallback((gen: number) => {
    if (attachGen.current !== gen) return;
    setPending((n) => Math.max(0, n - 1));
  }, []);

  const pickedText = useCallback(
    (i: number): string => {
      const parts = [...(picked[i] ?? [])];
      const extra = (other[i] ?? "").trim();
      if (extra) parts.push(extra);
      return parts.join(", ");
    },
    [picked, other],
  );

  const answerFor = useCallback(
    (i: number): string =>
      composeQuestionAnswerValue(pickedText(i), attachmentsByQ[i] ?? []),
    [pickedText, attachmentsByQ],
  );
  const allAnswered = questions.every((_, i) => answerFor(i) !== "");
  const instant =
    questions.length === 1 &&
    !questions[0].multiSelect &&
    !attachContext &&
    pending === 0;

  const submit = useCallback(
    async (override?: { index: number; label: string }) => {
      if (sent || pending > 0) return;
      const answers: Record<string, string> = {};
      const attachments: AttachmentInfo[] = [];
      questions.forEach((q, i) => {
        const text =
          override && override.index === i ? override.label : pickedText(i);
        const files = attachmentsByQ[i] ?? [];
        answers[q.question] = composeQuestionAnswerValue(text, files);
        attachments.push(...files);
      });
      if (!Object.values(answers).some(Boolean)) return;
      setSent(true);
      try {
        await onAnswer(
          answers,
          attachments.length ? attachments : undefined,
        );
      } catch {
        setSent(false);
      }
    },
    [sent, pending, questions, pickedText, attachmentsByQ, onAnswer],
  );

  const choose = useCallback(
    (qi: number, label: string) => {
      if (instant) {
        void submit({ index: qi, label });
        return;
      }
      setPicked((prev) => {
        const cur = prev[qi] ?? [];
        const next = questions[qi].multiSelect
          ? cur.includes(label)
            ? cur.filter((l) => l !== label)
            : [...cur, label]
          : [label];
        return { ...prev, [qi]: next };
      });
    },
    [instant, questions, submit],
  );

  const runPick = useCallback(
    async (qi: number) => {
      if (!onPickAttachments || sent) return;
      const gen = beginAttach(qi);
      try {
        const items = await onPickAttachments({ includeImages });
        if (!stillOwner(gen, qi)) return;
        addToQuestion(qi, items);
      } catch (err) {
        if (!stillOwner(gen, qi)) return;
        const msg =
          err instanceof Error && err.message
            ? err.message
            : "Failed to attach";
        setErrors((prev) => ({ ...prev, [qi]: msg }));
      } finally {
        endAttach(gen);
      }
    },
    [
      onPickAttachments,
      sent,
      beginAttach,
      includeImages,
      stillOwner,
      addToQuestion,
      endAttach,
    ],
  );

  const runDrop = useCallback(
    async (qi: number, files: File[], folders?: DroppedFolder[]) => {
      if (!onDropAttachmentFiles || sent) return;
      const gen = beginAttach(qi);
      try {
        const items = await onDropAttachmentFiles(files, folders);
        if (!stillOwner(gen, qi)) return;
        const accepted = acceptItems(items);
        if (accepted.length) addToQuestion(qi, accepted);
        else setErrors((prev) => ({ ...prev, [qi]: DROP_REJECT_MESSAGE }));
      } catch (err) {
        if (!stillOwner(gen, qi)) return;
        const msg =
          err instanceof Error && err.message
            ? err.message
            : DROP_REJECT_MESSAGE;
        setErrors((prev) => ({ ...prev, [qi]: msg }));
      } finally {
        endAttach(gen);
      }
    },
    [
      onDropAttachmentFiles,
      sent,
      beginAttach,
      stillOwner,
      acceptItems,
      addToQuestion,
      endAttach,
    ],
  );

  const runPaste = useCallback(
    (qi: number, e: ClipboardEvent<HTMLElement>) => {
      if (sent || !onSaveAttachmentImage || !includeImages) return;
      const items = Array.from(e.clipboardData?.items ?? []).filter(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      );
      if (!items.length) return;
      e.preventDefault();
      const gen = beginAttach(qi);
      let remaining = items.length;
      const finishOne = () => {
        remaining -= 1;
        if (remaining <= 0) endAttach(gen);
      };
      for (const item of items) {
        const blob = item.getAsFile();
        if (!blob) {
          finishOne();
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl =
            typeof reader.result === "string" ? reader.result : "";
          if (!dataUrl) {
            finishOne();
            return;
          }
          void onSaveAttachmentImage(dataUrl)
            .then((attachment) => {
              if (!stillOwner(gen, qi)) return;
              if (attachment) addToQuestion(qi, [attachment]);
              else {
                setErrors((prev) => ({
                  ...prev,
                  [qi]: "Failed to attach",
                }));
              }
            })
            .catch(() => {
              if (!stillOwner(gen, qi)) return;
              setErrors((prev) => ({ ...prev, [qi]: "Failed to attach" }));
            })
            .finally(finishOne);
        };
        reader.onerror = () => {
          if (stillOwner(gen, qi)) {
            setErrors((prev) => ({ ...prev, [qi]: "Failed to attach" }));
          }
          finishOne();
        };
        reader.readAsDataURL(blob);
      }
    },
    [
      sent,
      onSaveAttachmentImage,
      includeImages,
      beginAttach,
      endAttach,
      stillOwner,
      addToQuestion,
    ],
  );

  // 1-9 pick an option of the first unanswered question; Enter submits.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === "Enter") {
        if (allAnswered && pending === 0) {
          ev.preventDefault();
          void submit();
        }
        return;
      }
      const n = Number(ev.key);
      if (!Number.isInteger(n) || n < 1) return;
      let qi = questions.findIndex((_, i) => answerFor(i) === "");
      if (qi < 0) qi = questions.length - 1;
      const opt = questions[qi]?.options[n - 1];
      if (!opt) return;
      ev.preventDefault();
      choose(qi, opt.label);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [questions, answerFor, allAnswered, pending, choose, submit]);

  const showAttachUi = allowAttachments && Boolean(onPickAttachments);

  return (
    <div
      className={styles.permissionCard}
      role="alertdialog"
      aria-label="Agent question"
      data-question-prompt=""
      data-question-attach-pending={pending > 0 ? "" : undefined}
    >
      {questions.map((q, qi) => (
        <QuestionBlock
          key={qi}
          qi={qi}
          q={q}
          picked={picked[qi] ?? []}
          other={other[qi] ?? ""}
          attachments={attachmentsByQ[qi] ?? []}
          error={errors[qi] ?? null}
          sent={sent}
          showAttach={showAttachUi && questionAllowsCustomAnswer(q)}
          showRemoteNote={
            remoteUnsupported && questionAllowsCustomAnswer(q)
          }
          onChoose={choose}
          onOtherChange={(value) =>
            setOther((prev) => ({ ...prev, [qi]: value }))
          }
          onOtherEnter={() => {
            if (answerFor(qi) !== "" && allAnswered && pending === 0) {
              void submit();
            }
          }}
          onPick={() => void runPick(qi)}
          onPaste={(e) => runPaste(qi, e)}
          onDropFiles={
            onDropAttachmentFiles ? (files, folders) => void runDrop(qi, files, folders) : undefined
          }
          onRemoveAttachment={(path) =>
            setAttachmentsByQ((prev) => ({
              ...prev,
              [qi]: (prev[qi] ?? []).filter((a) => a.path !== path),
            }))
          }
          onLoadImage={onLoadAttachmentImage}
        />
      ))}
      <div className={styles.permissionActions}>
        {pending > 0 ? (
          <span className={styles.questionAttachPending}>Saving files…</span>
        ) : null}
        {(!instant || (other[0] ?? "").trim() !== "") && (
          <button
            type="button"
            className={styles.permissionAllow}
            disabled={!allAnswered || sent || pending > 0}
            onClick={() => void submit()}
          >
            Answer
          </button>
        )}
        <button
          type="button"
          className={styles.permissionDeny}
          disabled={sent}
          onClick={() => {
            setSent(true);
            void onDismiss();
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function QuestionBlock({
  qi,
  q,
  picked,
  other,
  attachments,
  error,
  sent,
  showAttach,
  showRemoteNote,
  onChoose,
  onOtherChange,
  onOtherEnter,
  onPick,
  onPaste,
  onDropFiles,
  onRemoveAttachment,
  onLoadImage,
}: {
  qi: number;
  q: PendingQuestion;
  picked: string[];
  other: string;
  attachments: AttachmentInfo[];
  error: string | null;
  sent: boolean;
  showAttach: boolean;
  showRemoteNote: boolean;
  onChoose: (qi: number, label: string) => void;
  onOtherChange: (value: string) => void;
  onOtherEnter: () => void;
  onPick: () => void;
  onPaste: (e: ClipboardEvent<HTMLElement>) => void;
  onDropFiles?: (files: File[], folders?: DroppedFolder[]) => void;
  onRemoveAttachment: (path: string) => void;
  onLoadImage?: (path: string) => Promise<string | null>;
}) {
  const dropRef = useRef<HTMLDivElement>(null);
  useFileDrop(dropRef, {
    enabled: Boolean(onDropFiles) && showAttach && !sent,
    onFiles: (files, folders) => onDropFiles?.(files, folders),
  });
  const custom = questionAllowsCustomAnswer(q);

  return (
    <div
      ref={dropRef}
      className={styles.questionBlock}
      data-question-block={qi}
      onPaste={custom && showAttach ? onPaste : undefined}
    >
      <div className={styles.permissionHead}>
        {q.header && <span className={styles.questionChip}>{q.header}</span>}
        {q.question}
      </div>
      <div className={styles.questionOptions}>
        {q.options.map((opt, oi) => {
          const isPicked = picked.includes(opt.label);
          return (
            <button
              key={oi}
              type="button"
              className={styles.questionOption}
              data-picked={isPicked || undefined}
              onClick={() => onChoose(qi, opt.label)}
            >
              <span className={styles.questionKey}>{oi + 1}</span>
              <span className={styles.questionText}>
                <span className={styles.questionLabel}>{opt.label}</span>
                {opt.description && (
                  <span className={styles.questionDesc}>{opt.description}</span>
                )}
              </span>
            </button>
          );
        })}
        {custom ? (
          <div className={styles.questionOtherRow}>
            <input
              type="text"
              className={styles.questionOther}
              placeholder="Other…"
              value={other}
              onChange={(ev) => onOtherChange(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") {
                  ev.preventDefault();
                  onOtherEnter();
                }
              }}
            />
            {showAttach ? (
              <button
                type="button"
                className={styles.questionAttach}
                data-question-attach={qi}
                aria-label="Attach files to this answer"
                title="Attach files to this answer"
                disabled={sent}
                onClick={onPick}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m12.5 7.5-4.95 4.95a3.5 3.5 0 0 1-4.95-4.95l5.3-5.3a2.33 2.33 0 0 1 3.3 3.3l-5.3 5.3a1.17 1.17 0 0 1-1.65-1.65l4.6-4.6" />
                </svg>
              </button>
            ) : null}
          </div>
        ) : null}
        {showRemoteNote ? (
          <p className={styles.questionAttachNote} data-question-remote-files="">
            {REMOTE_QUESTION_ATTACH_NOTE}
          </p>
        ) : null}
        {attachments.length > 0 ? (
          <div
            className={styles.questionAttachmentRow}
            data-question-attachments={qi}
            aria-label="Answer attachments"
          >
            {attachments.map((a) => (
              <QuestionAttachmentChip
                key={a.path}
                attachment={a}
                onRemove={() => onRemoveAttachment(a.path)}
                onLoadImage={onLoadImage}
              />
            ))}
          </div>
        ) : null}
        {error ? (
          <p className={styles.questionAttachError} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function QuestionAttachmentChip({
  attachment,
  onRemove,
  onLoadImage,
}: {
  attachment: AttachmentInfo;
  onRemove: () => void;
  onLoadImage?: (path: string) => Promise<string | null>;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (attachment.kind !== "image" || !onLoadImage) return;
    let live = true;
    void onLoadImage(attachment.path)
      .then((url) => {
        if (live) setThumb(url);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [attachment.kind, attachment.path, onLoadImage]);
  return (
    <span
      className={styles.attachmentChip}
      data-attachment-kind={attachment.kind}
      title={attachment.path}
    >
      {attachment.kind === "image" && thumb ? (
        <img
          className={styles.attachmentThumb}
          src={thumb}
          alt={attachment.name}
        />
      ) : (
        <svg
          className={styles.attachmentIcon}
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {attachment.kind === "folder" ? (
            <path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h2.2a1.5 1.5 0 0 1 1.1.5l.8 1a1.5 1.5 0 0 0 1.1.5H12A1.5 1.5 0 0 1 13.5 6v5A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11V4Z" />
          ) : attachment.kind === "file" ? (
            <>
              <path d="M4.5 2.5h5l4 4v7A1.5 1.5 0 0 1 12 15H4.5A1.5 1.5 0 0 1 3 13.5v-10A1.5 1.5 0 0 1 4.5 2.5Z" />
              <path d="M9.5 2.5V7h4" />
            </>
          ) : (
            <>
              <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
              <circle cx="5.8" cy="6" r="1" />
              <path d="m3 12 3.5-3.5 2.5 2.5 2-2L13.5 12" />
            </>
          )}
        </svg>
      )}
      <span className={styles.attachmentName}>{attachment.name}</span>
      <button
        type="button"
        className={styles.attachmentRemove}
        aria-label={`Remove ${attachment.name}`}
        title={`Remove ${attachment.name}`}
        onClick={onRemove}
      >
        ×
      </button>
    </span>
  );
}
