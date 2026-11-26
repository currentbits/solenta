import { useRef } from "react";
import { AddProjectPathModal } from "./AddProjectPathModal";
import type { AddProjectOptions, CloneProjectInput, CoderApi, ProjectInfo } from "../shared/ipc";
import type { MachineOption } from "./WorkspaceStrip";

/** Prepare a checkout, retaining it if moving the draft needs a retry. */
export function RunOnMachineSetup({ target, source, cloneUrl, api, onClose, addProject, cloneProject, onMove, assertOnline }: {
  target: MachineOption;
  source: ProjectInfo;
  cloneUrl: string;
  api: CoderApi;
  onClose: () => void;
  addProject: (path: string, opts?: AddProjectOptions) => Promise<ProjectInfo | null>;
  cloneProject: (input: CloneProjectInput) => Promise<ProjectInfo>;
  onMove: (project: ProjectInfo) => Promise<void>;
  assertOnline: () => void;
}) {
  const prepared = useRef(new Map<string, ProjectInfo>());
  const prepare = async (key: string, action: () => Promise<ProjectInfo | null>) => {
    assertOnline();
    let project = prepared.current.get(key);
    if (!project) {
      project = await action() ?? undefined;
      if (!project) throw new Error("Could not add that checkout. Check the path and connection, then retry.");
      prepared.current.set(key, project);
    }
    if ((project.host?.key ?? "") !== (target.hostKey ?? "")) {
      throw new Error("The checkout belongs to another computer. Reconnect and try again.");
    }
    if (project.slug.toLowerCase() !== source.slug.toLowerCase()) {
      throw new Error(`Choose a checkout of ${source.slug}. This folder contains ${project.slug}.`);
    }
    assertOnline();
    await onMove(project);
    return project;
  };
  return <AddProjectPathModal
    runOn={{ hostKey: target.hostKey, label: target.label, cloneUrl, repository: source.slug }}
    onClose={onClose}
    onCreate={async () => { throw new Error("Choose an existing checkout or clone this repository."); }}
    onSubmit={(path) => prepare(`path:${path}`, () => addProject(path, {
      ...(target.hostKey ? { onHost: target.hostKey } : {}), requireExistingRepo: true,
    }))}
    onClone={(input) => prepare(JSON.stringify([input.url, input.parentDir, input.name]), () => cloneProject({
      ...input, onHost: target.hostKey,
    }))}
    onBrowse={(input) => api.fs.browse(input)}
    onCancelClone={(cloneId, onHost) => { void api.projects.cancelClone({ cloneId, onHost }); }}
    onCloneProgress={(cb) => api.on("clone:progress", cb)}
  />;
}
