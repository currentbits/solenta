/**
 * Skills tab backend: SKILL.md parser, lister (fixture dirs under a tmp
 * HOME), add/remove path confinement, the mcpServers settings slice, and
 * syncUserMcpServers reconciliation.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseSkillMarkdown,
  listSkills,
  addSkill,
  removeSkill,
  syncSkills,
  skillBaseDir,
  SKILL_DIRS,
  SKILL_TARGETS,
  activeSkillTargets,
} = require("../skills.js");
const {
  Store,
  normalizeSettings,
  normalizeMcpServers,
  validateMcpServers,
} = require("../store.js");
const services = require("../services.js");
const {
  activeServers,
  getClaudeMcpArgs,
  registerMcpServer,
  resetMemorySupForTests,
  syncUserMcpServers,
} = require("../memory-sup.js");

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-skills-"));
});

afterEach(() => {
  resetMemorySupForTests();
  delete process.env.CODER_KIMI_MCP_PATH;
  delete process.env.CODER_GROK_MCP_DISABLE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Isolate memory-sup side effects: kimi config path into tmp, grok off. */
function isolateMcpSideEffects() {
  process.env.CODER_KIMI_MCP_PATH = path.join(tmp, "kimi-mcp.json");
  process.env.CODER_GROK_MCP_DISABLE = "1";
}

function writeSkill(base, name, content) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
}

/** Create parent config dirs so those targets count as active (CLI is set up). */
function activate(env, ...targets) {
  const dirs = SKILL_DIRS(env);
  for (const t of targets) {
    fs.mkdirSync(path.dirname(dirs[t]), { recursive: true });
  }
}

function skillBytes(base, name) {
  return fs.statSync(path.join(base, name, "SKILL.md")).size;
}

describe("parseSkillMarkdown", () => {
  it("reads name and description from frontmatter", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: review-pr\ndescription: Review a PR end to end\n---\n\n# Body\n",
    );
    assert.equal(parsed.name, "review-pr");
    assert.equal(parsed.description, "Review a PR end to end");
  });

  it("strips quotes around frontmatter values", () => {
    const parsed = parseSkillMarkdown(
      '---\ndescription: "Quoted value"\n---\n',
    );
    assert.equal(parsed.description, "Quoted value");
  });

  it("ignores unknown frontmatter keys and keeps the first description", () => {
    const parsed = parseSkillMarkdown(
      "---\nauthor: x\ndescription: First\ndescription: Second\n---\n",
    );
    assert.equal(parsed.name, null);
    assert.equal(parsed.description, "First");
  });

  it("falls back to a bare description: line without frontmatter", () => {
    const parsed = parseSkillMarkdown("# Title\n\ndescription: Bare line\n");
    assert.equal(parsed.description, "Bare line");
  });

  it("falls back to the first non-heading content line", () => {
    const parsed = parseSkillMarkdown("# Title\n\nDoes the thing.\nMore.\n");
    assert.equal(parsed.description, "Does the thing.");
  });

  it("returns empty description for empty/garbage content", () => {
    assert.deepEqual(parseSkillMarkdown(""), { name: null, description: "" });
    assert.deepEqual(parseSkillMarkdown(null), { name: null, description: "" });
    assert.deepEqual(parseSkillMarkdown("# Only a heading\n"), {
      name: null,
      description: "",
    });
  });
});

describe("SKILL_DIRS / activeSkillTargets", () => {
  it("maps each target onto the verified user skills path", () => {
    const env = { HOME: tmp };
    const dirs = SKILL_DIRS(env);
    assert.deepEqual(SKILL_TARGETS, [
      "claude",
      "agents",
      "codex",
      "grok",
      "opencode",
      "kimi",
      "cursor",
    ]);
    assert.equal(dirs.claude, path.join(tmp, ".claude", "skills"));
    assert.equal(dirs.agents, path.join(tmp, ".agents", "skills"));
    assert.equal(dirs.codex, path.join(tmp, ".codex", "skills"));
    assert.equal(dirs.grok, path.join(tmp, ".grok", "skills"));
    assert.equal(
      dirs.opencode,
      path.join(tmp, ".config", "opencode", "skills"),
    );
    assert.equal(dirs.kimi, path.join(tmp, ".kimi", "skills"));
    assert.equal(dirs.cursor, path.join(tmp, ".cursor", "skills"));
    assert.equal(skillBaseDir("claude", env), dirs.claude);
    assert.equal(skillBaseDir("opencode", env), dirs.opencode);
    assert.equal(skillBaseDir("cursor", env), dirs.cursor);
    assert.throws(() => skillBaseDir("project", env), /target/i);
  });

  it("treats a target as active only when its CLI dir exists", () => {
    const env = { HOME: tmp };
    assert.deepEqual(activeSkillTargets(env), []);
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".config", "opencode"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".codex", "skills"), { recursive: true });
    assert.deepEqual(activeSkillTargets(env), [
      "claude",
      "codex",
      "opencode",
    ]);
  });
});

