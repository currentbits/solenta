import { useEffect, useRef, useState } from "react";
import { INITIAL_VIM, type VimState } from "../../composerVim";
import { useComposerVimEnabled } from "../../uiPrefs";

/** Vim mode for the composer textarea; resets on a thread switch or toggle. */
export function useComposerVim(threadId: string) {
  const vimEnabled = useComposerVimEnabled();
  const [vimMode, setVimMode] = useState(INITIAL_VIM.mode);
  const vimStateRef = useRef<VimState>(INITIAL_VIM);
  useEffect(() => {
    vimStateRef.current = INITIAL_VIM;
    setVimMode(INITIAL_VIM.mode);
  }, [threadId, vimEnabled]);
  return { vimEnabled, vimMode, setVimMode, vimStateRef };
}
