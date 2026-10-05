import { useEffect } from "react";
import { cycleTranscriptViewMode } from "../../focusView";
import { getTranscriptViewMode, setTranscriptViewMode } from "../../uiPrefs";

/** Window shortcuts for the transcript view: ⌃⌥F summary, ⌃O cycle (#1411). */
export function useTranscriptViewShortcuts() {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const key = e.key.toLowerCase();
      if (
        e.ctrlKey &&
        e.altKey &&
        !e.metaKey &&
        !e.shiftKey &&
        key === "f"
      ) {
        e.preventDefault();
        setTranscriptViewMode(
          getTranscriptViewMode() === "summary" ? "normal" : "summary",
        );
        return;
      }
      if (
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        key === "o"
      ) {
        e.preventDefault();
        setTranscriptViewMode(cycleTranscriptViewMode(getTranscriptViewMode()));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
