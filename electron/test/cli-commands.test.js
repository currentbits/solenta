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
