import type {
  ActivityItem,
  FailureMode,
  FleetEvidence,
  AppSettings,
  AppStatus,
  AttachmentInfo,
  AutomationInfo,
  UpdateStatus,
  CheckpointInfo,
  CoderApi,
  DistilledWorkflow,
  RunStatInfo,
  ConflictForecast,
  VerifyResult,
  GcScanResult,
  GcCleanResult,
  DiffResult,
  GitStatus,
  GitSyncInfo,
  GitRepoInfo,
  GitPullResult,
  FetchIssueResult,
  ListIssuesResult,
  ListPrsResult,
  SetPlanStatusResult,
  DevServerState,
  LocalServerInfo,
  MemoryEntryInfo,
  PrChecksResult,
  PrInfo,
  ProjectInfo,
  ProviderInfo,
  RewindResult,
  SkillInfo,
  SkillTarget,
  SpaceInfo,
  ThreadDetail,
  ThreadInfo,
  ThreadSummaryInfo,
  CrewTaskView,
  DigestResult,
  UsageByDay,
  WorkflowTemplateInfo,
} from "./shared/ipc";
import {
  WIRE_PUSH_CHANNELS,
  type WireClientMessage,
  type WireServerMessage,
} from "./shared/wire";

export type CreateWireCoderOptions = {
  url: string;
  token: string;
  WebSocket?: typeof WebSocket;
  setTimeout?: typeof setTimeout;
};

