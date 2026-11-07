/** Scheduled automations for the browser-dev fixture. */
import type {
  AutomationInfo,
  AutomationRunInfo,
  AutomationRunsResult,
  AutomationScope,
  AutomationWrite,
  CoderApi,
  ProjectInfo,
} from "../shared/ipc";
import type { DevCtx } from "./context.ts";
import { now, id } from "./util.ts";
import { nextCronFire, parseCron } from "../cron.ts";

const SLUG_RE = /^[a-z][a-z0-9-]{0,47}$/;

function slugFromName(name: string, taken: string[]): string {
  const used = new Set(taken);
  let base = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!SLUG_RE.test(base)) base = "auto";
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function harnessHash(parts: string[]): string {
  let n = 0;
  const s = parts.join("\0");
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
  return n.toString(16).padStart(8, "0").repeat(8);
}

export function nextAutomationFire(
  preset: AutomationInfo["preset"],
  hour: number | null,
  fromMs: number,
  cron?: string,
): number {
  if (preset === "cron") return nextCronFire(cron ?? "", fromMs) ?? fromMs;
  const from = new Date(fromMs);
  if (preset === "hourly") {
    const next = new Date(from);
    next.setMinutes(0, 0, 0);
    if (next.getTime() <= fromMs) next.setHours(next.getHours() + 1);
    return next.getTime();
  }
  const h = hour ?? 0;
  const next = new Date(from);
  next.setHours(h, 0, 0, 0);
  if (next.getTime() <= fromMs) {
    next.setDate(next.getDate() + (preset === "weekly" ? 7 : 1));
  }
  return next.getTime();
}

export function normalizeDevAutomation(
  input: Partial<AutomationWrite>,
  projectList: ProjectInfo[],
  existing: AutomationInfo | null,
): Omit<AutomationInfo, "id" | "lastRunAt" | "nextRunAt" | "lastError"> {
  const name = String(
    (Object.prototype.hasOwnProperty.call(input, "name")
      ? input.name
      : existing?.name) ?? "",
  ).trim();
  if (!name) throw new Error("Automation name is required");
  const projectId = String(
    (Object.prototype.hasOwnProperty.call(input, "projectId")
      ? input.projectId
      : existing?.projectId) ?? "",
  );
  if (!projectId || !projectList.some((p) => p.id === projectId)) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  const prompt = String(
    (Object.prototype.hasOwnProperty.call(input, "prompt")
      ? input.prompt
      : existing?.prompt) ?? "",
  );
  if (!prompt.trim()) throw new Error("Prompt is required");
  const provider = String(
    (Object.prototype.hasOwnProperty.call(input, "provider")
      ? input.provider
      : existing?.provider) ?? "",
  );
  if (!provider) throw new Error("Provider is required");
  const model = Object.prototype.hasOwnProperty.call(input, "model")
    ? (input.model ?? null)
    : (existing?.model ?? null);
  const preset = (Object.prototype.hasOwnProperty.call(input, "preset")
    ? input.preset
    : existing?.preset) as AutomationInfo["preset"] | undefined;
  if (preset !== "hourly" && preset !== "daily" && preset !== "weekly" && preset !== "cron") {
    throw new Error("Invalid preset");
  }
  let cron: string | undefined;
  if (preset === "cron") {
    cron = String(
      (Object.prototype.hasOwnProperty.call(input, "cron") ? input.cron : existing?.cron) ?? "",
    ).trim();
    parseCron(cron);
  }
  let hour: number | null = null;
  if (preset === "daily" || preset === "weekly") {
    const raw = Object.prototype.hasOwnProperty.call(input, "hour")
      ? input.hour
      : existing?.hour;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 23) {
      throw new Error("Hour must be an integer from 0 to 23");
    }
    hour = n;
  }
  const enabled = Object.prototype.hasOwnProperty.call(input, "enabled")
    ? Boolean(input.enabled)
    : existing
      ? existing.enabled
      : true;
  const trigger = Object.prototype.hasOwnProperty.call(input, "trigger")
    ? (input.trigger ?? null)
    : (existing?.trigger ?? null);
  const memory = Object.prototype.hasOwnProperty.call(input, "memory")
    ? String(input.memory ?? "")
    : (existing?.memory ?? "");
  const rawScope = Object.prototype.hasOwnProperty.call(input, "scope")
    ? input.scope
    : (existing?.scope ?? "private");
  const scope: AutomationScope = rawScope === "project" ? "project" : "private";
  if (rawScope != null && rawScope !== "private" && rawScope !== "project") {
    throw new Error(`Invalid scope: ${rawScope}. Expected private or project`);
  }
  if (existing && input.scope != null && input.scope !== existing.scope) {
    throw new Error("Cannot change automation scope");
  }
  const stage =
    (Object.prototype.hasOwnProperty.call(input, "stage")
      ? input.stage
      : existing?.stage) ?? "observe";
  const graduate = Object.prototype.hasOwnProperty.call(input, "graduate")
    ? input.graduate !== false
    : existing?.graduate !== false;
  const sessionMode = input.sessionMode ?? existing?.sessionMode ?? "new-thread";
  if (!["new-thread", "continue", "fresh"].includes(sessionMode)) throw new Error("Invalid automation session mode");
  const destinationThreadId = sessionMode === "new-thread" ? null : (input.destinationThreadId ?? existing?.destinationThreadId ?? "").trim();
  if (sessionMode !== "new-thread" && !destinationThreadId) throw new Error("Destination thread is required");
  return {
    sessionMode, destinationThreadId,
    tier: input.tier === undefined ? existing?.tier : input.tier,
    budget: input.budget === undefined ? existing?.budget : input.budget,
    name,
    projectId,
    scope,
    prompt,
    provider,
    model,
    preset,
    hour,
    ...(cron ? { cron } : {}),
    enabled,
    trigger,
    memory,
    stage,
    graduate,
  };
}

