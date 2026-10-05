import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { CoderApi, SpeechStatus } from "../../shared/ipc";
import { applySpeechDelta, applySpeechTranscript } from "../../speechDraft";
import {
  speechCaptureError,
  startSpeechCapture,
  type SpeechCapture,
} from "../../speechCapture";

function coderSpeech(): CoderApi["speech"] | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { coder?: CoderApi }).coder?.speech;
}

function coderOn(): CoderApi["on"] | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { coder?: CoderApi }).coder?.on;
}

export type SpeechSnapshot = {
  threadId: string;
  draft: string;
  caret: number;
  prefix: string;
  suffix: string;
  accumulated: string;
  sessionId: string;
};

export function speechMicLabel(
  status: SpeechStatus | null,
  dictating: boolean,
): string {
  if (dictating) return "Stop dictation";
  if (status?.state === "downloading") {
    const d = status.download;
    if (d && d.bytesTotal > 0) {
      const pct = Math.round((100 * d.bytesReceived) / d.bytesTotal);
      return `Downloading speech model, ${pct}%`;
    }
    return "Downloading speech model";
  }
  if (!status || status.state === "missing") return "Download speech model";
  if (status.state === "error" && !status.modelReady) {
    return "Download speech model";
  }
  return "Start dictation";
}

/**
 * Local speech-to-text for the composer: model status, the mic toggle, and
 * live dictation written into the thread's draft.
 */
