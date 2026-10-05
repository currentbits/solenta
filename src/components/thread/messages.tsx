import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AttachmentInfo,
  ChatMessage,
  WorkSuggestion,
} from "../../shared/ipc";
import { messageMetaLine } from "../../messageMeta";
import {
  liveGroupLabel,
  summarizeToolGroup,
  toolAction,
  type ToolGroup,
} from "../../toolGroups";
import {
  isMemoryToolMessage,
  memoryStepText,
  parseMemoryStep,
} from "../../memorySteps";
import { formatReviewBarText, type ReviewBar } from "../../reviewBar";
import type { RunHeader } from "../../runHeader";
import { useEscapeClose } from "../../useEscapeClose";
import { useModalFocus } from "../../useModalFocus";
import type { FocusTurnSummary } from "../../focusView";
import { routineWorkerActivitySummary } from "../../workerActivity";
import { captureCiteFromSelection, type ReplyTarget } from "../../replyContext";
import { Markdown } from "../Markdown";
import { PathText } from "../PathLinks";
import { provenanceVisible, type MessageProvenance } from "../../provenance";
import styles from "../ThreadView.module.css";

/** Byte-equal to electron/worktrees.js restoreCheckpoint run-active guard. */
const RESTORE_ACTIVE_TITLE =
  "Cannot restore a checkpoint while a run is active";

/**
 * Full-size viewer for an image clicked anywhere in the thread body. Clicking
 * the image toggles fit-to-window / native resolution (the overlay scrolls);
 * backdrop, close button and Escape all dismiss.
 */