export function createAutomations(ctx: DevCtx): Pick<CoderApi, "automations"> {
  /** Scheduled agent runs. */
  let automationsList: AutomationInfo[] = [];
  const automationIdByThread = new Map<string, string>();
  const trustByProject: Record<string, string> = {};
  const firing = new Set<string>();
  const fixedRuns = new Map<string, AutomationRunInfo[]>();
  function destination(a: Pick<AutomationInfo, "sessionMode" | "destinationThreadId" | "projectId" | "provider" | "model" | "tier">, runtime = false) {
    if (!a.sessionMode || a.sessionMode === "new-thread") return null;
    const t = ctx.threads.find((t) => t.id === a.destinationThreadId);
    if (!t || t.projectId !== a.projectId || t.archived || t.teleportedTo || t.provider !== a.provider || (t.model || null) !== (a.model || null) || t.permissionMode !== "default" || t.providerInstance || t.agentProfileId || t.autoApprove || t.route || a.tier) throw new Error("Automation destination must be an available thread in its project with matching provider/model, default permissions, no account override, grants, or routing");
    const detail = ctx.details.get(t.id);
    if (runtime && (t.status === "working" || t.status === "quota-wait" || t.quotaWaitUntil || t.queued || t.runQueue || t.pendingQuestion || t.pendingPlan || t.awaitingInput || detail?.pendingPermission || t.pendingSecret || t.btw?.length || (t.freshContextPending && a.sessionMode !== "fresh"))) throw new Error("Automation destination has unfinished work or pending input; run skipped");
    return t;
  }

  function sharedRows(projectId: string) {
    return automationsList.filter(
      (a) => a.projectId === projectId && a.scope === "project",
    );
  }

  function currentHash(projectId: string) {
    const rows = sharedRows(projectId);
    return harnessHash(rows.map((a) => a.id));
  }

  function setProjectFile(
    projectId: string,
    hash: string,
    trusted: boolean,
    count: number,
  ) {
    const i = ctx.projects.findIndex((p) => p.id === projectId);
    if (i < 0) return;
    ctx.projects[i] = {
      ...ctx.projects[i],
      automationsFile: { hash, trusted, count },
    };
  }

  function refreshProjectFile(projectId: string) {
    const project = ctx.projects.find((p) => p.id === projectId);
    if (!project || project.remoteHost || !project.path) return;
    const rows = sharedRows(projectId);
    if (rows.length === 0) {
      if (!project.automationsFile) return;
      const rest = { ...project };
      delete rest.automationsFile;
      ctx.projects[ctx.projects.indexOf(project)] = rest;
      delete trustByProject[projectId];
      return;
    }
    const hash = currentHash(projectId);
    setProjectFile(
      projectId,
      hash,
      trustByProject[projectId] === hash,
      rows.length,
    );
  }

  function persistTrust(project: ProjectInfo, hash: string) {
    trustByProject[project.id] = hash;
    refreshProjectFile(project.id);
  }

  return {
    automations: {
      async list() {
        return automationsList.map((a) => {
          const scope = a.scope === "project" ? "project" : "private";
          // Private default enabled=true; project writer keeps stored enabled
          // (add sets true). Untrusted / teammate file-only defaults false.
          const trusted =
            scope !== "project" ||
            trustByProject[a.projectId] === currentHash(a.projectId);
          return {
            ...a,
            scope,
            enabled: scope === "private" ? a.enabled : trusted && a.enabled,
          };
        });
      },
      async add(input: AutomationWrite) {
        const fields = normalizeDevAutomation(input, ctx.projects, null);
        destination(fields);
        const project = ctx.projects.find((p) => p.id === fields.projectId);
        if (!project) throw new Error(`Unknown project: ${fields.projectId}`);
        let createdId = id("auto");
        let enabled = fields.enabled;
        if (fields.scope === "project") {
          if (project.remoteHost || !project.path) {
            throw new Error("Project-scope automations require a local checkout");
          }
          if (input.id != null && input.id !== "" && !SLUG_RE.test(String(input.id))) {
            throw new Error(`Automation id must be a slug matching ${SLUG_RE}`);
          }
          const taken = sharedRows(project.id).map((a) => a.id.slice(a.id.lastIndexOf(":") + 1));
          const slug =
            input.id != null && input.id !== ""
              ? String(input.id)
              : slugFromName(fields.name, taken);
          if (taken.includes(slug)) {
            throw new Error(`Duplicate automation id "${slug}"`);
          }
          createdId = `shared:${project.id}:${slug}`;
          enabled = input.enabled !== false;
        } else if (input.id != null && String(input.id).startsWith("shared:")) {
          throw new Error("Private automation id cannot start with shared:");
        }
        const created: AutomationInfo = {
          id: createdId,
          ...fields,
          enabled,
          stageSince: now(),
          lastRunAt: null,
          nextRunAt: nextAutomationFire(fields.preset, fields.hour, now(), fields.cron),
          lastError: null,
        };
        automationsList = [...automationsList, created];
        if (created.scope === "project") {
          persistTrust(project, currentHash(project.id));
        }
        return { ...created };
      },
      async update(input: Partial<AutomationWrite> & { id: string }) {
        const existing = automationsList.find((a) => a.id === input.id);
        if (!existing) {
          throw new Error(`Unknown automation: ${input.id}`);
        }
        const fields = normalizeDevAutomation(input, ctx.projects, existing);
        if (fields.enabled) destination(fields);
        const scheduleChanged =
          fields.preset !== existing.preset ||
          fields.hour !== existing.hour ||
          fields.cron !== existing.cron;
        const updated: AutomationInfo = {
          ...existing,
          ...fields,
          ...(fields.stage !== existing.stage ? { stageSince: now() } : {}),
          nextRunAt: scheduleChanged
            ? nextAutomationFire(fields.preset, fields.hour, now(), fields.cron)
            : existing.nextRunAt,
        };
        if (!fields.cron) delete updated.cron;
        automationsList = automationsList.map((a) =>
          a.id === existing.id ? updated : a,
        );
        if (updated.scope === "project") {
          const project = ctx.projects.find((p) => p.id === updated.projectId);
          if (project) persistTrust(project, currentHash(project.id));
        }
        return { ...updated };
      },
      async remove(input) {
        const existing = automationsList.find((a) => a.id === input.id);
        if (!existing) {
          throw new Error(`Unknown automation: ${input.id}`);
        }
        automationsList = automationsList.filter((a) => a.id !== input.id);
        if (existing.scope === "project") refreshProjectFile(existing.projectId);
      },
      async trustFile(input: { projectId: string; hash: string }) {
        const projectId = String(input.projectId || "");
        const hash = String(input.hash || "");
        const project = ctx.projects.find((p) => p.id === projectId);
        if (!project) throw new Error(`Unknown project: ${projectId}`);
        const rows = sharedRows(projectId);
        if (rows.length === 0) throw new Error("No automations in solenta.json");
        const current = project.automationsFile?.hash ?? currentHash(projectId);
        if (hash !== current) throw new Error("Automations file hash does not match");
        persistTrust(project, hash);
      },
      async runNow(input) {
        const existing = automationsList.find((a) => a.id === input.id);
        if (!existing) {
          throw new Error(`Unknown automation: ${input.id}`);
        }
        if (existing.scope === "project") {
          const project = ctx.projects.find((p) => p.id === existing.projectId);
          const file = project?.automationsFile;
          if (!file || !file.trusted) {
            if (!input.hash || input.hash !== file?.hash) {
              throw new Error("Automations file is not trusted");
            }
            if (project) persistTrust(project, input.hash);
          }
        }
        const key = existing.sessionMode && existing.sessionMode !== "new-thread" ? `thread:${existing.destinationThreadId}` : existing.id;
        if (firing.has(key)) throw new Error("Automation destination is already starting a run");
        firing.add(key);
        const firedAt = now();
        const nextRunAt = nextAutomationFire(
          existing.preset,
          existing.hour,
          firedAt,
          existing.cron,
        );
        try {
          const target = destination(existing, true);
          const prior = (fixedRuns.get(existing.id) || []).map((r) => r.pending ? { ...r, pending: false, status: ctx.threads.find((t) => t.id === r.threadId)?.status || r.status } : r);
          const thread = target || await ctx.api().threads.create({
            projectId: existing.projectId,
            title: existing.name,
          });
          if (!target) automationIdByThread.set(thread.id, existing.id);
          if (!target) await ctx.api().threads.setProvider({
            threadId: thread.id,
            provider: existing.provider,
            model: existing.model,
          });
          ctx.assertUnderBudget();
          if (target && existing.sessionMode === "fresh") await ctx.api().threads.freshAgentContext({ threadId: target.id });
          const launch = await ctx.api().runs.start({
            threadId: thread.id,
            prompt: existing.prompt,
          });
          if (target) fixedRuns.set(existing.id, [{ id: id("fire"), runId: launch.runId, threadId: target.id, startedAt: firedAt, status: "working" as const, pending: true }, ...prior].slice(0, 20));
          const updated: AutomationInfo = {
            ...existing,
            lastRunAt: firedAt,
            nextRunAt,
            lastError: null,
          };
          automationsList = automationsList.map((a) =>
            a.id === existing.id ? updated : a,
          );
          return { ...updated };
        } catch (err) {
          const updated: AutomationInfo = {
            ...existing,
            lastRunAt: firedAt,
            nextRunAt,
            lastError: err instanceof Error ? err.message : String(err),
          };
          automationsList = automationsList.map((a) =>
            a.id === existing.id ? updated : a,
          );
          throw err;
        } finally { firing.delete(key); }
      },
      async listRuns(input: { id: string }): Promise<AutomationRunsResult> {
        const existing = automationsList.find((a) => a.id === input.id);
        if (!existing) {
          throw new Error(`Unknown automation: ${input.id}`);
        }
        const fixed = fixedRuns.get(existing.id);
        if (fixed) return { automationId: existing.id, runs: fixed, retentionLimitReached: fixed.length >= 20 };
        const indexed = ctx.threads
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => automationIdByThread.get(t.id) === existing.id);
        indexed.sort((a, b) => b.t.createdAt - a.t.createdAt || b.i - a.i);
        const runs = indexed.map(({ t }) => ({
          threadId: t.id,
          startedAt: t.createdAt,
          status: t.status,
        }));
        return {
          automationId: existing.id,
          runs,
          retentionLimitReached: runs.length >= 20,
        };
      },
    },
  };
}
