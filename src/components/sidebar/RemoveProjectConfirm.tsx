import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ProjectInfo, ThreadInfo } from "../../shared/ipc";
import styles from "../Sidebar.module.css";

/**
 * Remove-project confirm dialog. Focus trap and Escape stay in Sidebar
 * (useModalFocus / useEscapeClose on removeConfirmRef).
 */
export function RemoveProjectConfirm({
  removeConfirmId,
  projectById,
  threads,
  closeRemoveConfirm,
  removeConfirmRef,
  removePending,
  setRemovePending,
  onRemoveProject,
  setRemoveConfirmId,
}: {
  removeConfirmId: string;
  projectById: Map<string, ProjectInfo>;
  threads: ThreadInfo[];
  closeRemoveConfirm: () => void;
  removeConfirmRef: RefObject<HTMLDivElement | null>;
  removePending: boolean;
  setRemovePending: Dispatch<SetStateAction<boolean>>;
  onRemoveProject: ((projectId: string) => void | Promise<void>) | undefined;
  setRemoveConfirmId: Dispatch<SetStateAction<string | null>>;
}) {
  const confirmProject = projectById.get(removeConfirmId);
  if (!confirmProject) return null;
  const projectThreads = threads.filter(
    (t) => t.projectId === confirmProject.id,
  );
  const count = projectThreads.length;
  const worktreeCount = projectThreads.filter(
    (t) => t.worktreePath,
  ).length;
  const threadWord = count === 1 ? "thread" : "threads";
  const title = `Remove project ${confirmProject.slug} and delete its ${count} ${threadWord}?`;
  return (
    <div
      className={styles.removeConfirmOverlay}
      role="presentation"
      onClick={closeRemoveConfirm}
    >
      <div
        ref={removeConfirmRef}
        className={styles.removeConfirm}
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-project-title"
        tabIndex={-1}
        data-remove-confirm={confirmProject.id}
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="remove-project-title"
          className={styles.removeConfirmTitle}
        >
          {title}
        </h2>
        <p className={styles.removeConfirmMeta}>{confirmProject.path}</p>
        <p className={styles.removeConfirmBody}>
          This permanently clears conversation history for those
          threads.
        </p>
        <p className={styles.removeConfirmBody}>
          This removes only this project entry.
        </p>
        {worktreeCount > 0 && (
          <p
            className={styles.removeConfirmBody}
            data-remove-worktree-note
          >
            {worktreeCount === 1
              ? "Its 1 worktree folder is deleted too."
              : `Its ${worktreeCount} worktree folders are deleted too.`}{" "}
            Branches and the repository are kept; a worktree with
            uncommitted changes is left alone.
          </p>
        )}
        <div className={styles.removeConfirmActions}>
          <button
            type="button"
            className={styles.removeConfirmDanger}
            data-remove-confirm-submit={confirmProject.id}
            disabled={removePending}
            aria-busy={removePending || undefined}
            onClick={() => {
              if (removePending || !onRemoveProject) return;
              const id = confirmProject.id;
              setRemovePending(true);
              void Promise.resolve(onRemoveProject(id))
                .catch(() => {
                  // Failure toast is the caller's job; always close.
                })
                .finally(() => {
                  setRemovePending(false);
                  setRemoveConfirmId(null);
                });
            }}
          >
            {removePending ? "Removing…" : "Remove project"}
          </button>
          <button
            type="button"
            className={styles.removeConfirmCancel}
            disabled={removePending}
            onClick={closeRemoveConfirm}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
