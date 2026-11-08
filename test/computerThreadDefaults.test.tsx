import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { useRef, useState } from "react";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import { useCoderRuns } from "../src/coder/useCoderRuns";
import type { AppSettings, CoderApi, ProjectInfo, ThreadDetail, ThreadInfo } from "../src/shared/ipc";

afterEach(unmountAll);
it("creates on the target computer using its defaults and never inherits another computer's provider", async () => {
  const calls: { name: string; args: unknown[] }[] = [];
  const remoteHost = { key: "work", label: "Work", status: "online" as const };
  const project = { id: "remote-project", path: "/srv/work", host: remoteHost } as ProjectInfo;
  const localThread = { id: "local-thread", projectId: "local-project", provider: "local-only", model: "local-model" } as ThreadInfo;
  const created = { id: "remote-thread", projectId: project.id, provider: "remote-only", model: "remote-model", host: remoteHost } as ThreadInfo;
  const api = {
    settings: { get: async (...args: unknown[]) => { calls.push({ name: "settings.get", args }); return { defaultWorktree: true } as AppSettings; } },
    threads: {
      create: async (...args: unknown[]) => { calls.push({ name: "threads.create", args }); return created; },
      setProvider: async (...args: unknown[]) => { calls.push({ name: "threads.setProvider", args }); return created; },
    },
  } as unknown as CoderApi;
  let create!: ReturnType<typeof useCoderRuns>["createThread"];
  function View() {
    const [selected, setSelected] = useState<string | null>(localThread.id);
    const [, setDetail] = useState<ThreadDetail | null>(null);
    const [, setError] = useState<null | { scope: "run"; message: string }>(null);
    const selectedRef = useRef<string | null>(localThread.id);
    const threadsRef = useRef<ThreadInfo[]>([localThread]);
    create = useCoderRuns({ api, projects: [project], settings: { defaultWorktree: false } as AppSettings, selectedProjectId: localThread.projectId, selectedThreadId: selected, setSelectedThreadId: setSelected, setDetail, setError: setError as never, selectedRef, threadsRef, applyThreads: () => {} }).createThread;
    return null;
  }
  await mount(<View />);
  await inAct(async () => { await create("Remote work", project.id); });
  assert.deepEqual(calls, [
    { name: "settings.get", args: [{ onHost: "work" }] },
    { name: "threads.create", args: [{ projectId: project.id, title: "Remote work", worktree: true }] },
  ]);
});
