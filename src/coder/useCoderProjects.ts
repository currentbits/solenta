import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  CoderApi,
  CreateProjectInput,
  ProjectInfo,
  ProjectUpdateInput,
} from "../shared/ipc";
import type { CoderError } from "../useCoder";
import { errorMessage } from "./errorMessage";
import { isWebMode } from "../shared/wire";

/** Project add/create/scratch/update; writes the project list and the banner. */
export function useCoderProjects({
  api,
  setProjects,
  setError,
}: {
  api: CoderApi;
  setProjects: Dispatch<SetStateAction<ProjectInfo[]>>;
  setError: Dispatch<SetStateAction<CoderError | null>>;
}) {
  const addProject = useCallback(async (
    path?: string,
    opts?: { remoteHost?: string; remotePath?: string },
  ) => {
    try {
      const trimmed = typeof path === "string" ? path.trim() : "";
      const remoteHost = opts?.remoteHost?.trim() || "";
      const remotes = remoteHost
        ? {
            remoteHost,
            remotePath: opts?.remotePath?.trim() || undefined,
          }
        : undefined;
      // Native folder picker cannot run without Electron. Web callers must
      // pass a path (the path-input modal). Never fall through to addViaDialog.
      if (isWebMode() && !trimmed && !remoteHost) return null;
      const p = trimmed || remoteHost
        ? await api.projects.add(trimmed || remotes?.remotePath || "", remotes)
        : await api.projects.addViaDialog();
      if (p) {
        setProjects((prev) => {
          if (prev.some((x) => x.id === p.id)) return prev;
          return [...prev, p];
        });
        setError(null);
      }
      return p;
    } catch (err) {
      setError({ scope: "project", message: errorMessage(err) });
      return null;
    }
  }, [api]);

  const createProject = useCallback(async (input: CreateProjectInput) => {
    try {
      const p = await api.projects.create({
        name: input.name.trim(),
        parentDir: input.parentDir.trim(),
      });
      setProjects((prev) => {
        if (prev.some((x) => x.id === p.id)) return prev;
        return [...prev, p];
      });
      setError(null);
      return p;
    } catch (err) {
      setError({ scope: "project", message: errorMessage(err) });
      return null;
    }
  }, [api]);

  const ensureScratchProject = useCallback(async () => {
    try {
      const p = await api.projects.ensureScratch();
      setProjects((prev) => {
        if (prev.some((x) => x.id === p.id)) return prev;
        return [...prev, p];
      });
      setError(null);
      return p;
    } catch (err) {
      setError({ scope: "project", message: errorMessage(err) });
      return null;
    }
  }, [api]);

  const updateProject = useCallback(async (input: ProjectUpdateInput) => {
    try {
      const updated = await api.projects.update(input);
      setProjects((prev) =>
        prev.map((p) => (p.id === updated.id ? updated : p)),
      );
      setError(null);
      return updated;
    } catch (err) {
      setError({ scope: "project", message: errorMessage(err) });
      return null;
    }
  }, [api]);

  return {
    addProject,
    createProject,
    ensureScratchProject,
    updateProject,
  };
}
