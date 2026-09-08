/**
 * SkillsTab, mounted for real: list render, MCP add-form validation, the
 * enable/disable toggle, and skill add/remove/sync with inline confirm.
 *
 * Run: node --import=./test/support/render.mjs --test test/skillsTab.test.tsx
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it, afterEach } from "node:test";
import { useRef, useState } from "react";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import { SkillsTab } from "../src/components/SkillsTab";
import {
  filterInstalledSkills,
  providerFilterCount,
  sourceFilterCount,
  toggleSetValue,
} from "../src/components/skillsLibrary";
import type {
  AppSettings,
  McpCatalogEntry,
  McpImportPreview,
  McpInstallRequest,
  McpPreviewImportInput,
  McpServerDefinition,
  McpServerSaveInput,
  SkillCatalogEntry,
  SkillImportPreview,
  SkillInstallRequest,
  SkillInstallResult,
  SkillInfo,
  SkillPluginExtra,
  SkillPreviewImportInput,
  SkillTarget,
  SkillWrite,
  HarnessSourceId,
  HarnessSourceInfo,
  HarnessImportPreview,
  HarnessInstallRequest,
  HarnessInstallResult,
} from "../src/shared/ipc";

afterEach(unmountAll);

const ALL_TARGETS: SkillTarget[] = [
  "claude",
  "agents",
  "codex",
  "grok",
  "opencode",
  "kimi",
  "cursor",
];

const SKILLS: SkillInfo[] = [
  {
    name: "review-pr",
    description: "Review a pull request end to end",
    source: "claude",
    installedIn: [...ALL_TARGETS],
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
  {
    name: "local-rules",
    description: "Project-local rules",
    source: "project",
    installedIn: [],
    missingFrom: [],
    bytes: 400,
    provenance: "project",
  },
];

function settingsWith(
  mcpServers: AppSettings["mcpServers"] = [],
): AppSettings {
  return { dailyBudgetUsd: null, autoSettleAfterDays: 3, mcpServers };
}

const PONYTAIL_CATALOG: SkillCatalogEntry = {
  id: "ponytail",
  name: "Ponytail",
  description: "Lazy senior dev mode.",
  publisher: "Dietrich Gebert",
  sourceUrl: "https://github.com/DietrichGebert/ponytail",
  homepage: "https://github.com/DietrichGebert/ponytail",
  installed: false,
};

function catalogEntry(
  over: Partial<SkillCatalogEntry> = {},
): SkillCatalogEntry {
  return { ...PONYTAIL_CATALOG, ...over };
}

function previewSkill(
  over: Partial<SkillImportPreview["skills"][number]> = {},
): SkillImportPreview["skills"][number] {
  return {
    name: "ship-it",
    description: "Ship the change",
    files: ["SKILL.md"],
    bytes: 80,
    warnings: [],
    collision: false,
    ...over,
  };
}

function preview(over: Partial<SkillImportPreview> = {}): SkillImportPreview {
  return {
    previewId: "preview-1",
    source: { kind: "local", label: "skill.zip" },
    skills: [previewSkill()],
    plugins: [],
    ...over,
  };
}

function pluginExtra(over: Partial<SkillPluginExtra> = {}): SkillPluginExtra {
  return {
    provider: "claude",
    label: "Claude hooks",
    executableFiles: ["hooks/run.sh"],
    activation: { kind: "hooks", status: "pending" },
    ...over,
  };
}

function httpDef(
  over: Partial<Extract<McpServerDefinition, { transport: "http" }>> = {},
): Extract<McpServerDefinition, { transport: "http" }> {
  return {
    name: "team-tools",
    transport: "http",
    url: "https://tools.example.com/mcp",
    headerNames: [],
    hasToken: false,
    enabled: true,
    ...over,
  };
}

function definitionFromSave(input: McpServerSaveInput): McpServerDefinition {
  if (input.transport === "stdio") {
    return {
      name: input.name,
      transport: "stdio",
      command: input.command ?? "",
      args: input.args ?? [],
      envNames: Object.keys(input.env ?? {}),
      hasSecrets: Object.keys(input.env ?? {}).length > 0,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      enabled: input.enabled,
      trusted: input.trusted === true,
    };
  }
  return {
    name: input.name,
    transport: input.transport === "sse" ? "sse" : "http",
    url: input.url ?? "",
    headerNames: Object.keys(input.headers ?? {}),
    hasToken: Boolean(input.token),
    enabled: input.enabled,
  };
}

interface HarnessOptions {
  settings?: AppSettings;
  mcpServers?: McpServerDefinition[];
  skills?: SkillInfo[];
  catalog?: SkillCatalogEntry[];
  catalogError?: string;
  skillsError?: string;
  pendingCatalog?: Promise<SkillCatalogEntry[]>;
  onSaveSettings?: (patch: Partial<AppSettings>) => void;
  onListMcpServers?: () => void;
  onSaveMcpServer?: (input: McpServerSaveInput) => void;
  onRemoveMcpServer?: (input: { name: string }) => void;
  onSetMcpEnabled?: (input: { name: string; enabled: boolean }) => void;
  onListMcpCatalog?: () => void;
  onPickMcpImport?: () => McpImportPreview | null | Promise<McpImportPreview | null>;
  onPreviewMcpImport?: (input: McpPreviewImportInput) => McpImportPreview;
  onInstallMcpImport?: (input: McpInstallRequest) => { installed: string[] } | void;
  onDiscardMcpImport?: (input: { previewId: string }) => void;
  mcpCatalog?: McpCatalogEntry[];
  onAddSkill?: (input: SkillWrite) => void;
  onRemoveSkill?: (input: { name: string }) => void;
  onSyncSkills?: () => { copied: number; skills: string[] } | void;
  onListSkills?: (input?: { projectPath?: string }) => void;
  onListSkillCatalog?: () => void;
  onPickSkillImport?: () =>
    | SkillImportPreview
    | null
    | Promise<SkillImportPreview | null>;
  onPreviewSkillImport?: (
    input: SkillPreviewImportInput,
  ) => SkillImportPreview;
  onInstallSkillImport?: (
    input: SkillInstallRequest,
  ) => SkillInstallResult | void;
  onDiscardSkillImport?: (input: { previewId: string }) => void;
  harnessSources?: HarnessSourceInfo[];
  onDetectHarnessSources?: () => HarnessSourceInfo[];
  onPreviewHarnessImport?: (input: {
    source: HarnessSourceId;
    projectPath?: string;
  }) => HarnessImportPreview;
  onInstallHarnessImport?: (
    input: HarnessInstallRequest,
  ) => HarnessInstallResult | void;
  onDiscardHarnessImport?: (input: { previewId: string }) => void;
}

/**
 * Stateful wrapper: MCP list/CRUD goes through the dedicated redacted
 * methods. Skills are held in a ref so sync/add/remove mutations are
 * visible to the next listSkills.
 */
function Harness(opts: HarnessOptions) {
  const [settings, setSettings] = useState<AppSettings>(
    opts.settings ?? settingsWith(),
  );
  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>(
    (opts.mcpServers ?? []).map((s) => ({ ...s })),
  );
  const mcpRef = useRef(mcpServers);
  mcpRef.current = mcpServers;
  const skillsRef = useRef<SkillInfo[]>(
    (opts.skills ?? SKILLS).map((s) => ({
      ...s,
      installedIn: [...s.installedIn],
      missingFrom: [...s.missingFrom],
    })),
  );
  return (
    <SkillsTab
      projectPath="/repo"
      settings={settings}
      saveSettings={async (patch) => {
        opts.onSaveSettings?.(patch);
        const next = { ...settings, ...patch };
        setSettings(next);
        return next;
      }}
      listMcpServers={async () => {
        opts.onListMcpServers?.();
        return mcpRef.current.map((s) => ({ ...s }));
      }}
      saveMcpServer={async (input) => {
        opts.onSaveMcpServer?.(input);
        const saved = definitionFromSave(input);
        const next = [
          ...mcpRef.current.filter((s) => s.name !== saved.name),
          saved,
        ];
        mcpRef.current = next;
        setMcpServers(next);
        return { ...saved };
      }}
      removeMcpServer={async (input) => {
        opts.onRemoveMcpServer?.(input);
        const next = mcpRef.current.filter((s) => s.name !== input.name);
        mcpRef.current = next;
        setMcpServers(next);
      }}
      setMcpEnabled={async (input) => {
        opts.onSetMcpEnabled?.(input);
        const existing = mcpRef.current.find((s) => s.name === input.name);
        if (!existing) throw new Error(`Unknown MCP server: ${input.name}`);
        const saved = { ...existing, enabled: input.enabled };
        const next = mcpRef.current.map((s) =>
          s.name === input.name ? saved : s,
        );
        mcpRef.current = next;
        setMcpServers(next);
        return saved;
      }}
      listMcpCatalog={async () => {
        opts.onListMcpCatalog?.();
        return (opts.mcpCatalog ?? []).map((row) => ({ ...row }));
      }}
      pickMcpImport={async () => opts.onPickMcpImport?.() ?? null}
      previewMcpImport={async (input) => {
        if (opts.onPreviewMcpImport) return opts.onPreviewMcpImport(input);
        return {
          previewId: "m".repeat(32),
          source: { kind: input.kind, label: input.kind },
          warnings: [],
          servers: [
            {
              name: "imported-tools",
              transport: "http",
              url: "https://imported.example.com/mcp",
              envNames: [],
              headerNames: [],
              hasToken: false,
              requiresTrust: false,
              collision: false,
              warnings: [],
              providers: [{ id: "claude", supported: true }],
            },
          ],
        };
      }}
      installMcpImport={async (input) => {
        const override = opts.onInstallMcpImport?.(input);
        return override ?? { installed: input.selected };
      }}
      discardMcpImport={async (input) => {
        opts.onDiscardMcpImport?.(input);
      }}
      listSkills={async (input) => {
        opts.onListSkills?.(input);
        if (opts.skillsError) throw new Error(opts.skillsError);
        return skillsRef.current.map((s) => ({
          ...s,
          installedIn: [...s.installedIn],
          missingFrom: [...s.missingFrom],
        }));
      }}
      listSkillCatalog={async () => {
        opts.onListSkillCatalog?.();
        if (opts.pendingCatalog) return opts.pendingCatalog;
        if (opts.catalogError) throw new Error(opts.catalogError);
        return (opts.catalog ?? []).map((row) => ({ ...row }));
      }}
      pickSkillImport={async () => opts.onPickSkillImport?.() ?? null}
      previewSkillImport={async (input) => {
        if (opts.onPreviewSkillImport) return opts.onPreviewSkillImport(input);
        return preview({
          source:
            input.kind === "catalog"
              ? { kind: "catalog", label: "Ponytail" }
              : { kind: "github", label: "acme/tools" },
        });
      }}
      installSkillImport={async (input) => {
        const override = opts.onInstallSkillImport?.(input);
        for (const name of input.selected) {
          skillsRef.current = [
            ...skillsRef.current.filter(
              (s) => !(s.name === name && s.source !== "project"),
            ),
            {
              name,
              description: name,
              source: "claude",
              installedIn: [...ALL_TARGETS],
              missingFrom: [],
              bytes: 80,
              provenance: "added",
            },
          ];
        }
        return (
          override ?? {
            installed: input.selected.map((name) => ({
              name,
              installedIn: [...ALL_TARGETS],
            })),
            plugins: [],
          }
        );
      }}
      discardSkillImport={async (input) => {
        opts.onDiscardSkillImport?.(input);
      }}
      detectHarnessSources={async () =>
        opts.onDetectHarnessSources?.() ??
        opts.harnessSources ?? [
          { id: "claude", label: "Claude Code", present: true },
          { id: "cursor", label: "Cursor", present: false },
          { id: "codex", label: "Codex", present: false },
        ]
      }
      previewHarnessImport={async (input) => {
        if (opts.onPreviewHarnessImport) return opts.onPreviewHarnessImport(input);
        return {
          previewId: "h".repeat(32),
          source: { id: input.source, label: "Claude Code" },
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
            {
              id: "skill:already",
              name: "already",
              description: "Already present",
              origin: "skills",
              bytes: 40,
              alreadyImported: true,
              warnings: [],
            },
          ],
          commands: [],
          mcp: [],
          memories: [],
          instructions: [],
          settings: null,
          plugins: [],
          warnings: [],
        };
      }}
      installHarnessImport={async (input) => {
        const override = opts.onInstallHarnessImport?.(input);
        return (
          override ?? {
            skills: input.selected
              .filter((id) => id.startsWith("skill:"))
              .map((id) => ({
                name: id.slice("skill:".length),
                status: "installed" as const,
              })),
            commands: input.selected
              .filter((id) => id.startsWith("command:"))
              .map((id) => ({
                name: id.replace(/^command:(?:user|project|plugin):/, ""),
                status: "installed" as const,
              })),
            mcp: [],
            memories: [],
            instructions: [],
            settings: null,
            plugins: [],
          }
        );
      }}
      discardHarnessImport={async (input) => {
        opts.onDiscardHarnessImport?.(input);
      }}
      addSkill={async (input) => {
        opts.onAddSkill?.(input);
        const installedIn = [...ALL_TARGETS];
        skillsRef.current = [
          ...skillsRef.current.filter(
            (s) => !(s.name === input.name && s.source !== "project"),
          ),
          {
            name: input.name,
            description: input.description,
            source: "claude",
            installedIn,
            missingFrom: [],
            bytes: 100,
            provenance: "added",
          },
        ];
        return { name: input.name, installedIn };
      }}
      removeSkill={async (input) => {
        opts.onRemoveSkill?.(input);
        skillsRef.current = skillsRef.current.filter(
          (s) => !(s.name === input.name && s.source !== "project"),
        );
      }}
      syncSkills={async () => {
        const override = opts.onSyncSkills?.();
        const drifted = skillsRef.current.filter(
          (s) => s.missingFrom.length > 0,
        );
        skillsRef.current = skillsRef.current.map((s) =>
          s.missingFrom.length === 0
            ? s
            : {
                ...s,
                installedIn: [...s.installedIn, ...s.missingFrom],
                missingFrom: [],
              },
        );
        return (
          override ?? {
            copied: drifted.length,
            skills: drifted.map((s) => s.name),
          }
        );
      }}
    />
  );
}