describe("listSkills", () => {
  it("merges the same name into one row with installedIn/missingFrom/bytes", () => {
    const env = { HOME: tmp };
    activate(env, "claude", "agents", "codex");
    const content =
      "---\nname: review-pr\ndescription: Review a PR\n---\n\nBody\n";
    writeSkill(path.join(tmp, ".claude", "skills"), "review-pr", content);
    writeSkill(path.join(tmp, ".agents", "skills"), "review-pr", content);
    writeSkill(
      path.join(tmp, ".agents", "skills"),
      "write-tests",
      "---\ndescription: Add tests\n---\n",
    );

    const list = listSkills(null, env);
    const reviewBytes = skillBytes(path.join(tmp, ".claude", "skills"), "review-pr");
    const writeBytes = skillBytes(path.join(tmp, ".agents", "skills"), "write-tests");
    assert.deepEqual(list, [
      {
        name: "review-pr",
        description: "Review a PR",
        source: "claude",
        installedIn: ["claude", "agents"],
        missingFrom: ["codex"],
        bytes: reviewBytes,
      },
      {
        name: "write-tests",
        description: "Add tests",
        source: "agents",
        installedIn: ["agents"],
        missingFrom: ["claude", "codex"],
        bytes: writeBytes,
      },
    ]);
    // Context cost is SKILL.md only, not sibling files under the skill dir.
    fs.writeFileSync(
      path.join(tmp, ".claude", "skills", "review-pr", "notes.md"),
      "x".repeat(4000),
    );
    assert.equal(listSkills(null, env)[0].bytes, reviewBytes);
  });

  it("keeps project rows separate and read-only, even when names collide", () => {
    const env = { HOME: tmp };
    activate(env, "claude");
    const userContent = "---\ndescription: User copy\n---\n";
    writeSkill(path.join(tmp, ".claude", "skills"), "shared", userContent);
    const project = path.join(tmp, "proj");
    const projectContent = "---\ndescription: Project rules\n---\n";
    writeSkill(
      path.join(project, ".claude", "skills"),
      "shared",
      projectContent,
    );
    writeSkill(
      path.join(project, ".claude", "skills"),
      "local-only",
      "---\ndescription: Local\n---\n",
    );

    const list = listSkills(project, env);
    assert.equal(list.length, 3);
    assert.deepEqual(
      list.map((s) => ({ name: s.name, source: s.source })),
      [
        { name: "shared", source: "claude" },
        { name: "local-only", source: "project" },
        { name: "shared", source: "project" },
      ],
    );
    const projectShared = list.find(
      (s) => s.name === "shared" && s.source === "project",
    );
    assert.deepEqual(projectShared.installedIn, []);
    assert.deepEqual(projectShared.missingFrom, []);
    assert.equal(
      projectShared.bytes,
      skillBytes(path.join(project, ".claude", "skills"), "shared"),
    );
    assert.notEqual(
      projectShared.bytes,
      skillBytes(path.join(tmp, ".claude", "skills"), "shared"),
    );
  });

  it("tolerates missing dirs and skips dirs without SKILL.md", () => {
    const env = { HOME: tmp };
    fs.mkdirSync(path.join(tmp, ".claude", "skills", "no-file"), {
      recursive: true,
    });
    writeSkill(path.join(tmp, ".agents", "skills"), "one", "body only\n");
    const list = listSkills(null, env);
    assert.deepEqual(list, [
      {
        name: "one",
        description: "body only",
        source: "agents",
        installedIn: ["agents"],
        missingFrom: ["claude"],
        bytes: skillBytes(path.join(tmp, ".agents", "skills"), "one"),
      },
    ]);
  });

  it("names the skill after its directory, not the frontmatter", () => {
    const env = { HOME: tmp };
    writeSkill(
      path.join(tmp, ".claude", "skills"),
      "dir-name",
      "---\nname: other-name\ndescription: D\n---\n",
    );
    const list = listSkills(null, env);
    assert.equal(list[0].name, "dir-name");
  });
});

