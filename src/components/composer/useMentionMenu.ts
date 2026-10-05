import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { applyMention, getMentionQuery, type MentionQuery } from "../../mention";

/**
 * The @-mention popup: the token under the caret, a debounced file lookup,
 * and accepting a row into the draft. No effects, so it cannot reorder
 * Composer's effects wherever it is called.
 */
export function useMentionMenu({
  textareaRef,
  onListFiles,
  onPickMentionFolder,
  disabled,
  writeDraft,
  setLocalError,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onListFiles?: (query: string) => Promise<string[]>;
  onPickMentionFolder?: () => Promise<string | null>;
  disabled: boolean;
  writeDraft: (text: string, caret?: number) => void;
  setLocalError: Dispatch<SetStateAction<string | null>>;
}) {
  /** @-mention popup state; `mention` null means closed. */
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stale-response guard: only the latest lookup may paint the popup. */
  const mentionSeq = useRef(0);
  const mentionOpen =
    mention != null &&
    (mentionFiles.length > 0 || Boolean(onPickMentionFolder));

  const closeMention = useCallback(() => {
    if (mentionTimer.current) {
      clearTimeout(mentionTimer.current);
      mentionTimer.current = null;
    }
    setMention((prev) => (prev == null ? prev : null));
    setMentionFiles((prev) => (prev.length === 0 ? prev : []));
    setMentionIndex((prev) => (prev === 0 ? prev : 0));
  }, []);

  /** Recompute the active @token from the live textarea and (re)fetch files. */
  const refreshMention = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !onListFiles || disabled) {
      closeMention();
      return;
    }
    const q = getMentionQuery(el.value, el.selectionStart ?? el.value.length);
    if (!q) {
      closeMention();
      return;
    }
    setMention((prev) =>
      prev && prev.start === q.start && prev.query === q.query ? prev : q,
    );
    if (mentionTimer.current) clearTimeout(mentionTimer.current);
    const seq = ++mentionSeq.current;
    mentionTimer.current = setTimeout(() => {
      onListFiles(q.query)
        .then((files) => {
          if (mentionSeq.current !== seq) return;
          setMentionFiles(files);
          setMentionIndex(0);
        })
        .catch(() => {
          if (mentionSeq.current !== seq) return;
          setMentionFiles([]);
        });
    }, 150);
  }, [onListFiles, disabled, closeMention]);

  const acceptMention = useCallback(
    (path: string) => {
      const el = textareaRef.current;
      if (!el || !mention) return;
      const next = applyMention(
        el.value,
        el.selectionStart ?? el.value.length,
        mention.start,
        path,
      );
      writeDraft(next.text, next.caret);
      closeMention();
    },
    [mention, closeMention, writeDraft],
  );

  const browseMentionFolder = useCallback(() => {
    if (!onPickMentionFolder || disabled) return;
    void onPickMentionFolder()
      .then((path) => {
        if (path) acceptMention(path);
      })
      .catch((err) => {
        const msg =
          err instanceof Error && err.message
            ? err.message
            : "Failed to pick folder";
        setLocalError(msg);
      });
  }, [onPickMentionFolder, disabled, acceptMention]);
  return {
    mentionFiles,
    mentionIndex,
    setMentionIndex,
    mentionOpen,
    closeMention,
    refreshMention,
    acceptMention,
    browseMentionFolder,
  };
}