export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [zoomed, setZoomed] = useState(false);
  useEscapeClose(true, onClose);
  useModalFocus(true, dialogRef);
  return (
    <div
      ref={dialogRef}
      className={styles.lightbox}
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Image"}
      tabIndex={-1}
      data-image-lightbox=""
      onClick={onClose}
    >
      <img
        className={styles.lightboxImg}
        data-zoom={zoomed ? "1" : undefined}
        src={src}
        alt={alt}
        title={zoomed ? "Fit to window" : "View at full size"}
        onClick={(e) => {
          e.stopPropagation();
          setZoomed((v) => !v);
        }}
      />
      <button
        type="button"
        className={styles.lightboxClose}
        aria-label="Close image"
        title="Close (Esc)"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

function ToolCallCard({
  message,
  autoExpand,
  animateIn,
  onLoadImage,
  bare,
}: {
  message: ChatMessage;
  autoExpand: boolean;
  /** Freshly appended at the live tail — play the stream-in entrance. */
  animateIn?: boolean;
  onLoadImage?: (name: string) => Promise<string | null>;
  /** Inside an expanded tool group: disclosure only, no tile. */
  bare?: boolean;
}) {
  const tool = message.tool;
  const [manual, setManual] = useState<boolean | null>(null);
  /**
   * Latch the entrance flag at mount: any later re-render passes animateIn=false
   * (the key is already seen), and stripping the class mid-flight would cancel
   * the CSS animation. Remounts (collapse/expand) get a fresh false.
   */
  const [entered] = useState(Boolean(animateIn));
  const open = manual ?? autoExpand;
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  // Bytes live under userData, not in the message: fetch an img src (protocol
  // URL on desktop, data URL on web) the first time the card is open.
  const imageKey = (tool?.images ?? []).join("\n");
  useEffect(() => {
    if (!open || !imageKey || !onLoadImage) return;
    let live = true;
    void Promise.all(imageKey.split("\n").map((name) => onLoadImage(name)))
      .then((urls) => {
        if (live) setImageUrls(urls.filter((u): u is string => Boolean(u)));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, imageKey, onLoadImage]);

  if (!tool) {
    return (
      <article
        className={`${styles.message}${entered ? ` ${styles.streamIn}` : ""}`}
        data-stream-in={entered ? "" : undefined}
      >
        <p>{message.text}</p>
      </article>
    );
  }

  const status: "running" | "done" | "error" = !tool.done
    ? "running"
    : tool.isError
      ? "error"
      : "done";

  return (
    <section
      className={`${bare ? styles.toolBare : `${styles.card} ${styles.toolCard}`}${entered ? ` ${styles.streamIn}` : ""}`}
      data-stream-in={entered ? "" : undefined}
    >
      <div
        className={styles.toolHeader}
        onClick={() => setManual(!open)}
      >
        <button
          type="button"
          className={styles.toolToggle}
          onClick={(e) => {
            e.stopPropagation();
            setManual(!open);
          }}
          aria-expanded={open}
        >
          <span
            className={styles.toolDot}
            data-status={status}
            aria-label={status}
          />
          <span className={styles.toolName}>{tool.name}</span>
        </button>
        <span className={styles.toolSummary}>
          <PathText text={message.text} />
        </span>
        <span className={styles.chevron} data-open={open} aria-hidden="true">
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.5 2 6.5 5 3.5 8" />
          </svg>
        </span>
      </div>
      {open && (
        <div className={styles.toolBody}>
          <pre className={styles.toolPre}>
            <PathText text={tool.input} />
          </pre>
          {tool.output != null && tool.output !== "" && (
            <>
              <div className={styles.toolDivider} />
              <pre className={styles.toolPre}>
                <PathText text={tool.output} />
              </pre>
            </>
          )}
          {imageUrls.map((url) => (
            <img
              key={url.slice(-32)}
              className={styles.toolImage}
              src={url}
              alt={`Image from ${tool.name}`}
              title="Click to view full size"
              tabIndex={0}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ThinkingCard({
  message,
  autoExpand,
  animateIn,
  bare,
}: {
  message: ChatMessage;
  autoExpand: boolean;
  animateIn?: boolean;
  bare?: boolean;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const [entered] = useState(Boolean(animateIn));
  const open = manual ?? autoExpand;
  const status: "running" | "done" = autoExpand ? "running" : "done";
  const firstLine = message.text.split(/\r?\n/, 1)[0] ?? "";

  return (
    <section
      className={`${bare ? styles.toolBare : `${styles.card} ${styles.toolCard}`}${entered ? ` ${styles.streamIn}` : ""}`}
      data-thinking=""
      data-stream-in={entered ? "" : undefined}
    >
      <div className={styles.toolHeader} onClick={() => setManual(!open)}>
        <button
          type="button"
          className={styles.toolToggle}
          onClick={(e) => {
            e.stopPropagation();
            setManual(!open);
          }}
          aria-expanded={open}
        >
          <span
            className={styles.toolDot}
            data-status={status}
            aria-label={status}
          />
          <span className={styles.toolName}>Thinking</span>
        </button>
        {!open && (
          <span className={styles.toolSummary}>
            <PathText text={firstLine} />
          </span>
        )}
        <span className={styles.chevron} data-open={open} aria-hidden="true">
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.5 2 6.5 5 3.5 8" />
          </svg>
        </span>
      </div>
      {open && (
        <div className={styles.toolBody}>
          <pre className={styles.toolPre}>
            <PathText text={message.text} />
          </pre>
        </div>
      )}
    </section>
  );
}

export function ToolGroupRow({
  group,
  working,
  expanded,
  verbose,
  animateIn,
  onToggle,
  onLoadImage,
  latestRunningToolId,
  latestThinkingId,
}: {
  group: ToolGroup;
  working: boolean;
  expanded: boolean;
  verbose: boolean;
  animateIn?: boolean;
  onToggle: () => void;
  onLoadImage?: (name: string) => Promise<string | null>;
  latestRunningToolId: string | null;
  latestThinkingId: string | null;
}) {
  const [entered] = useState(Boolean(animateIn));
  const open = verbose || expanded;
  // Shared-memory calls get their own "memory moment" lines (#1429 F5).
  const memory = group.messages.filter(isMemoryToolMessage);
  const rest =
    memory.length > 0
      ? group.messages.filter((m) => !isMemoryToolMessage(m))
      : group.messages;
  const live = working ? liveGroupLabel(rest) : null;
  const label = live ?? summarizeToolGroup(rest);
  const restTools = rest.filter((m) => m.role === "tool");
  return (
    <section
      className={`${styles.toolGroup}${entered ? ` ${styles.streamIn}` : ""}`}
      data-tool-group={group.id}
      data-status={group.hasError ? "error" : undefined}
      data-thinking={
        !group.messages.some((m) => m.role === "tool") &&
        group.messages.some((m) => m.thinking)
          ? ""
          : undefined
      }
      data-stream-in={entered ? "" : undefined}
    >
      {memory.map((m) => (
        <MemoryStepRow key={m.id} message={m} />
      ))}
      {rest.length > 0 && (
        <StepLine
          icon={
            restTools.length === 0
              ? "thinking"
              : stepIconForTools(restTools.map((m) => m.tool?.name ?? ""))
          }
          open={open}
          onToggle={onToggle}
        >
          {label}
        </StepLine>
      )}
      {open &&
        rest.map((message) =>
          message.thinking ? (
            <ThinkingCard
              key={message.id}
              message={message}
              autoExpand={verbose || message.id === latestThinkingId}
              bare
            />
          ) : (
            <ToolCallCard
              key={message.id}
              message={message}
              autoExpand={verbose || message.id === latestRunningToolId}
              onLoadImage={onLoadImage}
              bare
            />
          ),
        )}
    </section>
  );
}

type StepIconKind =
  | "file"
  | "edit"
  | "terminal"
  | "search"
  | "agents"
  | "thinking"
  | "tool";

function stepIconForTools(names: string[]): StepIconKind {
  const actions = new Set(names.map(toolAction));
  if (actions.size !== 1) return "tool";
  const [only] = actions;
  if (only === "read") return "file";
  if (only === "edit") return "edit";
  if (only === "command") return "terminal";
  if (only === "code-search" || only === "search") return "search";
  return "tool";
}

const STEP_ICON_PATHS: Record<StepIconKind, ReactNode> = {
  file: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </>
  ),
  edit: <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />,
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  agents: (
    <>
      <circle cx="9" cy="8" r="3" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M3 20a6 6 0 0 1 12 0M14 20a4.5 4.5 0 0 1 7 0" />
    </>
  ),
  thinking: (
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
  ),
  tool: (
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" />
  ),
};

/**
 * One muted work step (#1429 item 4): small icon, text, and a right-aligned
 * Show/Hide when there is something to expand. Replaces bold headings.
 */
function StepLine({
  icon,
  open,
  onToggle,
  children,
}: {
  icon: StepIconKind | "memory";
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const glyph =
    icon === "memory" ? (
      <span className={styles.stepIcon} aria-hidden="true">
        <i className={styles.memoryDiamond} />
      </span>
    ) : (
      <svg
        className={styles.stepIcon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {STEP_ICON_PATHS[icon]}
      </svg>
    );
  if (!onToggle) {
    return (
      <div className={styles.step} data-step={icon}>
        {glyph}
        <span className={styles.stepText}>{children}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`${styles.step} ${styles.toolGroupToggle}`}
      data-step={icon}
      aria-expanded={open}
      onClick={onToggle}
    >
      {glyph}
      <span className={styles.stepText}>{children}</span>
      <span className={styles.stepMore}>{open ? "Hide" : "Show"}</span>
    </button>
  );
}

/** Shared-memory recall/store as a yellow-marker step (#1429 F5). */
function MemoryStepRow({ message }: { message: ChatMessage }) {
  const step = parseMemoryStep(message);
  const items = step?.kind === "recall" ? step.items : [];
  const [open, setOpen] = useState(items.length > 0 && items.length <= 3);
  if (!step) return null;
  const text = memoryStepText(step);
  return (
    <div className={styles.memoryStep} data-memory-step={step.kind}>
      <StepLine
        icon="memory"
        open={open}
        onToggle={items.length > 0 ? () => setOpen((v) => !v) : undefined}
      >
        {text.before}
        {text.mark ? <span className={styles.mark}>{text.mark}</span> : null}
        {text.after}
      </StepLine>
      {open && items.length > 0 ? (
        <ul className={styles.memoryList} data-memory-list="">
          {items.map((item, i) => (
            <li key={i}>
              {item.title}
              {item.agent || item.age ? (
                <span className={styles.memoryMeta}>
                  {[item.agent, item.age].filter(Boolean).join(" · ")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Attachments on a user transcript message: image thumbnails load lazily as
 * img src (solenta-media:// on desktop, data URL on web); files/folders
 * render as icon + name.
 */
function TranscriptAttachments({
  attachments,
  onLoadImage,
}: {
  attachments: AttachmentInfo[];
  onLoadImage?: (path: string) => Promise<string | null>;
}) {
  return (
    <div className={styles.attachmentChips}>
      {attachments.map((a) => (
        <TranscriptAttachmentChip
          key={a.path}
          attachment={a}
          onLoadImage={onLoadImage}
        />
      ))}
    </div>
  );
}

function TranscriptAttachmentChip({
  attachment,
  onLoadImage,
}: {
  attachment: AttachmentInfo;
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
          tabIndex={0}
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
    </span>
  );
}

/**
 * One timeline row. memo'd because a streamed update re-renders the whole
 * timeline while only the message being written actually changed — so the
 * props are flat scalars, keeping the default shallow compare honest.
 */
/**
 * User bubble. Edit state lives here so a streamed timeline tick does not
 * blow away the draft. Confirm (destructive rewind) stays on ThreadView.
 */
const UserMessageBlock = memo(function UserMessageBlock({
  message,
  canEdit,
  confirming,
  animateIn,
  activityOpen = false,
  onRequestResubmit,
  onCancelConfirm,
  onLoadAttachmentImage,
  onSelectThread,
  pinned = false,
  onTogglePin,
}: {
  message: ChatMessage;
  canEdit: boolean;
  confirming: boolean;
  /** Freshly appended at the live tail — play the stream-in entrance. */
  animateIn?: boolean;
  /** Verbose mode or an active reveal: keep the original notice text shown. */
  activityOpen?: boolean;
  onRequestResubmit?: (messageId: string, prompt: string) => void;
  onCancelConfirm?: () => void;
  onLoadAttachmentImage?: (path: string) => Promise<string | null>;
  onSelectThread?: (id: string) => void;
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [activityOpened, setActivityOpened] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!canEdit && editing) {
      setEditing(false);
      setDraft(message.text);
    }
  }, [canEdit, editing, message.text]);

  const fromThread = message.fromThread;
  // Latch at mount; see ToolCallCard for why.
  const [entered] = useState(Boolean(animateIn));
  const streamCls = entered ? ` ${styles.streamIn}` : "";
  const streamAttr = entered ? "" : undefined;
  const cancelEdit = () => {
    if (confirming) onCancelConfirm?.();
    setEditing(false);
    setDraft(message.text);
  };

  const submitEdit = () => {
    const prompt = draft.trim();
    if (!prompt || !onRequestResubmit) return;
    onRequestResubmit(message.id, prompt);
  };

  if (editing && canEdit) {
    return (
      <article
        className={`${styles.message} ${styles.messageUser}${streamCls}`}
        data-stream-in={streamAttr}
      >
        <div className={styles.userEdit}>
          <textarea
            ref={taRef}
            className={styles.userEditTextarea}
            aria-label="Edit message"
            data-edit-textarea={message.id}
            value={draft}
            rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                if (confirming) onCancelConfirm?.();
                else cancelEdit();
                return;
              }
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submitEdit();
              }
            }}
          />
          <div className={styles.userEditActions}>
            <button
              type="button"
              className={styles.retryBtn}
              data-edit-resubmit={message.id}
              disabled={!draft.trim()}
              onClick={submitEdit}
            >
              Resubmit
            </button>
            <button
              type="button"
              className={styles.retryBtn}
              data-edit-cancel={message.id}
              onClick={cancelEdit}
            >
              Cancel
            </button>
          </div>
        </div>
      </article>
    );
  }

  if (fromThread) {
    const label = fromThread.title || fromThread.id;
    return (
      <article
        className={`${styles.message} ${styles.messageInbound}${streamCls}`}
        data-inbound-card=""
        data-inbound-from={fromThread.id}
        data-stream-in={streamAttr}
      >
        <div className={styles.inboundCard}>
          <div className={styles.inboundFrom}>
            From{" "}
            {onSelectThread ? (
              <button
                type="button"
                className={styles.handoffLink}
                data-inbound-source={fromThread.id}
                onClick={() => onSelectThread(fromThread.id)}
              >
                {label}
              </button>
            ) : (
              <span>{label}</span>
            )}
          </div>
          <div className={styles.inboundBody}>{message.text}</div>
        </div>
      </article>
    );
  }

  const activitySummary = routineWorkerActivitySummary(message);
  if (activitySummary) {
    const activityIsOpen = activityOpen || activityOpened;
    return (
      <article
        className={`${styles.workerActivityRow}${streamCls}`}
        data-msg={message.id}
        data-stream-in={streamAttr}
      >
        <div className={styles.workerActivityCluster}>
          <details
            className={styles.workerActivity}
            data-worker-activity=""
            open={activityIsOpen}
          >
            <summary
              className={styles.workerActivitySummary}
              onClick={(event) => {
                event.preventDefault();
                if (activityOpen) return;
                setActivityOpened((open) => !open);
              }}
            >
              {activitySummary}
            </summary>
            <div
              className={styles.workerActivityBody}
              data-worker-activity-body=""
            >
              {message.text}
            </div>
          </details>
          {canEdit && onRequestResubmit && (
            <button
              type="button"
              className={`${styles.msgAction} ${styles.workerActivityAction}`}
              aria-label="Edit and resubmit"
              title="Edit and resubmit"
              data-edit-message={message.id}
              onClick={() => {
                setDraft(message.text);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
          {onTogglePin && (
            <button
              type="button"
              className={`${styles.msgAction} ${styles.workerActivityAction}`}
              data-msg-pin=""
              aria-pressed={pinned}
              aria-label={pinned ? "Unpin message" : "Pin message"}
              title={pinned ? "Unpin this message" : "Pin this message"}
              onClick={onTogglePin}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 11v3.5M4.5 11h7l-1.25-3.5V3h-4.5v4.5Z" /></svg>
            </button>
          )}
        </div>
      </article>
    );
  }

  return (
    <article
      className={`${styles.message} ${styles.messageUser}${streamCls}`}
      data-stream-in={streamAttr}
    >
      <div className={styles.userBubbleWrap}>
        <div className={styles.userBubbleCluster}>
          {canEdit && onRequestResubmit && (
            <button
              type="button"
              className={`${styles.retryBtn} ${styles.userEditBtn}`}
              aria-label="Edit and resubmit"
              title="Edit and resubmit"
              data-edit-message={message.id}
              onClick={() => {
                setDraft(message.text);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
          <div className={styles.userBubble}>
            {message.steer && (
              <div className={styles.steerLabel} data-steer-label="">
                Steered
              </div>
            )}
            {message.text}
            {message.attachments && message.attachments.length > 0 && (
              <TranscriptAttachments
                attachments={message.attachments}
                onLoadImage={onLoadAttachmentImage}
              />
            )}
          </div>
        </div>
      </div>
      {onTogglePin && (
        <footer className={styles.msgMeta}>
          <span className={styles.msgActions}>
            <button
              type="button"
              className={styles.msgAction}
              data-msg-pin=""
              aria-pressed={pinned}
              aria-label={pinned ? "Unpin message" : "Pin message"}
              title={pinned ? "Unpin this message" : "Pin this message"}
              onClick={onTogglePin}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 11v3.5M4.5 11h7l-1.25-3.5V3h-4.5v4.5Z" /></svg>
            </button>
          </span>
        </footer>
      )}
    </article>
  );
});

/** Last two path segments for a chip; full list stays on the tooltip. */
function provShortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
}

/**
 * Provenance tier strip under an assistant message (issue #404). Grounded
 * messages get one chip per addressable source tier; a substantive message
 * with no addressable source gets the "model prior knowledge" tag — the
 * fluent-summary warning this feature exists for.
 */
function ProvenanceStrip({
  prov,
  text,
}: {
  prov: MessageProvenance;
  text: string;
}) {
  if (!provenanceVisible(prov, text)) return null;
  if (!prov.grounded) {
    return (
      <div className={styles.provStrip} data-provenance="prior">
        <span
          className={styles.provChip}
          data-tier="prior"
          title="No repo file, shared-memory entry, or GitHub issue backs this message — it came from the model's prior knowledge."
        >
          model prior knowledge
        </span>
      </div>
    );
  }
  return (
    <div className={styles.provStrip} data-provenance="grounded">
      {prov.repo.length > 0 && (
        <span
          className={styles.provChip}
          data-tier="repo"
          title={prov.repo.join("\n")}
        >
          repo: {provShortPath(prov.repo[0])}
          {prov.repo.length > 1 ? ` +${prov.repo.length - 1}` : ""}
        </span>
      )}
      {prov.memory.length > 0 && (
        <span
          className={styles.provChip}
          data-tier="memory"
          title={`Shared memory: ${prov.memory.join(", ")}`}
        >
          memory
        </span>
      )}
      {prov.issues.map((ref) => (
        <span
          key={ref}
          className={styles.provChip}
          data-tier="issue"
          title="GitHub issue/PR reference"
        >
          {ref.startsWith("#") ? ref : "issue"}
        </span>
      ))}
    </div>
  );
}

export const MessageBlock = memo(function MessageBlock({
  message,
  autoExpandTool,
  animateIn,
  activityOpen = false,
  streaming,
  eventActionLabel,
  eventActionTitle,
  onEventAction,
  canEdit,
  confirming,
  onRequestResubmit,
  onCancelConfirm,
  metaAgent = null,
  metaModel = null,
  metaEffort = null,
  metaDuration = null,
  provenance = null,
  onLoadImage,
  onLoadAttachmentImage,
  onSelectThread,
  onReply,
  onCiteSelection,
  onWaitWhat,
  pinned = false,
  onTogglePin,
  threadId = null,
}: {
  message: ChatMessage;
  autoExpandTool: boolean;
  /** Freshly appended at the live tail — play the stream-in entrance. */
  animateIn?: boolean;
  /** Verbose mode or an active reveal: keep a routine notice expanded. */
  activityOpen?: boolean;
  /** Actively growing assistant message — show the streaming caret. */
  streaming?: boolean;
  onLoadImage?: (name: string) => Promise<string | null>;
  onLoadAttachmentImage?: (path: string) => Promise<string | null>;
  eventActionLabel?: string;
  eventActionTitle?: string;
  onEventAction?: () => void;
  canEdit?: boolean;
  confirming?: boolean;
  onRequestResubmit?: (messageId: string, prompt: string) => void;
  onCancelConfirm?: () => void;
  /** Assistant footer segments; null fields are omitted inside. */
  metaAgent?: string | null;
  metaModel?: string | null;
  metaEffort?: string | null;
  metaDuration?: string | null;
  /** Provenance tiers for assistant messages; null hides the strip. */
  provenance?: MessageProvenance | null;
  onSelectThread?: (id: string) => void;
  onReply?: (message: ChatMessage) => void;
  onCiteSelection?: (target: ReplyTarget) => void;
  onWaitWhat?: (message: ChatMessage) => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  threadId?: string | null;
}) {
  // Latch at mount; see ToolCallCard for why.
  const [entered] = useState(Boolean(animateIn));
  const [copied, setCopied] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  if (message.thinking) {
    return (
      <ThinkingCard
        message={message}
        autoExpand={autoExpandTool}
        animateIn={entered}
      />
    );
  }
  if (isMemoryToolMessage(message)) {
    return <MemoryStepRow message={message} />;
  }
  if (message.role === "tool") {
    return (
      <ToolCallCard
        message={message}
        autoExpand={autoExpandTool}
        animateIn={entered}
        onLoadImage={onLoadImage}
      />
    );
  }

  if (message.role === "user") {
    return (
      <UserMessageBlock
        message={message}
        canEdit={Boolean(canEdit)}
        confirming={Boolean(confirming)}
        animateIn={entered}
        activityOpen={activityOpen}
        onRequestResubmit={onRequestResubmit}
        onCancelConfirm={onCancelConfirm}
        onLoadAttachmentImage={onLoadAttachmentImage}
        onSelectThread={onSelectThread}
        pinned={pinned}
        onTogglePin={onTogglePin}
      />
    );
  }

  if (message.role === "event") {
    // Quiet one-line step (#1429). Only the subagent kickoff folds its
    // phase list behind Show; any other notice body (failures, "Not
    // delivered") stays visible.
    const [eventHead, ...eventRest] = message.text.split(/\r?\n/);
    const eventBody = eventRest.join("\n").trim();
    const kickoff = /^kicked off \d+ subagent/i.test(eventHead ?? "");
    return (
      <section
        className={`${styles.eventLine}${entered ? ` ${styles.streamIn}` : ""}`}
        data-stream-in={entered ? "" : undefined}
      >
        <div className={styles.eventRow}>
          <StepLine
            icon={kickoff ? "agents" : "tool"}
            open={eventOpen}
            onToggle={
              kickoff && eventBody ? () => setEventOpen((v) => !v) : undefined
            }
          >
            {eventHead}
          </StepLine>
          {eventActionLabel && onEventAction && (
            <button
              type="button"
              className={styles.retryBtn}
              title={eventActionTitle}
              onClick={onEventAction}
            >
              {eventActionLabel}
            </button>
          )}
        </div>
        {eventBody && (eventOpen || !kickoff) ? (
          <div className={styles.eventTitle}>{eventBody}</div>
        ) : null}
      </section>
    );
  }

  const metaLine = messageMetaLine({
    createdAt: message.createdAt,
    agent: metaAgent,
    model: metaModel,
    effort: metaEffort,
    duration: metaDuration,
  });
  return (
    <article
      className={`${styles.message}${entered ? ` ${styles.streamIn}` : ""}`}
      data-stream-in={entered ? "" : undefined}
      data-msg={message.id}
      data-thread={threadId ?? undefined}
      data-streaming={streaming ? "" : undefined}
    >
      <div data-cite-body="">
        <Markdown text={message.text} streaming={streaming} />
      </div>
      {streaming && (
        <span
          className={styles.streamCaret}
          data-streaming-caret=""
          aria-hidden
        />
      )}
      {provenance && <ProvenanceStrip prov={provenance} text={message.text} />}
      <footer className={styles.msgMeta}>
        <span>{metaLine}</span>
        {(onTogglePin ||
          (!streaming &&
            message.text.trim() &&
            (onReply || onCiteSelection || onWaitWhat))) && (
          <span className={styles.msgActions}>
            {!streaming && message.text.trim() && (
              <button
                type="button"
                className={styles.msgAction}
                data-msg-copy=""
                aria-label={copied ? "Copied" : "Copy message"}
                title={copied ? "Copied" : "Copy message"}
                onClick={() => {
                  void navigator.clipboard?.writeText(message.text).then(
                    () => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1200);
                    },
                    () => {},
                  );
                }}
              >
                {copied ? <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg> : <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" /></svg>}
              </button>
            )}
            {onTogglePin && (
              <button
                type="button"
                className={styles.msgAction}
                data-msg-pin=""
                aria-pressed={pinned}
                aria-label={pinned ? "Unpin message" : "Pin message"}
                title={pinned ? "Unpin this message" : "Pin this message"}
                onClick={onTogglePin}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 11v3.5M4.5 11h7l-1.25-3.5V3h-4.5v4.5Z" /></svg>
              </button>
            )}
            {!streaming && onReply && message.text.trim() && (
              <button
                type="button"
                className={styles.msgAction}
                data-msg-reply=""
                aria-label="Reply"
                title="Reply: quote this message as context for the next send"
                onClick={() => onReply(message)}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 10 2.5 6.5 6 3" /><path d="M2.5 6.5h7a4 4 0 0 1 4 4v2" /></svg>
              </button>
            )}
            {!streaming && onCiteSelection && threadId && message.text.trim() && (
              <button
                type="button"
                className={styles.msgAction}
                data-msg-cite=""
                title="Quote the selected text as context for the next send (⌘⇧C)"
                onClick={(e) => {
                  const article = e.currentTarget.closest("[data-msg]");
                  const citeBody = article?.querySelector("[data-cite-body]");
                  if (!(citeBody instanceof Element)) return;
                  const target = captureCiteFromSelection({
                    selection: window.getSelection(),
                    messageId: message.id,
                    threadId,
                    sourceText: message.text,
                    citeBody,
                  });
                  if (target) onCiteSelection(target);
                }}
                aria-label="Cite selection"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5h10M3 8h6M3 11.5h8" /></svg>
              </button>
            )}
            {!streaming && onWaitWhat && message.text.trim() && (
              <button
                type="button"
                className={styles.msgAction}
                data-msg-wait-what=""
                aria-label="Wait, what?"
                title="Wait, what? Re-explain this message in plain English"
                onClick={() => onWaitWhat(message)}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.75" /><path d="M6.4 6.3a1.7 1.7 0 0 1 3.2.6c0 1.1-1.6 1.4-1.6 2.4M8 11.2h.01" /></svg>
              </button>
            )}
          </span>
        )}
      </footer>
    </article>
  );
});

export function ReviewBarStrip({
  bar,
  isWorking,
  expanded = false,
  onReview,
  onUndo,
}: {
  bar: ReviewBar;
  isWorking: boolean;
  expanded?: boolean;
  onReview: () => void;
  onUndo: () => void;
}) {
  const canUndo = Boolean(bar.undoSha) && !isWorking;
  const undoTitle = isWorking
    ? RESTORE_ACTIVE_TITLE
    : bar.undoSha
      ? "Undo this run"
      : "Nothing to undo";
  return (
    <div className={styles.reviewBar} data-review-bar={bar.runId}>
      <span className={styles.reviewStats} data-review-stats="">
        {formatReviewBarText(bar.files, bar.additions, bar.deletions)}
      </span>
      <div className={styles.reviewActions}>
        <button
          type="button"
          className={styles.reviewBtn}
          data-review-undo=""
          disabled={!canUndo}
          title={undoTitle}
          onClick={() => {
            if (!canUndo) return;
            onUndo();
          }}
        >
          Undo
        </button>
        <button
          type="button"
          className={styles.reviewBtn}
          data-review-open=""
          title={expanded ? "Hide this turn's diff" : "Review this turn"}
          aria-expanded={expanded}
          onClick={onReview}
        >
          {expanded ? "Hide" : "Review"}
        </button>
      </div>
    </div>
  );
}

/** Open suggested-work chips under the transcript (issue #550). */
export function SuggestedWorkStrip({
  suggestions,
  onStart,
  onFile,
  onDismiss,
}: {
  suggestions: WorkSuggestion[] | undefined;
  onStart?: (s: WorkSuggestion) => void | Promise<void>;
  onFile?: (s: WorkSuggestion) => void | Promise<void>;
  onDismiss?: (s: WorkSuggestion) => void | Promise<void>;
}) {
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const open = (suggestions ?? []).filter((s) => s.status === "open");
  if (open.length === 0) return null;

  const run = (
    s: WorkSuggestion,
    action?: (s: WorkSuggestion) => void | Promise<void>,
  ) => {
    if (!action || inFlight.has(s.id)) return;
    setInFlight((prev) => new Set(prev).add(s.id));
    void Promise.resolve(action(s)).finally(() => {
      setInFlight((prev) => {
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
    });
  };

  return (
    <div className={styles.suggestedWork} data-suggested-work="">
      <span className={styles.suggestedLabel}>Suggested</span>
      {open.map((s) => {
        const busy = inFlight.has(s.id);
        return (
          <span
            key={s.id}
            className={styles.suggestedRow}
            data-suggestion-id={s.id}
          >
            <button
              type="button"
              className={styles.suggestedChip}
              data-suggestion-action="start"
              disabled={busy}
              title={`Start a thread: ${s.title}`}
              onClick={() => run(s, onStart)}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M8 3v10M3 8h10" />
              </svg>
              <span className={styles.suggestedTitle}>{s.title}</span>
            </button>
            <button
              type="button"
              className={styles.suggestedIcon}
              data-suggestion-action="file"
              disabled={busy}
              aria-label="File on planboard"
              title="File on planboard"
              onClick={() => run(s, onFile)}
            >
              <svg
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
                <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
                <path d="M6.5 3v10M10 3v10" />
              </svg>
            </button>
            <button
              type="button"
              className={styles.suggestedIcon}
              data-suggestion-action="dismiss"
              disabled={busy}
              aria-label="Dismiss suggestion"
              title="Dismiss"
              onClick={() => run(s, onDismiss)}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** One-line Focus fold for a settled turn's tool/thinking rows (#461). */
export function FocusTurnRow({
  turn,
  collapsed,
  onToggle,
}: {
  turn: FocusTurnSummary;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.focusTurn}
      data-focus-turn={turn.key}
      aria-expanded={!collapsed}
      title={collapsed ? "Show tool activity" : "Hide tool activity"}
      onClick={onToggle}
    >
      {turn.live && (
        <span className={styles.focusTurnSpin} aria-hidden="true" />
      )}
      <span className={styles.chevron} data-open={!collapsed}>
        <svg
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3.5 2 6.5 5 3.5 8" />
        </svg>
      </span>
      <span className={styles.focusTurnLabel}>{turn.label}</span>
    </button>
  );
}

/** Collapsible "Worked for 2m 5s" header row above a completed run. */
export function RunHeaderRow({
  header,
  collapsed,
  onToggle,
}: {
  header: RunHeader;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.runHeader}
      data-run-header={header.runId}
      aria-expanded={!collapsed}
      title={collapsed ? "Show this run" : "Hide this run"}
      onClick={onToggle}
    >
      <span className={styles.chevron} data-open={!collapsed}>
        <svg
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3.5 2 6.5 5 3.5 8" />
        </svg>
      </span>
      <span className={styles.runHeaderLabel}>{header.label}</span>
    </button>
  );
}