describe("addSkill / removeSkill", () => {
  it("fans out to every active target and skips inactive ones", () => {
    const env = { HOME: tmp };
    activate(env, "claude", "agents", "codex");
    const out = addSkill(
      {
        name: "my-skill",
        description: "Does a thing",
        body: "# Steps\n\n1. Do it.",
      },
      env,
    );
    assert.deepEqual(out, {
      name: "my-skill",
      installedIn: ["claude", "agents", "codex"],
    });
    const dirs = SKILL_DIRS(env);
    for (const target of ["claude", "agents", "codex"]) {
      const file = path.join(dirs[target], "my-skill", "SKILL.md");
      const content = fs.readFileSync(file, "utf8");
      assert.ok(
        content.startsWith(
          "---\nname: my-skill\ndescription: Does a thing\n---\n",
        ),
      );
      assert.ok(content.includes("1. Do it."));
    }
    for (const target of ["grok", "opencode", "kimi", "cursor"]) {
      assert.equal(fs.existsSync(dirs[target]), false);
    }
    const list = listSkills(null, env);
    assert.deepEqual(list, [
      {
        name: "my-skill",
        description: "Does a thing",
        source: "claude",
        installedIn: ["claude", "agents", "codex"],
        missingFrom: [],
        bytes: skillBytes(dirs.claude, "my-skill"),
      },
    ]);
  });

  it("collapses multi-line descriptions into one frontmatter line", () => {
    const env = { HOME: tmp };
    activate(env, "claude");
    addSkill(
      { name: "s", description: "line one\nline two", body: "b" },
      env,
    );
    const list = listSkills(null, env);
    assert.equal(list[0].description, "line one line two");
  });

  it("rejects bad names and empty fields; traversal guard rejects ../evil", () => {
    const env = { HOME: tmp };
    activate(env, "claude");
    assert.throws(
      () => addSkill({ name: "Bad Name", description: "d", body: "b" }, env),
      /Skill name/,
    );
    assert.throws(
      () => addSkill({ name: "../evil", description: "d", body: "b" }, env),
      /Skill name/,
    );
    assert.throws(
      () => addSkill({ name: "ok", description: "", body: "b" }, env),
      /description is required/i,
    );
    assert.throws(
      () => addSkill({ name: "ok", description: "d", body: " " }, env),
      /body is required/i,
    );
    // Nothing was written on any rejection.
    assert.equal(fs.existsSync(path.join(tmp, ".claude", "skills")), false);
    assert.equal(fs.existsSync(path.join(tmp, "evil")), false);
  });

  it("removeSkill clears every copy and refuses unknown skills", () => {
    const env = { HOME: tmp };
    activate(env, "claude", "agents");
    addSkill({ name: "gone", description: "d", body: "b" }, env);
    assert.deepEqual(removeSkill({ name: "gone" }, env), { name: "gone" });
    const dirs = SKILL_DIRS(env);
    assert.equal(fs.existsSync(path.join(dirs.claude, "gone")), false);
    assert.equal(fs.existsSync(path.join(dirs.agents, "gone")), false);
    assert.throws(() => removeSkill({ name: "gone" }, env), /Unknown skill/);
    assert.throws(
      () => removeSkill({ name: ".." }, env),
      /Skill name/,
    );
  });
});

