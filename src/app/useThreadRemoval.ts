import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { UseCoderResult } from "../useCoder";

/** Archive / delete / remove-project handlers and their undo toasts. */
export function useThreadRemoval({
  selectedThreadId,
  projects,
  projectById,
  setArchived,
  deleteThread,
  restoreThread,
  removeProject,
  archiveToastIds,
  setArchiveToastIds,
  deleteToastId,
  setDeleteToastId,
  setRemoveFailMessage,
}: {
  selectedThreadId: UseCoderResult["selectedThreadId"];
  projects: UseCoderResult["projects"];
  projectById: UseCoderResult["projectById"];
  setArchived: UseCoderResult["setArchived"];
  deleteThread: UseCoderResult["deleteThread"];
  restoreThread: UseCoderResult["restoreThread"];
  removeProject: UseCoderResult["removeProject"];
  archiveToastIds: string[] | null;
  setArchiveToastIds: Dispatch<SetStateAction<string[] | null>>;
  deleteToastId: string | null;
  setDeleteToastId: Dispatch<SetStateAction<string | null>>;
  setRemoveFailMessage: Dispatch<SetStateAction<string | null>>;
}) {
  const handleSetArchived = useCallback(
    async (archived: boolean) => {
      if (archived) {
        // Capture id before setArchived moves selection off the open thread.
        const id = selectedThreadId;
        if (!id) return;
        setRemoveFailMessage(null);
        if (await setArchived(true, id)) {
          setDeleteToastId(null);
          setArchiveToastIds([id]);
        }
      } else {
        setArchiveToastIds(null);
        await setArchived(false);
      }
    },
    [selectedThreadId, setArchived],
  );

  /** Clear the settled tail: archive every settled thread, undoable as one unit. */
  const handleClearSettled = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      setRemoveFailMessage(null);
      // Offer undo only for what actually archived: a mid-loop failure (its
      // message lands in the run-error banner) used to leave a partial
      // archive whose undo toast still claimed every id (issue #85).
      const archived: string[] = [];
      for (const id of ids) {
        if (await setArchived(true, id)) archived.push(id);
      }
      if (archived.length > 0) {
        setDeleteToastId(null);
        setArchiveToastIds(archived);
      }
    },
    [setArchived],
  );

  const dismissArchiveToast = useCallback(() => {
    setArchiveToastIds(null);
  }, []);

  const undoArchive = useCallback(async () => {
    if (!archiveToastIds) return;
    const ids = archiveToastIds;
    setArchiveToastIds(null);
    for (const id of ids) {
      await setArchived(false, id);
    }
  }, [archiveToastIds, setArchived]);

  const handleDeleteThread = useCallback(async () => {
    const id = selectedThreadId;
    if (!id) return;
    setArchiveToastIds(null);
    if (await deleteThread()) setDeleteToastId(id);
  }, [selectedThreadId, deleteThread]);

  const dismissDeleteToast = useCallback(() => {
    setDeleteToastId(null);
  }, []);

  const undoDelete = useCallback(async () => {
    if (!deleteToastId) return;
    const id = deleteToastId;
    setDeleteToastId(null);
    await restoreThread(id);
  }, [deleteToastId, restoreThread]);

  const handleRemoveProject = useCallback(
    async (projectId: string) => {
      const slug =
        projectById.get(projectId)?.slug ??
        projects.find((p) => p.id === projectId)?.slug ??
        projectId;
      setArchiveToastIds(null);
      try {
        await removeProject(projectId);
        setRemoveFailMessage(null);
      } catch (err) {
        const reason = err instanceof Error ? err.message.trim() : "";
        const title = reason
          ? `Failed to remove "${slug}": ${reason}`
          : `Failed to remove "${slug}"`;
        setRemoveFailMessage(title);
        throw new Error(title);
      }
    },
    [projectById, projects, removeProject],
  );

  const dismissRemoveFail = useCallback(() => {
    setRemoveFailMessage(null);
  }, []);

  return {
    handleSetArchived,
    handleClearSettled,
    dismissArchiveToast,
    undoArchive,
    handleDeleteThread,
    dismissDeleteToast,
    undoDelete,
    handleRemoveProject,
    dismissRemoveFail,
  };
}
