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
  skillBaseDir,
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

describe("listSkills", () => {
  it("scans both user dirs and the project dir, tagged by source", () => {
    const env = { HOME: tmp };
    writeSkill(
      path.join(tmp, ".claude", "skills"),
      "review-pr",
      "---\nname: review-pr\ndescription: Review a PR\n---\n\nBody\n",
    );
    writeSkill(
      path.join(tmp, ".agents", "skills"),
      "write-tests",
      "---\ndescription: Add tests\n---\n",
    );
    const project = path.join(tmp, "proj");
    writeSkill(
      path.join(project, ".claude", "skills"),
      "local-rules",
      "---\ndescription: Project rules\n---\n",
    );

    const list = listSkills(project, env);
    assert.deepEqual(list, [
      { name: "review-pr", description: "Review a PR", source: "claude" },
      { name: "write-tests", description: "Add tests", source: "agents" },
      { name: "local-rules", description: "Project rules", source: "project" },
    ]);
  });

  it("tolerates missing dirs and skips dirs without SKILL.md", () => {
    const env = { HOME: tmp };
    fs.mkdirSync(path.join(tmp, ".claude", "skills", "no-file"), {
      recursive: true,
    });
    writeSkill(path.join(tmp, ".agents", "skills"), "one", "body only\n");
    const list = listSkills(null, env);
    assert.deepEqual(list, [
      { name: "one", description: "body only", source: "agents" },
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
  it("writes <base>/<name>/SKILL.md with frontmatter", () => {
    const env = { HOME: tmp };
    const out = addSkill(
      {
        target: "agents",
        name: "my-skill",
        description: "Does a thing",
        body: "# Steps\n\n1. Do it.",
      },
      env,
    );
    assert.deepEqual(out, { name: "my-skill" });
    const file = path.join(
      tmp,
      ".agents",
      "skills",
      "my-skill",
      "SKILL.md",
    );
    const content = fs.readFileSync(file, "utf8");
    assert.ok(content.startsWith("---\nname: my-skill\ndescription: Does a thing\n---\n"));
    assert.ok(content.includes("1. Do it."));
    // And the lister sees it.
    const list = listSkills(null, env);
    assert.deepEqual(list, [
      { name: "my-skill", description: "Does a thing", source: "agents" },
    ]);
  });

  it("collapses multi-line descriptions into one frontmatter line", () => {
    const env = { HOME: tmp };
    addSkill(
      { target: "claude", name: "s", description: "line one\nline two", body: "b" },
      env,
    );
    const list = listSkills(null, env);
    assert.equal(list[0].description, "line one line two");
  });

  it("rejects bad names, targets, and empty fields", () => {
    const env = { HOME: tmp };
    assert.throws(
      () => addSkill({ target: "claude", name: "Bad Name", description: "d", body: "b" }, env),
      /Skill name/,
    );
    assert.throws(
      () => addSkill({ target: "claude", name: "../evil", description: "d", body: "b" }, env),
      /Skill name/,
    );
    assert.throws(
      () => addSkill({ target: "project", name: "ok", description: "d", body: "b" }, env),
      /target/i,
    );
    assert.throws(
      () => addSkill({ target: "claude", name: "ok", description: "", body: "b" }, env),
      /description is required/i,
    );
    assert.throws(
      () => addSkill({ target: "claude", name: "ok", description: "d", body: " " }, env),
      /body is required/i,
    );
    // Nothing was written on any rejection.
    assert.equal(fs.existsSync(path.join(tmp, ".claude")), false);
  });

  it("removeSkill deletes the folder and refuses unknown skills", () => {
    const env = { HOME: tmp };
    addSkill({ target: "claude", name: "gone", description: "d", body: "b" }, env);
    assert.deepEqual(removeSkill({ target: "claude", name: "gone" }, env), {
      name: "gone",
    });
    assert.equal(
      fs.existsSync(path.join(tmp, ".claude", "skills", "gone")),
      false,
    );
    assert.throws(
      () => removeSkill({ target: "claude", name: "gone" }, env),
      /Unknown skill/,
    );
    assert.throws(
      () => removeSkill({ target: "agents", name: "..", description: "", body: "" }, env),
      /Skill name/,
    );
  });

  it("confines writes to the two user skill dirs", () => {
    const env = { HOME: tmp };
    assert.equal(skillBaseDir("claude", env), path.join(tmp, ".claude", "skills"));
    assert.equal(skillBaseDir("agents", env), path.join(tmp, ".agents", "skills"));
    assert.throws(() => skillBaseDir("project", env), /target/i);
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
