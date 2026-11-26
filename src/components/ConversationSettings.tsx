import {
  TRANSCRIPT_VIEW_HINTS,
  TRANSCRIPT_VIEW_LABELS,
  TRANSCRIPT_VIEW_MODES,
  type TranscriptViewMode,
} from "../focusView";
import {
  setComposerBusyAction,
  setComposerVimEnabled,
  setRunDurationEnabled,
  setTranscriptViewMode,
  useComposerBusyAction,
  useComposerVimEnabled,
  useRunDurationEnabled,
  useTranscriptViewMode,
  setConversationAnnouncements,
  setConversationAnnouncementTitle,
  useConversationAnnouncements,
  useConversationAnnouncementTitle,
  type ConversationAnnouncements,
} from "../uiPrefs";
import { bindingLabel } from "../keybindings";
import { useKeybindingOverrides } from "../uiPrefs";
import styles from "./SettingsModal.module.css";

export function ConversationSettings() {
  useKeybindingOverrides();
  const alternateShortcut = bindingLabel("composer.steer") ?? "The alternate send shortcut";
  const busyAction = useComposerBusyAction();
  const transcriptView = useTranscriptViewMode();
  const vimEnabled = useComposerVimEnabled();
  const runDuration = useRunDurationEnabled();
  const announcements = useConversationAnnouncements();
  const announcementTitle = useConversationAnnouncementTitle();

  return (
    <section className={styles.section} aria-label="Conversation preferences">
      <h3 className={styles.sectionLabel}>Conversation</h3>
      <p className={styles.note}>Applies to all threads on this device. Changes take effect immediately.</p>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="conversation-follow-up">When you send during a run</label>
        <select
          id="conversation-follow-up"
          className={styles.input}
          value={busyAction}
          aria-describedby="conversation-follow-up-hint"
          onChange={e => setComposerBusyAction(e.target.value === "steer" ? "steer" : "queue")}
        >
          <option value="queue">Queue until the run finishes</option>
          <option value="steer">Steer the live turn</option>
        </select>
        <p id="conversation-follow-up-hint" className={styles.note}>
          {busyAction === "queue"
            ? `Queue keeps your next request for after the current run. ${alternateShortcut} steers one message instead.`
            : `Steer redirects the current run. ${alternateShortcut} queues one message instead.`}
          {" "}Agents without steering support always queue. You can also change this preference in the composer.
        </p>
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="conversation-transcript-view">Tool detail</label>
        <select
          id="conversation-transcript-view"
          className={styles.input}
          value={transcriptView}
          aria-describedby="conversation-transcript-view-hint"
          onChange={e => setTranscriptViewMode(e.target.value as TranscriptViewMode)}
        >
          {TRANSCRIPT_VIEW_MODES.map(mode => <option key={mode} value={mode}>{TRANSCRIPT_VIEW_LABELS[mode]}</option>)}
        </select>
        <p id="conversation-transcript-view-hint" className={styles.note}>{TRANSCRIPT_VIEW_HINTS[transcriptView]}.</p>
      </div>
      <label className={styles.fieldRow}>
        <input type="checkbox" checked={runDuration} onChange={e => setRunDurationEnabled(e.target.checked)} />
        <span>Show run duration below replies</span>
      </label>
      <label className={styles.fieldRow}>
        <input type="checkbox" checked={vimEnabled} onChange={e => setComposerVimEnabled(e.target.checked)} />
        <span>Use Vim motions in the composer</span>
      </label>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="conversation-announcements">Screen-reader announcements</label>
        <select
          id="conversation-announcements"
          className={styles.input}
          value={announcements}
          aria-describedby="conversation-announcements-hint"
          onChange={e => setConversationAnnouncements(e.target.value as ConversationAnnouncements)}
        >
          <option value="off">Off</option>
          <option value="status">Run status and input requests</option>
          <option value="replies">Status and final reply previews</option>
        </select>
        <p id="conversation-announcements-hint" className={styles.note}>
          Announces changes in the selected conversation without moving focus.
          Streaming text and tool output stay quiet. Reply previews read up to 600 characters when a run finishes.
        </p>
        <label className={styles.fieldRow}>
          <input type="checkbox" checked={announcementTitle} disabled={announcements === "off"} onChange={e => setConversationAnnouncementTitle(e.target.checked)} />
          <span>Include the thread title in announcements</span>
        </label>
      </div>
    </section>
  );
}
