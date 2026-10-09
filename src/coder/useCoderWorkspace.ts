import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  EDITOR_PREF_KEY,
  type AttachmentInfo,
  type CoderApi,
  type DiffOptions,
  type EditorId,
  type ReviewSymbol,
  type ThreadDetail,
  type ThreadInfo,
} from "../shared/ipc";
import type { DroppedFolder } from "../dropFiles";
import { isWebMode } from "../shared/wire";
import {
  filesToAttachments,
  pickWebFiles,
  pickWebFolder,
} from "./webAttachments";

/**
 * The "Open in" editor last picked in Thread details (#1506), for opening
 * files. The file manager and Terminal are skipped: neither opens a file
 * at a line, and Terminal would run it.
 */
function preferredFileEditor(): EditorId | null {
  try {
    const id = window.localStorage.getItem(EDITOR_PREF_KEY) as EditorId | null;
    return id && id !== "finder" && id !== "terminal" ? id : null;
  } catch {
    return null;
  }
}

/** Selected thread's worktree, diff/review/commit, files and attachments. */
export function useCoderWorkspace({
  api,
  selectedThreadId,
  setDetail,
  selectedRef,
  stagedPathsRef,
  applyThreadUpdate,
}: {
  api: CoderApi;
  selectedThreadId: string | null;
  setDetail: Dispatch<SetStateAction<ThreadDetail | null>>;
  selectedRef: RefObject<string | null>;
  stagedPathsRef: RefObject<string[] | null>;
  applyThreadUpdate: (thread: ThreadInfo) => void;
}) {
  const listBaseBranches = useCallback(
    async (projectId: string) => {
      return api.git.listBranches({ projectId });
    },
    [api],
  );

  const setupWorktree = useCallback(async () => {
    if (!selectedThreadId) return null;
    const threadId = selectedThreadId;
    const thread = await api.git.setupWorktree({ threadId });
    if (selectedRef.current !== threadId) return thread;
    applyThreadUpdate(thread);
    // Refresh detail in case main also mutates other fields.
    const d = await api.threads.get(threadId);
    if (selectedRef.current === threadId) setDetail(d);
    return thread;
  }, [api, selectedThreadId, applyThreadUpdate]);

  const mergeWorktree = useCallback(async (opts?: {
    ciWorkflowApproved?: boolean;
  }) => {
    if (!selectedThreadId) return null;
    const threadId = selectedThreadId;
    const staged = stagedPathsRef.current;
    const thread = await api.git.mergeWorktree({
      threadId,
      ciWorkflowApproved: opts?.ciWorkflowApproved,
      ...(staged != null ? { paths: staged } : {}),
    });
    if (selectedRef.current !== threadId) return thread;
    applyThreadUpdate(thread);
    const d = await api.threads.get(threadId);
    if (selectedRef.current === threadId) setDetail(d);
    return thread;
  }, [api, selectedThreadId, applyThreadUpdate]);

  const conflictContext = useCallback(async (threadId: string) => {
    return api.git.conflictContext({ threadId });
  }, [api]);

  const removeWorktree = useCallback(
    async (force = false) => {
      if (!selectedThreadId) return null;
      const threadId = selectedThreadId;
      const thread = await api.git.removeWorktree({ threadId, force });
      if (selectedRef.current !== threadId) return thread;
      applyThreadUpdate(thread);
      const d = await api.threads.get(threadId);
      if (selectedRef.current === threadId) setDetail(d);
      return thread;
    },
    [api, selectedThreadId, applyThreadUpdate],
  );

  const fetchDiff = useCallback(async (opts?: DiffOptions) => {
    if (!selectedThreadId) {
      return { files: [], patch: "", truncated: false };
    }
    const threadId = selectedThreadId;
    return api.git.diff({ threadId, ...opts });
  }, [api, selectedThreadId]);

  const fetchReviewContext = useCallback(async () => {
    if (!selectedThreadId) {
      return { annotation: null, symbols: [] as ReviewSymbol[], acceptedHunks: [] };
    }
    const threadId = selectedThreadId;
    return api.git.reviewContext({ threadId });
  }, [api, selectedThreadId]);

  const setReviewAccepted = useCallback(
    async (hashes: string[]) => {
      if (!selectedThreadId) return;
      const threadId = selectedThreadId;
      const thread = await api.git.setReviewAccepted({ threadId, hashes });
      if (selectedRef.current !== threadId) return;
      applyThreadUpdate(thread);
    },
    [api, selectedThreadId, applyThreadUpdate],
  );

  const commitChanges = useCallback(
    async (message: string, paths?: string[]) => {
      if (!selectedThreadId) {
        throw new Error("No thread selected");
      }
      const threadId = selectedThreadId;
      const selected = paths ?? stagedPathsRef.current ?? undefined;
      return api.git.commit({
        threadId,
        message,
        ...(selected != null ? { paths: selected } : {}),
      });
    },
    [api, selectedThreadId],
  );

  const revertFile = useCallback(
    async (path: string, status: string) => {
      if (!selectedThreadId) {
        throw new Error("No thread selected");
      }
      const threadId = selectedThreadId;
      return api.git.revertFile({ threadId, path, status });
    },
    [api, selectedThreadId],
  );

  const suggestCommitMessage = useCallback(async () => {
    if (!selectedThreadId) {
      throw new Error("No thread selected");
    }
    const threadId = selectedThreadId;
    return api.git.suggestCommitMessage({ threadId });
  }, [api, selectedThreadId]);

  const listFiles = useCallback(
    async (query: string, opts?: { limit?: number }) => {
      if (!selectedThreadId) return [];
      const threadId = selectedThreadId;
      const result = await api.files.list({
        threadId,
        query,
        limit: opts?.limit,
      });
      return result.files;
    },
    [api, selectedThreadId],
  );

  const searchFileContents = useCallback(
    async (query: string) => {
      if (!selectedThreadId || !query.trim()) return [];
      const threadId = selectedThreadId;
      const result = await api.files.search({ threadId, query });
      return result.hits;
    },
    [api, selectedThreadId],
  );

  const resolvePaths = useCallback(
    async (paths: string[]) => {
      if (!selectedThreadId || paths.length === 0) {
        return paths.map((p) => ({ path: p, abs: null }));
      }
      try {
        const result = await api.files.resolve({
          threadId: selectedThreadId,
          paths,
        });
        return result.resolved;
      } catch {
        return paths.map((p) => ({ path: p, abs: null }));
      }
    },
    [api, selectedThreadId],
  );

  const openWorkspacePath = useCallback(
    async (
      abs: string,
      opts?: { reveal?: boolean; line?: number; col?: number },
    ) => {
      if (!selectedThreadId || !abs) return;
      if (opts?.reveal) {
        await api.shell.reveal({ threadId: selectedThreadId, path: abs });
        return;
      }
      const editor = preferredFileEditor();
      if (editor) {
        try {
          await api.shell.openIn({
            threadId: selectedThreadId,
            path: abs,
            editor,
            line: opts?.line,
            column: opts?.col,
          });
          return;
        } catch {
          // Editor gone since it was picked: the default app still opens it.
        }
      }
      await api.shell.openPath({ threadId: selectedThreadId, path: abs });
    },
    [api, selectedThreadId],
  );

  const loadToolImage = useCallback(
    async (name: string) => {
      try {
        const result = await api.files.image({ name });
        return result.dataUrl;
      } catch {
        return null;
      }
    },
    [api],
  );

  const saveAttachmentImage = useCallback(
    async (dataUrl: string) => {
      if (!selectedThreadId) return null;
      const threadId = selectedThreadId;
      try {
        const result = await api.attachments.saveImage({ threadId, dataUrl });
        return result.attachment;
      } catch {
        return null;
      }
    },
    [api, selectedThreadId],
  );

  const saveAttachmentFile = useCallback(
    async (name: string, dataUrl: string) => {
      if (!selectedThreadId) return null;
      try {
        const result = await api.attachments.saveFile({
          threadId: selectedThreadId,
          name,
          dataUrl,
        });
        return result.attachment;
      } catch {
        return null;
      }
    },
    [api, selectedThreadId],
  );

  const pickDirectory = useCallback(async () => {
    try {
      return await api.projects.pickDirectory();
    } catch {
      return null;
    }
  }, [api]);

  const listSnapWindows = useCallback(async () => {
    try {
      const result = await api.attachments.listWindows();
      return result.windows;
    } catch {
      return [];
    }
  }, [api]);

  const captureSnapWindow = useCallback(
    async (sourceId: string) => {
      if (!selectedThreadId) return null;
      const result = await api.attachments.captureWindow({
        threadId: selectedThreadId,
        sourceId,
      });
      if (!result.attachment) return null;
      return result.textAttachment
        ? [result.attachment, result.textAttachment]
        : result.attachment;
    },
    [api, selectedThreadId],
  );

  const pickAttachments = useCallback(async (opts?: {
    includeImages?: boolean;
  }) => {
    if (isWebMode()) {
      if (!selectedThreadId) return [];
      return filesToAttachments(await pickWebFiles(), {
        image: saveAttachmentImage,
        file: saveAttachmentFile,
      });
    }
    const result = await api.attachments.pick({
      includeImages: opts?.includeImages !== false,
    });
    return result.attachments;
  }, [api, saveAttachmentFile, saveAttachmentImage, selectedThreadId]);

  const pickFolderAttachments = useCallback(async () => {
    if (!selectedThreadId) return [];
    const picked = await pickWebFolder();
    if (!picked) return [];
    try {
      const result = await api.attachments.saveFolder({
        threadId: selectedThreadId,
        name: picked.name,
        files: picked.files,
      });
      return result.attachment ? [result.attachment] : [];
    } catch {
      return [];
    }
  }, [api, selectedThreadId]);

  const loadAttachmentImage = useCallback(
    async (path: string) => {
      try {
        const result = await api.attachments.readImage({ path });
        return result.dataUrl;
      } catch {
        return null;
      }
    },
    [api],
  );

  const dropAttachmentFiles = useCallback(
    async (files: File[], folders?: DroppedFolder[]) => {
      // Absolute paths of dropped Files (including Finder directories)
      // exist only behind the Electron preload (webUtils). Web/dev
      // bridges persist bytes via saveImage / saveFile / saveFolder.
      const pathOf = api.attachments.droppedFilePath;
      if (pathOf) {
        const paths = files
          .map((file) => {
            try {
              return pathOf(file);
            } catch {
              return "";
            }
          })
          .filter((p) => p.length > 0);
        if (!paths.length) return [];
        const result = await api.attachments.fromPaths({ paths });
        return result.attachments;
      }
      const out: AttachmentInfo[] = [];
      if (folders?.length && selectedThreadId) {
        for (const folder of folders) {
          try {
            const result = await api.attachments.saveFolder({
              threadId: selectedThreadId,
              name: folder.name,
              files: folder.files,
            });
            if (result.attachment) out.push(result.attachment);
          } catch {
            // skip a folder that the host refused
          }
        }
      }
      const folderNames = new Set((folders ?? []).map((folder) => folder.name));
      const loose = files.filter((file) => !folderNames.has(file.name));
      out.push(
        ...(await filesToAttachments(loose, {
          image: saveAttachmentImage,
          file: saveAttachmentFile,
        })),
      );
      return out;
    },
    [api, saveAttachmentFile, saveAttachmentImage, selectedThreadId],
  );

  return {
    listBaseBranches,
    setupWorktree,
    mergeWorktree,
    conflictContext,
    removeWorktree,
    fetchDiff,
    fetchReviewContext,
    setReviewAccepted,
    commitChanges,
    revertFile,
    suggestCommitMessage,
    listFiles,
    searchFileContents,
    resolvePaths,
    openWorkspacePath,
    loadToolImage,
    saveAttachmentImage,
    pickDirectory,
    listSnapWindows,
    captureSnapWindow,
    pickAttachments,
    pickFolderAttachments,
    loadAttachmentImage,
    dropAttachmentFiles,
  };
}
