/** Scheduled automations for the browser-dev fixture. */
import type {
  AutomationInfo,
  AutomationRunsResult,
  AutomationWrite,
  CoderApi,
  ProjectInfo,
} from "../shared/ipc";
import type { DevCtx } from "./context.ts";
import { now, id } from "./util.ts";

export function nextAutomationFire(
  preset: AutomationInfo["preset"],
  hour: number | null,
  fromMs: number,
): number {
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
  if (preset !== "hourly" && preset !== "daily" && preset !== "weekly") {
    throw new Error("Invalid preset");
  }
  let hour: number | null = null;
  if (preset !== "hourly") {
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
  return { name, projectId, prompt, provider, model, preset, hour, enabled };
}

export function createAutomations(ctx: DevCtx): Pick<CoderApi, "automations"> {
  /** Scheduled agent runs. */
  let automationsList: AutomationInfo[] = [];
  const automationIdByThread = new Map<string, string>();

  return {
    automations: {
      async list() {
        return automationsList.map((a) => ({ ...a }));
      },
      async add(input: AutomationWrite) {
        const fields = normalizeDevAutomation(input, ctx.projects, null);
        const created: AutomationInfo = {
          id: id("auto"),
          ...fields,
          lastRunAt: null,
          nextRunAt: nextAutomationFire(fields.preset, fields.hour, now()),
          lastError: null,
        };
        automationsList = [...automationsList, created];
        return { ...created };
      },
      async update(input: Partial<AutomationWrite> & { id: string }) {
        const existing = automationsList.find((a) => a.id === input.id);
        if (!existing) {
          throw new Error(`Unknown automation: ${input.id}`);
        }
        const fields = normalizeDevAutomation(input, ctx.projects, existing);
        const scheduleChanged =
          fields.preset !== existing.preset || fields.hour !== existing.hour;
        const updated: AutomationInfo = {
          ...existing,
          ...fields,
          nextRunAt: scheduleChanged
            ? nextAutomationFire(fields.preset, fields.hour, now())
            : existing.nextRunAt,
        };
        automationsList = automationsList.map((a) =>
          a.id === existing.id ? updated : a,
        );
        return { ...updated };
      },
      async remove(input) {
        const existing = automationsList.find((a) => a.id === input.id);
        if (!existing) {
          throw new Error(`Unknown automation: ${input.id}`);
        }
        automationsList = automationsList.filter((a) => a.id !== input.id);
      },
      async runNow(input) {
        const existing = automationsList.find((a) => a.id === input.id);
        if (!existing) {
          throw new Error(`Unknown automation: ${input.id}`);
        }
        const firedAt = now();
        const nextRunAt = nextAutomationFire(
          existing.preset,
          existing.hour,
          firedAt,
        );
        try {
          const thread = await ctx.api().threads.create({
            projectId: existing.projectId,
            title: existing.name,
          });
          automationIdByThread.set(thread.id, existing.id);
          await ctx.api().threads.setProvider({
            threadId: thread.id,
            provider: existing.provider,
            model: existing.model,
          });
          await ctx.api().runs.start({
            threadId: thread.id,
            prompt: existing.prompt,
          });
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
        }
      },
      async listRuns(input: { id: string }): Promise<AutomationRunsResult> {
        const existing = automationsList.find((a) => a.id === input.id);
        if (!existing) {
          throw new Error(`Unknown automation: ${input.id}`);
        }
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
