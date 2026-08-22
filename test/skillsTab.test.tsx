/**
 * SkillsTab, mounted for real: list render, MCP add-form validation, the
 * enable/disable toggle, and skill add/remove/sync with inline confirm.
 *
 * Run: node --import=./test/support/render.mjs --test test/skillsTab.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { useRef, useState } from "react";
import { mount, unmountAll } from "./support/dom.ts";
import { SkillsTab } from "../src/components/SkillsTab";
import type {
  AppSettings,
  SkillInfo,
  SkillTarget,
  SkillWrite,
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
  },
  {
    name: "write-tests",
    description: "Add tests for the current change",
    source: "agents",
    installedIn: ["claude", "agents", "codex", "grok", "opencode"],
    missingFrom: ["kimi"],
    bytes: 800,
  },
  {
    name: "local-rules",
    description: "Project-local rules",
    source: "project",
    installedIn: [],
    missingFrom: [],
    bytes: 400,
  },
];

function settingsWith(
  mcpServers: AppSettings["mcpServers"] = [],
): AppSettings {
  return { dailyBudgetUsd: null, autoSettleAfterDays: 3, mcpServers };
}

interface HarnessOptions {
  settings?: AppSettings;
  skills?: SkillInfo[];
  onSaveSettings?: (patch: Partial<AppSettings>) => void;
  onAddSkill?: (input: SkillWrite) => void;
  onRemoveSkill?: (input: { name: string }) => void;
  onSyncSkills?: () => { copied: number; skills: string[] } | void;
  onListSkills?: (input?: { projectPath?: string }) => void;
}

/**
 * Stateful wrapper: the tab reads mcpServers from the settings PROP, so the
 * harness applies each saved patch the way useCoder does. Skills are held
 * in a ref so sync/add/remove mutations are visible to the next listSkills.
 */
