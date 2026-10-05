/** Shared-memory stub for the browser-dev fixture (Memory tab). */
import type {
  CoderApi,
  MemoryEntryInfo,
  MemoryMaintenanceReport,
  MemoryReviewResolution,
} from "../shared/ipc";
import type { DevCtx } from "./context.ts";
import { toIso, now, id } from "./util.ts";

export const MEMORY_EXCERPT_LEN = 160;
export const MEMORY_NOT_FOUND = "Memory entry not found";

/** Full in-memory store rows; list/search return excerpts. */
export interface MemoryRow {
  id: string;
  type: MemoryEntryInfo["type"];
  title: string;
  body: string;
  project: string | null;
  importance: number;
  createdAt: string;
  updatedAt: string;
  citations?: MemoryEntryInfo["citations"];
  agent?: string;
}

export function excerptBody(body: string): string {
  if (body.length <= MEMORY_EXCERPT_LEN) return body;
  return `${body.slice(0, MEMORY_EXCERPT_LEN - 1)}…`;
}

export function toListEntry(row: MemoryRow): MemoryEntryInfo {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: excerptBody(row.body),
    project: row.project,
    importance: row.importance,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    citations: row.citations,
    agent: row.agent ?? null,
  };
}

export function toFullEntry(row: MemoryRow): MemoryEntryInfo {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    project: row.project,
    importance: row.importance,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    citations: row.citations,
    agent: row.agent ?? null,
  };
}

// Memory rows are scoped by the project PATH the Memory tab sends, so the demo
// entries have to carry the demo project paths, not slugs.
export const DEMO_NEBULA = "/Users/demo/acme/nebula";
export const DEMO_LEDGER = "/Users/demo/acme/ledger";

export function seedMemoryEntries(t0: number): MemoryRow[] {
  const hours = (h: number) => toIso(t0 - h * 60 * 60 * 1000);
  return [
    {
      id: "mem-seed-1",
      type: "strategy",
      title: "Rewriting auth was ruled out. Cookie sessions stay",
      body: "Thread 1 costed a move to token auth and dropped it. Refresh lives in src/lib/auth.ts and the 401 retry in src/lib/api.ts. Do not re-open the rewrite without new evidence.",
      project: DEMO_NEBULA,
      agent: "codex",
      importance: 5,
      createdAt: hours(48),
      updatedAt: hours(6),
    },
    {
      id: "mem-seed-2",
      type: "knowledge",
      title: "Per-device overrides read from the settings store, not the env",
      body: "src/settings/store.ts is the single source for per-device overrides. The env reader was a migration shim and is gone. Anything reading process.env for a device key is stale.",
      project: DEMO_NEBULA,
      agent: "grok",
      importance: 4,
      createdAt: hours(36),
      updatedAt: hours(12),
    },
    {
      id: "mem-seed-3",
      type: "knowledge",
      title: "Windows worktree paths need the UNC form",
      body: "A WSL path handed to git on the Windows side resolves relative to the wrong root. Convert to \\\\wsl$\\ before spawning. Found while fixing #839.",
      project: DEMO_NEBULA,
      importance: 4,
      createdAt: hours(72),
      updatedAt: hours(24),
    },
    {
      id: "mem-seed-4",
      type: "convention",
      title: "Every state write after an await re-checks the thread id",
      body: "Applying a result to state after an await must confirm the selected thread still matches the id captured before the call, or a slow response lands in the wrong thread.",
      project: null,
      importance: 5,
      createdAt: hours(20),
      updatedAt: hours(2),
    },
    {
      id: "mem-seed-5",
      type: "strategy",
      title: "Dirty merge: stash by path, merge, pop",
      body: "When merging a worktree into a dirty checkout, do not commit the WIP. Stash by path, merge, then pop. Untracked files trip the dirty guard too.",
      project: null,
      importance: 4,
      createdAt: hours(8),
      updatedAt: hours(3),
    },
    {
      id: "mem-seed-6",
      type: "knowledge",
      title: "The CSP change belongs in the preload, not the page",
      body: "Meta-tag CSP is ignored once the response header is set. Ship the policy from the main process response header and keep the preload surface typed.",
      project: DEMO_LEDGER,
      importance: 3,
      createdAt: hours(10),
      updatedAt: hours(8),
    },
    {
      id: "mem-seed-7",
      type: "task",
      title: "Backfill the migration test before the schema lands",
      body: "The key-schema patch needs a fixture that runs the old rows through the migration. Blocked until the store move in #842 merges.",
      project: DEMO_NEBULA,
      agent: "claude",
      importance: 3,
      createdAt: hours(4),
      updatedAt: hours(1),
    },
  ];
}