async function openSkillsView(
  m: Awaited<ReturnType<typeof mount>>,
  view: "library" | "catalog" | "mcp" | "add",
): Promise<void> {
  const btn = m.query(`[data-skills-view-btn="${view}"]`);
  assert.ok(btn, `${view} view control must render`);
  await m.click(btn);
}

async function expandSkill(
  m: Awaited<ReturnType<typeof mount>>,
  key: string,
): Promise<void> {
  const row = m.query(`[data-skill="${key}"]`);
  assert.ok(row, `skill ${key} must render`);
  if (row.hasAttribute("data-expanded")) return;
  const toggle = row.querySelector("[data-skill-toggle]");
  assert.ok(toggle, `skill ${key} must have an expand control`);
  await m.click(toggle);
}

describe("SkillsTab lists", () => {
  it("renders installed skills first; MCP stays on a secondary view", async () => {
    const m = await mount(
      <Harness mcpServers={[httpDef()]} />,
    );
    assert.ok(m.text().includes("review-pr"), "skill must render");
    assert.ok(
      m.text().includes("Review a pull request end to end"),
      "skill description must render",
    );
    assert.equal(
      m.text().includes("coder-memory"),
      false,
      "built-in MCP must not occupy the installed library",
    );
    assert.equal(
      m.text().includes("team-tools"),
      false,
      "added MCP must not occupy the installed library",
    );
    const badges = m.queryAll('[class*="badge"]').map((b) => b.textContent);
    assert.ok(badges.includes("Project"), "Project badge must render");
    assert.equal(
      badges.includes("Claude"),
      false,
      "user skills no longer carry a per-provider source badge",
    );
    assert.equal(
      badges.includes("Agents"),
      false,
      "user skills no longer carry a per-provider source badge",
    );
    await openSkillsView(m, "mcp");
    assert.ok(m.text().includes("coder-memory"), "built-in must render");
    assert.ok(m.text().includes("coder-threads"), "built-in must render");
    assert.ok(m.text().includes("Built-in"), "built-in badge must render");
    assert.ok(m.text().includes("team-tools"), "user server must render");
    assert.ok(
      m.text().includes("https://tools.example.com/mcp"),
      "user server URL must render",
    );
    m.unmount();
  });

  it("scopes the skills list to the current project path", async () => {
    const seen: Array<{ projectPath?: string } | undefined> = [];
    const m = await mount(
      <Harness onListSkills={(input) => seen.push(input)} />,
    );
    assert.equal(seen.length, 1, "skills must be fetched once on mount");
    assert.equal(
      seen[0]?.projectPath,
      "/repo",
      "listSkills must receive the selected project path",
    );
    m.unmount();
  });

  it("project skills are read-only: no Remove control on them", async () => {
    const m = await mount(<Harness />);
    const projectRow = m.query('[data-skill="project:local-rules"]');
    assert.ok(projectRow, "project skill row must render");
    assert.equal(
      projectRow.textContent?.includes("Remove"),
      false,
      "project skills must not offer Remove",
    );
    await expandSkill(m, "project:local-rules");
    assert.equal(
      m.query('[data-skill="project:local-rules"]')?.textContent?.includes("Remove"),
      false,
      "expanded project skills must not offer Remove",
    );
    await expandSkill(m, "claude:review-pr");
    const claudeRow = m.query('[data-skill="claude:review-pr"]');
    assert.ok(claudeRow?.textContent?.includes("Remove"));
    m.unmount();
  });

  it("renders coverage and token cost per row", async () => {
    const m = await mount(<Harness />);
    await expandSkill(m, "claude:review-pr");
    const synced = m.query('[data-skill="claude:review-pr"]');
    assert.ok(synced, "synced skill row must render");
    const syncedCoverage = synced.querySelector("[data-coverage]");
    assert.equal(syncedCoverage?.textContent, "7/7");
    assert.ok(
      syncedCoverage?.getAttribute("title")?.includes("Claude"),
      "coverage title lists installed targets",
    );
    assert.ok(
      syncedCoverage?.getAttribute("aria-label")?.includes("Claude"),
      "coverage aria-label lists installed targets",
    );
    assert.equal(
      synced.querySelector("[data-tokens]")?.textContent,
      "~1.2k tokens",
    );

    await expandSkill(m, "agents:write-tests");
    const drifted = m.query('[data-skill="agents:write-tests"]');
    assert.ok(drifted, "drifted skill row must render");
    assert.equal(drifted.querySelector("[data-coverage]")?.textContent, "5/6");
    assert.equal(
      drifted.querySelector("[data-tokens]")?.textContent,
      "~200 tokens",
    );

    await expandSkill(m, "project:local-rules");
    const project = m.query('[data-skill="project:local-rules"]');
    assert.ok(project, "project skill row must render");
    assert.equal(
      project.querySelector("[data-coverage]"),
      null,
      "project rows show a Project badge instead of coverage",
    );
    assert.ok(project.textContent?.includes("Project"));
    assert.equal(
      project.querySelector("[data-tokens]")?.textContent,
      "~100 tokens",
    );
    m.unmount();
  });

  it("shows a drift marker only for skills with missingFrom", async () => {
    const m = await mount(<Harness />);
    assert.ok(
      m.query('[data-skill="agents:write-tests"]')?.querySelector("[data-drift]"),
      "drifted skill must show the Drift marker",
    );
    assert.equal(
      m.query('[data-skill="claude:review-pr"]')?.querySelector("[data-drift]"),
      null,
      "fully-synced skill must not show Drift",
    );
    assert.equal(
      m.query('[data-skill="project:local-rules"]')?.querySelector("[data-drift]"),
      null,
      "project skill must not show Drift",
    );
    m.unmount();
  });
});

