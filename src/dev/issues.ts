/** Source control, issue and Planboard fixtures for the browser-dev fixture. */
import type {
  CoderApi,
  FetchIssueResult,
  ListIssuesResult,
  PlanIssue,
  PlanStatus,
  SetPlanStatusResult,
  SourceControlDiscovery,
  VibeKanbanPreview,
  VibeKanbanImportResult,
} from "../shared/ipc";
import type { DevCtx } from "./context.ts";

export function createSourceControl(): Pick<CoderApi, "sourceControl"> {
  return {
    sourceControl: {
      async discover(): Promise<SourceControlDiscovery> {
        return {
          sourceControlProviders: [
            {
              kind: "github",
              label: "GitHub",
              status: "available",
              installHint: "gh auth login",
              version: "2.97.0",
              auth: { status: "authenticated", detail: "dev" },
            },
            {
              kind: "gitlab",
              label: "GitLab",
              status: "missing",
              installHint: "brew install glab",
              version: null,
              auth: {
                status: "unauthenticated",
                detail: "GitLab CLI (glab) is not installed.",
              },
            },
            {
              kind: "bitbucket",
              label: "Bitbucket",
              status: "available",
              installHint:
                'export SOLENTA_BITBUCKET_ACCESS_TOKEN="your-access-token"',
              version: null,
              auth: {
                status: "unauthenticated",
                detail:
                  "Set SOLENTA_BITBUCKET_ACCESS_TOKEN, or SOLENTA_BITBUCKET_EMAIL plus SOLENTA_BITBUCKET_API_TOKEN.",
              },
            },
            {
              kind: "azure-devops",
              label: "Azure DevOps",
              status: "missing",
              installHint: "brew install azure-cli",
              version: null,
              auth: {
                status: "unauthenticated",
                detail: "Azure CLI (az) is not installed.",
              },
            },
          ],
          probedAt: Date.now(),
        };
      },
    },
  };
}

export function createIssues(ctx: DevCtx): Pick<CoderApi, "vibeKanban" | "issues"> {
  /** Planboard label moves made this session (issue number → plan status). */
  const demoPlanStatus = new Map<number, PlanStatus>();

  return {
    vibeKanban: {
      async preview(): Promise<VibeKanbanPreview> {
        return {
          found: false,
          dataDir: null,
          dbPath: null,
          projects: [],
          taskCount: 0,
          worktreeCount: 0,
          alreadyImported: 0,
        };
      },
      async import(): Promise<VibeKanbanImportResult> {
        return {
          dataDir: null,
          dbPath: null,
          projectsAdded: 0,
          projectsReused: 0,
          threadsCreated: 0,
          threadsSkipped: 0,
          worktreesMapped: 0,
          skipped: [],
        };
      },
      async pickDataDir() {
        return null;
      },
      async export() {
        return null;
      },
    },
    issues: {
      async fetch(input: {
        projectPath: string;
        ref: string;
      }): Promise<FetchIssueResult> {
        const raw = String(input.ref || "").trim();
        const linearUrl = raw.match(
          /^https?:\/\/(?:www\.)?linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/i,
        );
        const linearId = raw.match(/^([A-Za-z][A-Za-z0-9]*-\d+)$/);
        const linear = (linearUrl && linearUrl[1]) || (linearId && linearId[1]);
        if (linear) {
          const identifier = linear.toUpperCase();
          const num = Number(identifier.split("-")[1]);
          return {
            ok: true,
            issue: {
              number: num,
              title: `Linear ${identifier}`,
              body: `Dev stand-in for ${raw}`,
              url: `https://linear.app/acme/issue/${identifier}`,
              source: "linear",
              identifier,
            },
          };
        }
        const url = raw.match(/\/issues\/(\d+)/);
        const hashed = raw.match(/#(\d+)$/);
        const bare = /^\d+$/.test(raw) ? raw : "";
        const num = Number((url && url[1]) || (hashed && hashed[1]) || bare);
        if (!Number.isInteger(num) || num <= 0) {
          return { ok: false, reason: "invalid issue reference" };
        }
        const project = ctx.projects.find((p) => p.path === input.projectPath);
        const slug = project?.slug || "acme/demo";
        return {
          ok: true,
          issue: {
            number: num,
            title: `Issue #${num}`,
            body: `Dev stand-in for ${raw}`,
            url: `https://github.com/${slug}/issues/${num}`,
          },
        };
      },
      async setPlanStatus(input: {
        projectPath: string;
        number: number;
        status: PlanStatus;
      }): Promise<SetPlanStatusResult> {
        demoPlanStatus.set(input.number, input.status);
        return { ok: true };
      },
      async create(_input: {
        projectPath: string;
        title: string;
        body: string;
      }) {
        return {
          ok: true as const,
          number: 1234,
          url: "https://github.com/dev/fixture/issues/1234",
        };
      },
      async list(projectPath: string): Promise<ListIssuesResult> {
        const project = ctx.projects.find((p) => p.path === projectPath);
        const slug = project?.slug || "acme/demo";
        const withPlanStatus = (issues: PlanIssue[]): PlanIssue[] =>
          issues.map((issue) => {
            const moved = demoPlanStatus.get(issue.number);
            if (!moved) return issue;
            return {
              ...issue,
              labels: [
                ...issue.labels.filter((l) => !l.startsWith("plan:")),
                `plan:${moved}`,
              ],
            };
          });
        return {
          ok: true,
          issues: withPlanStatus([
            {
              number: 1,
              title: "Ship the planboard",
              url: `https://github.com/${slug}/issues/1`,
              state: "OPEN",
              labels: ["plan:doing", "roadmap"],
            },
            {
              number: 2,
              title: "Write the docs",
              url: `https://github.com/${slug}/issues/2`,
              state: "OPEN",
              labels: ["plan:todo", "task"],
            },
            {
              number: 3,
              title: "Pick the label convention",
              url: `https://github.com/${slug}/issues/3`,
              state: "CLOSED",
              labels: ["plan:done"],
            },
          ]),
        };
      },
    },
  };
}