describe("syncSkills", () => {
  it("fills drift, copies subdirectories, and is idempotent", () => {
    const env = { HOME: tmp };
    activate(env, "claude", "agents", "codex");
    const src = path.join(tmp, ".claude", "skills", "ship-it");
    fs.mkdirSync(path.join(src, "references"), { recursive: true });
    fs.mkdirSync(path.join(src, "examples"), { recursive: true });
    fs.writeFileSync(
      path.join(src, "SKILL.md"),
      "---\ndescription: Ship it\n---\n\nGo.\n",
    );
    fs.writeFileSync(path.join(src, "references", "api.md"), "api notes\n");
    fs.writeFileSync(path.join(src, "examples", "ok.md"), "example\n");

    const first = syncSkills(env);
    assert.deepEqual(first, { copied: 2, skills: ["ship-it"] });
    const dirs = SKILL_DIRS(env);
    for (const target of ["agents", "codex"]) {
      assert.equal(
        fs.readFileSync(
          path.join(dirs[target], "ship-it", "references", "api.md"),
          "utf8",
        ),
        "api notes\n",
      );
      assert.equal(
        fs.readFileSync(
          path.join(dirs[target], "ship-it", "examples", "ok.md"),
          "utf8",
        ),
        "example\n",
      );
    }
    assert.equal(fs.existsSync(path.join(dirs.grok, "ship-it")), false);

    const second = syncSkills(env);
    assert.deepEqual(second, { copied: 0, skills: [] });

    const list = listSkills(null, env);
    assert.deepEqual(list[0].installedIn, ["claude", "agents", "codex"]);
    assert.deepEqual(list[0].missingFrom, []);
  });

  it("counts a symlinked skill as installed and copies real content out", () => {
    const env = { HOME: tmp };
    activate(env, "claude", "agents", "opencode");
    const agents = path.join(tmp, ".agents", "skills");
    const claude = path.join(tmp, ".claude", "skills");
    writeSkill(agents, "linked", "---\ndescription: Linked\n---\n\nBody.\n");
    fs.mkdirSync(claude, { recursive: true });
    // The pre-existing hand-rolled fan-out: a relative link into ~/.agents.
    fs.symlinkSync(
      path.join("..", "..", ".agents", "skills", "linked"),
      path.join(claude, "linked"),
    );

    // Seen through the link, so claude is NOT drift.
    const row = listSkills(null, env).find((s) => s.name === "linked");
    assert.deepEqual(row.installedIn, ["claude", "agents"]);
    assert.deepEqual(row.missingFrom, ["opencode"]);
    assert.equal(row.description, "Linked");

    assert.deepEqual(syncSkills(env), { copied: 1, skills: ["linked"] });
    // opencode sits a level deeper, so a copied-verbatim link would dangle.
    const dest = path.join(SKILL_DIRS(env).opencode, "linked");
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), false);
    assert.equal(
      fs.readFileSync(path.join(dest, "SKILL.md"), "utf8"),
      "---\ndescription: Linked\n---\n\nBody.\n",
    );
    assert.deepEqual(syncSkills(env), { copied: 0, skills: [] });
  });

  it("skips a name it could never write back instead of aborting the sync", () => {
    const env = { HOME: tmp };
    activate(env, "claude", "agents");
    const claude = path.join(tmp, ".claude", "skills");
    // A marketplace can install a dir our name rule rejects; it must not take
    // the whole fan-out down with it.
    writeSkill(claude, "Legacy.Skill", "---\ndescription: Old\n---\n\nx\n");
    writeSkill(claude, "ship-it", "---\ndescription: Ship it\n---\n\nGo.\n");

    assert.deepEqual(syncSkills(env), { copied: 1, skills: ["ship-it"] });
    const dirs = SKILL_DIRS(env);
    assert.equal(fs.existsSync(path.join(dirs.agents, "ship-it")), true);
    assert.equal(fs.existsSync(path.join(dirs.agents, "Legacy.Skill")), false);

    // Still listed, but never reported as drift we cannot actually clear.
    const odd = listSkills(null, env).find((s) => s.name === "Legacy.Skill");
    assert.deepEqual(odd.installedIn, ["claude"]);
    assert.deepEqual(odd.missingFrom, []);
  });
});

describe("mcpServers settings slice", () => {
  it("normalizeSettings heals junk entries and keeps valid ones", () => {
    const n = normalizeSettings({
      mcpServers: [
        { name: "ok-one", url: "https://a.example.com/mcp", enabled: true, token: "t" },
        { name: "coder-memory", url: "https://b.example.com/mcp" }, // reserved
        { name: "Bad Name", url: "https://c.example.com/mcp" }, // bad name
        { name: "no-url" }, // missing url
        { name: "ok-one", url: "https://dup.example.com/mcp" }, // duplicate
        "garbage",
        { name: "off", url: "http://127.0.0.1:9000/mcp", enabled: 0 }, // enabled coerced
      ],
    });
    assert.deepEqual(n.mcpServers, [
      { name: "ok-one", url: "https://a.example.com/mcp", enabled: true, token: "t" },
      { name: "off", url: "http://127.0.0.1:9000/mcp", enabled: true },
    ]);
  });

  it("normalizeMcpServers returns [] for non-arrays", () => {
    assert.deepEqual(normalizeMcpServers(null), []);
    assert.deepEqual(normalizeMcpServers("x"), []);
  });

  it("validateMcpServers throws on the first problem", () => {
    assert.throws(() => validateMcpServers("nope"), /must be an array/);
    assert.throws(
      () => validateMcpServers([{ name: "X", url: "https://a.b/mcp" }]),
      /name must be lowercase/,
    );
    assert.throws(
      () => validateMcpServers([{ name: "coder-threads", url: "https://a.b/mcp" }]),
      /reserved/,
    );
    assert.throws(
      () => validateMcpServers([{ name: "ok", url: "ftp://a.b/mcp" }]),
      /http\(s\)/,
    );
    assert.throws(
      () =>
        validateMcpServers([
          { name: "dup", url: "https://a.b/mcp" },
          { name: "dup", url: "https://c.d/mcp" },
        ]),
      /Duplicate/,
    );
  });

  it("services.setSettings validates, persists, and round-trips", () => {
    const store = new Store(path.join(tmp, "store.json"));
    const next = services.setSettings(store, {
      mcpServers: [
        { name: "team-tools", url: "https://tools.example.com/mcp", enabled: true },
      ],
    });
    assert.equal(next.mcpServers.length, 1);
    assert.equal(next.mcpServers[0].name, "team-tools");

    store.saveNow();
    const reloaded = new Store(path.join(tmp, "store.json"));
    assert.deepEqual(reloaded.getSettings().mcpServers, [
      { name: "team-tools", url: "https://tools.example.com/mcp", enabled: true },
    ]);

    assert.throws(
      () =>
        services.setSettings(store, {
          mcpServers: [{ name: "coder-memory", url: "https://x.example.com/mcp" }],
        }),
      /reserved/,
    );
    // The failed patch must not clobber the stored list.
    assert.equal(store.getSettings().mcpServers.length, 1);
  });
});

