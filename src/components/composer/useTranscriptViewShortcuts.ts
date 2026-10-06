import { useEffect } from "react";
import { cycleTranscriptViewMode } from "../../focusView";
import { matchesBinding } from "../../keybindings";
import { getTranscriptViewMode, setTranscriptViewMode } from "../../uiPrefs";

/** Window shortcuts for the transcript view: ⌃⌥F summary, ⌃O cycle (#1411). */
export function useTranscriptViewShortcuts() {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      if (matchesBinding(e, "transcript.summary")) {
        e.preventDefault();
        setTranscriptViewMode(
          getTranscriptViewMode() === "summary" ? "normal" : "summary",
        );
        return;
      }
      if (matchesBinding(e, "transcript.cycle")) {
        e.preventDefault();
        setTranscriptViewMode(cycleTranscriptViewMode(getTranscriptViewMode()));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