export function useComposerSpeech({
  threadId,
  disabled,
  sending,
  draftsRef,
  textareaRef,
  liveThreadIdRef,
  readDraft,
  syncHasPrompt,
  syncOverflow,
  setLocalError,
}: {
  threadId: string;
  disabled: boolean;
  sending: boolean;
  draftsRef: RefObject<Record<string, string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  liveThreadIdRef: RefObject<string>;
  readDraft: () => string;
  syncHasPrompt: (text: string) => void;
  syncOverflow: (draft: string) => void;
  setLocalError: Dispatch<SetStateAction<string | null>>;
}) {
  const hasSpeech = Boolean(coderSpeech());
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const [speechConfirm, setSpeechConfirm] = useState(false);
  const [dictating, setDictating] = useState(false);
  const snapshotRef = useRef<SpeechSnapshot | null>(null);
  const captureRef = useRef<SpeechCapture | null>(null);
  const dictatingRef = useRef(false);
  const writeDraftFor = useCallback(
    (tid: string, text: string, caret?: number) => {
      draftsRef.current[tid] = text;
      if (liveThreadIdRef.current !== tid) return;
      const el = textareaRef.current;
      if (el) {
        el.value = text;
        if (caret != null) {
          el.focus();
          el.setSelectionRange(caret, caret);
        }
      }
      syncHasPrompt(text);
      syncOverflow(text);
    },
    [syncHasPrompt, syncOverflow],
  );
  const cancelDictation = useCallback(async () => {
    if (!snapshotRef.current && !captureRef.current && !dictatingRef.current) {
      return;
    }
    const snap = snapshotRef.current;
    const capture = captureRef.current;
    snapshotRef.current = null;
    captureRef.current = null;
    dictatingRef.current = false;
    setDictating(false);
    setSpeechConfirm(false);
    capture?.close();
    if (snap) writeDraftFor(snap.threadId, snap.draft, snap.caret);
    const api = coderSpeech();
    if (snap?.sessionId && api) {
      try {
        await api.cancel({ sessionId: snap.sessionId });
      } catch {
        // session already gone
      }
    }
  }, [writeDraftFor]);
  const cancelDictationRef = useRef(cancelDictation);
  cancelDictationRef.current = cancelDictation;
  const applySpeechStatus = useCallback(
    (status: SpeechStatus) => {
      setSpeech(status);
      if (status.state === "downloading" || status.state === "ready") {
        setSpeechConfirm(false);
      }
      const snap = snapshotRef.current;
      if (!snap) return;
      if (status.state === "error") {
        void cancelDictationRef.current();
        if (status.error) setLocalError(status.error);
        return;
      }
      if (status.delta) {
        const next = applySpeechDelta({
          prefix: snap.prefix,
          suffix: snap.suffix,
          accumulated: snap.accumulated,
          delta: status.delta,
        });
        snap.accumulated = next.accumulated;
        writeDraftFor(snap.threadId, next.text, next.caret);
      }
      if (status.transcript !== undefined) {
        const next = applySpeechTranscript({
          prefix: snap.prefix,
          suffix: snap.suffix,
          original: snap.draft,
          originalCaret: snap.caret,
          transcript: status.transcript,
        });
        writeDraftFor(snap.threadId, next.text, next.caret);
        snapshotRef.current = null;
        dictatingRef.current = false;
        setDictating(false);
        captureRef.current?.close();
        captureRef.current = null;
      }
    },
    [writeDraftFor],
  );
  useEffect(() => {
    const api = coderSpeech();
    const on = coderOn();
    if (!api || !on) return;
    let live = true;
    void api
      .status()
      .then((s) => {
        if (live) setSpeech(s);
      })
      .catch(() => {});
    const off = on("speech:changed", (s) => {
      if (live) applySpeechStatus(s);
    });
    return () => {
      live = false;
      off();
    };
  }, [applySpeechStatus]);
  useEffect(() => {
    if (disabled) void cancelDictationRef.current();
  }, [disabled]);
  const startDictation = useCallback(async () => {
    const api = coderSpeech();
    if (!api || dictatingRef.current || disabled) return;
    setSpeechConfirm(false);
    const el = textareaRef.current;
    const draft = readDraft();
    const caret = el?.selectionStart ?? draft.length;
    snapshotRef.current = {
      threadId,
      draft,
      caret,
      prefix: draft.slice(0, caret),
      suffix: draft.slice(caret),
      accumulated: "",
      sessionId: "",
    };
    dictatingRef.current = true;
    setDictating(true);
    try {
      const capture = await startSpeechCapture({
        write: (pcm, seq) => {
          const id = snapshotRef.current?.sessionId;
          if (!id) return;
          return api.write({ sessionId: id, pcm, seq });
        },
      });
      if (!snapshotRef.current) {
        capture.close();
        return;
      }
      captureRef.current = capture;
      const started = await api.start();
      if (!snapshotRef.current) {
        capture.close();
        captureRef.current = null;
        try {
          await api.cancel({ sessionId: started.sessionId });
        } catch {
          // already cancelled
        }
        return;
      }
      snapshotRef.current.sessionId = started.sessionId;
    } catch (err) {
      captureRef.current?.close();
      captureRef.current = null;
      const snap = snapshotRef.current;
      snapshotRef.current = null;
      dictatingRef.current = false;
      setDictating(false);
      if (snap) writeDraftFor(snap.threadId, snap.draft, snap.caret);
      setLocalError(speechCaptureError(err));
    }
  }, [disabled, readDraft, threadId, writeDraftFor]);
  const stopDictation = useCallback(async () => {
    const snap = snapshotRef.current;
    const api = coderSpeech();
    if (!snap || !api) return;
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) await capture.flushAndStop();
    try {
      if (snap.sessionId) await api.stop({ sessionId: snap.sessionId });
    } catch (err) {
      await cancelDictation();
      setLocalError(speechCaptureError(err));
    }
  }, [cancelDictation]);
  const onMicClick = useCallback(() => {
    if (disabled || sending) return;
    if (dictatingRef.current) {
      void stopDictation();
      return;
    }
    const state = speech?.state ?? "missing";
    if (state === "downloading") return;
    if (state === "ready" || state === "recording") {
      void startDictation();
      return;
    }
    if (state === "missing" || (state === "error" && !speech?.modelReady)) {
      setSpeechConfirm(true);
    }
  }, [disabled, sending, speech, startDictation, stopDictation]);
  const confirmSpeechDownload = useCallback(() => {
    const api = coderSpeech();
    if (!api) return;
    setSpeechConfirm(false);
    void api.download().catch((err) => {
      setLocalError(speechCaptureError(err));
    });
  }, []);
  return {
    hasSpeech,
    speech,
    speechConfirm,
    setSpeechConfirm,
    dictating,
    snapshotRef,
    cancelDictationRef,
    onMicClick,
    confirmSpeechDownload,
  };
}