describe("SkillsTab MCP servers", () => {
  it("uses dedicated mcp methods and never sends mcpServers through saveSettings", () => {
    const src = fs.readFileSync(
      new URL("../src/components/SkillsTab.tsx", import.meta.url),
      "utf8",
    );
    assert.match(src, /\blistMcpServers\b/);
    assert.match(src, /\bsaveMcpServer\b/);
    assert.match(src, /\bsetMcpEnabled\b/);
    assert.match(src, /\bremoveMcpServer\b/);
    assert.doesNotMatch(src, /settings\?\.mcpServers|settings\.mcpServers/);
    assert.doesNotMatch(src, /saveSettings\(\s*\{\s*mcpServers/);
    const componentsDir = new URL("../src/components/", import.meta.url);
    for (const name of fs.readdirSync(componentsDir)) {
      if (!name.endsWith(".tsx") && !name.endsWith(".ts")) continue;
      const body = fs.readFileSync(new URL(name, componentsDir), "utf8");
      assert.doesNotMatch(
        body,
        /settings\?\.mcpServers|settings\.mcpServers/,
        `${name} must not inspect settings.mcpServers`,
      );
    }
  });

  it("loads redacted definitions from listMcpServers and ignores settings.mcpServers", async () => {
    const listed: string[] = [];
    const settingsPatches: Partial<AppSettings>[] = [];
    const m = await mount(
      <Harness
        settings={settingsWith([
          {
            name: "from-settings",
            url: "https://secret.example.com/mcp",
            token: "must-not-appear",
            enabled: true,
          },
        ])}
        mcpServers={[httpDef({ name: "from-list", hasToken: true })]}
        onListMcpServers={() => listed.push("list")}
        onSaveSettings={(p) => settingsPatches.push(p)}
      />,
    );
    await openSkillsView(m, "mcp");
    assert.ok(listed.length >= 1, "listMcpServers must run when MCP servers opens");
    assert.ok(m.text().includes("from-list"), "redacted list row must render");
    assert.equal(
      m.text().includes("from-settings"),
      false,
      "settings.mcpServers must not drive the UI",
    );
    assert.equal(m.text().includes("must-not-appear"), false);
    assert.ok(
      settingsPatches.every((p) => !Object.hasOwn(p, "mcpServers")),
      "saveSettings must not receive mcpServers",
    );
    m.unmount();
  });

  async function openLocalCommand(
    m: Awaited<ReturnType<typeof mount>>,
  ): Promise<void> {
    const disclosure = m
      .queryAll("summary")
      .find((s) => s.textContent?.includes("Local command"));
    assert.ok(disclosure, "Local command disclosure must render");
    await m.click(disclosure ?? null);
  }

  it("adds a server through saveMcpServer, not saveSettings", async () => {
    const saved: McpServerSaveInput[] = [];
    const settingsPatches: Partial<AppSettings>[] = [];
    const m = await mount(
      <Harness
        onSaveMcpServer={(p) => saved.push(p)}
        onSaveSettings={(p) => settingsPatches.push(p)}
      />,
    );
    await openSkillsView(m, "mcp");
    await m.type(m.query('input[aria-label="MCP server name"]'), "team-tools");
    await m.type(
      m.query('input[aria-label="MCP server URL"]'),
      "https://tools.example.com/mcp",
    );
    await m.type(m.query('input[aria-label="MCP bearer token"]'), "sekrit");
    await m.click(m.byText("Add server"));

    assert.equal(saved.length, 1, "saveMcpServer must fire once");
    assert.deepEqual(saved[0], {
      name: "team-tools",
      url: "https://tools.example.com/mcp",
      token: "sekrit",
      enabled: true,
    });
    assert.ok(
      settingsPatches.every((p) => !Object.hasOwn(p, "mcpServers")),
      "saveSettings must not receive mcpServers",
    );
    assert.ok(m.text().includes("team-tools"), "new row must render");
    m.unmount();
  });

  it("saves a quoted script path and spaced label as one argv element each (#1139)", async () => {
    const saved: McpServerSaveInput[] = [];
    const m = await mount(
      <Harness onSaveMcpServer={(p) => saved.push(p)} />,
    );
    await openSkillsView(m, "mcp");
    await openLocalCommand(m);
    await m.type(m.query('input[aria-label="MCP server name"]'), "local-tools");
    await m.type(m.query('input[aria-label="MCP command"]'), "node");
    await m.type(
      m.query('input[aria-label="MCP command arguments"]'),
      '"/tmp/My Tools/server.mjs" --label "hello world"',
    );
    await m.click(m.byText("Add local server"));

    assert.equal(saved.length, 1, "saveMcpServer must fire once");
    assert.deepEqual(saved[0], {
      name: "local-tools",
      transport: "stdio",
      command: "node",
      args: ["/tmp/My Tools/server.mjs", "--label", "hello world"],
      enabled: false,
      trusted: false,
    });
    m.unmount();
  });

  it("accepts a JSON string array in the local arguments field", async () => {
    const saved: McpServerSaveInput[] = [];
    const m = await mount(
      <Harness onSaveMcpServer={(p) => saved.push(p)} />,
    );
    await openSkillsView(m, "mcp");
    await openLocalCommand(m);
    await m.type(m.query('input[aria-label="MCP server name"]'), "json-tools");
    await m.type(m.query('input[aria-label="MCP command"]'), "node");
    await m.type(
      m.query('input[aria-label="MCP command arguments"]'),
      '["/tmp/My Tools/server.mjs", "--label", "hello world"]',
    );
    await m.click(m.byText("Add local server"));

    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0]?.args, [
      "/tmp/My Tools/server.mjs",
      "--label",
      "hello world",
    ]);
    m.unmount();
  });

  it("keeps the local draft and shows an error when quoting is malformed", async () => {
    const saved: McpServerSaveInput[] = [];
    const m = await mount(
      <Harness onSaveMcpServer={(p) => saved.push(p)} />,
    );
    await openSkillsView(m, "mcp");
    await openLocalCommand(m);
    await m.type(m.query('input[aria-label="MCP server name"]'), "local-tools");
    await m.type(m.query('input[aria-label="MCP command"]'), "node");
    await m.type(
      m.query('input[aria-label="MCP command arguments"]'),
      '"/tmp/My Tools/server.mjs',
    );
    await m.click(m.byText("Add local server"));

    assert.equal(saved.length, 0, "malformed quoting must not save");
    assert.match(m.text(), /unclosed quote/i);
    assert.equal(
      (m.query('input[aria-label="MCP server name"]') as HTMLInputElement)
        .value,
      "local-tools",
    );
    assert.equal(
      (m.query('input[aria-label="MCP command"]') as HTMLInputElement).value,
      "node",
    );
    assert.equal(
      (m.query('input[aria-label="MCP command arguments"]') as HTMLInputElement)
        .value,
      '"/tmp/My Tools/server.mjs',
    );
    m.unmount();
  });

  it("shows a local quoting error inside the Local command disclosure", async () => {
    const saved: McpServerSaveInput[] = [];
    const m = await mount(
      <Harness onSaveMcpServer={(p) => saved.push(p)} />,
    );
    await openSkillsView(m, "mcp");
    await openLocalCommand(m);
    await m.type(m.query('input[aria-label="MCP server name"]'), "local-tools");
    await m.type(m.query('input[aria-label="MCP command"]'), "node");
    await m.type(
      m.query('input[aria-label="MCP command arguments"]'),
      '"/tmp/My Tools/server.mjs',
    );
    await m.click(m.byText("Add local server"));

    assert.equal(saved.length, 0, "malformed quoting must not save");
    const localDetails = m
      .queryAll("details")
      .find((el) =>
        Array.from(el.querySelectorAll("summary")).some((s) =>
          s.textContent?.includes("Local command"),
        ),
      );
    assert.ok(localDetails, "Local command disclosure must render");
    const localAlert = localDetails.querySelector('[role="alert"]');
    assert.ok(
      localAlert,
      "quoting error must render inside the Local command disclosure",
    );
    assert.match(localAlert.textContent ?? "", /unclosed quote/i);
    const addServer = m.byText("Add server");
    assert.ok(addServer, "HTTP Add server button must still render");
    assert.equal(
      addServer.previousElementSibling?.getAttribute("role") === "alert",
      false,
      "quoting error must not sit above the HTTP Add server button",
    );
    assert.equal(
      (m.query('input[aria-label="MCP command arguments"]') as HTMLInputElement)
        .value,
      '"/tmp/My Tools/server.mjs',
      "draft arguments must stay",
    );
    m.unmount();
  });

  it("trust still enables a local server after quoted args parse", async () => {
    const saved: McpServerSaveInput[] = [];
    const m = await mount(
      <Harness onSaveMcpServer={(p) => saved.push(p)} />,
    );
    await openSkillsView(m, "mcp");
    await openLocalCommand(m);
    await m.type(m.query('input[aria-label="MCP server name"]'), "trusted-tools");
    await m.type(m.query('input[aria-label="MCP command"]'), "node");
    await m.type(
      m.query('input[aria-label="MCP command arguments"]'),
      '"/tmp/My Tools/server.mjs"',
    );
    await m.click(m.query('input[aria-label="Trust local MCP command"]'));
    await m.click(m.byText("Add local server"));

    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0]?.args, ["/tmp/My Tools/server.mjs"]);
    assert.equal(saved[0]?.trusted, true);
    assert.equal(saved[0]?.enabled, true);
    m.unmount();
  });

  it("rejects bad names, duplicate names, and non-http URLs without saving", async () => {
    const saved: McpServerSaveInput[] = [];
    const m = await mount(
      <Harness
        mcpServers={[
          httpDef({ name: "taken", url: "https://a.example.com/mcp" }),
        ]}
        onSaveMcpServer={(p) => saved.push(p)}
      />,
    );
    await openSkillsView(m, "mcp");
    const name = () => m.query('input[aria-label="MCP server name"]');
    const url = () => m.query('input[aria-label="MCP server URL"]');

    await m.type(name(), "Bad Name");
    await m.type(url(), "https://b.example.com/mcp");
    await m.click(m.byText("Add server"));
    assert.equal(saved.length, 0, "invalid name must not save");
    assert.ok(m.text().includes("lowercase letters, digits, dashes"));

    await m.type(name(), "taken");
    await m.click(m.byText("Add server"));
    assert.equal(saved.length, 0, "duplicate name must not save");
    assert.ok(m.text().includes('A server named "taken" already exists'));

    await m.type(name(), "fresh");
    await m.type(url(), "ftp://b.example.com/mcp");
    await m.click(m.byText("Add server"));
    assert.equal(saved.length, 0, "non-http URL must not save");
    assert.ok(m.text().includes("http://"));

    await m.type(name(), "creds");
    await m.type(url(), "https://user:pass@evil.example.com/mcp");
    await m.click(m.byText("Add server"));
    assert.equal(saved.length, 0, "credentialed URL must not save");
    assert.match(m.text(), /credential|http:\/\//i);
    m.unmount();
  });

  it("toggle flips enabled through setMcpEnabled", async () => {
    const enabled: Array<{ name: string; enabled: boolean }> = [];
    const settingsPatches: Partial<AppSettings>[] = [];
    const m = await mount(
      <Harness
        mcpServers={[httpDef({ url: "https://a.example.com/mcp" })]}
        onSetMcpEnabled={(p) => enabled.push(p)}
        onSaveSettings={(p) => settingsPatches.push(p)}
      />,
    );
    await openSkillsView(m, "mcp");
    const toggle = m.query(
      'input[aria-label="Enable team-tools"]',
    ) as HTMLInputElement | null;
    assert.ok(toggle, "toggle must render");
    assert.equal(toggle.checked, true);
    await m.click(toggle);
    assert.equal(enabled.length, 1, "toggle must call setMcpEnabled");
    assert.deepEqual(enabled[0], { name: "team-tools", enabled: false });
    assert.ok(settingsPatches.every((p) => !Object.hasOwn(p, "mcpServers")));
    const after = m.query(
      'input[aria-label="Enable team-tools"]',
    ) as HTMLInputElement;
    assert.equal(after.checked, false, "the row must reflect the saved state");
    m.unmount();
  });

  it("Remove drops the server through removeMcpServer", async () => {
    const removed: Array<{ name: string }> = [];
    const settingsPatches: Partial<AppSettings>[] = [];
    const m = await mount(
      <Harness
        mcpServers={[httpDef({ url: "https://a.example.com/mcp" })]}
        onRemoveMcpServer={(p) => removed.push(p)}
        onSaveSettings={(p) => settingsPatches.push(p)}
      />,
    );
    await openSkillsView(m, "mcp");
    const row = m.query('[data-mcp="team-tools"]');
    const btn = Array.from(row?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("Remove"),
    );
    await m.click(btn ?? null);
    assert.equal(removed.length, 1);
    assert.deepEqual(removed[0], { name: "team-tools" });
    assert.ok(settingsPatches.every((p) => !Object.hasOwn(p, "mcpServers")));
    assert.equal(
      m.query('[data-mcp="team-tools"]'),
      null,
      "the row must disappear",
    );
    m.unmount();
  });

  it("renders stdio rows by command and can toggle/remove them", async () => {
    const enabled: Array<{ name: string; enabled: boolean }> = [];
    const removed: Array<{ name: string }> = [];
    const settingsPatches: Partial<AppSettings>[] = [];
    const stdio: Extract<McpServerDefinition, { transport: "stdio" }> = {
      name: "local-tools",
      transport: "stdio",
      command: "/usr/bin/mcp-server",
      args: ["--stdio"],
      envNames: ["GITHUB_TOKEN"],
      hasSecrets: true,
      enabled: true,
      trusted: true,
    };
    const m = await mount(
      <Harness
        mcpServers={[stdio]}
        onSetMcpEnabled={(p) => enabled.push(p)}
        onRemoveMcpServer={(p) => removed.push(p)}
        onSaveSettings={(p) => settingsPatches.push(p)}
      />,
    );
    await openSkillsView(m, "mcp");
    const row = m.query('[data-mcp="local-tools"]');
    assert.ok(row, "stdio row must render");
    assert.ok(
      row.textContent?.includes("/usr/bin/mcp-server"),
      "stdio row must show the command, not assume a URL",
    );
    assert.ok(!row.textContent?.includes("undefined"));
    assert.ok(
      row.textContent?.includes("GITHUB_TOKEN"),
      "stdio row lists required env names",
    );
    const toggle = m.query(
      'input[aria-label="Enable local-tools"]',
    ) as HTMLInputElement | null;
    assert.ok(toggle);
    await m.click(toggle);
    assert.deepEqual(enabled, [{ name: "local-tools", enabled: false }]);
    const after = m.query('[data-mcp="local-tools"]');
    const btn = Array.from(after?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("Remove"),
    );
    await m.click(btn ?? null);
    assert.deepEqual(removed, [{ name: "local-tools" }]);
    assert.ok(settingsPatches.every((p) => !Object.hasOwn(p, "mcpServers")));
    assert.equal(m.query('[data-mcp="local-tools"]'), null);
    m.unmount();
  });

  it("splits built-in, curated, and added MCP sections", async () => {
    const m = await mount(
      <Harness mcpServers={[httpDef()]} mcpCatalog={[]} />,
    );
    await openSkillsView(m, "mcp");
    assert.ok(m.query('[data-mcp-section="curated"]'));
    assert.ok(m.query('[data-mcp-section="added"]'));
    assert.ok(m.text().includes("No curated MCP servers"));
    assert.ok(m.query('[data-mcp="team-tools"]'));
    m.unmount();
  });

  it("previews JSON without echoing secret values", async () => {
    const seen: McpPreviewImportInput[] = [];
    const m = await mount(
      <Harness
        onPreviewMcpImport={(input) => {
          seen.push(input);
          return {
            previewId: "m".repeat(32),
            source: { kind: "json", label: "JSON" },
            warnings: ["credentials were stripped"],
            servers: [
              {
                name: "imported-tools",
                transport: "stdio",
                command: "/usr/bin/mcp-server",
                args: ["--stdio"],
                envNames: ["GITHUB_TOKEN"],
                headerNames: [],
                hasToken: false,
                requiresTrust: true,
                collision: false,
                warnings: ["environment values were stripped"],
                providers: [
                  { id: "claude", supported: true },
                  { id: "codex", supported: true },
                ],
              },
            ],
          };
        }}
      />,
    );
    await openSkillsView(m, "mcp");
    const disclosure = m
      .queryAll("summary")
      .find((s) => s.textContent?.includes("Import JSON"));
    assert.ok(disclosure);
    await m.click(disclosure ?? null);
    await m.type(
      m.query('textarea[aria-label="MCP JSON"]'),
      '{"mcpServers":{"imported-tools":{"command":"/usr/bin/mcp-server","env":{"GITHUB_TOKEN":"sekrit"}}}}',
    );
    await m.click(m.byText("Check JSON"));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, "json");
    const panel = m.query("[data-mcp-preview]");
    assert.ok(panel);
    assert.ok(panel?.textContent?.includes("imported-tools"));
    assert.ok(panel?.textContent?.includes("GITHUB_TOKEN"));
    assert.equal(panel?.textContent?.includes("sekrit"), false);
    assert.ok(panel?.textContent?.includes("Needs trust"));
    m.unmount();
  });

  it("shows grok is unsupported for a stdio MCP server that needs cwd (#705)", async () => {
    const m = await mount(
      <Harness
        onPreviewMcpImport={() => ({
          previewId: "n".repeat(32),
          source: { kind: "json", label: "JSON" },
          warnings: [],
          servers: [
            {
              name: "worker",
              transport: "stdio",
              command: "/usr/bin/mcp-server",
              args: [],
              cwd: "/tmp/mcp-ok",
              envNames: [],
              headerNames: [],
              hasToken: false,
              requiresTrust: true,
              collision: false,
              warnings: [],
              providers: [
                { id: "claude", supported: true },
                { id: "kimi", supported: true },
                { id: "codex", supported: true },
                {
                  id: "grok",
                  supported: false,
                  note: "Grok cannot express stdio cwd",
                },
              ],
            },
          ],
        })}
      />,
    );
    await openSkillsView(m, "mcp");
    const disclosure = m
      .queryAll("summary")
      .find((s) => s.textContent?.includes("Import JSON"));
    assert.ok(disclosure);
    await m.click(disclosure ?? null);
    await m.type(
      m.query('textarea[aria-label="MCP JSON"]'),
      '{"mcpServers":{"worker":{"command":"/usr/bin/mcp-server","cwd":"/tmp/mcp-ok"}}}',
    );
    await m.click(m.byText("Check JSON"));
    const panel = m.query("[data-mcp-preview]");
    assert.ok(panel);
    assert.ok(panel?.textContent?.includes("worker"));
    assert.match(panel?.textContent || "", /Grok cannot express stdio cwd/i);
    m.unmount();
  });

  it("shows a backend validation error instead of pretending success", async () => {
    const m = await mount(
      <Harness
        onSaveMcpServer={() => {
          throw new Error(
            "Error invoking remote method 'mcp:save': Error: MCP server URL must be http(s)",
          );
        }}
      />,
    );
    await openSkillsView(m, "mcp");
    await m.type(m.query('input[aria-label="MCP server name"]'), "srv");
    await m.type(
      m.query('input[aria-label="MCP server URL"]'),
      "https://a.example.com/mcp",
    );
    await m.click(m.byText("Add server"));
    assert.ok(
      m.text().includes("MCP server URL must be http(s)"),
      "the stripped backend error must render",
    );
    assert.equal(
      m.text().includes("Error invoking remote method"),
      false,
      "transport noise must be stripped",
    );
    m.unmount();
  });
});