type Pending = {
  id: number;
  channel: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

const TRANSPORT_ERROR = "WebSocket disconnected";
const QUEUE_FULL_ERROR = "Offline queue full, request dropped";
const MAX_BACKOFF_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_QUEUED = 64;
// ponytail: one timeout for every channel. Raise it if a legitimately slow
// handler (gh network calls) starts tripping instead of per-channel budgets.
const INVOKE_TIMEOUT_MS = 120_000;

function unref(timer: unknown): void {
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

export function createWireCoder(opts: CreateWireCoderOptions): CoderApi {
  const WS = opts.WebSocket ?? WebSocket;
  const schedule = opts.setTimeout ?? setTimeout;

  let socket: InstanceType<typeof WS> | null = null;
  let ready = false;
  let nextId = 1;
  let backoffMs = MIN_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let everAuthed = false;

  const inflight = new Map<number, Pending>();
  const queued: Pending[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let resyncId: number | null = null;

  function send(msg: WireClientMessage): void {
    if (!socket || socket.readyState !== WS.OPEN) return;
    socket.send(JSON.stringify(msg));
  }

  function sendPending(p: Pending): void {
    inflight.set(p.id, p);
    send({ kind: "invoke", id: p.id, channel: p.channel, args: p.args });
  }

  function flushQueue(): void {
    const batch = queued.splice(0);
    const bySig = new Map<string, Pending>();
    for (const p of batch) {
      const sig = JSON.stringify([p.channel, p.args]);
      const first = bySig.get(sig);
      if (!first) {
        bySig.set(sig, p);
        sendPending(p);
        continue;
      }
      // Interval pollers queue the same call over and over during an outage.
      // Send one and share its reply instead of stampeding main on reconnect.
      const { resolve, reject } = first;
      first.resolve = (v) => {
        resolve(v);
        p.resolve(v);
      };
      first.reject = (e) => {
        reject(e);
        p.reject(e);
      };
    }
  }

  function rejectInflight(message: string): void {
    const err = new Error(message);
    for (const p of inflight.values()) p.reject(err);
    inflight.clear();
  }

  function rejectQueued(message: string): void {
    const err = new Error(message);
    while (queued.length) queued.shift()!.reject(err);
  }

  function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      // Covers both a handler that hangs in main and a queued call that never
      // gets a reconnect: either way the caller's button stops spinning.
      const timer = schedule(() => {
        inflight.delete(id);
        const i = queued.findIndex((q) => q.id === id);
        if (i >= 0) queued.splice(i, 1);
        reject(new Error(`Timed out after ${INVOKE_TIMEOUT_MS}ms: ${channel}`));
      }, INVOKE_TIMEOUT_MS);
      unref(timer);
      const p: Pending = {
        id,
        channel,
        args,
        resolve: (v) => {
          clearTimeout(timer as ReturnType<typeof setTimeout>);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer as ReturnType<typeof setTimeout>);
          reject(e);
        },
      };
      if (ready && socket && socket.readyState === WS.OPEN) {
        sendPending(p);
      } else {
        while (queued.length >= MAX_QUEUED) {
          queued.shift()!.reject(new Error(QUEUE_FULL_ERROR));
        }
        queued.push(p);
      }
    });
  }

  function resyncThreads(): void {
    const p: Pending = {
      id: nextId++,
      channel: "threads:list",
      args: [],
      resolve: () => {},
      reject: () => {},
    };
    resyncId = p.id;
    sendPending(p);
  }

  function handleMessage(raw: string): void {
    let msg: WireServerMessage;
    try {
      msg = JSON.parse(raw) as WireServerMessage;
    } catch {
      return;
    }
    if (msg.kind === "auth-ok") {
      ready = true;
      backoffMs = MIN_BACKOFF_MS;
      const reconnecting = everAuthed;
      everAuthed = true;
      flushQueue();
      if (reconnecting) resyncThreads();
      return;
    }
    if (msg.kind === "reply") {
      const p = inflight.get(msg.id);
      if (!p) return;
      inflight.delete(msg.id);
      if (typeof msg.error === "string") {
        p.reject(new Error(msg.error));
        return;
      }
      p.resolve(msg.result);
      if (msg.id === resyncId) {
        resyncId = null;
        const set = listeners.get("threads:changed");
        if (set) {
          for (const cb of set) cb(msg.result);
        }
      }
      return;
    }
    if (msg.kind === "push") {
      const set = listeners.get(msg.channel);
      if (!set) return;
      for (const cb of set) cb(msg.payload);
    }
  }

  function scheduleReconnect(): void {
    if (reconnectTimer != null) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    const timer = schedule(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
    reconnectTimer = timer as ReturnType<typeof setTimeout>;
    unref(timer);
  }

  function attach(ws: InstanceType<typeof WS>): void {
    socket = ws;
    ready = false;
    ws.onopen = () => {
      send({ kind: "auth", token: opts.token });
    };
    ws.onmessage = (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      handleMessage(data);
    };
    // Browser WebSocket errors stay on onerror. The `ws` package (and Node's
    // WebSocket) emit an 'error' that becomes uncaughtException with no
    // listener — same close path either way, so swallow here.
    ws.onerror = () => {};
    ws.onclose = () => {
      ready = false;
      rejectInflight(TRANSPORT_ERROR);
      // Queued invokes sit here until auth-ok. A close before the first
      // auth-ok (wrong token, refused, drop) used to leave them pending
      // forever — the integration harness hung on a bad token.
      if (!everAuthed) rejectQueued(TRANSPORT_ERROR);
      scheduleReconnect();
    };
  }

  function openSocket(): void {
    attach(new WS(opts.url));
  }

  function on(channel: string, cb: (payload: unknown) => void): () => void {
    if (!(WIRE_PUSH_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`Push channel not allowed: ${channel}`);
    }
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  openSocket();

  const call = <T>(channel: string, ...args: unknown[]) =>
    invoke(channel, ...args) as Promise<T>;

  return {
    app: {
      status: () => call<AppStatus>("app:status"),
      checkUpdate: () => call<UpdateStatus>("app:checkUpdate"),
      downloadUpdate: () => call<UpdateStatus>("app:downloadUpdate"),
      applyUpdate: () => call<void>("app:applyUpdate"),
    },
    memory: {
      search: (input) => call<MemoryEntryInfo[]>("memory:search", input),
      recent: (input) => call<MemoryEntryInfo[]>("memory:recent", input),
      get: (input) => call<MemoryEntryInfo>("memory:get", input),
      store: (input) => call<{ id: string }>("memory:store", input),
      update: (input) => call<{ id: string }>("memory:update", input),
      remove: (input) => call<void>("memory:remove", input),
    },
    settings: {
      get: () => call<AppSettings>("settings:get"),
      set: (patch) => call<AppSettings>("settings:set", patch),
    },
    skills: {
      list: (input) => call<SkillInfo[]>("skills:list", input),
      add: (input) =>
        call<{ name: string; installedIn: SkillTarget[] }>("skills:add", input),
      remove: (input) => call<void>("skills:remove", input),
      sync: () => call<{ copied: number; skills: string[] }>("skills:sync"),
    },
    providers: {
      list: () => call<ProviderInfo[]>("providers:list"),
    },
    workflows: {
      list: () => call<WorkflowTemplateInfo[]>("workflows:list"),
      save: (template) =>
        call<WorkflowTemplateInfo>("workflows:save", template),
      remove: (input) => call<void>("workflows:remove", input),
    },
    automations: {
      list: () => call<AutomationInfo[]>("automations:list"),
      add: (input) => call<AutomationInfo>("automations:add", input),
      update: (input) => call<AutomationInfo>("automations:update", input),
      remove: (input) => call<void>("automations:remove", input),
      runNow: (input) => call<AutomationInfo>("automations:runNow", input),
    },
    projects: {
      list: () => call<ProjectInfo[]>("projects:list"),
      add: (projectPath, opts) =>
        call<ProjectInfo>("projects:add", projectPath, opts),
      create: (input) => call<ProjectInfo>("projects:create", input),
      update: (input) => call<ProjectInfo>("projects:update", input),
      addViaDialog: () => call<ProjectInfo | null>("projects:addViaDialog"),
      pickDirectory: () => call<string | null>("projects:pickDirectory"),
      remove: (input) => call<void>("projects:remove", input),
    },
    spaces: {
      list: () => call<SpaceInfo[]>("spaces:list"),
      add: (input) => call<SpaceInfo>("spaces:add", input),
      update: (input) => call<SpaceInfo>("spaces:update", input),
      remove: (input) => call<void>("spaces:remove", input),
    },
    threads: {
      list: () => call<ThreadInfo[]>("threads:list"),
      summaries: () => call<ThreadSummaryInfo[]>("threads:summaries"),
      crewTasks: (input) =>
        call<{ rootThreadId: string; tasks: CrewTaskView[] }>(
          "threads:crewTasks",
          input,
        ),
      search: (input) => call<ThreadInfo[]>("threads:search", input),
      create: (input) => call<ThreadInfo>("threads:create", input),
      fork: (input) => call<ThreadInfo>("threads:fork", input),
      rewind: (input) => call<RewindResult>("threads:rewind", input),
      get: (id) => call<ThreadDetail>("threads:get", id),
      setPermissionMode: (input) =>
        call<ThreadInfo>("threads:setPermissionMode", input),
      respondPermission: (input) =>
        call<void>("threads:respondPermission", input),
      setArchived: (input) => call<ThreadInfo>("threads:setArchived", input),
      setSettled: (input) => call<ThreadInfo>("threads:setSettled", input),
      setPinned: (input) => call<ThreadInfo>("threads:setPinned", input),
      setQueued: (input) => call<ThreadInfo>("threads:setQueued", input),
      setSnoozed: (input) => call<ThreadInfo>("threads:setSnoozed", input),
      setMuted: (input) => call<ThreadInfo>("threads:setMuted", input),
      setNotes: (input) => call<ThreadInfo>("threads:setNotes", input),
      startSpec: (input) => call<ThreadInfo>("threads:startSpec", input),
      stopSpec: (input) => call<ThreadInfo>("threads:stopSpec", input),
      reviewSpec: (input) => call<ThreadInfo>("threads:reviewSpec", input),
      specArtifact: (input) =>
        call<{ path: string; text: string | null }>(
          "threads:specArtifact",
          input,
        ),
      rename: (input) => call<ThreadInfo>("threads:rename", input),
      setProvider: (input) => call<ThreadInfo>("threads:setProvider", input),
      setReasoningEffort: (input) =>
        call<ThreadInfo>("threads:setReasoningEffort", input),
      setVerifyCommand: (input) =>
        call<ThreadInfo>("threads:setVerifyCommand", input),
      runVerify: (input) => call<VerifyResult>("threads:runVerify", input),
      delete: (input) => call<void>("threads:delete", input),
    },
    activity: {
      list: () => call<ActivityItem[]>("activity:list"),
    },
    usage: {
      byDay: () => call<UsageByDay>("usage:byDay"),
    },
    insights: {
      failureModes: () => call<FailureMode[]>("insights:failureModes"),
    },
    fleet: {
      evidence: (input) => call<FleetEvidence>("fleet:evidence", input),
    },
    digest: {
      list: (input) => call<DigestResult>("digest:list", input),
      markSeen: (input) => call<{ seenAt: number }>("digest:markSeen", input),
    },
    runs: {
      start: (input) => call<{ runId: string }>("runs:start", input),
      startWorkflow: (input) =>
        call<{ runId: string }>("runs:startWorkflow", input),
      distill: (input) =>
        call<DistilledWorkflow>("runs:distill", input),
      stop: (input) => call<void>("runs:stop", input),
    },
    git: {
      status: (projectId) => call<GitStatus>("git:status", projectId),
      setupWorktree: (input) => call<ThreadInfo>("git:setupWorktree", input),
      diff: (input) => call<DiffResult>("git:diff", input),
      commit: (input) => call<{ subject: string }>("git:commit", input),
      revertFile: (input) => call<{ path: string }>("git:revertFile", input),
      suggestCommitMessage: (input) =>
        call<{ message: string }>("git:suggestCommitMessage", input),
      mergeWorktree: (input) => call<ThreadInfo>("git:mergeWorktree", input),
      removeWorktree: (input) => call<ThreadInfo>("git:removeWorktree", input),
      push: (input) =>
        call<{ remote: string; branch: string }>("git:push", input),
      createPr: (input) => call<PrInfo>("git:createPr", input),
      prStatus: (input) => call<PrInfo | null>("git:prStatus", input),
      prChecks: (input) => call<PrChecksResult>("git:prChecks", input),
      prMerge: (input) => call<PrInfo>("git:prMerge", input),
      listPrs: (projectPath) => call<ListPrsResult>("git:listPrs", projectPath),
      listCheckpoints: (input) =>
        call<CheckpointInfo[]>("git:listCheckpoints", input),
      restoreCheckpoint: (input) => call<void>("git:restoreCheckpoint", input),
      syncInfo: (input) => call<GitSyncInfo>("git:syncInfo", input),
      fetch: (input) => call<void>("git:fetch", input),
      repoInfo: (input) => call<GitRepoInfo>("git:repoInfo", input),
      pull: (input) => call<GitPullResult>("git:pull", input),
      runStats: (input) => call<RunStatInfo[]>("git:runStats", input),
      conflictForecast: (input) =>
        call<ConflictForecast>("git:conflictForecast", input),
      gcScan: () => call<GcScanResult>("git:gcScan"),
      gcClean: (input) => call<GcCleanResult>("git:gcClean", input),
    },
    issues: {
      fetch: (input) => call<FetchIssueResult>("issues:fetch", input),
      list: (projectPath) => call<ListIssuesResult>("issues:list", projectPath),
      setPlanStatus: (input) =>
        call<SetPlanStatusResult>("issues:setPlanStatus", input),
    },
    files: {
      list: (input) => call<{ files: string[] }>("files:list", input),
      image: (input) =>
        call<{ dataUrl: string | null }>("files:image", input),
    },
    attachments: {
      pick: () =>
        call<{ attachments: AttachmentInfo[] }>("attachments:pick"),
      fromPaths: (input) =>
        call<{ attachments: AttachmentInfo[] }>("attachments:fromPaths", input),
      saveImage: (input) =>
        call<{ attachment: AttachmentInfo | null }>(
          "attachments:saveImage",
          input,
        ),
      readImage: (input) =>
        call<{ dataUrl: string | null }>("attachments:readImage", input),
    },
    servers: {
      list: (input) => call<LocalServerInfo[]>("servers:list", input),
    },
    shell: {
      reveal: (input) => call<void>("shell:reveal", input),
      openPath: (input) => call<void>("shell:openPath", input),
    },
    devserver: {
      scripts: (input) => call<string[]>("devserver:scripts", input),
      start: (input) => call<DevServerState>("devserver:start", input),
      stop: (input) => call<DevServerState>("devserver:stop", input),
      status: (input) => call<DevServerState>("devserver:status", input),
    },
    on: on as CoderApi["on"],
  };
}
