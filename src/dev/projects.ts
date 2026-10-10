/** Projects and spaces for the browser-dev fixture. */
import type {
  CloneProgressPush,
  CoderApi,
  AgentConfigDoctorReport,
  AgentConfigPreview,
  AgentConfigWriteResult,
  ProjectCodeMap,
  ProjectInfo,
  RecentRepoGroup,
  SpaceInfo,
} from "../shared/ipc";
import type { DevCtx } from "./context.ts";
import { id } from "./util.ts";

/** "clone:progress" subscribers for the browser-dev mock (#1506). */
export const devCloneProgress = new Set<(push: CloneProgressPush) => void>();
const devCloneCancels = new Map<string, () => void>();

export function createProjects(ctx: DevCtx): Pick<CoderApi, "projects" | "spaces"> {
  const { details, runStates, clearedDiff, emitThreads, clearRunTimer } = ctx;
  let spaces: SpaceInfo[] = [];

  return {
    projects: {
      async list() {
        return ctx.projects.map((p) => ({ ...p }));
      },
      async add(path: string, opts?: { remoteHost?: string; remotePath?: string }) {
        const remoteHost = opts?.remoteHost?.trim() || "";
        const remotePath = opts?.remotePath?.trim() || "";
        if (remoteHost) {
          if (!remotePath) {
            throw new Error("Remote path is required when remote host is set");
          }
          if (!remotePath.startsWith("/")) {
            throw new Error("Remote path must be an absolute path (start with /)");
          }
          const folder =
            remotePath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ||
            "remote";
          const project: ProjectInfo = {
            id: id("proj"),
            slug: folder,
            name: folder,
            path: path || remotePath,
            remoteHost,
            remotePath,
          };
          ctx.projects.push(project);
          return { ...project };
        }
        if (/not-a-git|nongit/i.test(path)) {
          throw new Error("Not a git repository...");
        }
        const slug =
          path
            .replace(/\\/g, "/")
            .split("/")
            .filter(Boolean)
            .slice(-2)
            .join("/") || "local/project";
        const project: ProjectInfo = {
          id: id("proj"),
          slug,
          name: slug.includes("/") ? (slug.split("/").pop() ?? slug) : slug,
          path,
        };
        ctx.projects.push(project);
        return { ...project };
      },
      async addViaDialog() {
        const n = ctx.projects.length + 1;
        return ctx.api().projects.add(`/Users/demo/demo-org/project-${n}`);
      },
      async create(input: { name: string; parentDir: string }) {
        const name = input.name.trim();
        const parentDir = input.parentDir.trim().replace(/\/+$/, "");
        if (!name) throw new Error("Project name is required");
        if (name === "." || name === ".." || /[/\\\0]/.test(name)) {
          throw new Error("Project name must be a plain folder name (no slashes)");
        }
        if (!parentDir) throw new Error("Location is required");
        const project: ProjectInfo = {
          id: id("proj"),
          slug: name,
          name,
          path: `${parentDir}/${name}`,
        };
        ctx.projects.push(project);
        return { ...project };
      },
      /** Fake clone: a few progress lines over ~3s, cancellable. */
      async clone(input) {
        const url = String(input.url ?? "").trim();
        if (!/^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(url)) {
          throw new Error(
            "Use an https:// or ssh URL (for example git@github.com:owner/repo.git)",
          );
        }
        const parentDir = String(input.parentDir ?? "").trim().replace(/\/+$/, "");
        if (!parentDir) throw new Error("Location is required");
        const name =
          input.name?.trim() ||
          url.replace(/\/+$/, "").split(/[/:]/).pop()?.replace(/\.git$/, "") ||
          "repo";
        const cloneId = input.cloneId ?? "";
        const lines = [
          `Cloning into '${parentDir}/${name}'...`,
          "Receiving objects:  38% (412/1084), 2.1 MiB | 4.2 MiB/s",
          "Receiving objects: 100% (1084/1084), 5.6 MiB | 4.4 MiB/s, done.",
          "Resolving deltas: 100% (702/702), done.",
        ];
        await new Promise<void>((resolve, reject) => {
          let i = 0;
          const timer = setInterval(() => {
            for (const fn of devCloneProgress) fn({ cloneId, line: lines[i] });
            i += 1;
            if (i >= lines.length) {
              clearInterval(timer);
              devCloneCancels.delete(cloneId);
              resolve();
            }
          }, 750);
          devCloneCancels.set(cloneId, () => {
            clearInterval(timer);
            reject(new Error("Clone cancelled"));
          });
        });
        return ctx.api().projects.add(`${parentDir}/${name}`);
      },
      async cancelClone(input) {
        devCloneCancels.get(input.cloneId)?.();
        devCloneCancels.delete(input.cloneId);
      },
      async discoverRecent(): Promise<RecentRepoGroup[]> {
        const hour = 3_600_000;
        const now = Date.now();
        const all: RecentRepoGroup[] = [
          {
            remote: "acme/storefront",
            repos: [
              { path: "/Users/demo/code/storefront", name: "storefront", lastActiveAt: now - 2 * hour, providers: ["claude", "codex"], preselected: true },
              { path: "/Users/demo/scratch/storefront-old", name: "storefront-old", lastActiveAt: now - 400 * hour, providers: ["claude"], preselected: false },
            ],
          },
          {
            remote: "acme/billing-api",
            repos: [
              { path: "/Users/demo/code/billing-api", name: "billing-api", lastActiveAt: now - 26 * hour, providers: ["codex"], preselected: true },
            ],
          },
          {
            remote: null,
            repos: [
              { path: "/Users/demo/notes-site", name: "notes-site", lastActiveAt: now - 90 * hour, providers: ["grok"], preselected: true },
            ],
          },
          {
            remote: "acme/infra",
            repos: [
              { path: "/Users/demo/code/infra", name: "infra", lastActiveAt: now - 600 * hour, providers: ["claude", "opencode"], preselected: false },
            ],
          },
        ];
        const added = new Set(ctx.projects.map((p) => p.path));
        return all
          .map((g) => ({ ...g, repos: g.repos.filter((r) => !added.has(r.path)) }))
          .filter((g) => g.repos.length > 0);
      },
      async ensureScratch() {
        const found = ctx.projects.find((p) => p.scratch === true);
        if (found) return { ...found };
        const project: ProjectInfo = {
          id: id("proj"),
          slug: "Scratch",
          name: "Scratch",
          path: "/Users/demo/Library/Application Support/Solenta/scratch",
          scratch: true,
        };
        ctx.projects.push(project);
        return { ...project };
      },
      async pickDirectory() {
        // No native dialog in the browser dev mock; cancel like the real one.
        return null;
      },
      async pickIcon() {
        return null;
      },
      async resolveIcon(input: {
        projectId: string;
        iconPath?: string | null;
      }) {
        const project = ctx.projects.find((p) => p.id === input.projectId);
        if (!project) throw new Error(`Unknown project: ${input.projectId}`);
        const override =
          input.iconPath === undefined ? project.iconPath : input.iconPath;
        return {
          iconUrl:
            override === null ? null : project.iconUrl ?? null,
        };
      },
      /** Empty host clears the remote fields. */
      async update(input: {
        projectId: string;
        name?: string;
        remoteHost?: string;
        remotePath?: string;
        spaceId?: string;
        iconPath?: string | null;
        setupCommand?: string | null;
        quickActions?: ProjectInfo["quickActions"];
        env?: ProjectInfo["env"] | null;
        threadDefaults?: ProjectInfo["threadDefaults"] | null;
        waitForSetup?: boolean | null;
        branchPrefix?: string | null;
      }) {
        const project = ctx.projects.find((p) => p.id === input.projectId);
        if (!project) {
          throw new Error(`Unknown project: ${input.projectId}`);
        }
        if (typeof input.name === "string") {
          const name = input.name.trim();
          if (!name) throw new Error("Name cannot be empty");
          project.name = name;
        }
        if (typeof input.spaceId === "string") {
          const spaceId = input.spaceId.trim();
          if (spaceId && !spaces.some((s) => s.id === spaceId)) {
            throw new Error(`Unknown space: ${spaceId}`);
          }
          if (spaceId) project.spaceId = spaceId;
          else delete project.spaceId;
        }
        if (
          typeof input.remoteHost === "string" ||
          typeof input.remotePath === "string"
        ) {
          const host = (input.remoteHost ?? "").trim();
          const rpath = (input.remotePath ?? "").trim();
          if (host) {
            if (!rpath) {
              throw new Error("Remote path is required when remote host is set");
            }
            if (!rpath.startsWith("/")) {
              throw new Error(
                "Remote path must be an absolute path (start with /)",
              );
            }
            project.remoteHost = host;
            project.remotePath = rpath;
          } else {
            delete project.remoteHost;
            delete project.remotePath;
          }
        }
        if (Object.prototype.hasOwnProperty.call(input, "iconPath")) {
          if (input.iconPath) project.iconPath = input.iconPath;
          else {
            delete project.iconPath;
            delete project.iconUrl;
          }
        }
        if (Object.prototype.hasOwnProperty.call(input, "setupCommand")) {
          const cmd =
            typeof input.setupCommand === "string"
              ? input.setupCommand.trim()
              : "";
          if (cmd) project.setupCommand = cmd;
          else delete project.setupCommand;
        }
        if (Object.prototype.hasOwnProperty.call(input, "quickActions")) {
          const rows = Array.isArray(input.quickActions)
            ? input.quickActions.filter((a) => a && a.name && a.command)
            : [];
          if (rows.length) project.quickActions = rows;
          else delete project.quickActions;
        }
        if (Object.prototype.hasOwnProperty.call(input, "env")) {
          if (input.env && Object.keys(input.env).length) {
            project.env = { ...input.env };
          } else delete project.env;
        }
        if (Object.prototype.hasOwnProperty.call(input, "threadDefaults")) {
          if (input.threadDefaults) project.threadDefaults = input.threadDefaults;
          else delete project.threadDefaults;
        }
        if (input.waitForSetup === true) project.waitForSetup = true;
        else if (input.waitForSetup === false || input.waitForSetup === null) {
          delete project.waitForSetup;
        }
        if (Object.prototype.hasOwnProperty.call(input, "branchPrefix")) {
          const prefix = input.branchPrefix?.trim() ?? "";
          if (prefix && /[\s~^:?*[\\]|\.\.|^[-/]/.test(prefix)) {
            throw new Error("Branch prefix cannot contain spaces or any of ~ ^ : ? * [ \\");
          }
          if (prefix && prefix !== "coder/") project.branchPrefix = prefix;
          else delete project.branchPrefix;
        }
        return { ...project };
      },
      /** Drops the project entry + its thread history. Repo on disk untouched. */
      async remove(input: { projectId: string }) {
        const projectId = String(input.projectId ?? "");
        if (!ctx.projects.some((p) => p.id === projectId)) {
          throw new Error(`Unknown project: ${projectId}`);
        }
        for (const t of ctx.threads.filter((t) => t.projectId === projectId)) {
          clearRunTimer(t.id);
          runStates.delete(t.id);
          clearedDiff.delete(t.id);
          details.delete(t.id);
        }
        ctx.threads = ctx.threads.filter((t) => t.projectId !== projectId);
        ctx.projects = ctx.projects.filter((p) => p.id !== projectId);
        emitThreads();
      },
      async codeMap(input: { projectId: string }): Promise<ProjectCodeMap> {
        const project = ctx.projects.find((p) => p.id === input.projectId);
        if (!project) throw new Error(`Unknown project: ${input.projectId}`);
        return {
          projectId: project.id,
          updatedAt: Date.now() - 5 * 60_000,
          fileCount: 42,
          symbolCount: 180,
          headSha: "abc1234deadbeef",
          defaultBranch: "main",
          modules: [
            {
              name: "src",
              fileCount: 20,
              symbolCount: 90,
              hot: [
                { path: "src/App.tsx", symbols: ["App"], rank: 12 },
                { path: "src/useCoder.ts", symbols: ["useCoder"], rank: 10 },
              ],
            },
            {
              name: "electron",
              fileCount: 22,
              symbolCount: 90,
              hot: [
                { path: "electron/runner.js", symbols: ["createRunner"], rank: 20 },
              ],
            },
          ],
          dependencies: ["react", "electron"],
        };
      },
      async lintAgentConfig(input: {
        projectId: string;
      }): Promise<AgentConfigDoctorReport> {
        const project = ctx.projects.find((p) => p.id === input.projectId);
        if (!project) throw new Error(`Unknown project: ${input.projectId}`);
        const considered = ctx.memoryEntries.filter(
          (e) =>
            e.type === "convention" ||
            e.type === "strategy" ||
            e.type === "knowledge",
        );
        return {
          projectId: project.id,
          files: [],
          score: 0,
          grade: "F",
          memory: {
            considered: considered.length,
            covered: 0,
            missing: considered.map((e) => ({
              id: e.id,
              type: e.type,
              title: e.title,
            })),
          },
          issues: [
            {
              severity: "error",
              message: "No AGENTS.md / CLAUDE.md (or sibling) in this repo",
            },
          ],
          recommendations: [
            "Generate AGENTS.md from shared memory so every agent reads the same conventions",
          ],
        };
      },
      async previewAgentConfig(input: {
        projectId: string;
        targets?: string[];
      }): Promise<AgentConfigPreview> {
        const project = ctx.projects.find((p) => p.id === input.projectId);
        if (!project) throw new Error(`Unknown project: ${input.projectId}`);
        const lines = [
          `# ${project.name}`,
          "",
          "Standing instructions generated from Solenta shared memory.",
          "",
          "<!-- generated-by: solenta-config-doctor -->",
          "",
        ];
        for (const e of ctx.memoryEntries) {
          if (e.type !== "convention" && e.type !== "strategy") continue;
          lines.push(`### ${e.title}`, "", e.body, "");
        }
        const targets = input.targets?.length ? input.targets : ["AGENTS.md"];
        return {
          projectId: project.id,
          files: targets.map((p) => ({
            path: p,
            content: lines.join("\n"),
            exists: false,
          })),
        };
      },
      async writeAgentConfig(): Promise<AgentConfigWriteResult> {
        throw new Error("Config doctor writes are not available in browser dev");
      },
    },
    spaces: {
      async list() {
        return spaces.map((s) => ({ ...s }));
      },
      async add(input: { name: string }) {
        const name = String(input?.name ?? "").trim();
        if (!name) throw new Error("Name cannot be empty");
        const created = { id: id("space"), name };
        spaces.push(created);
        return { ...created };
      },
      async update(input: { id: string; name: string }) {
        const found = spaces.find((s) => s.id === input.id);
        if (!found) throw new Error(`Unknown space: ${input.id}`);
        const name = String(input?.name ?? "").trim();
        if (!name) throw new Error("Name cannot be empty");
        found.name = name;
        return { ...found };
      },
      async remove(input: { id: string }) {
        const spaceId = String(input?.id ?? "");
        if (!spaces.some((s) => s.id === spaceId)) {
          throw new Error(`Unknown space: ${spaceId}`);
        }
        spaces = spaces.filter((s) => s.id !== spaceId);
        for (const p of ctx.projects) {
          if (p.spaceId === spaceId) delete p.spaceId;
        }
      },
    },
  };
}