export function createMemory(ctx: DevCtx): Pick<CoderApi, "memory"> {
  return {
    memory: {
      async search(input: {
        query: string;
        project?: string;
        type?: MemoryEntryInfo["type"];
      }): Promise<MemoryEntryInfo[]> {
        const q = input.query.trim().toLowerCase();
        if (!q) return [];
        let rows = ctx.memoryEntries.filter((row) => {
          const hay = `${row.title}\n${row.body}`.toLowerCase();
          return hay.includes(q);
        });
        if (input.project != null && input.project !== "") {
          rows = rows.filter((row) => row.project === input.project);
        }
        if (input.type) {
          rows = rows.filter((row) => row.type === input.type);
        }
        rows = [...rows].sort((a, b) =>
          a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
        );
        return rows.map(toListEntry);
      },
      async recent(input?: {
        limit?: number;
        offset?: number;
        project?: string;
        type?: MemoryEntryInfo["type"];
      }): Promise<MemoryEntryInfo[]> {
        const limit =
          input?.limit != null && input.limit > 0 ? Math.floor(input.limit) : 20;
        const offset =
          input?.offset != null && input.offset > 0 ? Math.floor(input.offset) : 0;
        let rows = [...ctx.memoryEntries];
        if (input?.project != null && input.project !== "") {
          rows = rows.filter((row) => row.project === input.project);
        }
        if (input?.type) {
          rows = rows.filter((row) => row.type === input.type);
        }
        rows = rows.sort((a, b) =>
          a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
        );
        return rows.slice(offset, offset + limit).map(toListEntry);
      },
      async get(input: { id: string }): Promise<MemoryEntryInfo> {
        const row = ctx.memoryEntries.find((e) => e.id === input.id);
        if (!row) throw new Error(MEMORY_NOT_FOUND);
        return toFullEntry(row);
      },
      async store(input: {
        type: MemoryEntryInfo["type"];
        title: string;
        body: string;
        project?: string;
        citations?: MemoryEntryInfo["citations"];
      }): Promise<{ id: string }> {
        const title = input.title.trim();
        const body = input.body.trim();
        if (!title) throw new Error("Title is required");
        if (!body) throw new Error("Body is required");
        const ts = toIso(now());
        const entry: MemoryRow = {
          id: id("mem"),
          type: input.type,
          title,
          body,
          project:
            input.project != null && input.project !== ""
              ? input.project
              : null,
          importance:
            input.type === "convention"
              ? 5
              : input.type === "strategy"
                ? 4
                : input.type === "run"
                  ? 1
                  : 3,
          createdAt: ts,
          updatedAt: ts,
          citations: input.citations,
        };
        ctx.memoryEntries = [entry, ...ctx.memoryEntries];
        return { id: entry.id };
      },
      async update(input: {
        id: string;
        title: string;
        body: string;
      }): Promise<{ id: string }> {
        const title = input.title.trim();
        const body = input.body.trim();
        if (!title) throw new Error("Title is required");
        if (!body) throw new Error("Body is required");
        const old = ctx.memoryEntries.find((e) => e.id === input.id);
        if (!old) throw new Error(`no entry with id ${input.id}`);
        const ts = toIso(now());
        const successor: MemoryRow = {
          ...old,
          id: id("mem"),
          title,
          body,
          createdAt: ts,
          updatedAt: ts,
        };
        // Supersede semantics: the old row stops being served.
        ctx.memoryEntries = [
          successor,
          ...ctx.memoryEntries.filter((e) => e.id !== input.id),
        ];
        return { id: successor.id };
      },
      async remove(input: { id: string }): Promise<void> {
        const before = ctx.memoryEntries.length;
        ctx.memoryEntries = ctx.memoryEntries.filter((e) => e.id !== input.id);
        if (ctx.memoryEntries.length === before) {
          throw new Error(`no entry with id ${input.id}`);
        }
      },
      async maintenance(_input?: {
        project?: string;
      }): Promise<MemoryMaintenanceReport> {
        return {
          queue: { open: 0, oldestAgeDays: 0, items: [] },
          autoResolved: { last7Days: 0, invalidated: 0, kept: 0, byRule: {} },
          nearDupes: [],
          agingRuns: [],
          fatConventions: [],
          trust: { agents: [], suspect: [] },
        };
      },
      async resolve(input: {
        id: number;
        resolution: MemoryReviewResolution;
      }): Promise<{ ok: boolean; id: number; resolution: string }> {
        return { ok: true, id: input.id, resolution: input.resolution };
      },
    },
  };
}
