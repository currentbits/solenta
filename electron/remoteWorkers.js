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
 * }} deps
 */
function createRemoteWorkers({ store, hub, deliver }) {
  /** Leads with a remote worker still out. Built from the store on first use. */
  let leads = null;
  function pendingLeads() {
    if (!leads) {
      leads = new Set(
        store.getThreads()
          .filter((t) => Array.isArray(t.remoteWorkers) && t.remoteWorkers.length)
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
    await hub.invoke(host.key, "runs:start", [{ threadId: created.id, prompt: input.prompt }]);
    const record = {
      hostKey: host.key,
      hostLabel: host.label,
      threadId: created.id,
      title: created.title || null,
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

  // The worker is a new thread: idle until its first run, which ends done
  // or failed. Idle after a run means it was stopped, so count it only once
  // the worker was seen working.
  function finished(w, row) {
    if (!row) return false;
    if (RUNNING.has(row.status)) {
      w.sawWorking = true;
      return false;
    }
    return row.status === "done" || row.status === "failed" || w.sawWorking === true;
  }

  async function wake(leadId, w, row) {
    let reply = "";
    let branch = "";
    try {
      const detail = await hub.invoke(w.hostKey, "threads:get", [w.threadId]);
      reply = lastReplyLine(detail);
      branch = (detail && detail.thread && detail.thread.branch) || "";
    } catch {
      // Host went away between the list push and this call: wake anyway.
    }
    const status = row.status === "failed" ? "failed" : row.status === "idle" ? "stopped" : "done";
    const title = w.title ? ` ("${w.title}")` : "";
    const land =
      status === "done"
        ? ` Its work is on ${w.hostLabel}${branch ? `, branch ${branch}` : ""}, not on this` +
          ` computer: thread_merge and thread_pr cannot land it from here. Tell the user` +
          ` what it built and ask whether to open a pull request from that thread on` +
          ` ${w.hostLabel} (it is in the sidebar). Do not land it before they answer.`
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
      const out = (lead && Array.isArray(lead.remoteWorkers)) ? lead.remoteWorkers : [];
      const done = out.filter((w) => w.hostKey === key && finished(w, byId.get(w.threadId)));
      if (!lead || done.length) {
        const left = out.filter((w) => !done.includes(w));
        if (lead) store.updateThread(leadId, { remoteWorkers: left.length ? left : null });
        if (!left.length) set.delete(leadId);
        store.saveNow();
      }
      for (const w of done) void wake(leadId, w, byId.get(w.threadId));
    }
  }

  return { fork, onHostThreads };
}

module.exports = { createRemoteWorkers };