async function openWriteManually(
  m: Awaited<ReturnType<typeof mount>>,
): Promise<void> {
  const toggle = m.byText("Write manually");
  assert.ok(toggle, "Write manually disclosure must render");
  await m.click(toggle);
}

describe("SkillsTab skills", () => {
  it("adds a skill with name, description, and body, and no target field", async () => {
    const added: SkillWrite[] = [];
    const m = await mount(<Harness onAddSkill={(i) => added.push(i)} />);
    await openWriteManually(m);
    assert.equal(
      m.query('select[aria-label="Skill target"]'),
      null,
      "the target dropdown is gone",
    );
    await m.type(m.query('input[aria-label="Skill name"]'), "ship-it");
    await m.type(
      m.query('input[aria-label="Skill description"]'),
      "Ship the change",
    );
    await m.type(m.query('textarea[aria-label="Skill body"]'), "Do the thing.");
    await m.click(m.query('[data-skill-section="add"] button[type="submit"]'));

    assert.equal(added.length, 1, "addSkill must fire once");
    assert.deepEqual(added[0], {
      name: "ship-it",
      description: "Ship the change",
      body: "Do the thing.",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(added[0], "target"),
      false,
      "add must not post a target field",
    );
    m.unmount();
  });

  it("validates the add form before calling addSkill", async () => {
    const added: SkillWrite[] = [];
    const m = await mount(<Harness onAddSkill={(i) => added.push(i)} />);
    await openWriteManually(m);
    await m.type(m.query('input[aria-label="Skill name"]'), "Bad Name");
    await m.type(
      m.query('input[aria-label="Skill description"]'),
      "d",
    );
    await m.type(m.query('textarea[aria-label="Skill body"]'), "b");
    await m.click(m.query('[data-skill-section="add"] button[type="submit"]'));
    assert.equal(added.length, 0, "invalid name must not call addSkill");
    assert.ok(m.text().includes("lowercase letters, digits, dashes"));

    await m.type(m.query('input[aria-label="Skill name"]'), "ok-name");
    await m.type(m.query('input[aria-label="Skill description"]'), "");
    await m.click(m.query('[data-skill-section="add"] button[type="submit"]'));
    assert.equal(added.length, 0, "empty description must not call addSkill");
    assert.ok(m.text().includes("Description is required"));
    m.unmount();
  });

  it("remove asks inline, then deletes by name from all providers", async () => {
    const removed: Array<{ name: string }> = [];
    const m = await mount(<Harness onRemoveSkill={(i) => removed.push(i)} />);
    await expandSkill(m, "claude:review-pr");
    const row = m.query('[data-skill="claude:review-pr"]');
    assert.ok(row, "skill row must render");
    const removeBtn = Array.from(row.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Remove"),
    );
    assert.equal(
      removeBtn?.getAttribute("aria-label"),
      "Remove review-pr",
      "Remove must name the skill",
    );
    await m.click(removeBtn ?? null);
    assert.equal(removed.length, 0, "first click must only arm the confirm");
    const confirmRow = m.query('[data-skill="claude:review-pr"]');
    assert.ok(
      confirmRow?.textContent?.includes("all providers"),
      "confirm copy must say the skill is removed from all providers",
    );
    const confirmBtn = Array.from(
      confirmRow?.querySelectorAll("button") ?? [],
    ).find((b) => b.textContent?.includes("Confirm"));
    assert.ok(confirmBtn, "Confirm must appear inline");
    const hintId = confirmRow
      ?.querySelector("[class*='confirmHint']")
      ?.getAttribute("id");
    assert.ok(hintId, "confirm hint must have an id");
    assert.equal(
      confirmBtn?.getAttribute("aria-describedby"),
      hintId,
      "Confirm must be tied to the status text",
    );
    await m.click(confirmBtn);
    assert.deepEqual(removed, [{ name: "review-pr" }]);
    m.unmount();
  });

  it("Sync calls skills.sync, reloads, and reports what it copied", async () => {
    const listed: Array<{ projectPath?: string } | undefined> = [];
    let syncs = 0;
    const m = await mount(
      <Harness
        onListSkills={(input) => listed.push(input)}
        onSyncSkills={() => {
          syncs += 1;
        }}
      />,
    );
    assert.equal(listed.length, 1, "listSkills once on mount");
    const syncBtn = m.query(
      'button[aria-label="Sync missing skills"]',
    ) as HTMLButtonElement | null;
    assert.ok(syncBtn, "Sync button must render");
    assert.ok(
      m.query("[data-skills-toolbar]")?.contains(syncBtn),
      "Sync belongs on the installed library toolbar",
    );
    assert.equal(syncBtn.disabled, false, "Sync is enabled when there is drift");
    await m.click(syncBtn);
    assert.equal(syncs, 1, "syncSkills must fire once");
    assert.equal(listed.length, 2, "listSkills must reload after sync");
    assert.ok(m.text().includes("Copied 1 skill"), "sync reports what it did");
    const live = m.queryAll("[aria-live]").find((el) =>
      (el.textContent || "").includes("Copied 1 skill"),
    );
    assert.ok(live, "sync success must be an aria-live status");
    assert.equal(
      m.queryAll("[aria-live]").length,
      1,
      "status uses one always-mounted live region",
    );
    assert.equal(
      m.query('[data-skill="agents:write-tests"]')?.querySelector("[data-drift]"),
      null,
      "drift marker clears after sync reloads",
    );
    const after = m.query(
      'button[aria-label="Sync missing skills"]',
    ) as HTMLButtonElement;
    assert.equal(after.disabled, true, "Sync disables once nothing has drift");
    m.unmount();
  });

  it("disables Sync when no skill has drift", async () => {
    const m = await mount(
      <Harness
        skills={[
          {
            name: "review-pr",
            description: "Review a pull request end to end",
            source: "claude",
            installedIn: [...ALL_TARGETS],
            missingFrom: [],
            bytes: 4800,
            provenance: "added",
          },
        ]}
      />,
    );
    const syncBtn = m.query(
      'button[aria-label="Sync missing skills"]',
    ) as HTMLButtonElement | null;
    assert.ok(syncBtn, "Sync button must render");
    assert.equal(syncBtn.disabled, true);
    assert.equal(
      m.query('[data-skill="project:local-rules"]'),
      null,
      "Project skills are omitted when the inventory has none",
    );
    m.unmount();
  });
});

describe("SkillsTab sections", () => {
  it("keeps curated, added, and project skills in distinct sections without duplication", async () => {
    const m = await mount(
      <Harness
        catalog={[catalogEntry({ installed: true })]}
        skills={[
          {
            name: "review-pr",
            description: "Review a pull request end to end",
            source: "claude",
            installedIn: [...ALL_TARGETS],
            missingFrom: [],
            bytes: 4800,
            provenance: "curated",
            origin: { catalogId: "ponytail" },
          },
          SKILLS[1],
          SKILLS[2],
        ]}
      />,
    );
    assert.ok(m.query('[data-skill="claude:review-pr"]'));
    assert.ok(m.query('[data-skill="agents:write-tests"]'));
    assert.ok(m.query('[data-skill="project:local-rules"]'));
    await openSkillsView(m, "catalog");
    const curated = m.query('[data-skill-section="curated"]');
    assert.ok(curated, "Curated section must render in the catalog view");
    assert.ok(curated.textContent?.includes("Curated skills"));
    assert.ok(curated.textContent?.includes("Ponytail"));
    assert.ok(curated.textContent?.includes("Dietrich Gebert"));
    assert.ok(curated.textContent?.includes("Installed"));
    assert.ok(
      curated.querySelector("[data-coverage]")?.textContent === "7/7",
      "installed curated rows keep coverage from the matched skill",
    );
    assert.equal(
      curated.querySelector("[data-tokens]")?.textContent,
      "~1.2k tokens",
    );
    await openSkillsView(m, "library");
    await m.click(m.query('[data-source-filter="added"]'));
    assert.ok(m.query('[data-skill="agents:write-tests"]'));
    assert.equal(
      m.query('[data-skill="claude:review-pr"]'),
      null,
      "curated installs must not appear in the User filter",
    );
    await m.click(m.query('[data-source-filter="added"]'));
    await m.click(m.query('[data-source-filter="project"]'));
    assert.ok(m.query('[data-skill="project:local-rules"]'));
    assert.equal(
      m.query('[data-skill="project:local-rules"]')?.textContent?.includes("Remove"),
      false,
    );
    m.unmount();
  });

  it("loads catalog independently and does not erase installed skills on catalog failure", async () => {
    const listed: unknown[] = [];
    const catalogs: unknown[] = [];
    const m = await mount(
      <Harness
        catalog={[catalogEntry()]}
        catalogError="Error invoking remote method 'skills:catalog': Error: catalog down"
        onListSkills={() => listed.push(1)}
        onListSkillCatalog={() => catalogs.push(1)}
      />,
    );
    assert.equal(listed.length, 1);
    assert.equal(catalogs.length, 0, "catalog stays unloaded until Browse catalog");
    assert.ok(
      m.query('[data-skill="claude:review-pr"]'),
      "installed skills must still render",
    );
    await openSkillsView(m, "catalog");
    assert.equal(catalogs.length, 1);
    const curated = m.query('[data-skill-section="curated"]');
    assert.ok(curated?.textContent?.toLowerCase().includes("unavailable"));
    assert.equal(
      curated?.textContent?.includes("Error invoking remote method"),
      false,
    );
    assert.equal(curated?.textContent?.includes("Ponytail"), false);
    m.unmount();
  });

  it("keeps catalog rows when installed skills fail to load", async () => {
    const m = await mount(
      <Harness
        catalog={[catalogEntry()]}
        skillsError="Error invoking remote method 'skills:list': Error: skills down"
      />,
    );
    assert.ok(m.text().includes("skills down"));
    assert.equal(
      m.text().includes("Error invoking remote method"),
      false,
    );
    await openSkillsView(m, "catalog");
    assert.ok(
      m.query('[data-skill-section="curated"]')?.textContent?.includes("Ponytail"),
    );
    assert.equal(m.query('[data-skill="claude:review-pr"]'), null);
    m.unmount();
  });

  it("does not mention catalog unavailable when the catalog loaded empty", async () => {
    const m = await mount(<Harness catalog={[]} skills={[]} />);
    assert.ok(
      m.text().toLowerCase().includes("add skill"),
      "empty library invites Add skill",
    );
    await openSkillsView(m, "catalog");
    const curated = m.query('[data-skill-section="curated"]');
    assert.ok(curated);
    assert.equal(
      curated.textContent?.toLowerCase().includes("unavailable"),
      false,
    );
    const live = m.query("[aria-live]");
    assert.ok(live, "aria-live status is always mounted");
    assert.equal((live.textContent || "").trim(), "");
    assert.ok(
      live.hasAttribute("data-empty"),
      "empty live region must collapse via data-empty",
    );
    m.unmount();
  });

  it("falls back to installed curated skills when the catalog fails or is empty", async () => {
    const curatedInstalled: SkillInfo = {
      name: "review-pr",
      description: "Review a pull request end to end",
      source: "claude",
      installedIn: [...ALL_TARGETS],
      missingFrom: [],
      bytes: 4800,
      provenance: "curated",
      origin: {
        catalogId: "ponytail",
        sourceLabel: "Ponytail",
        sourceUrl: "https://github.com/DietrichGebert/ponytail",
      },
    };
    const failed = await mount(
      <Harness
        catalogError="catalog down"
        skills={[curatedInstalled, SKILLS[1]]}
      />,
    );
    await openSkillsView(failed, "catalog");
    const curated = failed.query('[data-skill-section="curated"]');
    assert.ok(curated?.textContent?.toLowerCase().includes("unavailable"));
    const row = failed.query('[data-catalog="ponytail"]');
    assert.ok(row, "installed curated skill must stay visible as a fallback row");
    assert.ok(row.textContent?.includes("Ponytail"));
    assert.ok(row.textContent?.includes("Installed"));
    assert.equal(row.querySelector("[data-coverage]")?.textContent, "7/7");
    await openSkillsView(failed, "library");
    await failed.click(failed.query('[data-source-filter="added"]'));
    assert.equal(
      failed.query('[data-skill="claude:review-pr"]'),
      null,
      "fallback curated rows must not be duplicated as User skills",
    );
    failed.unmount();

    const empty = await mount(
      <Harness catalog={[]} skills={[curatedInstalled, SKILLS[1]]} />,
    );
    await openSkillsView(empty, "catalog");
    assert.ok(empty.query('[data-catalog="ponytail"]'));
    assert.equal(
      empty
        .query('[data-skill-section="curated"]')
        ?.textContent?.toLowerCase()
        .includes("unavailable"),
      false,
    );
    empty.unmount();
  });

  it("does not treat an added skill as curated just because names match", async () => {
    const m = await mount(
      <Harness
        catalog={[catalogEntry({ name: "Ponytail", installed: true })]}
        skills={[
          {
            name: "Ponytail",
            description: "User-added skill that happens to share a name",
            source: "claude",
            installedIn: [...ALL_TARGETS],
            missingFrom: [],
            bytes: 4800,
            provenance: "added",
          },
        ]}
      />,
    );
    await openSkillsView(m, "catalog");
    const row = m.query('[data-catalog="ponytail"]');
    assert.ok(row);
    assert.ok(row.textContent?.includes("Installed"));
    assert.equal(
      row.querySelector("[data-coverage]"),
      null,
      "name-only match must not borrow an added skill's coverage",
    );
    await openSkillsView(m, "library");
    assert.ok(m.query('[data-skill="claude:Ponytail"]'));
    m.unmount();
  });

  it("shows curated loading without hiding installed skills", async () => {
    let resolveCatalog!: (rows: SkillCatalogEntry[]) => void;
    const pending = new Promise<SkillCatalogEntry[]>((resolve) => {
      resolveCatalog = resolve;
    });
    const m = await mount(
      <Harness catalog={[catalogEntry()]} pendingCatalog={pending} />,
    );
    assert.ok(m.query('[data-skill="claude:review-pr"]'));
    await openSkillsView(m, "catalog");
    assert.ok(
      m.query('[data-skill-section="curated"]')?.textContent?.includes("Loading"),
    );
    await inAct(async () => {
      resolveCatalog([catalogEntry()]);
    });
    await m.flush();
    assert.ok(
      m.query('[data-skill-section="curated"]')?.textContent?.includes("Ponytail"),
    );
    m.unmount();
  });
});

describe("SkillsTab import preview", () => {
  it("previews a catalog install by id", async () => {
    const previews: SkillPreviewImportInput[] = [];
    const m = await mount(
      <Harness
        catalog={[catalogEntry()]}
        onPreviewSkillImport={(input) => {
          previews.push(input);
          return preview({
            source: { kind: "catalog", label: "Ponytail" },
            skills: [
              previewSkill({
                name: "ponytail",
                description: "Stay simple",
                files: ["SKILL.md", "scripts/run.sh"],
                bytes: 120,
              }),
            ],
          });
        }}
      />,
    );
    await openSkillsView(m, "catalog");
    const row = m.query('[data-catalog="ponytail"]');
    assert.ok(row, "catalog row must render");
    assert.ok(row.textContent?.includes("Dietrich Gebert"));
    const source = row.querySelector("a");
    assert.ok(source, "catalog row needs a source/homepage affordance");
    assert.ok(
      source.getAttribute("aria-label")?.includes("Ponytail"),
      "source link name must include the catalog entry",
    );
    const install = Array.from(row.querySelectorAll("button")).find((b) =>
      b.textContent?.trim() === "Install",
    );
    await m.click(install ?? null);
    assert.deepEqual(previews, [{ kind: "catalog", id: "ponytail" }]);
    const panel = m.query("[data-import-preview]");
    assert.ok(panel, "preview panel must open");
    assert.ok(panel.textContent?.includes("Ponytail"));
    assert.ok(panel.textContent?.includes("catalog"));
    assert.ok(panel.textContent?.includes("Stay simple"));
    assert.ok(panel.textContent?.includes("2 files") || panel.textContent?.includes("2 file"));
    m.unmount();
  });

  it("ignores a canceled file picker and shows a picked preview", async () => {
    const picks: Array<SkillImportPreview | null> = [];
    const m = await mount(
      <Harness
        onPickSkillImport={() => {
          picks.push(null);
          return null;
        }}
      />,
    );
    await m.click(m.byText("Import file"));
    assert.deepEqual(picks, [null]);
    assert.equal(m.query("[data-import-preview]"), null);

    picks.length = 0;
    m.unmount();
    const shown = preview({
      source: { kind: "local", label: "review.zip" },
      skills: [previewSkill({ name: "review-pr", files: ["SKILL.md"] })],
    });
    const m2 = await mount(
      <Harness
        onPickSkillImport={() => {
          picks.push(shown);
          return shown;
        }}
      />,
    );
    await m2.click(m2.byText("Import file"));
    assert.equal(picks.length, 1);
    const panel = m2.query("[data-import-preview]");
    assert.ok(panel?.textContent?.includes("review.zip"));
    assert.ok(panel?.textContent?.includes("local"));
    assert.ok(panel?.textContent?.includes("review-pr"));
    m2.unmount();
  });

  it("previews a GitHub URL as a github source", async () => {
    const previews: SkillPreviewImportInput[] = [];
    const m = await mount(
      <Harness
        onPreviewSkillImport={(input) => {
          previews.push(input);
          return preview({
            source: { kind: "github", label: "acme/tools" },
            skills: [previewSkill({ name: "ship-it" })],
          });
        }}
      />,
    );
    await m.type(
      m.query('input[aria-label="GitHub URL"]'),
      "https://github.com/acme/tools",
    );
    await m.click(m.byText("Preview"));
    assert.deepEqual(previews, [
      { kind: "github", url: "https://github.com/acme/tools" },
    ]);
    const panel = m.query("[data-import-preview]");
    assert.ok(panel?.textContent?.includes("acme/tools"));
    assert.ok(panel?.textContent?.includes("github"));
    m.unmount();
  });

  it("selects detected skills by default and disables install at zero selection", async () => {
    const m = await mount(
      <Harness
        onPickSkillImport={() =>
          preview({
            skills: [
              previewSkill({ name: "alpha" }),
              previewSkill({ name: "beta" }),
            ],
          })
        }
      />,
    );
    await m.click(m.byText("Import file"));
    const alpha = m.query(
      'input[aria-label="Select alpha"]',
    ) as HTMLInputElement | null;
    const beta = m.query(
      'input[aria-label="Select beta"]',
    ) as HTMLInputElement | null;
    assert.equal(alpha?.checked, true);
    assert.equal(beta?.checked, true);
    const install = m.byText("Install selected") as HTMLButtonElement | null;
    assert.equal(install?.disabled, false);
    await m.click(alpha);
    await m.click(beta);
    assert.equal(
      (m.byText("Install selected") as HTMLButtonElement).disabled,
      true,
    );
    m.unmount();
  });

  it("gates install on replace when a selected skill collides", async () => {
    const m = await mount(
      <Harness
        onPickSkillImport={() =>
          preview({
            skills: [previewSkill({ name: "review-pr", collision: true })],
          })
        }
      />,
    );
    await m.click(m.byText("Import file"));
    const panel = m.query("[data-import-preview]");
    assert.ok(
      panel?.textContent?.toLowerCase().includes("collision"),
      "collision marker must be visible",
    );
    const install = m.byText("Install selected") as HTMLButtonElement;
    assert.equal(install.disabled, true);
    const replace = m.query(
      'input[aria-label="Replace existing skills"]',
    ) as HTMLInputElement | null;
    assert.ok(replace, "replace checkbox must render for collisions");
    await m.click(replace);
    assert.equal(
      (m.byText("Install selected") as HTMLButtonElement).disabled,
      false,
    );
    m.unmount();
  });

  it("requires risk acknowledgement and says plugin extras stay inactive", async () => {
    const m = await mount(
      <Harness
        onPickSkillImport={() =>
          preview({
            skills: [
              previewSkill({
                name: "risky",
                warnings: ["executable-looking file: scripts/run.sh"],
              }),
            ],
            plugins: [
              pluginExtra(),
              pluginExtra({
                provider: "codex",
                label: "Codex plugin",
                executableFiles: ["commands/ok.md"],
                activation: { kind: "codex-plugin", status: "pending" },
              }),
            ],
          })
        }
      />,
    );
    await m.click(m.byText("Import file"));
    const panel = m.query("[data-import-preview]");
    assert.ok(panel?.textContent?.includes("executable-looking file"));
    assert.ok(panel?.textContent?.includes("Claude hooks"));
    assert.ok(panel?.textContent?.includes("Codex plugin"));
    assert.ok(panel?.textContent?.includes("hooks/run.sh"));
    const warnKeys = m
      .queryAll("[data-warn-key]")
      .map((el) => el.getAttribute("data-warn-key"));
    assert.ok(warnKeys.length > 0, "warnings need stable keys");
    assert.equal(new Set(warnKeys).size, warnKeys.length);
    assert.ok(
      panel?.textContent?.toLowerCase().includes("inactive"),
      "unsupported extras must stay inactive",
    );
    assert.ok(
      panel?.textContent?.toLowerCase().includes("activated after explicit trust") ||
        panel?.textContent?.toLowerCase().includes("activated after you trust"),
      "recognized extras can be activated after explicit trust",
    );
    const install = m.byText("Install selected") as HTMLButtonElement;
    assert.equal(install.disabled, true);
    const ack = m.query(
      'input[aria-label="I trust this package and understand it may include executable instructions or hooks."]',
    ) as HTMLInputElement | null;
    assert.ok(ack, "acknowledgement checkbox must render");
    await m.click(ack);
    assert.equal(
      (m.byText("Install selected") as HTMLButtonElement).disabled,
      false,
    );
    m.unmount();
  });

  it("Cancel discards the staged preview", async () => {
    const discarded: Array<{ previewId: string }> = [];
    const m = await mount(
      <Harness
        onPickSkillImport={() => preview({ previewId: "preview-9" })}
        onDiscardSkillImport={(input) => discarded.push(input)}
      />,
    );
    await m.click(m.byText("Import file"));
    assert.ok(m.query("[data-import-preview]"));
    await m.click(m.byText("Cancel"));
    assert.deepEqual(discarded, [{ previewId: "preview-9" }]);
    assert.equal(m.query("[data-import-preview]"), null);
    m.unmount();
  });

  it("installs the selection, reloads lists, and announces the count", async () => {
    const installed: SkillInstallRequest[] = [];
    const discarded: Array<{ previewId: string }> = [];
    const listed: unknown[] = [];
    const catalogs: unknown[] = [];
    const m = await mount(
      <Harness
        catalog={[catalogEntry()]}
        onListSkills={() => listed.push(1)}
        onListSkillCatalog={() => catalogs.push(1)}
        onPickSkillImport={() =>
          preview({
            previewId: "preview-ok",
            skills: [previewSkill({ name: "ship-it" })],
          })
        }
        onInstallSkillImport={(input) => {
          installed.push(input);
        }}
        onDiscardSkillImport={(input) => discarded.push(input)}
      />,
    );
    assert.equal(listed.length, 1);
    assert.equal(catalogs.length, 0, "catalog is not fetched for the installed library");
    await m.click(m.byText("Import file"));
    await m.click(m.byText("Install selected"));
    assert.deepEqual(installed, [
      {
        previewId: "preview-ok",
        selected: ["ship-it"],
        replace: false,
        trustPluginCode: false,
      },
    ]);
    assert.equal(listed.length, 2, "skills reload after install");
    assert.equal(
      catalogs.length,
      0,
      "file install does not fetch a hidden catalog",
    );
    assert.equal(m.query("[data-import-preview]"), null);
    assert.deepEqual(
      discarded,
      [],
      "successful install leaves cleanup to the backend",
    );
    const live = m.queryAll("[aria-live]").find((el) =>
      (el.textContent || "").includes("Installed 1 skill"),
    );
    assert.ok(live, "install success must be an aria-live status");
    assert.equal(live.hasAttribute("data-empty"), false);
    m.unmount();
    assert.deepEqual(
      discarded,
      [],
      "unmount must not discard a preview the backend already took",
    );
  });

  it("sends trustPluginCode after ack and summarizes a successful plugin activation", async () => {
    const installed: SkillInstallRequest[] = [];
    const m = await mount(
      <Harness
        onPickSkillImport={() =>
          preview({
            previewId: "preview-trust",
            skills: [previewSkill({ name: "ship-it" })],
            plugins: [
              pluginExtra({
                provider: "codex",
                label: "Codex plugin",
                executableFiles: [],
                activation: { kind: "codex-plugin", status: "pending" },
              }),
            ],
          })
        }
        onInstallSkillImport={(input) => {
          installed.push(input);
          return {
            installed: [{ name: "ship-it", installedIn: [...ALL_TARGETS] }],
            plugins: [
              {
                provider: "codex",
                label: "Codex plugin",
                status: "activated",
              },
            ],
          };
        }}
      />,
    );
    await m.click(m.byText("Import file"));
    assert.equal((m.byText("Install selected") as HTMLButtonElement).disabled, true);
    await m.click(
      m.query(
        'input[aria-label="I trust this package and understand it may include executable instructions or hooks."]',
      ),
    );
    await m.click(m.byText("Install selected"));
    assert.deepEqual(installed, [
      {
        previewId: "preview-trust",
        selected: ["ship-it"],
        replace: false,
        trustPluginCode: true,
      },
    ]);
    assert.equal(m.query("[data-import-preview]"), null);
    const live = m.queryAll("[aria-live]").find((el) =>
      (el.textContent || "").toLowerCase().includes("installed"),
    );
    assert.ok(live, "install success must stay on the live status");
    assert.ok(
      (live.textContent || "").toLowerCase().includes("activated"),
      "status must mention activated plugin actions",
    );
    m.unmount();
  });

  it("keeps a failed plugin action on the live status after skills install", async () => {
    const m = await mount(
      <Harness
        onPickSkillImport={() =>
          preview({
            previewId: "preview-fail",
            plugins: [
              pluginExtra({
                provider: "codex",
                label: "Codex plugin",
                executableFiles: [],
                activation: { kind: "codex-plugin", status: "pending" },
              }),
            ],
          })
        }
        onInstallSkillImport={() => ({
          installed: [{ name: "ship-it", installedIn: [...ALL_TARGETS] }],
          plugins: [
            {
              provider: "codex",
              label: "Codex plugin",
              status: "failed",
              error: "CLI exited 1",
            },
          ],
        })}
      />,
    );
    await m.click(m.byText("Import file"));
    await m.click(
      m.query(
        'input[aria-label="I trust this package and understand it may include executable instructions or hooks."]',
      ),
    );
    await m.click(m.byText("Install selected"));
    assert.equal(m.query("[data-import-preview]"), null);
    const live = m.queryAll("[aria-live]").find((el) =>
      (el.textContent || "").toLowerCase().includes("installed"),
    );
    assert.ok(live);
    assert.ok((live.textContent || "").toLowerCase().includes("failed"));
    m.unmount();
  });

  it("retains selectable Claude plugin instructions after the preview clears", async () => {
    const instructions = [
      "/plugin marketplace add DietrichGebert/ponytail",
      "/plugin install ponytail@ponytail",
    ];
    const m = await mount(
      <Harness
        onPickSkillImport={() =>
          preview({
            previewId: "preview-claude",
            plugins: [
              pluginExtra({
                provider: "claude",
                label: "ponytail",
                executableFiles: [],
                activation: { kind: "claude-plugin", status: "pending" },
              }),
            ],
          })
        }
        onInstallSkillImport={() => ({
          installed: [{ name: "ship-it", installedIn: [...ALL_TARGETS] }],
          plugins: [
            {
              provider: "claude",
              label: "ponytail",
              status: "manual",
              instructions,
            },
          ],
        })}
      />,
    );
    await m.click(m.byText("Import file"));
    await m.click(
      m.query(
        'input[aria-label="I trust this package and understand it may include executable instructions or hooks."]',
      ),
    );
    await m.click(m.byText("Install selected"));
    assert.equal(m.query("[data-import-preview]"), null);
    const panel = m.query("[data-install-result]");
    assert.ok(panel, "manual instructions must persist after preview clears");
    assert.ok(
      panel.getAttribute("aria-live") === "polite" ||
        panel.getAttribute("aria-live") === "assertive",
      "plugin result panel must be announced",
    );
    for (const line of instructions) {
      assert.ok(panel.textContent?.includes(line), line);
    }
    const code = panel.querySelector("code, pre");
    assert.ok(code, "instructions must be selectable code text");
    const live = m.queryAll("[aria-live]").find((el) =>
      (el.textContent || "").toLowerCase().includes("installed"),
    );
    assert.ok(live);
    assert.ok(
      (live.textContent || "").toLowerCase().includes("instructions follow"),
      "status line must say instructions follow",
    );
    m.unmount();
  });

  it("renders covered and unsupported extras in the result panel", async () => {
    const m = await mount(
      <Harness
        onPickSkillImport={() =>
          preview({
            previewId: "preview-honest",
            plugins: [
              pluginExtra({
                provider: "codex",
                label: "Codex plugin",
                executableFiles: [],
                activation: { kind: "codex-plugin", status: "pending" },
              }),
            ],
          })
        }
        onInstallSkillImport={() => ({
          installed: [{ name: "ship-it", installedIn: [...ALL_TARGETS] }],
          plugins: [
            {
              provider: "codex",
              label: "Codex plugin",
              status: "activated",
            },
            { provider: "hooks", label: "Hooks", status: "covered" },
            {
              provider: "commands",
              label: "Commands",
              status: "unsupported",
              error:
                "Provider plugin activation cannot safely pin the previewed ref.",
            },
          ],
        })}
      />,
    );
    await m.click(m.byText("Import file"));
    await m.click(
      m.query(
        'input[aria-label="I trust this package and understand it may include executable instructions or hooks."]',
      ),
    );
    await m.click(m.byText("Install selected"));
    const panel = m.query("[data-install-result]");
    assert.ok(panel);
    assert.ok(panel.textContent?.includes("Hooks"));
    assert.ok(panel.textContent?.toLowerCase().includes("covered"));
    assert.ok(panel.textContent?.includes("Commands"));
    assert.ok(panel.textContent?.toLowerCase().includes("unsupported"));
    m.unmount();
  });

  it("strips transport noise from preview and install errors", async () => {
    const m = await mount(
      <Harness
        onPreviewSkillImport={() => {
          throw new Error(
            "Error invoking remote method 'skills:previewImport': Error: Unsupported GitHub URL",
          );
        }}
      />,
    );
    await m.type(
      m.query('input[aria-label="GitHub URL"]'),
      "https://example.com/not-github",
    );
    await m.click(m.byText("Preview"));
    assert.ok(m.text().includes("Unsupported GitHub URL"));
    assert.equal(m.text().includes("Error invoking remote method"), false);
    m.unmount();

    const m2 = await mount(
      <Harness
        onPickSkillImport={() => preview({ previewId: "preview-bad" })}
        onInstallSkillImport={() => {
          throw new Error(
            "Error invoking remote method 'skills:installImport': Error: Skill name is invalid",
          );
        }}
      />,
    );
    await m2.click(m2.byText("Import file"));
    await m2.click(m2.byText("Install selected"));
    assert.ok(m2.text().includes("Skill name is invalid"));
    assert.equal(m2.text().includes("Error invoking remote method"), false);
    m2.unmount();
  });

  it("labels catalog source links and unique row actions for focus", async () => {
    const m = await mount(
      <Harness
        catalog={[catalogEntry()]}
        skills={[
          SKILLS[0],
          {
            ...SKILLS[1],
            name: "other-skill",
          },
        ]}
      />,
    );
    await openSkillsView(m, "catalog");
    const link = m.query('[data-catalog="ponytail"] a');
    assert.ok(link);
    assert.ok(link.getAttribute("href")?.includes("github.com"));
    assert.ok(
      link.getAttribute("aria-label")?.includes("Ponytail"),
      "catalog source link must include the entry name",
    );
    await openSkillsView(m, "library");
    await expandSkill(m, "claude:review-pr");
    await expandSkill(m, "agents:other-skill");
    const labels = m
      .queryAll('button[aria-label^="Remove "]')
      .map((b) => b.getAttribute("aria-label"));
    assert.ok(labels.includes("Remove review-pr"));
    assert.ok(labels.includes("Remove other-skill"));
    assert.equal(new Set(labels).size, labels.length);
    m.unmount();
  });

  it("discards the open preview on unmount and ignores a stale result", async () => {
    const discarded: Array<{ previewId: string }> = [];
    const m = await mount(
      <Harness
        onPickSkillImport={() =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve(
                preview({
                  previewId: "late-1",
                  source: { kind: "local", label: "late.zip" },
                }),
              );
            }, 15);
          })
        }
        onDiscardSkillImport={(input) => discarded.push(input)}
      />,
    );
    const importBtn = m.byText("Import file");
    assert.ok(importBtn);
    await inAct(async () => {
      importBtn.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    m.unmount();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(discarded, [{ previewId: "late-1" }]);
  });

  it("discards a shown preview on unmount exactly once", async () => {
    const discarded: Array<{ previewId: string }> = [];
    const m = await mount(
      <Harness
        onPickSkillImport={() => preview({ previewId: "open-1" })}
        onDiscardSkillImport={(input) => discarded.push(input)}
      />,
    );
    await m.click(m.byText("Import file"));
    assert.ok(m.query("[data-import-preview]"));
    m.unmount();
    assert.deepEqual(discarded, [{ previewId: "open-1" }]);
  });

  it("replaces a preview by discarding the old id and keeps only the newer result", async () => {
    const discarded: Array<{ previewId: string }> = [];
    let picks = 0;
    const m = await mount(
      <Harness
        onPickSkillImport={() => {
          picks += 1;
          return preview({
            previewId: `prev-${picks}`,
            source: { kind: "local", label: picks === 1 ? "first.zip" : "second.zip" },
            skills: [previewSkill({ name: picks === 1 ? "alpha" : "beta" })],
          });
        }}
        onDiscardSkillImport={(input) => discarded.push(input)}
      />,
    );
    await m.click(m.byText("Import file"));
    assert.ok(m.query("[data-import-preview]")?.textContent?.includes("first.zip"));
    await m.click(m.byText("Import file"));
    assert.deepEqual(discarded, [{ previewId: "prev-1" }]);
    const panel = m.query("[data-import-preview]");
    assert.ok(panel?.textContent?.includes("second.zip"));
    assert.equal(panel?.textContent?.includes("first.zip"), false);
    m.unmount();
    assert.deepEqual(discarded, [
      { previewId: "prev-1" },
      { previewId: "prev-2" },
    ]);
  });

  it("ignores a same-tick double import and discards a slower stale preview", async () => {
    const discarded: Array<{ previewId: string }> = [];
    let picks = 0;
    const m = await mount(
      <Harness
        onPickSkillImport={() => {
          picks += 1;
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve(
                preview({
                  previewId: "slow-1",
                  source: { kind: "local", label: "slow.zip" },
                }),
              );
            }, 15);
          });
        }}
        onDiscardSkillImport={(input) => discarded.push(input)}
      />,
    );
    const importBtn = m.byText("Import file");
    assert.ok(importBtn);
    await inAct(async () => {
      importBtn.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      importBtn.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    assert.equal(picks, 1, "same-tick double click must not start a second pick");
    m.unmount();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(
      discarded.some((d) => d.previewId === "slow-1"),
      "stale preview that arrives after unmount must be discarded",
    );
    assert.equal(
      discarded.filter((d) => d.previewId === "slow-1").length,
      1,
      "stale discard must happen once",
    );
  });

  it("keeps the current preview installable when a replacement is canceled or fails", async () => {
    const discarded: Array<{ previewId: string }> = [];
    let picks = 0;
    const m = await mount(
      <Harness
        onPickSkillImport={() => {
          picks += 1;
          if (picks === 1) {
            return preview({
              previewId: "keep-1",
              source: { kind: "local", label: "keep.zip" },
              skills: [previewSkill({ name: "ship-it" })],
            });
          }
          return null;
        }}
        onPreviewSkillImport={() => {
          throw new Error(
            "Error invoking remote method 'skills:previewImport': Error: Unsupported GitHub URL",
          );
        }}
        onDiscardSkillImport={(input) => discarded.push(input)}
      />,
    );
    await m.click(m.byText("Import file"));
    assert.ok(m.query("[data-import-preview]")?.textContent?.includes("keep.zip"));
    assert.equal(
      (m.byText("Install selected") as HTMLButtonElement).disabled,
      false,
    );

    await m.click(m.byText("Import file"));
    assert.equal(picks, 2);
    assert.deepEqual(discarded, [], "canceled picker must not discard the live preview");
    assert.ok(m.query("[data-import-preview]")?.textContent?.includes("keep.zip"));
    assert.equal(
      (m.byText("Install selected") as HTMLButtonElement).disabled,
      false,
      "canceled replacement must leave Install selected enabled",
    );

    await m.type(
      m.query('input[aria-label="GitHub URL"]'),
      "https://example.com/not-github",
    );
    await m.click(m.byText("Preview"));
    assert.ok(m.text().includes("Unsupported GitHub URL"));
    assert.deepEqual(discarded, [], "failed preview must not discard the live preview");
    assert.ok(m.query("[data-import-preview]")?.textContent?.includes("keep.zip"));
    assert.equal(
      (m.byText("Install selected") as HTMLButtonElement).disabled,
      false,
      "failed replacement must leave Install selected enabled",
    );
    m.unmount();
    assert.deepEqual(discarded, [{ previewId: "keep-1" }]);
  });

  it("does not discard when unmounting during a pending install", async () => {
    const discarded: Array<{ previewId: string }> = [];
    const m = await mount(
      <Harness
        onPickSkillImport={() =>
          preview({
            previewId: "installing-1",
            skills: [previewSkill({ name: "ship-it" })],
          })
        }
        onInstallSkillImport={() =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                installed: [
                  { name: "ship-it", installedIn: [...ALL_TARGETS] },
                ],
                plugins: [],
              });
            }, 40);
          })
        }
        onDiscardSkillImport={(input) => discarded.push(input)}
      />,
    );
    await m.click(m.byText("Import file"));
    const installBtn = m.byText("Install selected");
    assert.ok(installBtn);
    await inAct(async () => {
      installBtn.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    m.unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      discarded,
      [],
      "unmount mid-install must not discard; backend owns the stage",
    );
  });

  it("discards a failed install preview after unmount so it does not leak until TTL", async () => {
    const discarded: Array<{ previewId: string }> = [];
    let rejectInstall: ((err: Error) => void) | null = null;
    const m = await mount(
      <Harness
        onPickSkillImport={() =>
          preview({
            previewId: "install-fail-1",
            skills: [previewSkill({ name: "ship-it" })],
          })
        }
        onInstallSkillImport={() =>
          new Promise((_, reject) => {
            rejectInstall = reject;
          })
        }
        onDiscardSkillImport={(input) => discarded.push(input)}
      />,
    );
    await m.click(m.byText("Import file"));
    await inAct(async () => {
      m.byText("Install selected").dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    m.unmount();
    await inAct(async () => {
      rejectInstall?.(new Error("Skill name is invalid"));
      await Promise.resolve();
    });
    assert.deepEqual(discarded, [{ previewId: "install-fail-1" }]);
  });

  it("keeps a failed install preview for retry while still mounted", async () => {
    const discarded: Array<{ previewId: string }> = [];
    let installs = 0;
    const m = await mount(
      <Harness
        onPickSkillImport={() =>
          preview({
            previewId: "install-retry-1",
            skills: [previewSkill({ name: "ship-it" })],
          })
        }
        onInstallSkillImport={() => {
          installs += 1;
          if (installs === 1) throw new Error("Skill name is invalid");
          return {
            installed: [{ name: "ship-it", installedIn: [...ALL_TARGETS] }],
            plugins: [],
          };
        }}
        onDiscardSkillImport={(input) => discarded.push(input)}
      />,
    );
    await m.click(m.byText("Import file"));
    await m.click(m.byText("Install selected"));
    assert.ok(m.text().includes("Skill name is invalid"));
    assert.ok(m.query("[data-import-preview]"));
    assert.deepEqual(discarded, []);
    await m.click(m.byText("Install selected"));
    assert.equal(installs, 2);
    assert.equal(m.query("[data-import-preview]"), null);
    assert.deepEqual(discarded, []);
    m.unmount();
    assert.deepEqual(discarded, []);
  });
});

