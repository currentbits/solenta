import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { mount } from "./support/dom.ts";
import { WorkerApprovals, approvalWorkers, type WorkerApprovalsProps } from "../src/components/WorkerApprovals";
import { ThreadView } from "../src/components/ThreadView";
import { PermissionPrompt } from "../src/components/thread/cards";
import type { PendingApprovalInfo, ThreadInfo, CoderApi, ProjectInfo, ThreadPatch } from "../src/shared/ipc";

function thread(id: string, over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id, projectId: "p1", title: id, branch: `coder/${id}`, prNumber: null, prUrl: null,
    status: "working", createdAt: 1, updatedAt: 1, runStartedAt: 1, archived: false,
    settledOverride: null, settledAt: null, pinnedAt: null, snoozedUntil: null, snoozedAt: null,
    lastVisitedAt: null, prState: null, provider: "claude", model: null, sessionId: null,
    permissionMode: "default", reasoningEffort: null, worktreePath: null, ...over,
  };
}
const parent = thread("parent");
const a = thread("worker-a", { orchWorker: true, handoffFrom: parent.id });
const b = thread("worker-b", { orchWorker: true, handoffFrom: parent.id });
const project = { id: "p1", name: "Example", path: "/tmp/example", slug: "owner/example" } as ProjectInfo;
const row = (worker: ThreadInfo, id = "req", over: Partial<PendingApprovalInfo> = {}): PendingApprovalInfo => ({
  threadId: worker.id, projectId: worker.projectId, threadTitle: worker.title,
  requestId: id, toolName: "Bash", summary: "Run tests", input: "{}", command: "npm test",
  provider: "claude", since: 1, ...over,
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Response = Parameters<CoderApi["threads"]["respondPermission"]>[0];
function setup(rows: PendingApprovalInfo[], over: Partial<WorkerApprovalsProps> = {}) {
  const calls: Response[] = [];
  const opened: string[] = [];
  const loads: unknown[] = [];
  const props: WorkerApprovalsProps = {
    parent, threads: [parent, a, b], projects: [project],
    loadApprovals: async (input) => { loads.push(input); return rows.filter((r) => r.threadId === input?.threadId); },
    respond: async (input) => { calls.push(input); rows = rows.filter((r) => !(r.threadId === input.threadId && r.requestId === input.requestId)); },
    onOpenWorker: (id) => { opened.push(id); }, ...over,
  };
  return { props, calls, loads, opened };
}

describe("worker approvals in the parent thread (#1931)", () => {
  it("only includes direct same-project same-computer children or explicit remote links", () => {
    const foreign = thread("foreign", { ...a, id: "foreign", projectId: "p2" });
    const remote = thread("remote", { host: { key: "box:1", label: "Box", status: "online" }, projectId: "remote-project" });
    const lead = { ...parent, remoteWorkers: [{ threadId: remote.id, hostKey: "box:1", hostLabel: "Box", title: "remote" }] };
    assert.deepEqual(approvalWorkers(lead, [a, a, b, foreign, thread("manual", { handoffFrom: parent.id }), thread("nested", { orchWorker: true, handoffFrom: a.id }), { ...a, id: "archived", archived: true }, remote, { ...remote, id: "impostor", handoffFrom: parent.id, orchWorker: true }]).map((t) => t.id), [a.id, b.id, remote.id]);
  });

  it("shows multiple children and requests without duplicates; edits and answers target one child", async () => {
    const s = setup([row(a), row(a), row(a, "second"), row(b)]);
    const m = await mount(<WorkerApprovals {...s.props} />);
    assert.equal(m.queryAll("[data-worker-request]").length, 3);
    assert.deepEqual(s.loads, [{ threadId: a.id }, { threadId: b.id }]);
    assert.match(m.text(), /Example · This computer · coder\/worker-a/);
    const area = m.query('[aria-label="Approvals from worker-b"]')!;
    await m.type(area.querySelector("textarea"), "npm run build");
    await m.click([...area.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Accept")!);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].threadId, b.id);
    assert.equal(s.calls[0].requestId, "req");
    assert.equal(s.calls[0].updatedCommand, "npm run build");
    assert.equal(m.queryAll("[data-worker-request]").length, 2);
    await m.click(m.byText("Open worker"));
    assert.deepEqual(s.opened, [a.id]);
    await m.click(m.byText("Deny"));
    assert.equal(s.calls[1].threadId, a.id);
    assert.equal(s.calls[1].decision, "deny");
  });

  it("routes a linked worker through its explicit computer and validates its own project", async () => {
    const remote = thread("worker-a", { projectId: "rp", host: { key: "box:1", label: "Build box", status: "online" } });
    const s = setup([row(remote)], {
      parent: { ...parent, remoteWorkers: [{ threadId: remote.id, hostKey: "box:1", hostLabel: "Build box", title: "Remote" }] },
      threads: [remote], projects: [{ ...project, id: "rp", host: remote.host }],
    });
    const m = await mount(<WorkerApprovals {...s.props} />);
    assert.deepEqual(s.loads, [{ threadId: remote.id, onHost: "box:1" }]);
    assert.match(m.text(), /Build box/);
    await m.click(m.byText("Accept"));
    assert.equal(s.calls[0].onHost, "box:1");
    assert.equal(s.calls[0].threadId, remote.id);
  });

  it("never exposes a linked worker omitted from the supplied roster", async () => {
    const s = setup([], { threads: [], parent: { ...parent, remoteWorkers: [{ threadId: "hidden", hostKey: "box:1", hostLabel: "Box", title: "Private worker title" }] } });
    const m = await mount(<WorkerApprovals {...s.props} />);
    assert.equal(m.text(), "");
    assert.deepEqual(s.loads, []);
  });

  it("rejects responses belonging to another child or project", async () => {
    const s = setup([], { threads: [a], loadApprovals: async () => [row(a, "good"), row(b, "wrong-child"), row(a, "wrong-project", { projectId: "p2" })] });
    const m = await mount(<WorkerApprovals {...s.props} />);
    assert.deepEqual(m.queryAll("[data-worker-request]").map((el) => el.getAttribute("data-worker-request")), ["good"]);
  });

  it("holds duplicate submissions, removes a successful request even before host pushes, and does not resurrect stale reads", async () => {
    const response = deferred<void>();
    const staleRead = deferred<PendingApprovalInfo[]>();
    const s = setup([row(a)], { threads: [a], respond: async (input) => { s.calls.push(input); await response.promise; } });
    const m = await mount(<WorkerApprovals {...s.props} />);
    const accept = m.byText("Accept");
    await m.click(accept);
    await m.click(accept);
    assert.equal(s.calls.length, 1);
    const load = async () => staleRead.promise;
    await m.rerender(<WorkerApprovals {...s.props} loadApprovals={load} threads={[{ ...a, updatedAt: 2 }]} />);
    await act(async () => response.resolve());
    assert.equal(m.queryAll("[data-worker-request]").length, 0);
    await act(async () => staleRead.resolve([row(a)]));
    assert.equal(m.queryAll("[data-worker-request]").length, 0);
  });

  it("shows a failed answer and allows retry without losing command edits", async () => {
    let attempt = 0;
    const s = setup([row(a)], { threads: [a], respond: async (input) => { s.calls.push(input); if (++attempt === 1) throw new Error("Connection interrupted"); } });
    const m = await mount(<WorkerApprovals {...s.props} />);
    await m.type(m.query("textarea"), "npm test -- smoke");
    await m.click(m.byText("Accept"));
    assert.match(m.query('[role="alert"]')?.textContent ?? "", /Connection interrupted.*Try again/);
    assert.equal((m.query("textarea") as HTMLTextAreaElement).value, "npm test -- smoke");
    await m.click(m.byText("Accept"));
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[1].updatedCommand, "npm test -- smoke");
    assert.equal(m.queryAll("[data-worker-request]").length, 0);
  });

  it("allows a reused provider request id in a later worker run", async () => {
    const s = setup([row(a)], { threads: [a], respond: async (input) => { s.calls.push(input); } });
    const m = await mount(<WorkerApprovals {...s.props} />);
    await m.click(m.byText("Accept"));
    assert.equal(m.queryAll("[data-worker-request]").length, 0);
    await m.rerender(<WorkerApprovals {...s.props} threads={[{ ...a, runStartedAt: 2 }]} />);
    assert.equal(m.queryAll("[data-worker-request]").length, 1);
    await m.click(m.byText("Deny"));
    assert.equal(s.calls.length, 2);
  });

  it("refreshes replaced/resolved requests and offers Retry after a read error", async () => {
    let rows = [row(a, "old")];
    let fail = false;
    const load = async () => { if (fail) throw new Error("Unavailable"); return rows; };
    const s = setup([], { threads: [a], loadApprovals: load });
    const m = await mount(<WorkerApprovals {...s.props} />);
    rows = [row(a, "new")];
    await m.rerender(<WorkerApprovals {...s.props} threads={[{ ...a, updatedAt: 2 }]} />);
    assert.equal(m.query('[data-worker-request="old"]'), null);
    assert.ok(m.query('[data-worker-request="new"]'));
    fail = true;
    await m.rerender(<WorkerApprovals {...s.props} threads={[{ ...a, updatedAt: 3 }]} />);
    assert.match(m.text(), /Could not load approvals.*Unavailable/);
    assert.equal(m.byText("Accept"), null, "stale cards are not actionable after a failed refresh");
    fail = false; rows = [];
    await m.click(m.byText("Retry"));
    assert.equal(m.queryAll("[data-worker-request]").length, 0);
  });

  it("refreshes a second request and external resolution even when the roster does not change", async () => {
    const listeners = new Map<string, (patch: unknown) => void>();
    let rows = [row(a, "first")];
    let loads = 0;
    const subscribe = ((channel: string, cb: (patch: unknown) => void) => {
      listeners.set(channel, cb);
      return () => { listeners.delete(channel); };
    }) as CoderApi["on"];
    const s = setup([], { threads: [a], subscribe, loadApprovals: async () => { loads++; return rows; } });
    const m = await mount(<WorkerApprovals {...s.props} />);
    rows = [row(a, "first"), row(a, "second")];
    await act(async () => listeners.get("thread:updated")?.({ thread: a } as ThreadPatch));
    assert.equal(m.queryAll("[data-worker-request]").length, 2);
    const before = loads;
    await act(async () => listeners.get("thread:updated")?.({ thread: b } as ThreadPatch));
    assert.equal(loads, before, "another child's pushes do not refresh this worker");
    rows = [];
    await act(async () => listeners.get("threads:changed")?.([a]));
    assert.equal(m.queryAll("[data-worker-request]").length, 0, "reconnect removes requests resolved while disconnected");
    m.unmount();
    assert.equal(listeners.size, 0);
  });

  it("ignores late loads after changing the parent or worker project", async () => {
    const late = deferred<PendingApprovalInfo[]>();
    const s = setup([], { threads: [a], loadApprovals: async () => late.promise });
    const m = await mount(<WorkerApprovals {...s.props} />);
    await m.rerender(<WorkerApprovals {...s.props} parent={thread("different-parent")} />);
    await act(async () => late.resolve([row(a)]));
    assert.equal(m.queryAll("[data-worker-request]").length, 0);
  });

  it("does not fetch or answer disconnected workers; reconnect refreshes them", async () => {
    const offline = { ...a, host: { key: "box:1", label: "Box", status: "offline" as const } };
    const lead = { ...parent, host: offline.host };
    const s = setup([row(a)], { parent: lead, threads: [offline] });
    const m = await mount(<WorkerApprovals {...s.props} />);
    assert.equal(s.loads.length, 0);
    assert.match(m.text(), /computer offline/);
    assert.equal(m.byText("Accept"), null);
    await m.rerender(<WorkerApprovals {...s.props} threads={[{ ...offline, host: { ...offline.host, status: "online" } }]} />);
    assert.equal(s.loads.length, 1);
    assert.ok(m.byText("Accept"));
  });

  it("keeps provider restrictions and special questions on the worker; worker shortcuts never answer cards", async () => {
    const s = setup([row(a, "native", { commandEditable: false, acceptAlways: false }), row(b, "question", { questions: [{ question: "Which target?", options: [{ label: "A", description: "Target A" }], multiSelect: false }] })]);
    const m = await mount(<WorkerApprovals {...s.props} />);
    assert.equal((m.query("textarea") as HTMLTextAreaElement).readOnly, true);
    assert.equal(m.byText("Always allow"), null);
    assert.equal(m.byText("Accept all"), null);
    assert.equal(m.query('[aria-keyshortcuts]'), null);
    assert.equal(m.query('[data-permission-redirect-hint]'), null);
    await m.press(m.container, "y");
    await m.press(m.container, "n");
    assert.equal(s.calls.length, 0);
    await m.click(m.byText("Open worker to answer"));
    assert.deepEqual(s.opened, [b.id]);
  });

  it("mounts alongside the parent's own question without replacing it", async () => {
    const s = setup([row(a)]);
    const m = await mount(<ThreadView
      detail={{ thread: parent, messages: [], workLog: [], workflow: null, usage: null, pendingPermission: { ...row(parent), questions: [{ question: "Parent question?", options: [{ label: "Keep going", description: "Continue" }], multiSelect: false }] } }}
      project={project} providers={[]} workflows={[]} hasProjects
      onAddProject={() => {}} onStartRun={() => {}} onStartWorkflow={() => {}}
      onSaveWorkflow={async () => ({ id: "w", name: "Workflow", phases: [] })} onRemoveWorkflow={async () => {}}
      onStopRun={() => {}} onSetPermissionMode={() => {}} onRespondPermission={() => {}}
      onSetProvider={() => {}} onSetReasoningEffort={() => {}} onSetArchived={() => {}} onDeleteThread={() => {}}
      workerApprovals={s.props}
    />);
    assert.match(m.text(), /Parent question\?/);
    assert.ok(m.query('[data-worker-request="req"]'));
    await m.click(m.byText("Deny"));
    assert.equal(s.calls[0].threadId, a.id);
    assert.match(m.text(), /Parent question\?/);
  });

  it("the parent's native approval keeps its shortcuts without answering any worker", async () => {
    let parentAnswers = 0;
    const s = setup([row(a), row(b)]);
    const m = await mount(<><PermissionPrompt pending={row(parent)} onRespond={() => { parentAnswers++; }} /><WorkerApprovals {...s.props} /></>);
    await m.press(m.container, "y");
    assert.equal(parentAnswers, 1);
    assert.deepEqual(s.calls, []);
    assert.equal(m.queryAll("[data-worker-request]").length, 2);
  });
});
