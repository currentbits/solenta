import type { Dispatch, SetStateAction } from "react";
import type { SpeechStatus } from "../../shared/ipc";
import { formatSpeechModelSize } from "../../speechDraft";
import styles from "../Composer.module.css";
import { speechMicLabel } from "./useComposerSpeech";

/** Mic pill and the inline download confirmation for the speech model. */
export function SpeechControls({
  speech,
  dictating,
  disabled,
  sending,
  speechConfirm,
  setSpeechConfirm,
  onMicClick,
  confirmSpeechDownload,
}: {
  speech: SpeechStatus;
  dictating: boolean;
  disabled: boolean;
  sending: boolean;
  speechConfirm: boolean;
  setSpeechConfirm: Dispatch<SetStateAction<boolean>>;
  onMicClick: () => void;
  confirmSpeechDownload: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className={`${styles.pill}${dictating ? ` ${styles.pillAccent}` : ""}`}
        data-speech-mic=""
        disabled={
          disabled ||
          sending ||
          speech.state === "downloading"
        }
        aria-disabled={
          disabled || sending || speech.state === "downloading"
            ? "true"
            : undefined
        }
        aria-label={speechMicLabel(speech, dictating)}
        aria-pressed={dictating ? "true" : "false"}
        title={speechMicLabel(speech, dictating)}
        onClick={onMicClick}
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
          <path d="M8 2.5a2.2 2.2 0 0 0-2.2 2.2v3.1a2.2 2.2 0 1 0 4.4 0V4.7A2.2 2.2 0 0 0 8 2.5Z" />
          <path d="M4.2 8.2a3.8 3.8 0 0 0 7.6 0" />
          <path d="M8 12v1.8" />
        </svg>
        {speech.state === "downloading" && speech.download?.bytesTotal
          ? `${Math.round((100 * speech.download.bytesReceived) / speech.download.bytesTotal)}%`
          : null}
      </button>
      {speechConfirm && (
        <span
          className={styles.speechConfirm}
          data-speech-confirm=""
          role="group"
          aria-label="Download speech model"
        >
          <span>Download {formatSpeechModelSize()}?</span>
          <button
            type="button"
            className={styles.pill}
            aria-label="Confirm download"
            onClick={confirmSpeechDownload}
          >
            Download
          </button>
          <button
            type="button"
            className={styles.pill}
            aria-label="Cancel download"
            onClick={() => setSpeechConfirm(false)}
          >
            Cancel
          </button>
        </span>
      )}
    </>
  );
}