describe("SkillsTab harness import", () => {
  it("scans Claude Code, selects remaining, and installs them", async () => {
    const installed: HarnessInstallRequest[] = [];
    const m = await mount(
      <Harness
        onInstallHarnessImport={(input) => {
          installed.push(input);
        }}
      />,
    );
    await openSkillsView(m, "add");
    const claude = m.query(
      '[data-harness-source="claude"]',
    ) as HTMLButtonElement | null;
    const cursor = m.query(
      '[data-harness-source="cursor"]',
    ) as HTMLButtonElement | null;
    assert.ok(claude);
    assert.equal(claude?.disabled, false);
    assert.equal(cursor?.disabled, true);
    await m.click(claude);
    const panel = m.query("[data-harness-preview]");
    assert.ok(panel);
    const remaining = m.query(
      'input[aria-label="Select house-style"]',
    ) as HTMLInputElement | null;
    const already = m.query(
      'input[aria-label="Select already"]',
    ) as HTMLInputElement | null;
    assert.equal(remaining?.checked, true);
    assert.equal(already?.checked, false);
    await m.click(m.byText("Import selected"));
    assert.equal(installed.length, 1);
    assert.deepEqual(installed[0].selected, ["skill:house-style"]);
    assert.equal(installed[0].trustPluginCode, false);
    m.unmount();
  });

  it("requires plugin trust and sends trustPluginCode", async () => {
    const installed: HarnessInstallRequest[] = [];
    const m = await mount(
      <Harness
        onPreviewHarnessImport={() => ({
          previewId: "h".repeat(32),
          source: { id: "claude" as const, label: "Claude Code" },
          skills: [
            {
              id: "skill:ponytail-help",
              name: "ponytail-help",
              description: "Helper",
              origin: "plugin",
              bytes: 80,
              alreadyImported: false,
              warnings: [],
            },
          ],
          commands: [],
          mcp: [],
          memories: [],
          instructions: [],
          settings: null,
          warnings: [],
          plugins: [
            {
              provider: "claude",
              label: "ponytail",
              executableFiles: ["hooks/setup.sh"],
              activation: { kind: "claude-plugin", status: "pending" },
            },
            {
              provider: "hooks",
              label: "Hooks",
              executableFiles: ["hooks/setup.sh"],
              activation: { kind: "hooks", status: "pending" },
            },
          ],
        })}
        onInstallHarnessImport={(input) => {
          installed.push(input);
        }}
      />,
    );
    await openSkillsView(m, "add");
    await m.click(m.query('[data-harness-source="claude"]') as HTMLButtonElement);
    const panel = m.query("[data-harness-preview]");
    assert.ok(panel?.textContent?.includes("ponytail"));
    assert.ok(panel?.textContent?.includes("hooks/setup.sh"));
    assert.ok(
      panel?.textContent?.toLowerCase().includes("activated after explicit trust") ||
        panel?.textContent?.toLowerCase().includes("activated after you trust"),
    );
    const install = m.byText("Import selected") as HTMLButtonElement;
    assert.equal(install.disabled, true);
    const ack = m.query(
      'input[aria-label="I trust this package and understand it may include executable instructions or hooks."]',
    ) as HTMLInputElement | null;
    assert.ok(ack, "plugin trust checkbox must render");
    await m.click(ack);
    assert.equal(
      (m.byText("Import selected") as HTMLButtonElement).disabled,
      false,
    );
    await m.click(m.byText("Import selected"));
    assert.equal(installed.length, 1);
    assert.equal(installed[0].trustPluginCode, true);
    assert.deepEqual(installed[0].selected, ["skill:ponytail-help"]);
    m.unmount();
  });

  it("lists slash commands and leaves already-imported ones unchecked", async () => {
    const installed: HarnessInstallRequest[] = [];
    const m = await mount(
      <Harness
        onPreviewHarnessImport={() => ({
          previewId: "c".repeat(32),
          source: { id: "claude", label: "Claude Code" },
          skills: [],
          commands: [
            {
              id: "command:user:draft",
              name: "draft",
              description: "Draft a changelog",
              origin: "user",
              bytes: 40,
              alreadyImported: false,
            },
            {
              id: "command:user:git:pr",
              name: "git:pr",
              description: "Open a pull request",
              origin: "user",
              bytes: 20,
              alreadyImported: true,
            },
          ],
          mcp: [],
          memories: [],
          instructions: [],
          settings: null,
          plugins: [],
          warnings: [],
        })}
        onInstallHarnessImport={(input) => {
          installed.push(input);
        }}
      />,
    );
    await openSkillsView(m, "add");
    await m.click(m.query('[data-harness-source="claude"]') as HTMLButtonElement);
    assert.ok(m.byText("/draft"));
    assert.ok(m.byText("/git:pr"));
    const remaining = m.query(
      'input[aria-label="Select /draft"]',
    ) as HTMLInputElement | null;
    const already = m.query(
      'input[aria-label="Select /git:pr"]',
    ) as HTMLInputElement | null;
    assert.equal(remaining?.checked, true);
    assert.equal(already?.checked, false);
    await m.click(m.byText("Import selected"));
    assert.deepEqual(installed[0].selected, ["command:user:draft"]);
    m.unmount();
  });

  it("lists Codex prompt rows in the Commands section", async () => {
    const installed: HarnessInstallRequest[] = [];
    const m = await mount(
      <Harness
        harnessSources={[
          { id: "claude", label: "Claude Code", present: false },
          { id: "cursor", label: "Cursor", present: false },
          { id: "codex", label: "Codex", present: true },
        ]}
        onPreviewHarnessImport={(input) => {
          assert.equal(input.source, "codex");
          return {
            previewId: "d".repeat(32),
            source: { id: "codex", label: "Codex" },
            skills: [],
            commands: [
              {
                id: "command:user:draft",
                name: "draft",
                description: "Draft a changelog",
                origin: "user",
                bytes: 40,
                alreadyImported: false,
              },
              {
                id: "command:user:git:pr",
                name: "git:pr",
                description: "Open a pull request",
                origin: "user",
                bytes: 20,
                alreadyImported: true,
              },
            ],
            mcp: [],
            memories: [],
            instructions: [],
            settings: null,
            plugins: [],
            warnings: [],
          };
        }}
        onInstallHarnessImport={(input) => {
          installed.push(input);
        }}
      />,
    );
    await openSkillsView(m, "add");
    await m.click(m.query('[data-harness-source="codex"]') as HTMLButtonElement);
    assert.ok(m.byText("/draft"));
    assert.ok(m.byText("/git:pr"));
    const remaining = m.query(
      'input[aria-label="Select /draft"]',
    ) as HTMLInputElement | null;
    const already = m.query(
      'input[aria-label="Select /git:pr"]',
    ) as HTMLInputElement | null;
    assert.equal(remaining?.checked, true);
    assert.equal(already?.checked, false);
    await m.click(m.byText("Import selected"));
    assert.deepEqual(installed[0].selected, ["command:user:draft"]);
    m.unmount();
  });

  it("lists plugin slash commands on the harness preview", async () => {
    const installed: HarnessInstallRequest[] = [];
    const m = await mount(
      <Harness
        onPreviewHarnessImport={() => ({
          previewId: "d".repeat(32),
          source: { id: "claude", label: "Claude Code" },
          skills: [],
          commands: [
            {
              id: "command:plugin:shipper:review",
              name: "shipper:review",
              description: "Review the diff",
              origin: "plugin",
              bytes: 40,
              alreadyImported: false,
            },
            {
              id: "command:plugin:shipper:git:pr",
              name: "shipper:git:pr",
              description: "Open a pull request",
              origin: "plugin",
              bytes: 20,
              alreadyImported: true,
            },
          ],
          mcp: [],
          memories: [],
          instructions: [],
          settings: null,
          plugins: [],
          warnings: [],
        })}
        onInstallHarnessImport={(input) => {
          installed.push(input);
        }}
      />,
    );
    await openSkillsView(m, "add");
    await m.click(m.query('[data-harness-source="claude"]') as HTMLButtonElement);
    assert.ok(m.byText("/shipper:review"));
    assert.ok(m.byText("/shipper:git:pr"));
    const remaining = m.query(
      'input[aria-label="Select /shipper:review"]',
    ) as HTMLInputElement | null;
    const already = m.query(
      'input[aria-label="Select /shipper:git:pr"]',
    ) as HTMLInputElement | null;
    assert.equal(remaining?.checked, true);
    assert.equal(already?.checked, false);
    await m.click(m.byText("Import selected"));
    assert.deepEqual(installed[0].selected, ["command:plugin:shipper:review"]);
    m.unmount();
  });
});

