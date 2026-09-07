/**
 * CLI slash commands (#606): discover skills + custom commands, expand
 * `/name args` into the SKILL.md / command body the TUI would inject.
 *
 * Run: node --test electron/test/cli-commands.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  listInvocableCommands,
  expandInvocableCommand,
} = require("../cliCommands.js");

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cli-cmd-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function envHome() {
  return { HOME: tmp };
}

function writeSkill(base, name, content) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
}

function names(rows) {
  return rows.map((r) => r.name);
}

function byName(rows, name) {
  return rows.find((r) => r.name === name);
}

const MAX_JSON_BYTES = 512 * 1024;

function writeCommand(file, description, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `---\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

function padPluginJson(obj, minBytes) {
  const body = JSON.stringify(obj);
  const pad = minBytes - Buffer.byteLength(body);
  return pad > 0 ? body + " ".repeat(pad) : body;
}

function writeClaudeInstalled(pluginRoot) {
  fs.mkdirSync(path.join(tmp, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "shipper@mp": [{ scope: "user", installPath: pluginRoot }],
      },
    }),
  );
}

function writeCursorCacheRoot() {
  const installPath = path.join(
    tmp,
    ".cursor",
    "plugins",
    "cache",
    "cursor-public",
    "shipper",
    "abc123",
  );
  fs.mkdirSync(installPath, { recursive: true });
  fs.mkdirSync(path.join(tmp, ".cursor", "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".cursor", "plugins", "installed.json"),
    JSON.stringify({ user: ["shipper@cursor-public"] }),
  );
  return installPath;
}

describe("listInvocableCommands", () => {
  it("lists a user skill as /name with a truncated hint", () => {
    writeSkill(
      path.join(tmp, ".claude", "skills"),
      "commit",
      "---\nname: commit\ndescription: Review staged changes and write a conventional commit\n---\n\n# Commit\n\nDo the commit.\n",
    );
    const rows = listInvocableCommands({ env: envHome() });
    const row = byName(rows, "/commit");
    assert.ok(row, "user skill /commit is listed");
    assert.equal(row.kind, "skill");
    assert.equal(
      row.hint,
      "Review staged changes and write a conventional commit",
    );
  });

  it("lists a project skill from .claude/skills and .grok/skills", () => {
    const project = path.join(tmp, "app");
    writeSkill(
      path.join(project, ".claude", "skills"),
      "repo-review",
      "---\ndescription: Project review checklist\n---\n\nBody.\n",
    );
    writeSkill(
      path.join(project, ".grok", "skills"),
      "ship",
      "---\ndescription: Ship the branch\n---\n\nBody.\n",
    );
    const rows = listInvocableCommands({
      projectPath: project,
      env: envHome(),
    });
    assert.ok(byName(rows, "/repo-review"), "project .claude skill");
    assert.ok(byName(rows, "/ship"), "project .grok skill");
  });

  it("lists grok bundled skills", () => {
    writeSkill(
      path.join(tmp, ".grok", "bundled", "skills"),
      "imagine",
      "---\nname: imagine\ndescription: Generate images with Imagine tools\n---\n\n# Imagine\n",
    );
    const rows = listInvocableCommands({ env: envHome() });
    assert.ok(byName(rows, "/imagine"), "bundled /imagine");
  });

  it("lists a plugin skill as /name and /plugin:name", () => {
    const pluginRoot = path.join(
      tmp,
      ".claude",
      "plugins",
      "cache",
      "claude-code-skills",
      "self-improving-agent",
      "2.9.0",
    );
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "si", skills: ["./skills"] }),
    );
    writeSkill(
      path.join(pluginRoot, "skills"),
      "review",
      "---\nname: review\ndescription: Audit auto-memory for promotion candidates\n---\n\n# /si:review\n",
    );
    fs.mkdirSync(path.join(tmp, ".claude", "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "self-improving-agent@claude-code-skills": [
            { scope: "user", installPath: pluginRoot },
          ],
        },
      }),
    );

    const rows = listInvocableCommands({ env: envHome() });
    assert.ok(byName(rows, "/review"), "bare plugin skill name");
    const namespaced = byName(rows, "/si:review");
    assert.ok(namespaced, "namespaced /si:review");
    assert.equal(namespaced.kind, "skill");
    assert.match(namespaced.hint, /auto-memory/);
  });

  it("omits user-invocable: false skills from the palette", () => {
    writeSkill(
      path.join(tmp, ".grok", "bundled", "skills"),
      "docx",
      "---\nname: docx\ndescription: Word documents\nuser-invocable: false\n---\n\n# DOCX\n",
    );
    writeSkill(
      path.join(tmp, ".grok", "bundled", "skills"),
      "imagine",
      "---\nname: imagine\ndescription: Images\n---\n\n# Imagine\n",
    );
    const listed = names(listInvocableCommands({ env: envHome() }));
    assert.ok(listed.includes("/imagine"));
    assert.ok(!listed.includes("/docx"));
  });

  it("lists custom command markdown as /name and substitutes description", () => {
    const dir = path.join(tmp, ".claude", "commands");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "draft.md"),
      "---\ndescription: Draft a changelog entry\n---\n\nWrite a changelog for $ARGUMENTS.\n",
    );
    fs.mkdirSync(path.join(dir, "git"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "git", "pr.md"),
      "---\ndescription: Open a pull request\n---\n\nCreate the PR.\n",
    );
    const rows = listInvocableCommands({ env: envHome() });
    assert.equal(byName(rows, "/draft")?.kind, "command");
    assert.equal(byName(rows, "/draft")?.hint, "Draft a changelog entry");
    assert.ok(byName(rows, "/git:pr"), "nested command becomes /git:pr");
  });

  it("project skills win over user skills of the same name", () => {
    writeSkill(
      path.join(tmp, ".claude", "skills"),
      "review",
      "---\ndescription: User review skill\n---\n\nUser body.\n",
    );
    const project = path.join(tmp, "app");
    writeSkill(
      path.join(project, ".claude", "skills"),
      "review",
      "---\ndescription: Project review skill\n---\n\nProject body.\n",
    );
    const row = byName(
      listInvocableCommands({ projectPath: project, env: envHome() }),
      "/review",
    );
    assert.equal(row.hint, "Project review skill");
  });

  it("never throws on a missing HOME or unreadable dirs", () => {
    assert.deepEqual(
      listInvocableCommands({ env: { HOME: path.join(tmp, "nope") } }),
      [],
    );
  });

  it("lists a Cursor local plugin command and omits unlisted cache plugins", () => {
    const cursor = path.join(tmp, ".cursor");
    const localRoot = path.join(cursor, "plugins", "local", "shipper");
    fs.mkdirSync(path.join(localRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(localRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "shipper" }),
    );
    fs.mkdirSync(path.join(localRoot, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(localRoot, "commands", "review.md"),
      "---\ndescription: Review the diff\n---\n\nReview $ARGUMENTS.\n",
    );
    const unlisted = path.join(
      cursor,
      "plugins",
      "cache",
      "cursor-public",
      "github",
      "abc123",
    );
    fs.mkdirSync(path.join(unlisted, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(unlisted, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "github" }),
    );
    fs.mkdirSync(path.join(unlisted, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(unlisted, "commands", "nope.md"),
      "---\ndescription: Cached marketplace plugin\n---\n\nDo not list.\n",
    );

    const rows = listInvocableCommands({ env: envHome() });
    assert.ok(byName(rows, "/review"), "bare Cursor local plugin command");
    const namespaced = byName(rows, "/shipper:review");
    assert.ok(namespaced, "namespaced /shipper:review");
    assert.equal(namespaced.kind, "command");
    assert.equal(namespaced.hint, "Review the diff");
    assert.equal(byName(rows, "/nope"), undefined);
    assert.equal(byName(rows, "/github:nope"), undefined);
  });

  it("lists a Cursor installed cache plugin command and omits unlisted cache plugins", () => {
    const cursor = path.join(tmp, ".cursor");
    const installPath = path.join(
      cursor,
      "plugins",
      "cache",
      "cursor-public",
      "shipper",
      "abc123",
    );
    fs.mkdirSync(path.join(installPath, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "shipper" }),
    );
    fs.mkdirSync(path.join(installPath, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, "commands", "deploy.md"),
      "---\ndescription: Deploy the app\n---\n\nShip $ARGUMENTS.\n",
    );
    const unlisted = path.join(
      cursor,
      "plugins",
      "cache",
      "cursor-public",
      "other",
      "def456",
    );
    fs.mkdirSync(path.join(unlisted, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(unlisted, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "other" }),
    );
    fs.mkdirSync(path.join(unlisted, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(unlisted, "commands", "nope.md"),
      "---\ndescription: Unlisted cache copy\n---\n\nDo not list.\n",
    );
    fs.mkdirSync(path.join(cursor, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(cursor, "plugins", "installed.json"),
      JSON.stringify({ user: ["shipper@cursor-public"] }),
    );

    const rows = listInvocableCommands({ env: envHome() });
    assert.ok(byName(rows, "/deploy"), "bare Cursor installed plugin command");
    const namespaced = byName(rows, "/shipper:deploy");
    assert.ok(namespaced, "namespaced /shipper:deploy from installed cache");
    assert.equal(namespaced.kind, "command");
    assert.equal(namespaced.hint, "Deploy the app");
    assert.equal(byName(rows, "/other:nope"), undefined);
    assert.equal(byName(rows, "/nope"), undefined);
  });

  it("namespaces a Cursor cache plugin from .cursor-plugin/plugin.json, not the hash dir", () => {
    const cursor = path.join(tmp, ".cursor");
    const installPath = path.join(
      cursor,
      "plugins",
      "cache",
      "cursor-public",
      "shipper",
      "abc123",
    );
    fs.mkdirSync(path.join(installPath, ".cursor-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "shipper" }),
    );
    fs.mkdirSync(path.join(installPath, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, "commands", "deploy.md"),
      "---\ndescription: Deploy the app\n---\n\nShip $ARGUMENTS.\n",
    );
    fs.mkdirSync(path.join(cursor, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(cursor, "plugins", "installed.json"),
      JSON.stringify({ user: ["shipper@cursor-public"] }),
    );

    const listed = names(listInvocableCommands({ env: envHome() }));
    assert.ok(
      listed.includes("/shipper:deploy"),
      "plugin name from .cursor-plugin/plugin.json",
    );
    assert.ok(
      !listed.includes("/abc123:deploy"),
      "hash dir is not the namespace",
    );
  });

  it("lists a Codex enabled plugin command without a harness import", () => {
    const codex = path.join(tmp, ".codex");
    const installPath = path.join(
      codex,
      "plugins",
      "cache",
      "mp",
      "shipper",
      "1.2.3",
    );
    fs.mkdirSync(path.join(installPath, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "shipper" }),
    );
    fs.mkdirSync(path.join(installPath, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, "commands", "deploy.md"),
      "---\ndescription: Deploy the app\n---\n\nShip it.\n",
    );

    const disabledPath = path.join(
      codex,
      "plugins",
      "cache",
      "mp",
      "other",
      "9.0.0",
    );
    fs.mkdirSync(path.join(disabledPath, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(disabledPath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "other" }),
    );
    fs.mkdirSync(path.join(disabledPath, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(disabledPath, "commands", "nope.md"),
      "---\ndescription: Disabled cache copy\n---\n\nNope.\n",
    );

    const unlistedPath = path.join(
      codex,
      "plugins",
      "cache",
      "orphan",
      "ghost",
      "1.0.0",
    );
    fs.mkdirSync(path.join(unlistedPath, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(unlistedPath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "ghost" }),
    );
    fs.mkdirSync(path.join(unlistedPath, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(unlistedPath, "commands", "nope.md"),
      "---\ndescription: Unlisted cache copy\n---\n\nNope.\n",
    );

    fs.mkdirSync(codex, { recursive: true });
    fs.writeFileSync(
      path.join(codex, "config.toml"),
      [
        `[plugins."shipper@mp"]`,
        "enabled = true",
        "",
        `[plugins."other@mp"]`,
        "enabled = false",
        "",
      ].join("\n"),
    );

    const rows = listInvocableCommands({ env: envHome() });
    const listed = names(rows);
    const row = byName(rows, "/shipper:deploy");
    assert.ok(
      row,
      "enabled Codex cache plugin is listed without a harness import",
    );
    assert.equal(row.kind, "command");
    assert.equal(row.hint, "Deploy the app");
    assert.ok(
      !listed.includes("/1.2.3:deploy"),
      "namespace comes from .codex-plugin/plugin.json, not the version dir",
    );
    assert.ok(!listed.includes("/other:nope"), "disabled Codex plugin stays out");
    assert.ok(!listed.includes("/ghost:nope"), "unlisted cache plugin stays out");
  });


  it("lists CURSOR_HOME plugin commands and omits a HOME/.cursor decoy", () => {
    const cursorHome = path.join(tmp, "cursor-home");
    const localRoot = path.join(cursorHome, "plugins", "local", "shipper");
    fs.mkdirSync(path.join(localRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(localRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "shipper" }),
    );
    fs.mkdirSync(path.join(localRoot, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(localRoot, "commands", "review.md"),
      "---\ndescription: Review the diff\n---\n\nReview $ARGUMENTS.\n",
    );

    const decoyRoot = path.join(tmp, ".cursor", "plugins", "local", "decoy");
    fs.mkdirSync(path.join(decoyRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(decoyRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "decoy" }),
    );
    fs.mkdirSync(path.join(decoyRoot, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(decoyRoot, "commands", "review.md"),
      "---\ndescription: HOME decoy\n---\n\nDo not list.\n",
    );

    const rows = listInvocableCommands({
      env: { HOME: tmp, CURSOR_HOME: cursorHome },
    });
    assert.ok(byName(rows, "/shipper:review"), "CURSOR_HOME lists /shipper:review");
    assert.equal(byName(rows, "/decoy:review"), undefined);
  });

  it("lists CODEX_HOME plugin commands and omits a HOME/.codex decoy", () => {
    const codexHome = path.join(tmp, "codex-home");
    const installPath = path.join(
      codexHome,
      "plugins",
      "cache",
      "mp",
      "shipper",
      "1.2.3",
    );
    fs.mkdirSync(path.join(installPath, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "shipper" }),
    );
    fs.mkdirSync(path.join(installPath, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, "commands", "deploy.md"),
      "---\ndescription: Deploy the app\n---\n\nShip it.\n",
    );
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      `[plugins."shipper@mp"]\nenabled = true\n`,
    );

    const decoyPath = path.join(
      tmp,
      ".codex",
      "plugins",
      "cache",
      "mp",
      "decoy",
      "9.0.0",
    );
    fs.mkdirSync(path.join(decoyPath, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(decoyPath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "decoy" }),
    );
    fs.mkdirSync(path.join(decoyPath, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(decoyPath, "commands", "deploy.md"),
      "---\ndescription: HOME decoy\n---\n\nDo not list.\n",
    );
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".codex", "config.toml"),
      `[plugins."decoy@mp"]\nenabled = true\n`,
    );

    const rows = listInvocableCommands({
      env: { HOME: tmp, CODEX_HOME: codexHome },
    });
    assert.ok(byName(rows, "/shipper:deploy"), "CODEX_HOME lists /shipper:deploy");
    assert.equal(byName(rows, "/decoy:deploy"), undefined);
  });

  it("lists a nameless Cursor cache plugin as /abc123:review", () => {
    const installPath = writeCursorCacheRoot();
    fs.mkdirSync(path.join(installPath, ".cursor-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, ".cursor-plugin", "plugin.json"),
      JSON.stringify({}),
    );
    writeCommand(
      path.join(installPath, "commands", "review.md"),
      "Review the diff",
      "Review $ARGUMENTS.",
    );

    const listed = names(listInvocableCommands({ env: envHome() }));
    assert.ok(
      listed.includes("/abc123:review"),
      "missing plugin name falls back to the cache hash dir",
    );
  });

  it("lists an invalid-name Codex cache plugin as /1.2.3:deploy", () => {
    const installPath = path.join(
      tmp,
      ".codex",
      "plugins",
      "cache",
      "mp",
      "shipper",
      "1.2.3",
    );
    fs.mkdirSync(path.join(installPath, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "Nope!" }),
    );
    writeCommand(
      path.join(installPath, "commands", "deploy.md"),
      "Deploy the app",
      "Ship it.",
    );
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".codex", "config.toml"),
      `[plugins."shipper@mp"]\nenabled = true\n`,
    );

    const listed = names(listInvocableCommands({ env: envHome() }));
    assert.ok(
      listed.includes("/1.2.3:deploy"),
      "invalid plugin name falls back to the version dir",
    );
    assert.ok(
      !listed.includes("/shipper:deploy"),
      "invalid plugin.json name is not the namespace",
    );
  });

  it("treats plugin.json larger than 512KB as missing and falls back to the dir name", () => {
    const installPath = writeCursorCacheRoot();
    const payload = padPluginJson(
      { name: "shipper", commands: ["./slash"] },
      MAX_JSON_BYTES + 1,
    );
    fs.writeFileSync(path.join(installPath, "plugin.json"), payload);
    assert.ok(
      fs.statSync(path.join(installPath, "plugin.json")).size > MAX_JSON_BYTES,
    );
    writeCommand(
      path.join(installPath, "slash", "review.md"),
      "From slash dir",
      "Do not list if the oversized json is ignored.",
    );
    writeCommand(
      path.join(installPath, "commands", "default.md"),
      "Default dir",
      "List via basename when the oversized json is missing.",
    );

    const listed = names(listInvocableCommands({ env: envHome() }));
    assert.ok(
      listed.includes("/abc123:default"),
      "oversized plugin.json is ignored; palette uses basename + default dirs",
    );
    assert.ok(
      !listed.includes("/shipper:review"),
      "oversized plugin.json must not supply the name or commands array",
    );
  });

  it("falls through an oversized earlier plugin.json to a later candidate", () => {
    const installPath = writeCursorCacheRoot();
    fs.mkdirSync(path.join(installPath, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, ".claude-plugin", "plugin.json"),
      padPluginJson({ name: "too-big", commands: ["./slash"] }, MAX_JSON_BYTES + 1),
    );
    fs.writeFileSync(
      path.join(installPath, "plugin.json"),
      JSON.stringify({ name: "shipper", commands: ["./ok"] }),
    );
    writeCommand(
      path.join(installPath, "slash", "wrong.md"),
      "From oversized candidate",
      "Must not list.",
    );
    writeCommand(
      path.join(installPath, "ok", "review.md"),
      "From later candidate",
      "List this.",
    );

    const listed = names(listInvocableCommands({ env: envHome() }));
    assert.ok(listed.includes("/shipper:review"));
    assert.ok(!listed.includes("/too-big:wrong"));
    assert.ok(!listed.includes("/abc123:review"));
  });

  it("treats a symlinked plugin.json as missing and falls back to the dir name", () => {
    const installPath = writeCursorCacheRoot();
    const outside = path.join(tmp, "outside.json");
    fs.writeFileSync(
      outside,
      JSON.stringify({ name: "shipper", commands: ["./slash"] }),
    );
    fs.symlinkSync(outside, path.join(installPath, "plugin.json"));
    writeCommand(
      path.join(installPath, "slash", "review.md"),
      "From symlink target",
      "Do not follow.",
    );
    writeCommand(
      path.join(installPath, "commands", "default.md"),
      "Default dir",
      "List via basename.",
    );

    const listed = names(listInvocableCommands({ env: envHome() }));
    assert.ok(
      listed.includes("/abc123:default"),
      "symlinked plugin.json is ignored; palette uses basename",
    );
    assert.ok(!listed.includes("/shipper:review"));
  });

  it("falls through a symlinked earlier plugin.json to a later candidate", () => {
    const installPath = writeCursorCacheRoot();
    const outside = path.join(tmp, "outside.json");
    fs.writeFileSync(outside, JSON.stringify({ name: "from-symlink" }));
    fs.mkdirSync(path.join(installPath, ".claude-plugin"), { recursive: true });
    fs.symlinkSync(
      outside,
      path.join(installPath, ".claude-plugin", "plugin.json"),
    );
    fs.writeFileSync(
      path.join(installPath, "plugin.json"),
      JSON.stringify({ name: "shipper", commands: ["./ok"] }),
    );
    writeCommand(
      path.join(installPath, "ok", "review.md"),
      "From later candidate",
      "List this.",
    );

    const listed = names(listInvocableCommands({ env: envHome() }));
    assert.ok(listed.includes("/shipper:review"));
    assert.ok(!listed.includes("/from-symlink:review"));
  });

  it("omits command and skill dirs that resolve outside the plugin root", () => {
    const pluginRoot = path.join(
      tmp,
      ".claude",
      "plugins",
      "cache",
      "mp",
      "shipper",
      "1.0.0",
    );
    const absCommands = path.join(tmp, "abs-commands");
    const absSkills = path.join(tmp, "abs-skills");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({
        name: "shipper",
        commands: ["../escaped-commands", absCommands, "./commands"],
        skills: ["../escaped-skills", absSkills, "./skills"],
      }),
    );
    writeCommand(
      path.join(pluginRoot, "..", "escaped-commands", "leak.md"),
      "Escaped command",
      "Must not list.",
    );
    writeCommand(
      path.join(absCommands, "abs.md"),
      "Absolute command",
      "Must not list.",
    );
    writeCommand(
      path.join(pluginRoot, "commands", "review.md"),
      "In-root command",
      "List this.",
    );
    writeSkill(
      path.join(pluginRoot, "..", "escaped-skills"),
      "leak",
      "---\ndescription: Escaped skill\n---\n\nNope.\n",
    );
    writeSkill(
      absSkills,
      "abs-skill",
      "---\ndescription: Absolute skill\n---\n\nNope.\n",
    );
    writeSkill(
      path.join(pluginRoot, "skills"),
      "ok",
      "---\ndescription: In-root skill\n---\n\nYes.\n",
    );
    writeClaudeInstalled(pluginRoot);

    const listed = names(listInvocableCommands({ env: envHome() }));
    assert.ok(listed.includes("/shipper:review"));
    assert.ok(listed.includes("/ok"));
    assert.ok(listed.includes("/shipper:ok"));
    assert.ok(!listed.includes("/shipper:leak"));
    assert.ok(!listed.includes("/leak"));
    assert.ok(!listed.includes("/shipper:abs"));
    assert.ok(!listed.includes("/abs"));
    assert.ok(!listed.includes("/abs-skill"));
    assert.ok(!listed.includes("/shipper:abs-skill"));
  });

  it("falls through invalid JSON on an earlier plugin.json to a later candidate", () => {
    const pluginRoot = path.join(
      tmp,
      ".claude",
      "plugins",
      "cache",
      "mp",
      "shipper",
      "1.0.0",
    );
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      "{ not json",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "shipper", commands: ["./slash"] }),
    );
    writeCommand(
      path.join(pluginRoot, "slash", "review.md"),
      "From later candidate",
      "List this.",
    );
    writeClaudeInstalled(pluginRoot);

    const listed = names(listInvocableCommands({ env: envHome() }));
    assert.ok(listed.includes("/shipper:review"));
    assert.ok(!listed.includes("/1.0.0:review"));
  });

});

describe("expandInvocableCommand", () => {
  it("injects the skill body and remaining args", () => {
    writeSkill(
      path.join(tmp, ".claude", "skills"),
      "commit",
      "---\nname: commit\ndescription: Commit\n---\n\n# Commit\n\nLook at git diff --staged.\n",
    );
    const hit = expandInvocableCommand("/commit the tests", {
      env: envHome(),
    });
    assert.ok(hit, "matched /commit");
    assert.equal(hit.name, "/commit");
    assert.equal(hit.kind, "skill");
    assert.match(hit.prompt, /Look at git diff --staged/);
    assert.match(hit.prompt, /the tests/);
    assert.ok(
      !hit.prompt.startsWith("/commit"),
      "slash token is expanded away so the CLI does not have to interpret it",
    );
  });

  it("expands a namespaced plugin skill", () => {
    const pluginRoot = path.join(tmp, "plugin");
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "si", skills: ["./skills"] }),
    );
    writeSkill(
      path.join(pluginRoot, "skills"),
      "review",
      "---\ndescription: Audit memory\n---\n\nRun the memory audit.\n",
    );
    fs.mkdirSync(path.join(tmp, ".claude", "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "si@x": [{ installPath: pluginRoot }],
        },
      }),
    );
    const hit = expandInvocableCommand("/si:review --quick", {
      env: envHome(),
    });
    assert.ok(hit);
    assert.equal(hit.name, "/si:review");
    assert.match(hit.prompt, /Run the memory audit/);
    assert.match(hit.prompt, /--quick/);
  });

  it("substitutes $ARGUMENTS in a custom command", () => {
    const dir = path.join(tmp, ".claude", "commands");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "draft.md"),
      "---\ndescription: Draft\n---\n\nWrite a changelog for $ARGUMENTS.\n",
    );
    const hit = expandInvocableCommand("/draft v0.7.0", { env: envHome() });
    assert.ok(hit);
    assert.equal(hit.kind, "command");
    assert.equal(hit.prompt.trim(), "Write a changelog for v0.7.0.");
  });

  it("returns null for unknown /foo and for non-slash prompts", () => {
    assert.equal(
      expandInvocableCommand("/foo bar", { env: envHome() }),
      null,
    );
    assert.equal(
      expandInvocableCommand("please /commit", { env: envHome() }),
      null,
    );
    assert.equal(expandInvocableCommand("", { env: envHome() }), null);
  });

  it("does not expand /handoff /advisor /committee — those are Solenta orch verbs", () => {
    writeSkill(
      path.join(tmp, ".claude", "skills"),
      "handoff",
      "---\ndescription: Not ours\n---\n\nWrong.\n",
    );
    assert.equal(
      expandInvocableCommand("/handoff @grok do it", { env: envHome() }),
      null,
    );
  });
});
