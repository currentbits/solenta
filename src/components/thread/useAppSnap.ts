import {
  useCallback,
  useEffect,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { AttachmentInfo } from "../../shared/ipc";
import { createDoubleOptionTracker } from "../../appsnapHotkey";
import { useEscapeClose } from "../../useEscapeClose";
import { useModalFocus } from "../../useModalFocus";

/**
 * AppSnap (double-Option window capture) and browser-pane screenshots, both
 * delivered to the composer only while the thread/generation that asked is
 * still live (#1206).
 */
export function useAppSnap({
  onListSnapWindows,
  onCaptureSnapWindow,
  onSaveAttachmentImage,
  isArchived,
  snapOpen,
  setSnapOpen,
  setSnapWindows,
  setSnapError,
  snapBusy,
  setSnapBusy,
  snapDialogRef,
  setIncomingHandoff,
  screenshotHandoffGen,
  screenshotHandoffThreadId,
}: {
  onListSnapWindows?: () => Promise<Array<{ id: string; name: string }>>;
  onCaptureSnapWindow?: (
    sourceId: string,
  ) => Promise<AttachmentInfo | AttachmentInfo[] | null>;
  onSaveAttachmentImage?: (dataUrl: string) => Promise<AttachmentInfo | null>;
  isArchived: boolean;
  snapOpen: boolean;
  setSnapOpen: Dispatch<SetStateAction<boolean>>;
  setSnapWindows: Dispatch<SetStateAction<Array<{ id: string; name: string }>>>;
  setSnapError: Dispatch<SetStateAction<string | null>>;
  snapBusy: boolean;
  setSnapBusy: Dispatch<SetStateAction<boolean>>;
  snapDialogRef: RefObject<HTMLDivElement | null>;
  setIncomingHandoff: Dispatch<
    SetStateAction<{ threadId: string; items: AttachmentInfo[] } | null>
  >;
  screenshotHandoffGen: RefObject<number>;
  screenshotHandoffThreadId: RefObject<string | null>;
}) {
  const openAppSnap = useCallback(async () => {
    if (!onListSnapWindows) return;
    setSnapError(null);
    setSnapOpen(true);
    try {
      const windows = await onListSnapWindows();
      setSnapWindows(windows);
      if (windows.length === 0) {
        setSnapError("No windows to capture. Grant screen recording if asked.");
      }
    } catch (err) {
      setSnapWindows([]);
      setSnapError(
        err instanceof Error && err.message
          ? err.message
          : "Failed to list windows",
      );
    }
  }, [onListSnapWindows]);

  const isLiveScreenshotHandoff = (
    originThreadId: string | null,
    generation: number,
  ) =>
    originThreadId != null &&
    originThreadId === screenshotHandoffThreadId.current &&
    generation === screenshotHandoffGen.current;

  const deliverIncomingAttachment = (
    originThreadId: string,
    generation: number,
    att: AttachmentInfo | AttachmentInfo[],
  ) => {
    if (!isLiveScreenshotHandoff(originThreadId, generation)) return;
    setIncomingHandoff({
      threadId: originThreadId,
      items: Array.isArray(att) ? att : [att],
    });
  };

  const attachBrowserScreenshot = useCallback(
    async (dataUrl: string, originThreadId: string) => {
      if (!onSaveAttachmentImage) return;
      const generation = screenshotHandoffGen.current;
      const att = await onSaveAttachmentImage(dataUrl);
      if (!att) return;
      deliverIncomingAttachment(originThreadId, generation, att);
    },
    [onSaveAttachmentImage],
  );

  const captureAppSnap = useCallback(
    async (sourceId: string) => {
      if (!onCaptureSnapWindow) return;
      const originThreadId = screenshotHandoffThreadId.current;
      const generation = screenshotHandoffGen.current;
      setSnapBusy(true);
      setSnapError(null);
      try {
        const att = await onCaptureSnapWindow(sourceId);
        if (!isLiveScreenshotHandoff(originThreadId, generation)) return;
        if (att && originThreadId) {
          deliverIncomingAttachment(originThreadId, generation, att);
          setSnapOpen(false);
        } else if (!att) {
          setSnapError("Could not capture that window");
        }
      } catch (err) {
        if (!isLiveScreenshotHandoff(originThreadId, generation)) return;
        setSnapError(
          err instanceof Error && err.message
            ? err.message
            : "Failed to capture the window",
        );
      } finally {
        if (isLiveScreenshotHandoff(originThreadId, generation)) {
          setSnapBusy(false);
        }
      }
    },
    [onCaptureSnapWindow],
  );

  useEffect(() => {
    if (!onListSnapWindows || isArchived) return;
    const tracker = createDoubleOptionTracker();
    const onKey = (e: KeyboardEvent) => {
      if (
        tracker.note(e.key, e.type as "keydown" | "keyup", {
          meta: e.metaKey,
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
        })
      ) {
        e.preventDefault();
        void openAppSnap();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [onListSnapWindows, isArchived, openAppSnap]);

  useEscapeClose(snapOpen && !snapBusy, () => setSnapOpen(false));
  useModalFocus(snapOpen, snapDialogRef);
  return { attachBrowserScreenshot, captureAppSnap };
}