describe("SkillsTab library search and filters", () => {
  it("filters installed skills by case-insensitive name or description", async () => {
    const skills: SkillInfo[] = [];
    for (let i = 0; i < 200; i += 1) {
      skills.push({
        name: `skill-${String(i).padStart(3, "0")}`,
        description: `Generic helper ${i}`,
        source: "claude",
        installedIn: ["claude"],
        missingFrom: [],
        bytes: 80,
        provenance: "added",
      });
    }
    skills[147] = {
      name: "unique-needle",
      description: "Find me in a large library",
      source: "claude",
      installedIn: ["claude"],
      missingFrom: [],
      bytes: 80,
      provenance: "added",
    };
    const m = await mount(<Harness skills={skills} />);
    assert.equal(m.query("[data-skills-count]")?.textContent, "200/200");
    await m.type(m.query('input[aria-label="Search installed skills"]'), "UNIQUE-NEEDLE");
    assert.ok(m.query('[data-skill="claude:unique-needle"]'));
    assert.equal(m.queryAll("[data-skill]").length, 1);
    assert.equal(m.query("[data-skills-count]")?.textContent, "1/200");
    await m.type(
      m.query('input[aria-label="Search installed skills"]'),
      "find me in a large",
    );
    assert.ok(m.query('[data-skill="claude:unique-needle"]'));
    assert.equal(m.queryAll("[data-skill]").length, 1);
    m.unmount();
  });

  it("composes provider and source filters with honest counts that clear independently", async () => {
    const m = await mount(<Harness />);
    const user = m.query('[data-source-filter="added"]');
    const project = m.query('[data-source-filter="project"]');
    const claude = m.query('[data-provider-filter="claude"]');
    const kimi = m.query('[data-provider-filter="kimi"]');
    assert.ok(user?.textContent?.includes("2"));
    assert.ok(project?.textContent?.includes("1"));
    assert.ok(claude?.textContent?.includes("2"));
    assert.ok(kimi?.textContent?.includes("1"));
    await m.click(user);
    assert.equal(m.queryAll("[data-skill]").length, 2);
    assert.equal(m.query('[data-skill="project:local-rules"]'), null);
    await m.click(kimi);
    assert.ok(m.query('[data-skill="claude:review-pr"]'));
    assert.equal(m.query('[data-skill="agents:write-tests"]'), null);
    await m.click(kimi);
    assert.ok(m.query('[data-skill="agents:write-tests"]'));
    await m.click(user);
    assert.ok(m.query('[data-skill="project:local-rules"]'));
    const filtered = filterInstalledSkills(SKILLS, {
      query: "",
      sources: new Set(["added"]),
      providers: new Set(["kimi"]),
    });
    assert.deepEqual(filtered.map((s) => s.name), ["review-pr"]);
    assert.equal(
      sourceFilterCount(SKILLS, "added", { query: "", providers: new Set() }),
      2,
    );
    assert.equal(
      providerFilterCount(SKILLS, "kimi", { query: "", sources: new Set() }),
      1,
    );
    const next = toggleSetValue(new Set(["added"]), "added");
    assert.equal(next.size, 0);
    m.unmount();
  });

  it("preserves search when moving between library and catalog", async () => {
    const m = await mount(<Harness catalog={[catalogEntry()]} />);
    await m.type(m.query('input[aria-label="Search installed skills"]'), "write-tests");
    assert.equal(m.queryAll("[data-skill]").length, 1);
    await openSkillsView(m, "catalog");
    assert.ok(m.query('[data-catalog="ponytail"]'));
    await openSkillsView(m, "library");
    assert.equal(
      (m.query('input[aria-label="Search installed skills"]') as HTMLInputElement)
        .value,
      "write-tests",
    );
    assert.equal(m.queryAll("[data-skill]").length, 1);
    m.unmount();
  });

  it("ignores a late skills list from the previous project", async () => {
    let resolveOld!: (rows: SkillInfo[]) => void;
    const pendingOld = new Promise<SkillInfo[]>((resolve) => {
      resolveOld = resolve;
    });
    let listCalls = 0;
    function RaceHarness() {
      const [projectPath, setProjectPath] = useState("/old");
      return (
        <div>
          <button type="button" onClick={() => {
            setProjectPath("/new");
          }}>
            switch-project
          </button>
          <SkillsTab
            projectPath={projectPath}
            settings={settingsWith()}
            saveSettings={async (patch) => ({ ...settingsWith(), ...patch })}
            listMcpServers={async () => []}
            saveMcpServer={async (input) => definitionFromSave(input)}
            removeMcpServer={async () => {}}
            setMcpEnabled={async (input) => httpDef({ name: input.name, enabled: input.enabled })}
            listMcpCatalog={async () => []}
            pickMcpImport={async () => null}
            previewMcpImport={async () => {
              throw new Error("unused");
            }}
            installMcpImport={async () => ({ installed: [] })}
            discardMcpImport={async () => {}}
            listSkills={async (input) => {
              listCalls += 1;
              if (input?.projectPath === "/old") return pendingOld;
              return [
                {
                  name: "new-project-skill",
                  description: "Only on the new project",
                  source: "claude",
                  installedIn: ["claude"],
                  missingFrom: [],
                  bytes: 40,
                  provenance: "added",
                },
              ];
            }}
            addSkill={async (input) => ({ name: input.name, installedIn: [] })}
            removeSkill={async () => {}}
            syncSkills={async () => ({ copied: 0, skills: [] })}
            listSkillCatalog={async () => []}
            pickSkillImport={async () => null}
            previewSkillImport={async () => preview()}
            installSkillImport={async () => ({ installed: [], plugins: [] })}
            discardSkillImport={async () => {}}
            detectHarnessSources={async () => []}
            previewHarnessImport={async () => {
              throw new Error("unused");
            }}
            installHarnessImport={async () => ({
              skills: [],
              commands: [],
              mcp: [],
              memories: [],
              instructions: [],
              settings: null,
              plugins: [],
            })}
            discardHarnessImport={async () => {}}
          />
        </div>
      );
    }
    const m = await mount(<RaceHarness />);
    await m.click(m.byText("switch-project"));
    await inAct(async () => {
      resolveOld([
        {
          name: "old-project-skill",
          description: "Stale",
          source: "claude",
          installedIn: ["claude"],
          missingFrom: [],
          bytes: 40,
          provenance: "added",
        },
      ]);
    });
    await m.flush();
    assert.ok(m.query('[data-skill="claude:new-project-skill"]'));
    assert.equal(m.query('[data-skill="claude:old-project-skill"]'), null);
    assert.ok(listCalls >= 2);
    m.unmount();
  });
});
