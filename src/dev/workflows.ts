/** Workflow templates for the browser-dev fixture. */
import type {
  CoderApi,
  WorkflowPhaseSpec,
  WorkflowTemplateInfo,
} from "../shared/ipc";
import type { DevCtx } from "./context.ts";
import { id } from "./util.ts";

/** Builtin Standard template (id "standard"). Seeded into every dev session. */
export const STANDARD_TEMPLATE: WorkflowTemplateInfo = {
  id: "standard",
  name: "Standard",
  builtin: true,
  phases: [
    {
      name: "seed",
      agentCount: 1,
      instruction: "Plan context from the prompt",
      provider: "claude",
      model: null,
    },
    {
      name: "analyze",
      agentCount: 2,
      instruction: "Concurrent exploration",
      provider: "claude",
      model: null,
    },
    {
      name: "synthesize",
      agentCount: 1,
      instruction: "Final answer",
      provider: "claude",
      model: null,
    },
  ],
};

export type TemplateSaveInput = Omit<WorkflowTemplateInfo, "id" | "builtin"> & {
  id?: string;
};

export function cloneTemplate(t: WorkflowTemplateInfo): WorkflowTemplateInfo {
  return {
    id: t.id,
    name: t.name,
    builtin: t.builtin,
    phases: t.phases.map((p) => ({ ...p })),
  };
}

/** Shape-only. electron/services.js validateWorkflowTemplate owns the rules. */
export function normalizeTemplate(input: TemplateSaveInput): {
  name: string;
  phases: WorkflowPhaseSpec[];
} {
  return {
    name: String(input.name ?? "").trim() || "Untitled",
    phases: (input.phases ?? []).map((p) => ({
      name: String(p?.name ?? "").trim() || "Phase",
      agentCount: Number(p?.agentCount) || 1,
      instruction: String(p?.instruction ?? "").trim(),
      provider: String(p?.provider ?? "claude"),
      model: p?.model || null,
    })),
  };
}

export function createWorkflows(ctx: DevCtx): Pick<CoderApi, "workflows"> {
  return {
    workflows: {
      async list() {
        return ctx.templates.map(cloneTemplate);
      },
      async save(input) {
        const cleaned = normalizeTemplate(input);
        const existing =
          input.id != null
            ? ctx.templates.find((t) => t.id === input.id)
            : undefined;

        // Saving a builtin always creates a copy (never mutates the builtin).
        // Name: append " (copy)" when the submitted name equals the builtin name
        if (existing?.builtin) {
          const renamed =
            cleaned.name.length > 0 &&
            cleaned.name !== String(existing.name || "");
          const copy: WorkflowTemplateInfo = {
            id: id("wf-tpl"),
            name: renamed ? cleaned.name : `${existing.name} (copy)`,
            builtin: false,
            phases: cleaned.phases,
          };
          ctx.templates = [...ctx.templates, copy];
          return cloneTemplate(copy);
        }

        if (existing) {
          const updated: WorkflowTemplateInfo = {
            id: existing.id,
            name: cleaned.name,
            builtin: false,
            phases: cleaned.phases,
          };
          ctx.templates = ctx.templates.map((t) =>
            t.id === existing.id ? updated : t,
          );
          return cloneTemplate(updated);
        }

        const created: WorkflowTemplateInfo = {
          id: input.id && input.id.trim() ? input.id.trim() : id("wf-tpl"),
          name: cleaned.name,
          builtin: false,
          phases: cleaned.phases,
        };
        // Guard: never allow overwriting standard via a fresh create with that id.
        if (created.id === "standard" || ctx.templates.some((t) => t.id === created.id)) {
          created.id = id("wf-tpl");
        }
        ctx.templates = [...ctx.templates, created];
        return cloneTemplate(created);
      },
      async remove(input) {
        const tid = String(input.id);
        const existing = ctx.templates.find((t) => t.id === tid);
        if (!existing) {
          throw new Error(`Unknown template: ${tid}`);
        }
        if (existing.builtin) {
          throw new Error(`Cannot remove builtin template: ${tid}`);
        }
        ctx.templates = ctx.templates.filter((t) => t.id !== tid);
      },
    },
  };
}
