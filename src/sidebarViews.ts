/**
 * Named sidebar filter views (#939).
 *
 * Local preference only: persist criteria + optional query, never a snapshot
 * of thread ids or message text. Callers AND these onto the live list via
 * existing filterThreads / search.
 */
import {
  parseGroupBy,
  parseStatusFilter,
  type GroupBy,
  type StatusFilter,
  type ThreadFilter,
} from "./sidebarFilters";

export const SAVED_VIEWS_KEY = "sidebar:savedViews";
export const ACTIVE_SAVED_VIEW_KEY = "sidebar:activeSavedView";

export const SAVED_VIEWS_CAP = 40;
export const SAVED_VIEW_NAME_MAX = 48;

export interface SavedViewCriteria {
  status: StatusFilter | null;
  /** Empty = all providers. */
  providers: string[];
  /** Null = all projects. */
  projectId: string | null;
  /** Null = all tags. */
  tag: string | null;
  /** Optional search query. Empty = no search. */
  query: string;
  groupBy: GroupBy;
}

export interface SavedView {
  id: string;
  name: string;
  criteria: SavedViewCriteria;
  createdAt: number;
  updatedAt: number;
}

export type SavedViewUnavailable = {
  kind: "project" | "tag" | "provider";
  message: string;
};

export function normalizeViewName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.slice(0, SAVED_VIEW_NAME_MAX);
}

function cloneProviders(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function cloneCriteria(c: SavedViewCriteria): SavedViewCriteria {
  return {
    status: c.status,
    providers: cloneProviders(c.providers),
    projectId: c.projectId,
    tag: c.tag,
    query: c.query.trim(),
    groupBy: c.groupBy,
  };
}

export function criteriaToFilter(c: SavedViewCriteria): ThreadFilter {
  return {
    status: c.status,
    providers: c.providers,
    projectId: c.projectId,
    tag: c.tag,
  };
}

export function criteriaEqual(
  a: SavedViewCriteria,
  b: SavedViewCriteria,
): boolean {
  if (a.status !== b.status) return false;
  if (a.projectId !== b.projectId) return false;
  if (a.tag !== b.tag) return false;
  if (a.groupBy !== b.groupBy) return false;
  if (a.query.trim() !== b.query.trim()) return false;
  if (a.providers.length !== b.providers.length) return false;
  const set = new Set(a.providers);
  for (const id of b.providers) {
    if (!set.has(id)) return false;
  }
  return true;
}

function newViewId(now: number): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10);
  return `v${now.toString(36)}-${rand}`;
}

export function addSavedView(
  views: readonly SavedView[],
  input: {
    name: string;
    criteria: SavedViewCriteria;
    now?: number;
    id?: string;
  },
): SavedView[] {
  const name = normalizeViewName(input.name);
  if (!name) return views.slice();
  const now = input.now ?? Date.now();
  const view: SavedView = {
    id: input.id ?? newViewId(now),
    name,
    criteria: cloneCriteria(input.criteria),
    createdAt: now,
    updatedAt: now,
  };
  return [view, ...views.filter((v) => v.id !== view.id)].slice(
    0,
    SAVED_VIEWS_CAP,
  );
}

export function renameSavedView(
  views: readonly SavedView[],
  id: string,
  name: string,
): SavedView[] {
  const nextName = normalizeViewName(name);
  if (!nextName) return views.slice();
  return views.map((v) => (v.id === id ? { ...v, name: nextName } : v));
}

export function updateSavedView(
  views: readonly SavedView[],
  id: string,
  criteria: SavedViewCriteria,
  now = Date.now(),
): SavedView[] {
  return views.map((v) =>
    v.id === id
      ? { ...v, criteria: cloneCriteria(criteria), updatedAt: now }
      : v,
  );
}

export function deleteSavedView(
  views: readonly SavedView[],
  id: string,
): SavedView[] {
  return views.filter((v) => v.id !== id);
}

function parseCriteria(raw: unknown): SavedViewCriteria | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const providers = Array.isArray(c.providers)
    ? cloneProviders(c.providers.filter((p): p is string => typeof p === "string"))
    : [];
  const projectId =
    typeof c.projectId === "string" && c.projectId
      ? c.projectId
      : null;
  const tag = typeof c.tag === "string" && c.tag ? c.tag : null;
  const query = typeof c.query === "string" ? c.query : "";
  return {
    status: parseStatusFilter(typeof c.status === "string" ? c.status : null),
    providers,
    projectId,
    tag,
    query,
    groupBy: parseGroupBy(typeof c.groupBy === "string" ? c.groupBy : null),
  };
}

function parseSavedView(row: unknown): SavedView | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  const name = typeof r.name === "string" ? normalizeViewName(r.name) : "";
  if (!name) return null;
  const parsed = parseCriteria(r.criteria);
  if (!parsed) return null;
  const createdAt = typeof r.createdAt === "number" ? r.createdAt : 0;
  const updatedAt = typeof r.updatedAt === "number" ? r.updatedAt : createdAt;
  return {
    id: r.id,
    name,
    criteria: parsed,
    createdAt,
    updatedAt,
  };
}

export function parseSavedViews(raw: string | null): SavedView[] {
  if (raw == null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SavedView[] = [];
    const seen = new Set<string>();
    for (const row of parsed) {
      const view = parseSavedView(row);
      if (!view || seen.has(view.id)) continue;
      seen.add(view.id);
      out.push(view);
    }
    return out.slice(0, SAVED_VIEWS_CAP);
  } catch {
    return [];
  }
}

export function serializeSavedViews(views: readonly SavedView[]): string {
  return JSON.stringify(
    views.slice(0, SAVED_VIEWS_CAP).map((v) => ({
      id: v.id,
      name: v.name,
      criteria: cloneCriteria(v.criteria),
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    })),
  );
}

export function parseActiveSavedViewId(
  raw: string | null,
  views: readonly SavedView[],
): string | null {
  if (raw == null || raw === "") return null;
  return views.some((v) => v.id === raw) ? raw : null;
}

export function savedViewTriggerLabel(
  view: { name: string } | null,
  modified: boolean,
): string {
  if (!view) return "Saved views";
  return modified ? `${view.name} ·` : view.name;
}

export function savedViewUnavailable(
  c: SavedViewCriteria,
  ctx: {
    projectIds: ReadonlySet<string>;
    tags: readonly string[];
    providerIds: ReadonlySet<string>;
  },
): SavedViewUnavailable | null {
  if (c.projectId != null && !ctx.projectIds.has(c.projectId)) {
    return {
      kind: "project",
      message: "This view's project is no longer available",
    };
  }
  if (c.tag != null && !ctx.tags.includes(c.tag)) {
    return {
      kind: "tag",
      message: "This view's tag is no longer used",
    };
  }
  if (c.providers.length > 0) {
    for (const id of c.providers) {
      if (!ctx.providerIds.has(id)) {
        return {
          kind: "provider",
          message: "This view's provider is no longer available",
        };
      }
    }
  }
  return null;
}
