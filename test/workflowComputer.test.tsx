import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { useRef, useState } from "react";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import { useComputerWorkflows } from "../src/coder/computerContext";
import { useCoderWorkflows } from "../src/coder/useCoderWorkflows";
import { createFakeCoder, installFakeCoder } from "./support/fakeCoder.ts";
import { useCoder } from "../src/useCoder";
import type { CoderApi, HostTag, ProjectInfo, ThreadInfo, WorkflowTemplateInfo } from "../src/shared/ipc";

afterEach(unmountAll);
const template = (name: string, id = "same-id"): WorkflowTemplateInfo => ({ id, name, builtin: false, phases: [] });
const local = template("Local definition");
const remote = template("Remote definition");
const host = (key: string): HostTag => ({ key, label: key, status: "online" });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
let current: { catalog: ReturnType<typeof useComputerWorkflows>; actions: ReturnType<typeof useCoderWorkflows> };
function Harness({ api, computer }: { api: CoderApi; computer?: string }) {
  const [rows, setWorkflows] = useState([local]);
  const [error, setWorkflowListError] = useState<string | null>(null);
  const selectedThreadId = computer ? `thread-${computer}` : "thread-local";
  const selectedRef = useRef<string | null>(selectedThreadId);
  selectedRef.current = selectedThreadId;
  const threadsRef = useRef([{ id: selectedThreadId, projectId: "project" }] as ThreadInfo[]);
  const catalog = useComputerWorkflows(api, computer ? host(computer) : undefined, rows, error);
  const actions = useCoderWorkflows({ api, workflowComputer: catalog, selectedThreadId, setWorkflows, setWorkflowListError, selectedRef, threadsRef, setAutomations() {}, setProjects() {}, setDetail() {}, setError() {}, applyThreads() {} });
  current = { catalog, actions };
  return <p>{catalog.workflows.map(row => row.name).join(",")} {catalog.error}</p>;
}
function fixture() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, args: unknown[]) => calls.push({ method, args });
  const api = {
    workflows: {
      list: async (...args: unknown[]) => { record("list", args); return args.length ? [remote] : [local]; },
      save: async (...args: unknown[]) => { record("save", args); return { ...args[0] as object, id: "new-id", builtin: false } as WorkflowTemplateInfo; },
      remove: async (...args: unknown[]) => { record("remove", args); },
      exportToRepo: async (...args: unknown[]) => { record("export", args); return { written: true, path: "WORKFLOW.md" }; },
    },
    runs: { startWorkflow: async (...args: unknown[]) => { record("run", args); return { runId: "run" }; } },
    threads: { get: async (id: string) => ({ thread: { id, projectId: "project" }, messages: [] }) },
  } as unknown as CoderApi;
  return { api, calls };
}

it("lists only the owning computer's same-ID workflow and scopes save/remove/export/run there", async () => {
  const { api, calls } = fixture();
  const m = await mount(<Harness api={api} computer="work" />);
  assert.match(m.text(), /Remote definition/);
  assert.doesNotMatch(m.text(), /Local definition/);
  assert.deepEqual(calls[0], { method: "list", args: [{ onHost: "work" }] });
  await inAct(() => current.actions.startWorkflowRun("build", remote.id));
  assert.deepEqual(calls.find(call => call.method === "run")?.args, [{ threadId: "thread-work", prompt: "build", templateId: "same-id", onHost: "work" }]);
  await inAct(() => current.actions.exportWorkflowToRepo(remote.id, false));
  assert.deepEqual(calls.find(call => call.method === "export")?.args, [{ id: "same-id", threadId: "thread-work", overwrite: false }, { onHost: "work" }]);
  await inAct(() => current.actions.saveWorkflow({ name: "Saved remote", phases: [] }));
  assert.deepEqual(calls.find(call => call.method === "save")?.args, [{ name: "Saved remote", phases: [] }, { onHost: "work" }]);
  await inAct(() => current.actions.removeWorkflow("same-id"));
  assert.deepEqual(calls.find(call => call.method === "remove")?.args, [{ id: "same-id" }, { onHost: "work" }]);
});

