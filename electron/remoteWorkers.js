"use strict";

/**
 * Cross-host delegation (#1821): thread_fork with `host` starts the worker
 * on another computer in the host hub, in that computer's copy of the same
 * repo. The worker lives in that computer's store like any thread started
 * from its sidebar. This side remembers it on the lead thread
 * (`remoteWorkers`, so a restart keeps it) and watches the host's thread
 * list. When that run ends, the lead gets the same wake-up notice a local
 * worker's finish sends.
 */

const RUNNING = new Set(["working", "quota-wait"]);

function lastReplyLine(detail) {
  const msgs = detail && Array.isArray(detail.messages) ? detail.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "assistant" && m.text != null && String(m.text)) {
      return String(m.text).split(/\r?\n/)[0];
    }
  }
  return "";
}

/**
 * @param {{
 *   store: any,
 *   hub: ReturnType<typeof import("./hostHub.js").createHostHub>,
 *   deliver: (input: { threadId: string, line: string }) => void,
 *   runner?: any,
 * }} deps
 */
function createRemoteWorkers({ store, hub, deliver, runner }) {
  /** Leads with a remote worker still out. Built from the store on first use. */
  let leads = null;
  function pendingLeads() {
    if (!leads) {
      leads = new Set(
        store.getThreads()
          .filter((t) => Array.isArray(t.remoteWorkers) && t.remoteWorkers.some((w) => w.out))
          .map((t) => t.id),
      );
    }
    return leads;
  }

  function findHost(name) {
    const want = String(name).trim().toLowerCase();
    const hosts = hub.list();
    const host = hosts.find((h) => h.key.toLowerCase() === want || h.label.toLowerCase() === want);
    if (!host) {
      const names = hosts.map((h) => `"${h.label}"`).join(", ");
      throw new Error(
        `No computer called "${name}" is in the sidebar. ` +
          (names ? `Connected computers: ${names}.` : "None are: add one in Settings → Connections and turn on Show in sidebar."),
      );
    }
    if (host.status !== "online") {
      throw new Error(`${host.label} is ${host.status}${host.error ? ` (${host.error})` : ""}. Try again once it is online.`);
    }
    return host;
  }

  /**
   * @param {{ lead: any, host: string, prompt: string, title?: string, provider?: string, worktree?: boolean }} input
   */
  async function fork(input) {
    const { lead } = input;
    const host = findHost(input.host);
    const project = store.getProject(lead.projectId);
    const slug = String((project && project.slug) || "").toLowerCase();
    // Same repo = same slug (owner/name from origin, or the folder name).
    const there = hub.projectsOf(host.key).find(
      (p) => p && !p.scratch && String(p.slug || "").toLowerCase() === slug,
    );
    if (!there) {
      throw new Error(
        `${host.label} has no project for ${project ? project.slug : "this repo"}. ` +
          `Add the repo there first (or Teleport a thread to it, which clones it).`,
      );
    }
    const created = await hub.invoke(host.key, "threads:create", [{
      projectId: there.id,
      title: input.title || String(input.prompt).split(/\r?\n/).find((l) => l.trim()) || "Worker",
      worktree: input.worktree !== false,
      ...(input.provider ? { provider: input.provider } : {}),
    }]);
    // Its task_* and peer_send calls come back here (crew relay). An older
    // Solenta there lacks the channel: the worker just runs without a crew.
    await hub.invoke(host.key, "threads:setCrewRelay", [{ threadId: created.id, leadId: lead.id, leadTitle: lead.title || null }]).catch(() => {});
    await hub.invoke(host.key, "runs:start", [{ threadId: created.id, prompt: input.prompt }]);
    const record = {
      hostKey: host.key,
      hostLabel: host.label,
      threadId: created.id,
      title: created.title || null,
      // Out = the lead is owed a wake-up; first = its first run (#1821).
      out: true,
      first: true,
    };
    const fresh = store.getThread(lead.id);
    store.updateThread(lead.id, {
      remoteWorkers: [...((fresh && fresh.remoteWorkers) || []), record],
    });
    store.saveNow();
    pendingLeads().add(lead.id);
    // A run that already ended before we stamped it still wakes the lead.
    onHostThreads(host.key, hub.threadsOf(host.key));
    return { threadId: created.id, host: host.label };
  }

  /** Replace one worker record on its lead. */
  function patch(leadId, threadId, fields) {
    const lead = store.getThread(leadId);
    if (!lead || !Array.isArray(lead.remoteWorkers)) return;
    store.updateThread(leadId, {
      remoteWorkers: lead.remoteWorkers.map((w) => (w.threadId === threadId ? { ...w, ...fields } : w)),
    });
    store.saveNow();
  }

  /** The lead that forked this remote worker, or null. */
  function find(threadId) {
    for (const t of store.getThreads()) {
      const w = Array.isArray(t.remoteWorkers) && t.remoteWorkers.find((r) => r.threadId === threadId);
      if (w) return { leadId: t.id, w };
    }
    return null;
  }

  function call(w, channel, args) {
    return hub.invoke(w.hostKey, channel, args);
  }

  /** threads_list rows for this project's remote workers, from the hub's list. */
  function listFor(projectId) {
    const out = [];
    for (const t of store.getThreads()) {
      if (t.projectId !== projectId || !Array.isArray(t.remoteWorkers)) continue;
      for (const w of t.remoteWorkers) {
        const row = hub.threadsOf(w.hostKey).find((r) => r.id === w.threadId);
        out.push({
          id: w.threadId,
          title: (row && row.title) || w.title,
          provider: (row && row.provider) || null,
          status: row ? row.status : null,
          handoffFrom: t.id,
          projectId: t.projectId,
          host: w.hostLabel,
          reachable: Boolean(row),
        });
      }
    }
    return out;
  }

  async function status(w) {
    const detail = await call(w, "threads:get", [w.threadId]);
    const t = (detail && detail.thread) || {};
    const lastError = t.lastError ? String(t.lastError) : null;
    return {
      status: t.status ?? null,
      title: t.title ?? null,
      provider: t.provider ?? null,
      host: w.hostLabel,
      branch: t.branch || null,
      lastAssistantText: lastReplyLine(detail) || null,
      lastError,
      awaitingInput: t.status === "working" && t.awaitingInput === true,
    };
  }

  /**
   * thread_send to a remote worker: start a turn, or queue it behind the
   * running one the same way a local send does. Either way the lead is owed
   * a wake-up when that turn ends.
   */
  async function send(leadId, w, prompt) {
    const row = hub.threadsOf(w.hostKey).find((r) => r.id === w.threadId);
    let queued = Boolean(row && RUNNING.has(row.status));
    // Arm before starting: the host's working/done pushes can land before
    // runs:start answers. A queued prompt runs after the current turn, so
    // that turn's end is skipped.
    const arm = () => {
      patch(leadId, w.threadId, { out: true, first: false, sawWorking: queued, skip: queued ? 1 : 0 });
      pendingLeads().add(leadId);
    };
    arm();
    try {
      if (!queued) {
        try {
          await call(w, "runs:start", [{ threadId: w.threadId, prompt }]);
        } catch (err) {
          if (!/already active/i.test(String(err && err.message))) throw err;
          queued = true;
          arm();
        }
      }
      if (queued) {
        await call(w, "threads:setQueued", [{ threadId: w.threadId, prompt, inbound: true }]);
      }
    } catch (err) {
      patch(leadId, w.threadId, { out: false });
      throw err;
    }
    return { outcome: queued ? "queued" : "delivered", threadId: w.threadId, host: w.hostLabel };
  }

  // First run: the worker is a new thread, idle until it starts, and a run
  // ends done or failed. Later runs start from done, so they only count
  // once seen working. Idle after working = stopped.
  function finished(w, row) {
    if (!row) return false;
    if (RUNNING.has(row.status)) {
      w.sawWorking = true;
      return false;
    }
    const ended = w.sawWorking === true || (w.first === true && (row.status === "done" || row.status === "failed"));
    if (!ended) return false;
    if (w.skip > 0) {
      w.skip -= 1;
      w.sawWorking = false;
      return false;
    }
    return true;
  }

  async function wake(leadId, w, row) {
    let reply = "";
    let branch = "";
    try {
      const detail = await call(w, "threads:get", [w.threadId]);
      reply = lastReplyLine(detail);
      branch = (detail && detail.thread && detail.thread.branch) || "";
    } catch {
      // Host went away between the list push and this call: wake anyway.
    }
    const status = row.status === "failed" ? "failed" : row.status === "idle" ? "stopped" : "done";
    const title = w.title ? ` ("${w.title}")` : "";
    // Same report-then-ask contract as a local worker's notice.
    const land =
      status === "done" && branch
        ? ` Its work is still only on branch ${branch} on ${w.hostLabel}: check it` +
          ` (thread_status), then tell the user what it built and ask whether to merge` +
          ` it here (thread_merge) or open a pull request (thread_pr) with workerThreadId` +
          ` ${w.threadId}. Do not land it before they answer. If other workers have` +
          ` finished too, ask about all of them in one question.`
        : "";
    deliver({
      threadId: leadId,
      line:
        `Worker thread ${w.threadId}${title} on ${w.hostLabel} finished with status ${status}.` +
        (reply ? ` Last reply: ${reply}` : "") +
        land,
    });
  }

  /** Hub hook: a host's thread list changed. */
  function onHostThreads(key, rows) {
    const set = pendingLeads();
    if (!set.size) return;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const leadId of [...set]) {
      const lead = store.getThread(leadId);
      const all = lead && Array.isArray(lead.remoteWorkers) ? lead.remoteWorkers : [];
      const done = all.filter((w) => w.out && w.hostKey === key && finished(w, byId.get(w.threadId)));
      if (done.length) {
        store.updateThread(leadId, {
          remoteWorkers: all.map((w) => (done.includes(w) ? { ...w, out: false, first: false, sawWorking: false } : w)),
        });
        store.saveNow();
      }
      if (!lead || !all.some((w) => w.out && !done.includes(w))) set.delete(leadId);
      for (const w of done) void wake(leadId, w, byId.get(w.threadId));
    }
  }

  /**
   * Hub hook: a worker on `hostKey` called a crew tool (task_*, peer_send).
   * Run it here as that worker, against its lead's crew. Null when the
   * worker is not one of ours, so another desktop on that host answers.
   */
  function onCrewCall(hostKey, payload) {
    const { RELAYED_TOOLS } = require("./crewRelay.js");
    const hit = payload && find(String(payload.workerId || ""));
    if (!hit || hit.w.hostKey !== hostKey) return null;
    const lead = store.getThread(hit.leadId);
    if (!lead) return Promise.reject(new Error("Your lead thread no longer exists."));
    if (!RELAYED_TOOLS.has(payload.tool)) return Promise.reject(new Error(`${payload.tool} does not run on the lead's computer.`));
    const workerId = hit.w.threadId;
    // The worker as this store sees it: a crew member of its lead.
    const stub = {
      id: workerId, title: hit.w.title, projectId: lead.projectId,
      orchWorker: true, handoffFrom: lead.id, status: "working",
    };
    const asWorker = new Proxy(store, {
      get(target, key) {
        if (key === "getThread") return (id) => (String(id) === workerId ? stub : target.getThread(id));
        const v = target[key];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const { createToolHandlers } = require("./orchServer.js");
    const handlers = createToolHandlers({
      store: asWorker,
      runner: runner || {},
      forkThread: () => { throw new Error("not available"); },
      getProvider: () => null,
      remoteWorkers: api,
      boundProjectId: lead.projectId,
      boundThreadId: workerId,
    });
    const args = payload.args && typeof payload.args === "object" ? payload.args : {};
    return handlers[payload.tool]({ ...args, threadId: workerId, projectId: lead.projectId });
  }

  const api = { fork, onHostThreads, find, call, listFor, status, send, onCrewCall };
  return api;
}

module.exports = { createRemoteWorkers };
