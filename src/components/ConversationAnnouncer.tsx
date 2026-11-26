import { useEffect, useRef, useState } from "react";
import type { ThreadDetail } from "../shared/ipc";
import { conversationAnnouncement, conversationState, type ConversationState } from "../conversationAnnouncements";
import { useConversationAnnouncements, useConversationAnnouncementTitle } from "../uiPrefs";
import styles from "./ConversationAnnouncer.module.css";

export function ConversationAnnouncer({ detail, scopeId }: { detail: ThreadDetail; scopeId: string }) {
  const mode = useConversationAnnouncements();
  const includeTitle = useConversationAnnouncementTitle();
  const prior = useRef<{ scopeId: string; state: ConversationState; preference: string } | null>(null);
  const sequence = useRef(0);
  const [notice, setNotice] = useState<{ id: number; text: string; scopeId: string; preference: string } | null>(null);
  const preference = `${mode}:${includeTitle}`;

  useEffect(() => {
    const next = conversationState(detail);
    const previous = prior.current;
    prior.current = { scopeId, state: next, preference };
    if (mode === "off" || previous && previous.preference !== preference) {
      setNotice(null);
      return;
    }
    const sameThread = previous?.scopeId === scopeId;
    const text = conversationAnnouncement(sameThread ? previous.state : null, next, detail, mode === "replies");
    if (!text) {
      if (!sameThread) setNotice(null);
      return;
    }
    const title = detail.thread.title.replace(/\s+/g, " ").trim().slice(0, 100);
    setNotice({ id: ++sequence.current, text: includeTitle && title ? `${title}. ${text}` : text, scopeId, preference });
  }, [detail, scopeId, mode, includeTitle, preference]);

  return <div className={styles.live} role="status" aria-live={mode === "off" ? "off" : "polite"} aria-atomic="true" data-conversation-announcer="">
    {notice?.scopeId === scopeId && notice.preference === preference && mode !== "off" && <span key={notice.id}>{notice.text}</span>}
  </div>;
}
