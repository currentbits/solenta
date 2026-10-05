import { useEffect } from "react";
import type { ThreadDetail } from "../../shared/ipc";
import {
  captureCiteFromSelection,
  citeBodyFromSelection,
  type ReplyTarget,
} from "../../replyContext";

/** ⌘⇧C on a selection inside an assistant message cites it as a reply. */
export function useCiteShortcut(
  detail: ThreadDetail | null,
  storeReply: (target: ReplyTarget) => void,
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key.toLowerCase() !== "c") return;
      const t = e.target;
      if (
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLInputElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      const sel = window.getSelection();
      const citeBody = citeBodyFromSelection(sel);
      if (!citeBody) return;
      const article = citeBody.closest("[data-msg]");
      if (!(article instanceof HTMLElement)) return;
      if (article.hasAttribute("data-streaming")) return;
      const messageId = article.getAttribute("data-msg");
      const originThreadId = article.getAttribute("data-thread");
      if (!messageId || !originThreadId) return;
      const message = detail?.messages.find((row) => row.id === messageId);
      if (!message || message.role !== "assistant" || !message.text.trim()) {
        return;
      }
      const target = captureCiteFromSelection({
        selection: sel,
        messageId,
        threadId: originThreadId,
        sourceText: message.text,
        citeBody,
      });
      if (!target) return;
      e.preventDefault();
      storeReply(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail?.messages, storeReply]);
}
