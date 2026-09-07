/**
 * Harness home scan, preview staging, and idempotent install.
 * Never executes imported files. Run:
 *   node --test electron/test/harness-imports.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  detectSources,
  previewImport,
  installImport,
  discardImport,
  parseCodexMcpToml,
  PREVIEW_TTL_MS,
} = require("../harnessImports.js");
const { SKILL_DIRS, listSkills } = require("../skills.js");
const { encodeClaudeProjectDir } = require("../cli-sessions.js");
const { listInvocableCommands } = require("../cliCommands.js");

let tmp;
let userData;
let env;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-harness-"));
  userData = path.join(tmp, "user-data");
  env = { HOME: path.join(tmp, "home") };
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(env.HOME, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function skillMd(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody for ${name}.\n`;
}

function writeSkill(base, name, description) {
  writeFile(path.join(base, name, "SKILL.md"), skillMd(name, description));
}

function activate(...targets) {
  const dirs = SKILL_DIRS(env);
  for (const t of targets) {
    fs.mkdirSync(path.dirname(dirs[t]), { recursive: true });
  }
}

function memoryStub(existingTitles) {
  const stored = [];
  const titles = new Set(existingTitles || []);
  return {
    stored,
    async search({ query }) {
      return titles.has(query) ? [{ title: query }] : [];
    },
    async store(input) {
      if (titles.has(input.title)) {
        throw new Error(
          `near-duplicate of existing entry x "${input.title}" (jaccard=0.9); pass force: true to store anyway`,
        );
      }
      stored.push(input);
      titles.add(input.title);
      return { id: `mem-${stored.length}` };
    },
  };
}

describe("parseCodexMcpToml", () => {
  it("extracts command, args, url, and env tables", () => {
    const map = parseCodexMcpToml(`
[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]

[mcp_servers.github.env]
GITHUB_TOKEN = "secret-value"

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"

[sandbox]
enabled = true
`);
    assert.equal(map.github.command, "npx");
    assert.deepEqual(map.github.args, ["-y", "@modelcontextprotocol/server-github"]);
    assert.equal(map.github.env.GITHUB_TOKEN, "secret-value");
    assert.equal(map.linear.url, "https://mcp.linear.app/mcp");
    assert.equal(map.sandbox, undefined);
  });
});

describe("detectSources", () => {
  it("reports present only when the home directory exists", () => {
    fs.mkdirSync(path.join(env.HOME, ".claude"), { recursive: true });
    const rows = detectSources({ env });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId.claude.present, true);
    assert.equal(byId.cursor.present, false);
    assert.equal(byId.codex.present, false);
    assert.equal(byId.claude.label, "Claude Code");
  });
});

describe("previewImport", () => {
  it("throws when the harness home is missing", async () => {
    await assert.rejects(
      () =>
        previewImport({
          userDataPath: userData,
          source: "claude",
          env,
        }),
      /Claude Code home not found/,
    );
  });

  it("scans skills-cursor, MCP, memories, instructions, and settings without copying the home", async () => {
    const claude = path.join(env.HOME, ".claude");
    const cursor = path.join(env.HOME, ".cursor");
    const project = path.join(tmp, "proj");
    fs.mkdirSync(claude, { recursive: true });
    fs.mkdirSync(cursor, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    writeSkill(path.join(claude, "skills"), "already-here", "Already listed");
    writeSkill(path.join(cursor, "skills-cursor"), "cursor-only", "Cursor managed");
    writeFile(
      path.join(claude, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          notes: {
            url: "https://notes.example/mcp",
            headers: { Authorization: "Bearer SECRET" },
          },
          local: { command: "node", args: ["server.js"], env: { TOKEN: "s" } },
        },
      }),
    );
    writeFile(
      path.join(claude, "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: "sk-secret", FOO: "bar" },
        sandbox: { enabled: true },
      }),
    );
    writeFile(path.join(claude, "CLAUDE.md"), "# House style\n\nUse tabs.\n");
    const encoded = encodeClaudeProjectDir(project);
    writeFile(
      path.join(claude, "projects", encoded, "memory", "decisions.md"),
      "# Use worktrees\n\nAlways bind a worktree.\n",
    );
    writeFile(path.join(claude, "sessions", "secret.jsonl"), "do-not-copy");
    activate("claude", "codex");
    writeSkill(SKILL_DIRS(env).claude, "already-here", "Already listed");

    const preview = await previewImport({
      userDataPath: userData,
      source: "cursor",
      projectPath: project,
      current: [],
      env,
    });
    assert.equal(preview.source.id, "cursor");
    assert.ok(preview.skills.some((s) => s.name === "cursor-only"));
    assert.equal(
      preview.skills.find((s) => s.name === "cursor-only").alreadyImported,
      false,
    );

    const claudePreview = await previewImport({
      userDataPath: userData,
      source: "claude",
      projectPath: project,
      current: [{ name: "notes" }],
      env,
      memory: memoryStub(),
    });
    const names = claudePreview.skills.map((s) => s.name);
    assert.ok(names.includes("already-here"));
    assert.equal(
      claudePreview.skills.find((s) => s.name === "already-here").alreadyImported,
      true,
    );
    const notes = claudePreview.mcp.find((s) => s.name === "notes");
    assert.ok(notes);
    assert.equal(notes.alreadyImported, true);
    assert.equal(notes.hasSecrets, true);
    assert.ok(!JSON.stringify(claudePreview).includes("SECRET"));
    assert.ok(!JSON.stringify(claudePreview).includes("sk-secret"));
    const local = claudePreview.mcp.find((s) => s.name === "local");
    assert.equal(local.requiresTrust, true);
    assert.equal(local.transport, "stdio");
    assert.ok(claudePreview.memories.some((m) => /Use worktrees/.test(m.title)));
    assert.ok(claudePreview.instructions.some((m) => /House style/.test(m.title)));
    assert.ok(claudePreview.settings);
    assert.match(claudePreview.settings.summary, /ANTHROPIC_API_KEY/);
    assert.match(claudePreview.settings.summary, /sandbox enabled: true/);
    assert.ok(!claudePreview.settings.summary.includes("sk-secret"));

    const stagedRoot = path.join(userData, "harness-imports");
    const ids = fs.readdirSync(stagedRoot);
    assert.ok(ids.length >= 1);
    for (const id of ids) {
      const stage = path.join(stagedRoot, id, "stage");
      assert.equal(fs.existsSync(path.join(stage, "sessions")), false);
      assert.equal(
        fs.existsSync(path.join(stage, "secret.jsonl")),
        false,
      );
    }
  });

  it("parses Codex config.toml MCP servers", async () => {
    const home = path.join(env.HOME, ".codex");
    fs.mkdirSync(home, { recursive: true });
    writeFile(
      path.join(home, "config.toml"),
      `[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"

[mcp_servers.shell]
command = "npx"
args = ["-y", "mcp-shell"]
`,
    );
    const preview = await previewImport({
      userDataPath: userData,
      source: "codex",
      current: [],
      env,
    });
    const names = preview.mcp.map((s) => s.name).sort();
    assert.deepEqual(names, ["context7", "shell"]);
    assert.equal(preview.mcp.find((s) => s.name === "shell").requiresTrust, true);
  });
});

describe("installImport", () => {
  it("fans out a new skill and skips it on re-run", async () => {
    const cursor = path.join(env.HOME, ".cursor");
    fs.mkdirSync(cursor, { recursive: true });
    writeSkill(path.join(cursor, "skills-cursor"), "cursor-only", "Cursor managed");
    activate("claude", "codex", "cursor");

    const preview = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const selected = preview.skills
      .filter((s) => !s.alreadyImported)
      .map((s) => s.id);
    const first = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected,
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(first.skills[0].status, "installed");
    const listed = listSkills(null, env, userData);
    assert.ok(listed.some((s) => s.name === "cursor-only"));

    const preview2 = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const again = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview2.previewId,
        selected: preview2.skills.map((s) => s.id),
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(again.skills[0].status, "skipped");
  });

  it("requires trust for stdio MCP and upserts http servers", async () => {
    const claude = path.join(env.HOME, ".claude");
    fs.mkdirSync(claude, { recursive: true });
    writeFile(
      path.join(claude, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          notes: { url: "https://notes.example/mcp" },
          local: { command: "node", args: ["server.js"] },
        },
      }),
    );
    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          env,
          current: [],
          saveMcp: () => {
            throw new Error("should not save");
          },
          request: {
            previewId: preview.previewId,
            selected: ["mcp:local"],
            replace: false,
            trustLocal: false,
          },
        }),
      /explicit trust/,
    );

    const preview2 = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    let saved = null;
    const result = await installImport({
      userDataPath: userData,
      env,
      current: [],
      saveMcp: (next) => {
        saved = next;
        return next;
      },
      request: {
        previewId: preview2.previewId,
        selected: ["mcp:notes"],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(result.mcp[0].status, "installed");
    assert.ok(saved.some((s) => s.name === "notes"));

    const preview3 = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: saved,
      env,
    });
    const skip = await installImport({
      userDataPath: userData,
      env,
      current: saved,
      saveMcp: () => {
        throw new Error("should not save on skip");
      },
      request: {
        previewId: preview3.previewId,
        selected: ["mcp:notes"],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(skip.mcp[0].status, "skipped");
  });

  it("stores memories and skips near-duplicates", async () => {
    const claude = path.join(env.HOME, ".claude");
    const project = path.join(tmp, "proj");
    fs.mkdirSync(claude, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    const encoded = encodeClaudeProjectDir(project);
    writeFile(
      path.join(claude, "projects", encoded, "memory", "decisions.md"),
      "# Use worktrees\n\nAlways bind a worktree.\n",
    );
    const memory = memoryStub();
    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      projectPath: project,
      current: [],
      env,
      memory,
    });
    const ids = preview.memories.map((m) => m.id);
    assert.ok(ids.length);
    const first = await installImport({
      userDataPath: userData,
      env,
      current: [],
      memory,
      projectPath: project,
      request: {
        previewId: preview.previewId,
        selected: ids,
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(first.memories[0].status, "stored");
    assert.equal(memory.stored[0].type, "knowledge");
    assert.equal(memory.stored[0].source, "import");

    const preview2 = await previewImport({
      userDataPath: userData,
      source: "claude",
      projectPath: project,
      current: [],
      env,
      memory,
    });
    const again = await installImport({
      userDataPath: userData,
      env,
      current: [],
      memory,
      projectPath: project,
      request: {
        previewId: preview2.previewId,
        selected: preview2.memories.map((m) => m.id),
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(again.memories[0].status, "skipped");
    assert.equal(memory.stored.length, 1);
  });

  it("does not execute a script that ships with an imported skill", async () => {
    const cursor = path.join(env.HOME, ".cursor");
    fs.mkdirSync(cursor, { recursive: true });
    writeSkill(path.join(cursor, "skills-cursor"), "with-hook", "Has a hook");
    const pwned = path.join(tmp, "pwned-harness");
    writeFile(
      path.join(cursor, "skills-cursor", "with-hook", "hooks", "setup.sh"),
      `#!/bin/sh\necho PWNED > "${pwned}"\n`,
    );
    activate("claude");
    const preview = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: ["skill:with-hook"],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(fs.existsSync(pwned), false);
    const dest = path.join(SKILL_DIRS(env).claude, "with-hook", "hooks", "setup.sh");
    assert.equal(fs.existsSync(dest), true);
  });

  it("discards a preview directory", async () => {
    const claude = path.join(env.HOME, ".claude");
    fs.mkdirSync(claude, { recursive: true });
    writeFile(path.join(claude, "CLAUDE.md"), "# Hi\n");
    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const dir = path.join(userData, "harness-imports", preview.previewId);
    assert.equal(fs.existsSync(dir), true);
    discardImport({ userDataPath: userData, previewId: preview.previewId });
    assert.equal(fs.existsSync(dir), false);
  });

  it("rejects an expired preview", async () => {
    const claude = path.join(env.HOME, ".claude");
    fs.mkdirSync(claude, { recursive: true });
    writeFile(path.join(claude, "CLAUDE.md"), "# Hi\n");
    const t0 = 1_700_000_000_000;
    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
      now: t0,
    });
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          env,
          current: [],
          now: t0 + PREVIEW_TTL_MS + 1,
          request: {
            previewId: preview.previewId,
            selected: preview.instructions.map((i) => i.id),
            replace: false,
            trustLocal: false,
          },
        }),
      /expired/,
    );
  });
});

describe("slash commands", () => {
  function writeCommand(file, description, body) {
    writeFile(
      file,
      `---\ndescription: ${description}\n---\n\n${body}\n`,
    );
  }

  it("lists user and project Claude command markdown, including nested names", async () => {
    const claude = path.join(env.HOME, ".claude");
    const project = path.join(tmp, "proj");
    fs.mkdirSync(claude, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    writeCommand(
      path.join(claude, "commands", "draft.md"),
      "Draft a changelog",
      "Write a changelog for $ARGUMENTS.",
    );
    writeCommand(
      path.join(claude, "commands", "git", "pr.md"),
      "Open a pull request",
      "Create the PR.",
    );
    writeCommand(
      path.join(project, ".claude", "commands", "ship.md"),
      "Ship the branch",
      "Merge and tag.",
    );
    writeFile(path.join(claude, "commands", "README.md"), "# skip me\n");
    writeFile(path.join(claude, "sessions", "secret.jsonl"), "do-not-copy");

    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      projectPath: project,
      current: [],
      env,
    });
    const byName = Object.fromEntries(
      preview.commands.map((c) => [c.name, c]),
    );
    assert.equal(byName.draft.description, "Draft a changelog");
    assert.equal(byName.draft.origin, "user");
    assert.equal(byName.draft.id, "command:user:draft");
    assert.equal(byName.draft.alreadyImported, false);
    assert.ok(byName["git:pr"], "nested git/pr.md becomes git:pr");
    assert.equal(byName["git:pr"].id, "command:user:git:pr");
    assert.equal(byName.ship.origin, "project");
    assert.equal(byName.ship.id, "command:project:ship");
    assert.equal(byName.README, undefined);
    assert.ok(!JSON.stringify(preview).includes("do-not-copy"));

    const stagedRoot = path.join(userData, "harness-imports");
    for (const id of fs.readdirSync(stagedRoot)) {
      assert.equal(
        fs.existsSync(path.join(stagedRoot, id, "stage", "sessions")),
        false,
      );
    }
  });

  it("does not list Cursor or Codex command markdown", async () => {
    fs.mkdirSync(path.join(env.HOME, ".cursor"), { recursive: true });
    fs.mkdirSync(path.join(env.HOME, ".codex"), { recursive: true });
    writeCommand(
      path.join(env.HOME, ".cursor", "commands", "nope.md"),
      "Cursor only",
      "Do not import.",
    );
    writeCommand(
      path.join(env.HOME, ".codex", "commands", "nope.md"),
      "Codex only",
      "Do not import.",
    );
    const cursor = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const codex = await previewImport({
      userDataPath: userData,
      source: "codex",
      current: [],
      env,
    });
    assert.deepEqual(cursor.commands, []);
    assert.deepEqual(codex.commands, []);
  });

  it("marks a command already imported when ~/.grok/commands has the dest file", async () => {
    const claude = path.join(env.HOME, ".claude");
    fs.mkdirSync(claude, { recursive: true });
    writeCommand(
      path.join(claude, "commands", "draft.md"),
      "Draft a changelog",
      "Write a changelog for $ARGUMENTS.",
    );
    writeCommand(
      path.join(env.HOME, ".grok", "commands", "draft.md"),
      "Already copied",
      "Solenta copy.",
    );
    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const draft = preview.commands.find((c) => c.name === "draft");
    assert.ok(draft);
    assert.equal(draft.alreadyImported, true);
  });

  it("installs user commands into ~/.grok/commands and skips them on re-run", async () => {
    const claude = path.join(env.HOME, ".claude");
    fs.mkdirSync(claude, { recursive: true });
    writeCommand(
      path.join(claude, "commands", "draft.md"),
      "Draft a changelog",
      "Write a changelog for $ARGUMENTS.",
    );
    writeCommand(
      path.join(claude, "commands", "git", "pr.md"),
      "Open a pull request",
      "Create the PR.",
    );
    const pwned = path.join(tmp, "pwned-command");
    writeFile(
      path.join(claude, "commands", "hook.sh"),
      `#!/bin/sh\necho PWNED > "${pwned}"\n`,
    );

    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const selected = preview.commands.map((c) => c.id);
    const first = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected,
        replace: false,
        trustLocal: false,
      },
    });
    assert.deepEqual(
      first.commands.map((c) => c.status).sort(),
      ["installed", "installed"],
    );
    assert.equal(fs.existsSync(pwned), false);
    const destDraft = path.join(env.HOME, ".grok", "commands", "draft.md");
    const destPr = path.join(env.HOME, ".grok", "commands", "git", "pr.md");
    assert.equal(fs.existsSync(destDraft), true);
    assert.equal(fs.existsSync(destPr), true);
    assert.match(fs.readFileSync(destDraft, "utf8"), /\$ARGUMENTS/);
    const listed = listInvocableCommands({ env });
    assert.ok(listed.some((r) => r.name === "/draft" && r.kind === "command"));
    assert.ok(listed.some((r) => r.name === "/git:pr" && r.kind === "command"));

    const preview2 = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const again = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview2.previewId,
        selected: preview2.commands.map((c) => c.id),
        replace: false,
        trustLocal: false,
      },
    });
    assert.ok(again.commands.every((c) => c.status === "skipped"));
  });

  it("installs project commands into <project>/.grok/commands", async () => {
    const claude = path.join(env.HOME, ".claude");
    const project = path.join(tmp, "proj");
    fs.mkdirSync(claude, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    writeCommand(
      path.join(project, ".claude", "commands", "ship.md"),
      "Ship the branch",
      "Merge and tag.",
    );
    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      projectPath: project,
      current: [],
      env,
    });
    const ship = preview.commands.find((c) => c.name === "ship");
    assert.ok(ship);
    const result = await installImport({
      userDataPath: userData,
      env,
      current: [],
      projectPath: project,
      request: {
        previewId: preview.previewId,
        selected: [ship.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(result.commands[0].status, "installed");
    const dest = path.join(project, ".grok", "commands", "ship.md");
    assert.equal(fs.existsSync(dest), true);
    assert.equal(
      fs.existsSync(path.join(env.HOME, ".grok", "commands", "ship.md")),
      false,
      "project commands stay in the project",
    );
    const listed = listInvocableCommands({ projectPath: project, env });
    assert.ok(listed.some((r) => r.name === "/ship" && r.kind === "command"));
  });

  it("replaces an existing dest command when replace is true", async () => {
    const claude = path.join(env.HOME, ".claude");
    fs.mkdirSync(claude, { recursive: true });
    writeCommand(
      path.join(claude, "commands", "draft.md"),
      "New body",
      "Updated prompt.",
    );
    writeCommand(
      path.join(env.HOME, ".grok", "commands", "draft.md"),
      "Old body",
      "Stale prompt.",
    );
    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const result = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: ["command:user:draft"],
        replace: true,
        trustLocal: false,
      },
    });
    assert.equal(result.commands[0].status, "replaced");
    assert.match(
      fs.readFileSync(path.join(env.HOME, ".grok", "commands", "draft.md"), "utf8"),
      /Updated prompt/,
    );
  });
});

describe("plugin slash commands", () => {
  function writeCommand(file, description, body) {
    writeFile(
      file,
      `---\ndescription: ${description}\n---\n\n${body}\n`,
    );
  }

  function writeInstalledPlugin(opts) {
    const {
      name,
      installPath,
      files,
      commands,
      secret = "plugin-secret-value",
    } = opts;
    const manifest = { name };
    if (commands) manifest.commands = commands;
    writeFile(
      path.join(installPath, ".claude-plugin", "plugin.json"),
      JSON.stringify(manifest),
    );
    for (const [rel, description, body] of files) {
      writeCommand(path.join(installPath, rel), description, body);
    }
    writeFile(path.join(installPath, "commands", "README.md"), "# skip\n");
    writeFile(
      path.join(installPath, "hooks", "setup.sh"),
      `#!/bin/sh\necho ${secret}\n`,
    );
    const claudePlugins = path.join(env.HOME, ".claude", "plugins");
    fs.mkdirSync(claudePlugins, { recursive: true });
    const installedFile = path.join(claudePlugins, "installed_plugins.json");
    let json = { version: 2, plugins: {} };
    try {
      json = JSON.parse(fs.readFileSync(installedFile, "utf8"));
    } catch {
      /* first plugin */
    }
    json.plugins = json.plugins || {};
    json.plugins[`${name}@local`] = [
      { scope: "user", installPath },
    ];
    writeFile(installedFile, JSON.stringify(json));
  }

  it("lists installed plugin command markdown with ids that cannot collide with user slugs", async () => {
    const claude = path.join(env.HOME, ".claude");
    writeCommand(
      path.join(claude, "commands", "review.md"),
      "User review",
      "User body with user-secret-value.",
    );
    const installPath = path.join(
      claude,
      "plugins",
      "cache",
      "shipper-mp",
      "shipper",
      "1.0.0",
    );
    writeInstalledPlugin({
      name: "shipper",
      installPath,
      files: [
        ["commands/review.md", "Review the diff", "Review $ARGUMENTS."],
        ["commands/git/pr.md", "Open a pull request", "Create the PR."],
        [".claude/commands/ship.md", "Ship the branch", "Merge and tag."],
      ],
    });
    writeFile(
      path.join(
        claude,
        "plugins",
        "cache",
        "other",
        "9.0.0",
        "commands",
        "nope.md",
      ),
      "---\ndescription: Uninstalled cache copy\n---\n\nNope with cache-secret.\n",
    );
    writeFile(
      path.join(claude, "plugins", "marketplaces", "noise", "commands", "nope.md"),
      "---\ndescription: Marketplace copy\n---\n\nNope with market-secret.\n",
    );

    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const byName = Object.fromEntries(
      preview.commands.map((c) => [c.name, c]),
    );
    assert.equal(byName.review.id, "command:user:review");
    assert.equal(byName.review.origin, "user");
    assert.equal(byName["shipper:review"].id, "command:plugin:shipper:review");
    assert.equal(byName["shipper:review"].origin, "plugin");
    assert.equal(byName["shipper:review"].description, "Review the diff");
    assert.ok(byName["shipper:git:pr"], "nested git/pr.md becomes shipper:git:pr");
    assert.equal(byName["shipper:git:pr"].id, "command:plugin:shipper:git:pr");
    assert.ok(byName["shipper:ship"], "default .claude/commands is scanned");
    assert.equal(byName.README, undefined);
    assert.equal(byName.nope, undefined);
    assert.equal(byName["other:nope"], undefined);
    assert.equal(byName["noise:nope"], undefined);
    const dumped = JSON.stringify(preview);
    assert.ok(!dumped.includes("user-secret-value"));
    assert.ok(!dumped.includes("cache-secret"));
    assert.ok(!dumped.includes("market-secret"));
    assert.ok(!dumped.includes("plugin-secret-value"));

    const stagedRoot = path.join(userData, "harness-imports");
    for (const id of fs.readdirSync(stagedRoot)) {
      const stage = path.join(stagedRoot, id, "stage");
      assert.equal(fs.existsSync(path.join(stage, "cache")), false);
      assert.equal(fs.existsSync(path.join(stage, "marketplaces")), false);
      assert.equal(fs.existsSync(path.join(stage, "hooks")), false);
    }
  });

  it("follows plugin.json commands array instead of the default dirs", async () => {
    const installPath = path.join(
      env.HOME,
      ".claude",
      "plugins",
      "cache",
      "custom",
      "1.0.0",
    );
    writeInstalledPlugin({
      name: "custom",
      installPath,
      commands: ["./slash"],
      files: [
        ["slash/foo.md", "Custom slash", "Do foo."],
        ["commands/default.md", "Default dir", "Should not list."],
      ],
    });

    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const names = preview.commands.map((c) => c.name);
    assert.ok(names.includes("custom:foo"));
    assert.equal(names.includes("custom:default"), false);
  });

  function writePluginCommands(root, name, files) {
    writeFile(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name }),
    );
    writeFile(path.join(root, "plugin.json"), JSON.stringify({ name }));
    for (const [rel, description, body] of files) {
      writeCommand(path.join(root, rel), description, body);
    }
  }

  it("lists Codex enabled plugin commands without copying the cache tree", async () => {
    const codex = path.join(env.HOME, ".codex");
    const installPath = path.join(
      codex,
      "plugins",
      "cache",
      "mp",
      "shipper",
      "1.2.3",
    );
    writePluginCommands(installPath, "shipper", [
      ["commands/deploy.md", "Deploy the app", "Ship it with deploy-secret."],
      ["commands/git/pr.md", "Open a pull request", "Create the PR."],
    ]);
    writeFile(
      path.join(installPath, "hooks", "setup.sh"),
      "#!/bin/sh\necho plugin-secret-value\n",
    );
    writePluginCommands(
      path.join(codex, "plugins", "cache", "mp", "other", "9.0.0"),
      "other",
      [["commands/nope.md", "Disabled cache copy", "Nope with disabled-secret."]],
    );
    writePluginCommands(
      path.join(codex, "plugins", "cache", "orphan", "ghost", "1.0.0"),
      "ghost",
      [["commands/nope.md", "Unlisted cache copy", "Nope with cache-secret."]],
    );
    writeFile(
      path.join(codex, "config.toml"),
      [
        `[plugins."shipper@mp"]`,
        "enabled = true",
        "",
        `[plugins."other@mp"]`,
        "enabled = false",
        "",
        "api_key = \"toml-secret-value\"",
        "",
      ].join("\n"),
    );
    writeCommand(
      path.join(codex, "commands", "home.md"),
      "Home command",
      "Must stay out.",
    );

    const preview = await previewImport({
      userDataPath: userData,
      source: "codex",
      current: [],
      env,
    });
    const pluginCmds = preview.commands.filter((c) => c.origin === "plugin");
    const byName = Object.fromEntries(pluginCmds.map((c) => [c.name, c]));
    assert.equal(byName["shipper:deploy"].id, "command:plugin:shipper:deploy");
    assert.equal(byName["shipper:deploy"].description, "Deploy the app");
    assert.equal(byName["shipper:git:pr"].id, "command:plugin:shipper:git:pr");
    assert.equal(byName["other:nope"], undefined);
    assert.equal(byName["ghost:nope"], undefined);
    assert.equal(
      preview.commands.some((c) => c.name === "home" || c.origin === "user"),
      false,
    );
    const dumped = JSON.stringify(preview);
    assert.ok(!dumped.includes("deploy-secret"));
    assert.ok(!dumped.includes("plugin-secret-value"));
    assert.ok(!dumped.includes("toml-secret-value"));
    assert.ok(!dumped.includes("cache-secret"));
    const staged = path.join(
      userData,
      "harness-imports",
      preview.previewId,
      "stage",
    );
    assert.equal(fs.existsSync(path.join(staged, "cache")), false);
    assert.equal(fs.existsSync(path.join(staged, "hooks")), false);
  });

  it("lists Cursor local plugin commands and ignores cache plugins", async () => {
    const cursor = path.join(env.HOME, ".cursor");
    writePluginCommands(
      path.join(cursor, "plugins", "local", "shipper"),
      "shipper",
      [
        ["commands/review.md", "Review the diff", "Review $ARGUMENTS."],
        ["commands/git/pr.md", "Open a pull request", "Create the PR."],
      ],
    );
    writePluginCommands(
      path.join(
        cursor,
        "plugins",
        "cache",
        "cursor-public",
        "github",
        "abc123",
      ),
      "github",
      [["commands/nope.md", "Cached marketplace plugin", "Do not import."]],
    );
    writeCommand(
      path.join(cursor, "commands", "home.md"),
      "Home command",
      "Must stay out.",
    );

    const preview = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const byName = Object.fromEntries(
      preview.commands.map((c) => [c.name, c]),
    );
    assert.equal(byName["shipper:review"].id, "command:plugin:shipper:review");
    assert.equal(byName["shipper:review"].origin, "plugin");
    assert.equal(byName["shipper:git:pr"].id, "command:plugin:shipper:git:pr");
    assert.equal(byName["github:nope"], undefined);
    assert.equal(byName.home, undefined);
    const staged = path.join(
      userData,
      "harness-imports",
      preview.previewId,
      "stage",
    );
    assert.equal(fs.existsSync(path.join(staged, "cache")), false);
  });

  it("lists Cursor installed cache plugin commands without copying the cache tree", async () => {
    const cursor = path.join(env.HOME, ".cursor");
    const installPath = path.join(
      cursor,
      "plugins",
      "cache",
      "cursor-public",
      "shipper",
      "abc123",
    );
    writePluginCommands(installPath, "shipper", [
      ["commands/deploy.md", "Deploy the app", "Ship it with deploy-secret."],
      ["commands/git/pr.md", "Open a pull request", "Create the PR."],
    ]);
    writeFile(
      path.join(installPath, "hooks", "setup.sh"),
      "#!/bin/sh\necho plugin-secret-value\n",
    );
    writePluginCommands(
      path.join(cursor, "plugins", "cache", "cursor-public", "other", "def456"),
      "other",
      [["commands/nope.md", "Unlisted cache copy", "Nope with disabled-secret."]],
    );
    writePluginCommands(
      path.join(cursor, "plugins", "cache", "orphan", "ghost", "1.0.0"),
      "ghost",
      [["commands/nope.md", "Unlisted cache copy", "Nope with cache-secret."]],
    );
    writeFile(
      path.join(cursor, "plugins", "installed.json"),
      JSON.stringify({
        user: ["shipper@cursor-public"],
      }),
    );
    writeCommand(
      path.join(cursor, "commands", "home.md"),
      "Home command",
      "Must stay out.",
    );

    const preview = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const pluginCmds = preview.commands.filter((c) => c.origin === "plugin");
    const byName = Object.fromEntries(pluginCmds.map((c) => [c.name, c]));
    assert.equal(byName["shipper:deploy"].id, "command:plugin:shipper:deploy");
    assert.equal(byName["shipper:deploy"].description, "Deploy the app");
    assert.equal(byName["shipper:git:pr"].id, "command:plugin:shipper:git:pr");
    assert.equal(byName["other:nope"], undefined);
    assert.equal(byName["ghost:nope"], undefined);
    assert.equal(
      preview.commands.some((c) => c.name === "home" || c.origin === "user"),
      false,
    );
    const dumped = JSON.stringify(preview);
    assert.ok(!dumped.includes("deploy-secret"));
    assert.ok(!dumped.includes("plugin-secret-value"));
    assert.ok(!dumped.includes("disabled-secret"));
    assert.ok(!dumped.includes("cache-secret"));
    const staged = path.join(
      userData,
      "harness-imports",
      preview.previewId,
      "stage",
    );
    assert.equal(fs.existsSync(path.join(staged, "cache")), false);
    assert.equal(fs.existsSync(path.join(staged, "hooks")), false);
  });

  it("installs Codex plugin commands into ~/.grok/commands/<plugin>/ and skips them on re-run", async () => {
    const installPath = path.join(
      env.HOME,
      ".codex",
      "plugins",
      "cache",
      "mp",
      "shipper",
      "1.2.3",
    );
    writePluginCommands(installPath, "shipper", [
      ["commands/deploy.md", "Deploy the app", "Ship $ARGUMENTS."],
    ]);
    writeFile(
      path.join(env.HOME, ".codex", "config.toml"),
      `[plugins."shipper@mp"]\nenabled = true\n`,
    );

    const preview = await previewImport({
      userDataPath: userData,
      source: "codex",
      current: [],
      env,
    });
    const row = preview.commands.find((c) => c.name === "shipper:deploy");
    assert.ok(row);
    const first = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: [row.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(first.commands[0].status, "installed");
    const dest = path.join(env.HOME, ".grok", "commands", "shipper", "deploy.md");
    assert.equal(fs.existsSync(dest), true);
    assert.match(fs.readFileSync(dest, "utf8"), /\$ARGUMENTS/);
    assert.equal(
      fs.existsSync(path.join(env.HOME, ".grok", "commands", "deploy.md")),
      false,
      "plugin deploy.md must not land on the user slug dest",
    );
    const listed = listInvocableCommands({ env });
    assert.ok(
      listed.some((r) => r.name === "/shipper:deploy" && r.kind === "command"),
    );

    const preview2 = await previewImport({
      userDataPath: userData,
      source: "codex",
      current: [],
      env,
    });
    const againRow = preview2.commands.find((c) => c.name === "shipper:deploy");
    assert.equal(againRow.alreadyImported, true);
    const again = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview2.previewId,
        selected: [againRow.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(again.commands[0].status, "skipped");
  });

  it("installs Cursor local plugin commands into ~/.grok/commands/<plugin>/", async () => {
    writePluginCommands(
      path.join(env.HOME, ".cursor", "plugins", "local", "shipper"),
      "shipper",
      [["commands/review.md", "Review the diff", "Review $ARGUMENTS."]],
    );
    const preview = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const row = preview.commands.find((c) => c.name === "shipper:review");
    assert.ok(row);
    const result = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: [row.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(result.commands[0].status, "installed");
    const dest = path.join(env.HOME, ".grok", "commands", "shipper", "review.md");
    assert.equal(fs.existsSync(dest), true);
    assert.match(fs.readFileSync(dest, "utf8"), /\$ARGUMENTS/);
  });

  it("installs Cursor cache plugin commands into ~/.grok/commands/<plugin>/ and skips them on re-run", async () => {
    const installPath = path.join(
      env.HOME,
      ".cursor",
      "plugins",
      "cache",
      "cursor-public",
      "shipper",
      "abc123",
    );
    writePluginCommands(installPath, "shipper", [
      ["commands/deploy.md", "Deploy the app", "Ship $ARGUMENTS."],
    ]);
    writeFile(
      path.join(env.HOME, ".cursor", "plugins", "installed.json"),
      JSON.stringify({ user: ["shipper@cursor-public"] }),
    );

    const preview = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const row = preview.commands.find((c) => c.name === "shipper:deploy");
    assert.ok(row);
    const first = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: [row.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(first.commands[0].status, "installed");
    const dest = path.join(env.HOME, ".grok", "commands", "shipper", "deploy.md");
    assert.equal(fs.existsSync(dest), true);
    assert.match(fs.readFileSync(dest, "utf8"), /\$ARGUMENTS/);
    assert.equal(
      fs.existsSync(path.join(env.HOME, ".grok", "commands", "deploy.md")),
      false,
      "plugin deploy.md must not land on the user slug dest",
    );
    const listed = listInvocableCommands({ env });
    assert.ok(
      listed.some((r) => r.name === "/shipper:deploy" && r.kind === "command"),
    );

    const preview2 = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const againRow = preview2.commands.find((c) => c.name === "shipper:deploy");
    assert.equal(againRow.alreadyImported, true);
    const again = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview2.previewId,
        selected: [againRow.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(again.commands[0].status, "skipped");
  });

  it("does not execute plugin hook scripts during preview or install", async () => {
    const pwned = path.join(tmp, "pwned-plugin-command");
    const installPath = path.join(
      env.HOME,
      ".claude",
      "plugins",
      "cache",
      "shipper",
      "1.0.0",
    );
    writeInstalledPlugin({
      name: "shipper",
      installPath,
      files: [["commands/ok.md", "Safe markdown", "Do the thing."]],
    });
    writeFile(
      path.join(installPath, "hooks", "setup.sh"),
      `#!/bin/sh\necho PWNED > "${pwned}"\n`,
    );
    writeFile(
      path.join(installPath, "commands", "hook.sh"),
      `#!/bin/sh\necho PWNED > "${pwned}"\n`,
    );

    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    assert.equal(fs.existsSync(pwned), false);
    const row = preview.commands.find((c) => c.name === "shipper:ok");
    assert.ok(row);
    const result = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: [row.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(result.commands[0].status, "installed");
    assert.equal(fs.existsSync(pwned), false);
    assert.equal(
      fs.existsSync(path.join(env.HOME, ".grok", "commands", "hook.sh")),
      false,
    );
  });

  it("installs plugin commands into ~/.grok/commands/<plugin>/ and skips them on re-run", async () => {
    const installPath = path.join(
      env.HOME,
      ".claude",
      "plugins",
      "cache",
      "shipper",
      "1.0.0",
    );
    writeInstalledPlugin({
      name: "shipper",
      installPath,
      files: [
        ["commands/review.md", "Review the diff", "Review $ARGUMENTS."],
        ["commands/git/pr.md", "Open a pull request", "Create the PR."],
      ],
    });
    writeCommand(
      path.join(env.HOME, ".claude", "commands", "review.md"),
      "User review",
      "User copy.",
    );

    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const row = preview.commands.find((c) => c.name === "shipper:review");
    const nested = preview.commands.find((c) => c.name === "shipper:git:pr");
    assert.ok(row);
    assert.ok(nested);
    const first = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: [row.id, nested.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.deepEqual(
      first.commands.map((c) => c.status).sort(),
      ["installed", "installed"],
    );
    const dest = path.join(env.HOME, ".grok", "commands", "shipper", "review.md");
    const destNested = path.join(
      env.HOME,
      ".grok",
      "commands",
      "shipper",
      "git",
      "pr.md",
    );
    assert.equal(fs.existsSync(dest), true);
    assert.equal(fs.existsSync(destNested), true);
    assert.equal(
      fs.existsSync(path.join(env.HOME, ".grok", "commands", "review.md")),
      false,
      "plugin review.md must not land on the user slug dest",
    );
    assert.equal(
      fs.existsSync(path.join(env.HOME, ".grok", "commands", "git", "pr.md")),
      false,
      "plugin git/pr.md must not land on the user nested dest",
    );
    assert.match(fs.readFileSync(dest, "utf8"), /\$ARGUMENTS/);
    const listed = listInvocableCommands({ env });
    assert.ok(
      listed.some((r) => r.name === "/shipper:review" && r.kind === "command"),
    );
    assert.ok(
      listed.some((r) => r.name === "/shipper:git:pr" && r.kind === "command"),
    );

    const preview2 = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const againRow = preview2.commands.find((c) => c.name === "shipper:review");
    assert.equal(againRow.alreadyImported, true);
    const again = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview2.previewId,
        selected: [againRow.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(again.commands[0].status, "skipped");
  });

  it("marks a plugin command already imported when the namespaced dest exists", async () => {
    const installPath = path.join(
      env.HOME,
      ".claude",
      "plugins",
      "cache",
      "shipper",
      "1.0.0",
    );
    writeInstalledPlugin({
      name: "shipper",
      installPath,
      files: [["commands/review.md", "Plugin copy", "From the plugin."]],
    });
    writeCommand(
      path.join(env.HOME, ".grok", "commands", "shipper", "review.md"),
      "Already here",
      "Solenta copy.",
    );
    writeCommand(
      path.join(env.HOME, ".grok", "commands", "review.md"),
      "User slug",
      "Unrelated user dest.",
    );
    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const row = preview.commands.find((c) => c.name === "shipper:review");
    assert.ok(row);
    assert.equal(row.alreadyImported, true);
    assert.equal(row.id, "command:plugin:shipper:review");
  });
});

describe("plugin skills", () => {
  function writePluginSkills(root, name, files, skills) {
    const manifest = { name };
    if (skills) manifest.skills = skills;
    writeFile(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify(manifest),
    );
    writeFile(path.join(root, "plugin.json"), JSON.stringify(manifest));
    for (const [rel, skillName, description] of files) {
      writeSkill(path.join(root, rel), skillName, description);
    }
  }

  function writeClaudeInstalled(name, installPath) {
    const claudePlugins = path.join(env.HOME, ".claude", "plugins");
    fs.mkdirSync(claudePlugins, { recursive: true });
    const installedFile = path.join(claudePlugins, "installed_plugins.json");
    let json = { version: 2, plugins: {} };
    try {
      json = JSON.parse(fs.readFileSync(installedFile, "utf8"));
    } catch {
      /* first plugin */
    }
    json.plugins = json.plugins || {};
    json.plugins[`${name}@local`] = [{ scope: "user", installPath }];
    writeFile(installedFile, JSON.stringify(json));
  }

  it("lists Cursor local plugin skills and ignores unlisted cache plugins", async () => {
    const cursor = path.join(env.HOME, ".cursor");
    writePluginSkills(
      path.join(cursor, "plugins", "local", "shipper"),
      "shipper",
      [
        ["skills", "ship-review", "Review the diff"],
        [".claude/skills", "ship-claude", "Claude-layout skill"],
      ],
    );
    writeFile(
      path.join(cursor, "plugins", "local", "shipper", "orphan", "SKILL.md"),
      skillMd("orphan", "Not in a skills dir"),
    );
    writePluginSkills(
      path.join(
        cursor,
        "plugins",
        "cache",
        "cursor-public",
        "github",
        "abc123",
      ),
      "github",
      [["skills", "nope", "Cached marketplace plugin"]],
    );
    writeSkill(path.join(cursor, "skills-cursor"), "cursor-only", "Cursor managed");
    writeFile(
      path.join(cursor, "plugins", "local", "shipper", "hooks", "setup.sh"),
      "#!/bin/sh\necho plugin-secret-value\n",
    );

    const preview = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const byName = Object.fromEntries(preview.skills.map((s) => [s.name, s]));
    assert.equal(byName["ship-review"].id, "skill:ship-review");
    assert.equal(byName["ship-review"].origin, "plugin");
    assert.equal(byName["ship-review"].description, "Review the diff");
    assert.equal(byName["ship-claude"].origin, "plugin");
    assert.equal(byName["cursor-only"].origin, "skills-cursor");
    assert.equal(byName.orphan, undefined);
    assert.equal(byName.nope, undefined);
    const dumped = JSON.stringify(preview);
    assert.ok(!dumped.includes("plugin-secret-value"));
    const staged = path.join(
      userData,
      "harness-imports",
      preview.previewId,
      "stage",
    );
    assert.equal(fs.existsSync(path.join(staged, "cache")), false);
    assert.equal(fs.existsSync(path.join(staged, "hooks")), false);
  });

  it("lists Cursor installed cache plugin skills without copying the cache tree", async () => {
    const cursor = path.join(env.HOME, ".cursor");
    const installPath = path.join(
      cursor,
      "plugins",
      "cache",
      "cursor-public",
      "shipper",
      "abc123",
    );
    writePluginSkills(installPath, "shipper", [
      ["skills", "deploy-flow", "Deploy the app"],
    ]);
    writeFile(
      path.join(installPath, "hooks", "setup.sh"),
      "#!/bin/sh\necho plugin-secret-value\n",
    );
    writeFile(
      path.join(installPath, "skills", "deploy-flow", "SKILL.md"),
      `${skillMd("deploy-flow", "Deploy the app")}\nSecret: deploy-secret\n`,
    );
    writePluginSkills(
      path.join(cursor, "plugins", "cache", "cursor-public", "other", "def456"),
      "other",
      [["skills", "nope", "Unlisted cache copy"]],
    );
    writePluginSkills(
      path.join(cursor, "plugins", "cache", "orphan", "ghost", "1.0.0"),
      "ghost",
      [["skills", "ghost-skill", "Unlisted cache copy"]],
    );
    writeFile(
      path.join(cursor, "plugins", "installed.json"),
      JSON.stringify({ user: ["shipper@cursor-public"] }),
    );

    const preview = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const pluginSkills = preview.skills.filter((s) => s.origin === "plugin");
    const byName = Object.fromEntries(pluginSkills.map((s) => [s.name, s]));
    assert.equal(byName["deploy-flow"].id, "skill:deploy-flow");
    assert.equal(byName["deploy-flow"].description, "Deploy the app");
    assert.equal(byName.nope, undefined);
    assert.equal(byName["ghost-skill"], undefined);
    const dumped = JSON.stringify(preview);
    assert.ok(!dumped.includes("deploy-secret"));
    assert.ok(!dumped.includes("plugin-secret-value"));
    const staged = path.join(
      userData,
      "harness-imports",
      preview.previewId,
      "stage",
    );
    assert.equal(fs.existsSync(path.join(staged, "cache")), false);
    assert.equal(fs.existsSync(path.join(staged, "hooks")), false);
  });

  it("follows plugin.json skills array instead of the default dirs", async () => {
    writePluginSkills(
      path.join(env.HOME, ".cursor", "plugins", "local", "custom"),
      "custom",
      [
        ["packages", "custom-flow", "Custom skill dir"],
        ["skills", "default-skill", "Default dir"],
      ],
      ["./packages"],
    );

    const preview = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const names = preview.skills.map((s) => s.name);
    assert.ok(names.includes("custom-flow"));
    assert.equal(names.includes("default-skill"), false);
  });

  it("installs Cursor local plugin skills and skips them on re-run", async () => {
    writePluginSkills(
      path.join(env.HOME, ".cursor", "plugins", "local", "shipper"),
      "shipper",
      [["skills", "ship-review", "Review the diff"]],
    );
    activate("claude", "codex", "cursor");

    const preview = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const row = preview.skills.find((s) => s.name === "ship-review");
    assert.ok(row);
    const first = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: [row.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(first.skills[0].status, "installed");
    const listed = listSkills(null, env, userData);
    assert.ok(listed.some((s) => s.name === "ship-review"));

    const preview2 = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const againRow = preview2.skills.find((s) => s.name === "ship-review");
    assert.equal(againRow.alreadyImported, true);
    const again = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview2.previewId,
        selected: [againRow.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(again.skills[0].status, "skipped");
  });

  it("installs Cursor cache plugin skills into skill dirs and skips them on re-run", async () => {
    const installPath = path.join(
      env.HOME,
      ".cursor",
      "plugins",
      "cache",
      "cursor-public",
      "shipper",
      "abc123",
    );
    writePluginSkills(installPath, "shipper", [
      ["skills", "deploy-flow", "Deploy the app"],
    ]);
    writeFile(
      path.join(env.HOME, ".cursor", "plugins", "installed.json"),
      JSON.stringify({ user: ["shipper@cursor-public"] }),
    );
    activate("claude", "codex", "cursor");

    const preview = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const row = preview.skills.find((s) => s.name === "deploy-flow");
    assert.ok(row);
    const first = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: [row.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(first.skills[0].status, "installed");
    const dest = path.join(SKILL_DIRS(env).claude, "deploy-flow", "SKILL.md");
    assert.equal(fs.existsSync(dest), true);
    assert.match(fs.readFileSync(dest, "utf8"), /Deploy the app/);

    const preview2 = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    const againRow = preview2.skills.find((s) => s.name === "deploy-flow");
    assert.equal(againRow.alreadyImported, true);
    const again = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview2.previewId,
        selected: [againRow.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(again.skills[0].status, "skipped");
  });

  it("does not execute plugin skill hooks during preview or install", async () => {
    const pwned = path.join(tmp, "pwned-plugin-skill");
    writePluginSkills(
      path.join(env.HOME, ".cursor", "plugins", "local", "shipper"),
      "shipper",
      [["skills", "with-hook", "Has a hook"]],
    );
    writeFile(
      path.join(
        env.HOME,
        ".cursor",
        "plugins",
        "local",
        "shipper",
        "skills",
        "with-hook",
        "hooks",
        "setup.sh",
      ),
      `#!/bin/sh\necho PWNED > "${pwned}"\n`,
    );
    activate("claude");

    const preview = await previewImport({
      userDataPath: userData,
      source: "cursor",
      current: [],
      env,
    });
    assert.equal(fs.existsSync(pwned), false);
    await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: ["skill:with-hook"],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(fs.existsSync(pwned), false);
    const dest = path.join(SKILL_DIRS(env).claude, "with-hook", "hooks", "setup.sh");
    assert.equal(fs.existsSync(dest), true);
  });

  it("lists Codex enabled plugin skills without copying the cache tree", async () => {
    const codex = path.join(env.HOME, ".codex");
    const installPath = path.join(
      codex,
      "plugins",
      "cache",
      "mp",
      "shipper",
      "1.2.3",
    );
    writePluginSkills(installPath, "shipper", [
      ["skills", "deploy-flow", "Deploy the app"],
      [".claude/skills", "codex-layout", "Claude-layout skill"],
    ]);
    writeFile(
      path.join(installPath, "orphan", "SKILL.md"),
      skillMd("orphan", "Not in a skills dir"),
    );
    writeFile(
      path.join(installPath, "hooks", "setup.sh"),
      "#!/bin/sh\necho plugin-secret-value\n",
    );
    writeFile(
      path.join(installPath, "skills", "deploy-flow", "SKILL.md"),
      `${skillMd("deploy-flow", "Deploy the app")}\nSecret: deploy-secret\n`,
    );
    writePluginSkills(
      path.join(codex, "plugins", "cache", "mp", "other", "9.0.0"),
      "other",
      [["skills", "nope", "Disabled cache copy"]],
    );
    writePluginSkills(
      path.join(codex, "plugins", "cache", "orphan", "ghost", "1.0.0"),
      "ghost",
      [["skills", "ghost-skill", "Unlisted cache copy"]],
    );
    writeFile(
      path.join(codex, "config.toml"),
      [
        `[plugins."shipper@mp"]`,
        "enabled = true",
        "",
        `[plugins."other@mp"]`,
        "enabled = false",
        "",
        'api_key = "toml-secret-value"',
        "",
      ].join("\n"),
    );
    writeSkill(path.join(codex, "skills"), "home-skill", "Home managed");

    const preview = await previewImport({
      userDataPath: userData,
      source: "codex",
      current: [],
      env,
    });
    const byName = Object.fromEntries(preview.skills.map((s) => [s.name, s]));
    assert.equal(byName["deploy-flow"].id, "skill:deploy-flow");
    assert.equal(byName["deploy-flow"].origin, "plugin");
    assert.equal(byName["deploy-flow"].description, "Deploy the app");
    assert.equal(byName["codex-layout"].origin, "plugin");
    assert.equal(byName["home-skill"].origin, "skills");
    assert.equal(byName.orphan, undefined);
    assert.equal(byName.nope, undefined);
    assert.equal(byName["ghost-skill"], undefined);
    const dumped = JSON.stringify(preview);
    assert.ok(!dumped.includes("deploy-secret"));
    assert.ok(!dumped.includes("plugin-secret-value"));
    assert.ok(!dumped.includes("toml-secret-value"));
    const staged = path.join(
      userData,
      "harness-imports",
      preview.previewId,
      "stage",
    );
    assert.equal(fs.existsSync(path.join(staged, "cache")), false);
    assert.equal(fs.existsSync(path.join(staged, "hooks")), false);
  });

  it("follows Codex plugin.json skills array instead of the default dirs", async () => {
    writePluginSkills(
      path.join(
        env.HOME,
        ".codex",
        "plugins",
        "cache",
        "mp",
        "custom",
        "1.0.0",
      ),
      "custom",
      [
        ["packages", "custom-flow", "Custom skill dir"],
        ["skills", "default-skill", "Default dir"],
      ],
      ["./packages"],
    );
    writeFile(
      path.join(env.HOME, ".codex", "config.toml"),
      `[plugins."custom@mp"]\nenabled = true\n`,
    );

    const preview = await previewImport({
      userDataPath: userData,
      source: "codex",
      current: [],
      env,
    });
    const names = preview.skills.map((s) => s.name);
    assert.ok(names.includes("custom-flow"));
    assert.equal(names.includes("default-skill"), false);
  });

  it("installs Codex plugin skills and skips them on re-run", async () => {
    const installPath = path.join(
      env.HOME,
      ".codex",
      "plugins",
      "cache",
      "mp",
      "shipper",
      "1.2.3",
    );
    writePluginSkills(installPath, "shipper", [
      ["skills", "deploy-flow", "Deploy the app"],
    ]);
    writeFile(
      path.join(env.HOME, ".codex", "config.toml"),
      `[plugins."shipper@mp"]\nenabled = true\n`,
    );
    activate("claude", "codex", "cursor");

    const preview = await previewImport({
      userDataPath: userData,
      source: "codex",
      current: [],
      env,
    });
    const row = preview.skills.find((s) => s.name === "deploy-flow");
    assert.ok(row);
    const first = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: [row.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(first.skills[0].status, "installed");
    const dest = path.join(SKILL_DIRS(env).claude, "deploy-flow", "SKILL.md");
    assert.equal(fs.existsSync(dest), true);
    assert.match(fs.readFileSync(dest, "utf8"), /Deploy the app/);

    const preview2 = await previewImport({
      userDataPath: userData,
      source: "codex",
      current: [],
      env,
    });
    const againRow = preview2.skills.find((s) => s.name === "deploy-flow");
    assert.equal(againRow.alreadyImported, true);
    const again = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview2.previewId,
        selected: [againRow.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(again.skills[0].status, "skipped");
  });

  it("does not execute Codex plugin skill hooks during preview or install", async () => {
    const pwned = path.join(tmp, "pwned-codex-plugin-skill");
    writePluginSkills(
      path.join(
        env.HOME,
        ".codex",
        "plugins",
        "cache",
        "mp",
        "shipper",
        "1.2.3",
      ),
      "shipper",
      [["skills", "with-hook", "Has a hook"]],
    );
    writeFile(
      path.join(
        env.HOME,
        ".codex",
        "plugins",
        "cache",
        "mp",
        "shipper",
        "1.2.3",
        "skills",
        "with-hook",
        "hooks",
        "setup.sh",
      ),
      `#!/bin/sh\necho PWNED > "${pwned}"\n`,
    );
    writeFile(
      path.join(env.HOME, ".codex", "config.toml"),
      `[plugins."shipper@mp"]\nenabled = true\n`,
    );
    activate("claude");

    const preview = await previewImport({
      userDataPath: userData,
      source: "codex",
      current: [],
      env,
    });
    assert.equal(fs.existsSync(pwned), false);
    await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: ["skill:with-hook"],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(fs.existsSync(pwned), false);
    const dest = path.join(SKILL_DIRS(env).claude, "with-hook", "hooks", "setup.sh");
    assert.equal(fs.existsSync(dest), true);
  });

  it("lists Claude installed plugin skills without copying the cache tree", async () => {
    const claude = path.join(env.HOME, ".claude");
    const installPath = path.join(
      claude,
      "plugins",
      "cache",
      "shipper-mp",
      "shipper",
      "1.0.0",
    );
    writePluginSkills(installPath, "shipper", [
      ["skills", "deploy-flow", "Deploy the app"],
      [".claude/skills", "claude-layout", "Claude-layout skill"],
    ]);
    writeFile(
      path.join(installPath, "orphan", "SKILL.md"),
      skillMd("orphan", "Not in a skills dir"),
    );
    writeFile(
      path.join(installPath, "hooks", "setup.sh"),
      "#!/bin/sh\necho plugin-secret-value\n",
    );
    writeFile(
      path.join(installPath, "skills", "deploy-flow", "SKILL.md"),
      `${skillMd("deploy-flow", "Deploy the app")}\nSecret: deploy-secret\n`,
    );
    writePluginSkills(
      path.join(claude, "plugins", "cache", "shipper-mp", "other", "9.0.0"),
      "other",
      [["skills", "nope", "Unlisted cache copy"]],
    );
    writePluginSkills(
      path.join(claude, "plugins", "cache", "orphan", "ghost", "1.0.0"),
      "ghost",
      [["skills", "ghost-skill", "Unlisted cache copy"]],
    );
    writeFile(
      path.join(claude, "plugins", "marketplaces", "noise", "skills", "market", "SKILL.md"),
      skillMd("market", "Marketplace copy"),
    );
    writeClaudeInstalled("shipper", installPath);
    writeSkill(path.join(claude, "skills"), "home-skill", "Home managed");

    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const byName = Object.fromEntries(preview.skills.map((s) => [s.name, s]));
    assert.equal(byName["deploy-flow"].id, "skill:deploy-flow");
    assert.equal(byName["deploy-flow"].origin, "plugin");
    assert.equal(byName["deploy-flow"].description, "Deploy the app");
    assert.equal(byName["claude-layout"].origin, "plugin");
    assert.equal(byName["home-skill"].origin, "skills");
    assert.equal(byName.orphan, undefined);
    assert.equal(byName.nope, undefined);
    assert.equal(byName["ghost-skill"], undefined);
    assert.equal(byName.market, undefined);
    const dumped = JSON.stringify(preview);
    assert.ok(!dumped.includes("deploy-secret"));
    assert.ok(!dumped.includes("plugin-secret-value"));
    const staged = path.join(
      userData,
      "harness-imports",
      preview.previewId,
      "stage",
    );
    assert.equal(fs.existsSync(path.join(staged, "cache")), false);
    assert.equal(fs.existsSync(path.join(staged, "hooks")), false);
  });

  it("follows Claude plugin.json skills array instead of the default dirs", async () => {
    const installPath = path.join(
      env.HOME,
      ".claude",
      "plugins",
      "cache",
      "shipper-mp",
      "custom",
      "1.0.0",
    );
    writePluginSkills(
      installPath,
      "custom",
      [
        ["packages", "custom-flow", "Custom skill dir"],
        ["skills", "default-skill", "Default dir"],
      ],
      ["./packages"],
    );
    writeClaudeInstalled("custom", installPath);

    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const names = preview.skills.map((s) => s.name);
    assert.ok(names.includes("custom-flow"));
    assert.equal(names.includes("default-skill"), false);
  });

  it("installs Claude plugin skills and skips them on re-run", async () => {
    const installPath = path.join(
      env.HOME,
      ".claude",
      "plugins",
      "cache",
      "shipper-mp",
      "shipper",
      "1.0.0",
    );
    writePluginSkills(installPath, "shipper", [
      ["skills", "deploy-flow", "Deploy the app"],
    ]);
    writeClaudeInstalled("shipper", installPath);
    activate("claude", "codex", "cursor");

    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const row = preview.skills.find((s) => s.name === "deploy-flow");
    assert.ok(row);
    const first = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: [row.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(first.skills[0].status, "installed");
    const dest = path.join(SKILL_DIRS(env).claude, "deploy-flow", "SKILL.md");
    assert.equal(fs.existsSync(dest), true);
    assert.match(fs.readFileSync(dest, "utf8"), /Deploy the app/);

    const preview2 = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    const againRow = preview2.skills.find((s) => s.name === "deploy-flow");
    assert.equal(againRow.alreadyImported, true);
    const again = await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview2.previewId,
        selected: [againRow.id],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(again.skills[0].status, "skipped");
  });

  it("does not execute Claude plugin skill hooks during preview or install", async () => {
    const pwned = path.join(tmp, "pwned-claude-plugin-skill");
    const installPath = path.join(
      env.HOME,
      ".claude",
      "plugins",
      "cache",
      "shipper-mp",
      "shipper",
      "1.0.0",
    );
    writePluginSkills(installPath, "shipper", [
      ["skills", "with-hook", "Has a hook"],
    ]);
    writeFile(
      path.join(installPath, "skills", "with-hook", "hooks", "setup.sh"),
      `#!/bin/sh\necho PWNED > "${pwned}"\n`,
    );
    writeClaudeInstalled("shipper", installPath);
    activate("claude");

    const preview = await previewImport({
      userDataPath: userData,
      source: "claude",
      current: [],
      env,
    });
    assert.equal(fs.existsSync(pwned), false);
    await installImport({
      userDataPath: userData,
      env,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: ["skill:with-hook"],
        replace: false,
        trustLocal: false,
      },
    });
    assert.equal(fs.existsSync(pwned), false);
    const dest = path.join(SKILL_DIRS(env).claude, "with-hook", "hooks", "setup.sh");
    assert.equal(fs.existsSync(dest), true);
  });
});