function Harness(opts: HarnessOptions) {
  const [settings, setSettings] = useState<AppSettings>(
    opts.settings ?? settingsWith(),
  );
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
      listSkills={async (input) => {
        opts.onListSkills?.(input);
        return skillsRef.current.map((s) => ({
          ...s,
          installedIn: [...s.installedIn],
          missingFrom: [...s.missingFrom],
        }));
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

describe("SkillsTab lists", () => {
  it("renders built-ins, user servers, and skills with source badges", async () => {
    const m = await mount(
      <Harness
        settings={settingsWith([
          {
            name: "team-tools",
            url: "https://tools.example.com/mcp",
            enabled: true,
          },
        ])}
      />,
    );
    assert.ok(m.text().includes("coder-memory"), "built-in must render");
    assert.ok(m.text().includes("coder-threads"), "built-in must render");
    assert.ok(m.text().includes("Built-in"), "built-in badge must render");
    assert.ok(m.text().includes("team-tools"), "user server must render");
    assert.ok(
      m.text().includes("https://tools.example.com/mcp"),
      "user server URL must render",
    );
    assert.ok(m.text().includes("review-pr"), "skill must render");
    assert.ok(
      m.text().includes("Review a pull request end to end"),
      "skill description must render",
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
    const claudeRow = m.query('[data-skill="claude:review-pr"]');
    assert.ok(claudeRow?.textContent?.includes("Remove"));
    m.unmount();
  });

  it("renders coverage and token cost per row", async () => {
    const m = await mount(<Harness />);
    const synced = m.query('[data-skill="claude:review-pr"]');
    assert.ok(synced, "synced skill row must render");
    const syncedCoverage = synced.querySelector("[data-coverage]");
    assert.equal(syncedCoverage?.textContent, "7/7");
    assert.ok(
      syncedCoverage?.getAttribute("title")?.includes("Claude"),
      "coverage title lists installed targets",
    );
    assert.equal(
      synced.querySelector("[data-tokens]")?.textContent,
      "~1.2k tokens",
    );

    const drifted = m.query('[data-skill="agents:write-tests"]');
    assert.ok(drifted, "drifted skill row must render");
    assert.equal(drifted.querySelector("[data-coverage]")?.textContent, "5/6");
    assert.equal(
      drifted.querySelector("[data-tokens]")?.textContent,
      "~200 tokens",
    );

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
  it("adds a server through the settings surface", async () => {
    const saved: Partial<AppSettings>[] = [];
    const m = await mount(<Harness onSaveSettings={(p) => saved.push(p)} />);
    await m.type(m.query('input[aria-label="MCP server name"]'), "team-tools");
    await m.type(
      m.query('input[aria-label="MCP server URL"]'),
      "https://tools.example.com/mcp",
    );
    await m.type(m.query('input[aria-label="MCP bearer token"]'), "sekrit");
    await m.click(m.byText("Add server"));

    assert.equal(saved.length, 1, "saveSettings must fire once");
    assert.deepEqual(saved[0].mcpServers, [
      {
        name: "team-tools",
        url: "https://tools.example.com/mcp",
        token: "sekrit",
        enabled: true,
      },
    ]);
    assert.ok(m.text().includes("team-tools"), "new row must render");
    m.unmount();
  });

  it("rejects bad names, duplicate names, and non-http URLs without saving", async () => {
    const saved: Partial<AppSettings>[] = [];
    const m = await mount(
      <Harness
        settings={settingsWith([
          { name: "taken", url: "https://a.example.com/mcp", enabled: true },
        ])}
        onSaveSettings={(p) => saved.push(p)}
      />,
    );
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
    m.unmount();
  });

  it("toggle flips enabled through saveSettings", async () => {
    const saved: Partial<AppSettings>[] = [];
    const m = await mount(
      <Harness
        settings={settingsWith([
          { name: "team-tools", url: "https://a.example.com/mcp", enabled: true },
        ])}
        onSaveSettings={(p) => saved.push(p)}
      />,
    );
    const toggle = m.query(
      'input[aria-label="Enable team-tools"]',
    ) as HTMLInputElement | null;
    assert.ok(toggle, "toggle must render");
    assert.equal(toggle.checked, true);
    await m.click(toggle);
    assert.equal(saved.length, 1, "toggle must save");
    assert.deepEqual(saved[0].mcpServers, [
      { name: "team-tools", url: "https://a.example.com/mcp", enabled: false },
    ]);
    const after = m.query(
      'input[aria-label="Enable team-tools"]',
    ) as HTMLInputElement;
    assert.equal(after.checked, false, "the row must reflect the saved state");
    m.unmount();
  });

  it("Remove drops the server through saveSettings", async () => {
    const saved: Partial<AppSettings>[] = [];
    const m = await mount(
      <Harness
        settings={settingsWith([
          { name: "team-tools", url: "https://a.example.com/mcp", enabled: true },
        ])}
        onSaveSettings={(p) => saved.push(p)}
      />,
    );
    const row = m.query('[data-mcp="team-tools"]');
    const btn = Array.from(row?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("Remove"),
    );
    await m.click(btn ?? null);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].mcpServers, []);
    assert.equal(
      m.query('[data-mcp="team-tools"]'),
      null,
      "the row must disappear",
    );
    m.unmount();
  });

  it("shows a backend validation error instead of pretending success", async () => {
    const m = await mount(
      <Harness
        onSaveSettings={() => {
          throw new Error(
            "Error invoking remote method 'settings:set': Error: MCP server URL must be http(s)",
          );
        }}
      />,
    );
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

describe("SkillsTab skills", () => {
  it("adds a skill with name, description, and body, and no target field", async () => {
    const added: SkillWrite[] = [];
    const m = await mount(<Harness onAddSkill={(i) => added.push(i)} />);
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
    await m.click(m.byText("Add skill"));

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
    await m.type(m.query('input[aria-label="Skill name"]'), "Bad Name");
    await m.type(
      m.query('input[aria-label="Skill description"]'),
      "d",
    );
    await m.type(m.query('textarea[aria-label="Skill body"]'), "b");
    await m.click(m.byText("Add skill"));
    assert.equal(added.length, 0, "invalid name must not call addSkill");
    assert.ok(m.text().includes("lowercase letters, digits, dashes"));

    await m.type(m.query('input[aria-label="Skill name"]'), "ok-name");
    await m.type(m.query('input[aria-label="Skill description"]'), "");
    await m.click(m.byText("Add skill"));
    assert.equal(added.length, 0, "empty description must not call addSkill");
    assert.ok(m.text().includes("Description is required"));
    m.unmount();
  });

  it("remove asks inline, then deletes by name from all providers", async () => {
    const removed: Array<{ name: string }> = [];
    const m = await mount(<Harness onRemoveSkill={(i) => removed.push(i)} />);
    const row = m.query('[data-skill="claude:review-pr"]');
    assert.ok(row, "skill row must render");
    const removeBtn = Array.from(row.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Remove"),
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
    assert.equal(syncBtn.disabled, false, "Sync is enabled when there is drift");
    await m.click(syncBtn);
    assert.equal(syncs, 1, "syncSkills must fire once");
    assert.equal(listed.length, 2, "listSkills must reload after sync");
    assert.ok(m.text().includes("Copied 1 skill"), "sync reports what it did");
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
          },
        ]}
      />,
    );
    const syncBtn = m.query(
      'button[aria-label="Sync missing skills"]',
    ) as HTMLButtonElement | null;
    assert.ok(syncBtn, "Sync button must render");
    assert.equal(syncBtn.disabled, true);
    m.unmount();
  });
});
