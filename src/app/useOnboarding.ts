import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { UseCoderResult } from "../useCoder";
import type { AppView } from "../App";

/** First-run tour: finish, create the first thread, relaunch from Settings. */
export function useOnboarding({
  settings,
  saveSettings,
  createThread,
  selectThread,
  setProvider,
  createdFirstThreadRef,
  onboardingDismissed,
  setOnboardingDismissed,
  onboardingForceOpen,
  setOnboardingForceOpen,
  setSettingsOpen,
  setView,
  setRevealThreadId,
}: {
  settings: UseCoderResult["settings"];
  saveSettings: UseCoderResult["saveSettings"];
  createThread: UseCoderResult["createThread"];
  selectThread: UseCoderResult["selectThread"];
  setProvider: UseCoderResult["setProvider"];
  createdFirstThreadRef: RefObject<{ id: string; projectId: string } | null>;
  onboardingDismissed: boolean;
  setOnboardingDismissed: Dispatch<SetStateAction<boolean>>;
  onboardingForceOpen: boolean;
  setOnboardingForceOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<AppView>>;
  setRevealThreadId: Dispatch<SetStateAction<string | null>>;
}) {
  const finishOnboarding = useCallback(async () => {
    await saveSettings({ onboardingSeen: true });
    createdFirstThreadRef.current = null;
    setOnboardingDismissed(true);
    setOnboardingForceOpen(false);
  }, [saveSettings]);

  const handleCreateFirstThread = useCallback(
    async (input: { projectId: string; provider: string }) => {
      const existing = createdFirstThreadRef.current;
      let threadId =
        existing && existing.projectId === input.projectId
          ? existing.id
          : null;
      if (!threadId) {
        const thread = await createThread("New Thread", input.projectId, {
          inheritProvider: false,
        });
        if (!thread) {
          throw new Error("Could not create thread");
        }
        threadId = thread.id;
      }
      createdFirstThreadRef.current = {
        id: threadId,
        projectId: input.projectId,
      };
      try {
        await setProvider({ threadId, provider: input.provider });
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Could not set the thread agent";
        throw err instanceof Error ? err : new Error(message);
      }
      selectThread(threadId);
      setView("thread");
      setRevealThreadId(threadId);
    },
    [createThread, selectThread, setProvider],
  );

  const showOnboarding = useCallback(() => {
    setSettingsOpen(false);
    setOnboardingForceOpen(true);
    createdFirstThreadRef.current = null;
  }, []);

  const onboardingOpen =
    onboardingForceOpen ||
    (settings !== null &&
      settings.onboardingSeen !== true &&
      !onboardingDismissed);

  return {
    finishOnboarding,
    handleCreateFirstThread,
    showOnboarding,
    onboardingOpen,
  };
}