it("keeps local workflow editing local and rejects stale editor actions after an owner switch", async () => {
  const { api, calls } = fixture();
  const m = await mount(<Harness api={api} />);
  assert.match(m.text(), /Local definition/);
  await inAct(() => current.actions.saveWorkflow({ name: "Saved local", phases: [] }));
  assert.deepEqual(calls.find(call => call.method === "save")?.args, [{ name: "Saved local", phases: [] }]);
  const oldSave = current.actions.saveWorkflow;
  await m.rerender(<Harness api={api} computer="work" />);
  await assert.rejects(oldSave({ name: "Stale local draft", phases: [] }), /computer changed/);
  assert.equal(calls.filter(call => call.method === "save").length, 1);
});

it("fences late workflow reads/writes and refuses offline catalogs without local fallback", async () => {
  const { api, calls } = fixture();
  const a = deferred<WorkflowTemplateInfo[]>();
  const save = deferred<WorkflowTemplateInfo>();
  api.workflows.list = (async (scope: { onHost: string }) => scope.onHost === "a" ? a.promise : scope.onHost === "b" ? [template("B definition")] : Promise.reject(new Error("Work computer offline"))) as CoderApi["workflows"]["list"];
  api.workflows.save = async () => save.promise;
  const m = await mount(<Harness api={api} computer="a" />);
  assert.doesNotMatch(m.text(), /Local definition/);
  const pending = current.actions.saveWorkflow({ name: "A draft", phases: [] });
  await m.rerender(<Harness api={api} computer="b" />);
  await inAct(async () => { a.resolve([remote]); save.resolve(template("A saved")); await pending; });
  assert.match(m.text(), /B definition/);
  assert.doesNotMatch(m.text(), /A saved|Remote definition|Local definition/);
  await m.rerender(<Harness api={api} computer="offline" />);
  assert.match(m.text(), /Work computer offline/);
  assert.equal(current.catalog.workflows.length, 0);
  await assert.rejects(current.actions.startWorkflowRun("build", "same-id"), /workflows are unavailable/);
  assert.equal(calls.some(call => call.method === "run"), false);
});

it("retains an acknowledged remote save ID when only the catalog refresh fails", async () => {
  const { api } = fixture();
  let lists = 0;
  api.workflows.list = async () => { if (++lists === 1) return [remote]; throw new Error("list unavailable"); };
  const m = await mount(<Harness api={api} computer="work" />);
  await inAct(() => current.actions.saveWorkflow({ name: "Saved remote", phases: [] }));
  assert.equal(current.catalog.workflows.some(row => row.id === "new-id"), true);
  assert.equal(current.catalog.workflows.some(row => row.id === remote.id), true);
  assert.match(m.text(), /Saved, but the list failed/);
});


it("useCoder exposes the selected remote thread's workflow catalog to its composer", async () => {
  const fake = createFakeCoder({
    projects: [{ id: "project", name: "Remote project", slug: "org/project", path: "/tmp/test-workflow-project", host: host("work") } as ProjectInfo],
    threads: [{ id: "thread-work", title: "Remote thread", projectId: "project", status: "idle", host: host("work") } as ThreadInfo],
    workflows: [local],
  });
  const scopes: unknown[] = [];
  fake.api.workflows.list = (async (scope?: { onHost: string }) => { scopes.push(scope); return scope?.onHost === "work" ? [remote] : [local]; }) as CoderApi["workflows"]["list"];
  installFakeCoder(fake);
  let coder: ReturnType<typeof useCoder>;
  function View() { coder = useCoder(); return <p>{coder.workflows.map(row => row.name).join(",")}</p>; }
  const m = await mount(<View />);
  await inAct(() => coder!.selectThread("thread-work"));
  assert.match(m.text(), /Remote definition/);
  assert.doesNotMatch(m.text(), /Local definition/);
  assert.equal(scopes.some((scope: any) => scope?.onHost === "work"), true);
});