describe("syncUserMcpServers", () => {
  it("registers enabled url servers and removes stale ones", () => {
    isolateMcpSideEffects();
    syncUserMcpServers([
      { name: "team-tools", url: "https://tools.example.com/mcp", enabled: true, token: "tok" },
      { name: "off-srv", url: "https://off.example.com/mcp", enabled: false },
      { name: "coder-threads", url: "https://evil.example.com/mcp", enabled: true },
    ]);
    let names = activeServers().map((s) => s.name);
    assert.deepEqual(names, ["team-tools"]);
    const entry = activeServers()[0];
    assert.equal(entry.url, "https://tools.example.com/mcp");
    assert.equal(entry.token, "tok");

    // Disable -> unregistered; new server -> registered.
    syncUserMcpServers([
      { name: "team-tools", url: "https://tools.example.com/mcp", enabled: false },
      { name: "new-srv", url: "https://new.example.com/mcp", enabled: true },
    ]);
    names = activeServers().map((s) => s.name);
    assert.deepEqual(names, ["new-srv"]);
    assert.equal(activeServers()[0].token, "");
  });

  it("never unregisters built-ins registered without the user flag", () => {
    isolateMcpSideEffects();
    registerMcpServer({ name: "coder-threads", port: 4317, token: "secret" });
    syncUserMcpServers([]);
    assert.deepEqual(
      activeServers().map((s) => s.name),
      ["coder-threads"],
    );
  });

  it("keeps user servers out of the claude allow rule", () => {
    isolateMcpSideEffects();
    registerMcpServer({
      name: "coder-threads",
      port: 4317,
      token: "secret",
      userDataPath: tmp,
    });
    syncUserMcpServers(
      [{ name: "team-tools", url: "https://tools.example.com/mcp", enabled: true }],
      { userDataPath: tmp },
    );

    const args = getClaudeMcpArgs();
    assert.equal(args.length, 2);
    assert.equal(args[1], "--allowedTools=mcp__coder-threads__*");
    // Still reachable, just not pre-approved: the config lists both.
    const cfg = JSON.parse(
      fs.readFileSync(args[0].slice("--mcp-config=".length), "utf8"),
    );
    assert.deepEqual(Object.keys(cfg.mcpServers).sort(), [
      "coder-threads",
      "team-tools",
    ]);

    // Only user servers left -> no allow rule at all (never an empty one).
    resetMemorySupForTests();
    syncUserMcpServers(
      [{ name: "team-tools", url: "https://tools.example.com/mcp", enabled: true }],
      { userDataPath: tmp },
    );
    assert.deepEqual(
      getClaudeMcpArgs().map((a) => a.split("=")[0]),
      ["--mcp-config"],
    );
  });

  it("url-based registration needs no token; port-based still requires one", () => {
    isolateMcpSideEffects();
    assert.equal(
      registerMcpServer({ name: "u1", url: "https://a.example.com/mcp" }),
      true,
    );
    assert.equal(
      registerMcpServer({ name: "u2", url: "ftp://a.example.com/mcp" }),
      false,
    );
    assert.equal(registerMcpServer({ name: "u3", port: 1234, token: "" }), false);
    assert.equal(activeServers().length, 1);
  });
});
