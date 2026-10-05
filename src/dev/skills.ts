/** Skills and harness import for the browser-dev fixture (Skills tab). */
import type {
  CoderApi,
  CliSlashCommand,
  SkillCatalogEntry,
  SkillImportPreview,
  SkillInstallRequest,
  HarnessSourceId,
  HarnessImportPreview,
  HarnessInstallRequest,
  HarnessInstallResult,
  SkillInstallResult,
  SkillPluginExtra,
  SkillPluginInstallResult,
  SkillInfo,
  SkillPreviewImportInput,
  SkillTarget,
  SkillWrite,
} from "../shared/ipc";

export function createSkills(): Pick<CoderApi, "skills" | "harness"> {
  /** Writable targets a skill fans out to (mirrors CoderApi SkillTarget). */
  const ALL_SKILL_TARGETS: SkillTarget[] = [
    "claude",
    "agents",
    "codex",
    "grok",
    "opencode",
    "kimi",
    "cursor",
    "muse",
  ];

  function skillMdBytes(name: string, description: string, body: string): number {
    const md = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
    return new TextEncoder().encode(md).length;
  }

  /** In-memory skills (Skills tab); dev twin of the on-disk SKILL.md scan. */
  let pendingSkillImport: { kind: "local" | "github" | "catalog"; catalogId?: string } | null =
    null;
  function ponytailPluginPreviewExtras(): SkillPluginExtra[] {
    return [
      {
        provider: "claude",
        label: "ponytail",
        executableFiles: [],
        activation: { kind: "claude-plugin", status: "pending" },
      },
      {
        provider: "codex",
        label: "ponytail",
        executableFiles: [],
        activation: { kind: "codex-plugin", status: "pending" },
      },
      {
        provider: "grok",
        label: "ponytail",
        executableFiles: [],
        activation: { kind: "grok-plugin", status: "pending" },
      },
      {
        provider: "plugin",
        label: "ponytail",
        executableFiles: [],
        activation: { kind: "plugin", status: "pending" },
      },
      {
        provider: "hooks",
        label: "Hooks",
        executableFiles: [
          "hooks/ponytail-statusline.sh",
          "hooks/ponytail-statusline.ps1",
        ],
        activation: { kind: "hooks", status: "pending" },
      },
      {
        provider: "commands",
        label: "Commands",
        executableFiles: [],
        activation: { kind: "commands", status: "pending" },
      },
    ];
  }

  function ponytailPluginInstallResults(
    trustPluginCode: boolean,
  ): SkillPluginInstallResult[] {
    const extras: Array<{ provider: string; label: string }> = [
      { provider: "claude", label: "ponytail" },
      { provider: "codex", label: "ponytail" },
      { provider: "grok", label: "ponytail" },
      { provider: "plugin", label: "ponytail" },
      { provider: "hooks", label: "Hooks" },
      { provider: "commands", label: "Commands" },
    ];
    if (trustPluginCode !== true) {
      return extras.map((extra) => ({ ...extra, status: "skipped" as const }));
    }
    const instructions = [
      "/plugin marketplace add DietrichGebert/ponytail",
      "/plugin install ponytail@ponytail",
    ];
    return [
      { provider: "claude", label: "ponytail", status: "manual", instructions },
      { provider: "codex", label: "ponytail", status: "activated" },
      { provider: "grok", label: "ponytail", status: "activated" },
      { provider: "plugin", label: "ponytail", status: "covered" },
      { provider: "hooks", label: "Hooks", status: "covered" },
      { provider: "commands", label: "Commands", status: "covered" },
    ];
  }

  function cannedHarnessPreview(source: HarnessSourceId): HarnessImportPreview {
    const labels = {
      claude: "Claude Code",
      cursor: "Cursor",
      codex: "Codex",
    } as const;
    return {
      previewId: "h".repeat(32),
      source: { id: source, label: labels[source] },
      skills: [
        {
          id: "skill:house-style",
          name: "house-style",
          description: "Imported house style",
          origin: "skills",
          bytes: 80,
          alreadyImported: false,
          warnings: [],
        },
      ],
      commands: source === "claude" || source === "codex"
        ? [
            {
              id: "command:user:draft",
              name: "draft",
              description: "Draft a changelog",
              origin: "user" as const,
              bytes: 40,
              alreadyImported: false,
            },
          ]
        : [],
      mcp: [],
      memories: [],
      instructions: [],
      settings: null,
      plugins: [],
      warnings: [],
    };
  }

  let pendingHarnessPreview: HarnessImportPreview | null = null;
  let skillsList: SkillInfo[] = [
    {
      name: "review-pr",
      description: "Review a pull request end to end",
      source: "claude",
      installedIn: [...ALL_SKILL_TARGETS],
      missingFrom: [],
      bytes: 4800,
      provenance: "added",
    },
    {
      name: "write-tests",
      description: "Add tests for the current change",
      source: "agents",
      installedIn: ["claude", "agents", "codex", "grok", "opencode"],
      missingFrom: ["kimi"],
      bytes: 800,
      provenance: "added",
    },
  ];

  return {
    skills: {
      async list(input?: { projectPath?: string }): Promise<SkillInfo[]> {
        const out = skillsList.map((s) => ({
          ...s,
          installedIn: [...s.installedIn],
          missingFrom: [...s.missingFrom],
        }));
        if (input?.projectPath) {
          out.push({
            name: "project-conventions",
            description: "Project-local review rules",
            source: "project",
            installedIn: [],
            missingFrom: [],
            bytes: 400,
            provenance: "project",
          });
        }
        return out;
      },
      async add(
        input: SkillWrite,
      ): Promise<{ name: string; installedIn: SkillTarget[] }> {
        if (!/^[a-z0-9-]+$/.test(input.name)) {
          throw new Error("Skill name must be lowercase letters, digits, dashes");
        }
        const installedIn = [...ALL_SKILL_TARGETS];
        skillsList = [
          ...skillsList.filter(
            (s) => !(s.name === input.name && s.source !== "project"),
          ),
          {
            name: input.name,
            description: input.description,
            source: "claude",
            installedIn,
            missingFrom: [],
            bytes: skillMdBytes(input.name, input.description, input.body),
            provenance: "added",
          },
        ];
        return { name: input.name, installedIn: [...installedIn] };
      },
      async remove(input: { name: string }): Promise<void> {
        skillsList = skillsList.filter(
          (s) => !(s.name === input.name && s.source !== "project"),
        );
      },
      async sync(): Promise<{ copied: number; skills: string[] }> {
        const skills: string[] = [];
        let copied = 0;
        skillsList = skillsList.map((s) => {
          if (s.source === "project" || s.missingFrom.length === 0) {
            return {
              ...s,
              installedIn: [...s.installedIn],
              missingFrom: [...s.missingFrom],
            };
          }
          copied += 1;
          skills.push(s.name);
          return {
            ...s,
            installedIn: [...s.installedIn, ...s.missingFrom],
            missingFrom: [],
          };
        });
        return { copied, skills };
      },
      async commands(): Promise<CliSlashCommand[]> {
        return skillsList
          .filter((s) => s.source !== "project")
          .map((s) => ({
            name: `/${s.name}`,
            hint: s.description,
            kind: "insert" as const,
          }));
      },
      async catalog(): Promise<SkillCatalogEntry[]> {
        return [
          {
            id: "ponytail",
            name: "Ponytail",
            description:
              "Lazy senior dev mode. Forces the simplest, shortest solution that actually works.",
            publisher: "Dietrich Gebert",
            sourceUrl: "https://github.com/DietrichGebert/ponytail",
            homepage: "https://github.com/DietrichGebert/ponytail",
            installed: skillsList.some(
              (s) =>
                s.provenance === "curated" && s.origin?.catalogId === "ponytail",
            ),
          },
        ];
      },
      async pickImport(): Promise<SkillImportPreview | null> {
        pendingSkillImport = { kind: "local" };
        return null;
      },
      async previewImport(
        input: SkillPreviewImportInput,
      ): Promise<SkillImportPreview> {
        const fromCatalog = input.kind === "catalog";
        pendingSkillImport = fromCatalog
          ? { kind: "catalog", catalogId: input.id }
          : { kind: "github" };
        return {
          previewId: "0".repeat(32),
          source: {
            kind: fromCatalog ? "catalog" : "github",
            label: fromCatalog ? "Ponytail" : "github",
          },
          skills: [
            {
              name: "review-pr",
              description: "Dev preview skill",
              files: ["SKILL.md"],
              bytes: 80,
              warnings: [],
              collision: skillsList.some((s) => s.name === "review-pr"),
            },
          ],
          plugins: fromCatalog ? ponytailPluginPreviewExtras() : [],
        };
      },
      async installImport(
        input: SkillInstallRequest,
      ): Promise<SkillInstallResult> {
        const installedIn = [...ALL_SKILL_TARGETS];
        const curated =
          pendingSkillImport?.kind === "catalog" &&
          Boolean(pendingSkillImport.catalogId);
        for (const name of input.selected) {
          skillsList = [
            ...skillsList.filter(
              (s) => !(s.name === name && s.source !== "project"),
            ),
            {
              name,
              description: name,
              source: "claude",
              installedIn,
              missingFrom: [],
              bytes: 80,
              provenance: curated ? "curated" : "added",
              origin: curated
                ? { catalogId: pendingSkillImport?.catalogId }
                : undefined,
            },
          ];
        }
        return {
          installed: input.selected.map((name) => ({
            name,
            installedIn: [...installedIn],
          })),
          plugins:
            pendingSkillImport?.kind === "catalog" &&
            pendingSkillImport.catalogId === "ponytail"
              ? ponytailPluginInstallResults(input.trustPluginCode === true)
              : [],
        };
      },
      async discardImport(): Promise<void> {},
    },
    harness: {
      async detectSources() {
        return [
          { id: "claude" as const, label: "Claude Code", present: true },
          { id: "cursor" as const, label: "Cursor", present: false },
          { id: "codex" as const, label: "Codex", present: false },
        ];
      },
      async previewImport(input: {
        source: HarnessSourceId;
        projectPath?: string;
      }): Promise<HarnessImportPreview> {
        pendingHarnessPreview = cannedHarnessPreview(input.source);
        return pendingHarnessPreview;
      },
      async installImport(
        input: HarnessInstallRequest,
      ): Promise<HarnessInstallResult> {
        if (
          !pendingHarnessPreview ||
          pendingHarnessPreview.previewId !== input.previewId
        ) {
          throw new Error("Import preview is invalid");
        }
        const installedIn = [...ALL_SKILL_TARGETS];
        const skills: HarnessInstallResult["skills"] = [];
        const commands: HarnessInstallResult["commands"] = [];
        for (const id of input.selected) {
          if (id.startsWith("command:")) {
            commands.push({
              name: id.replace(/^command:(?:user|project|plugin):/, ""),
              status: "installed",
            });
            continue;
          }
          if (!id.startsWith("skill:")) continue;
          const name = id.slice("skill:".length);
          skillsList = [
            ...skillsList.filter(
              (s) => !(s.name === name && s.source !== "project"),
            ),
            {
              name,
              description: name,
              source: "claude",
              installedIn,
              missingFrom: [],
              bytes: 80,
              provenance: "added",
            },
          ];
          skills.push({ name, status: "installed" });
        }
        pendingHarnessPreview = null;
        return {
          skills,
          commands,
          mcp: [],
          memories: [],
          instructions: [],
          settings: null,
          plugins: [],
        };
      },
      async discardImport(input: { previewId: string }): Promise<void> {
        if (pendingHarnessPreview?.previewId === input.previewId) {
          pendingHarnessPreview = null;
        }
      },
    },
  };
}
