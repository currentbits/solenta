/**
 * Issue #172: per-thread CLI custom agents (claude --agent, opencode --agent).
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { getProvider, listProviders } = require("../providers.js");
const { listAgents } = require("../agents.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { rmTree } = require("./support/rmTree.js");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe("cli agents: discovery", () => {
  let tmp;
  let home;
  let repo;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-agents-"));
    home = path.join(tmp, "home");
    repo = path.join(tmp, "repo");
    fs.mkdirSync(home);
    fs.mkdirSync(repo);
  });
  afterEach(async () => {
    await rmTree(tmp);
  });

  it("lists claude project + user agents, frontmatter name wins, project shadows user", () => {
    write(
      path.join(repo, ".claude/agents/rev.md"),
      "---\nname: reviewer\ndescription: Reviews diffs\n---\nbody",
    );
    write(path.join(home, ".claude/agents/reviewer.md"), "---\ndescription: user copy\n---\n");
    write(path.join(home, ".claude/agents/scout.md"), "---\ndescription: Explores\n---\n");
    write(path.join(home, ".claude/agents/bad name.md"), "x");
    write(path.join(home, ".claude/agents/notes.txt"), "x");
    const rows = listAgents({ provider: "claude", projectPath: repo, env: { HOME: home } });
    assert.deepEqual(rows, [
      { name: "reviewer", description: "Reviews diffs", source: "project" },
      { name: "scout", description: "Explores", source: "user" },
    ]);
  });

  it("lists opencode builtins + primaries, skips subagents, file overrides builtin", () => {
    write(path.join(repo, ".opencode/agent/plan.md"), "---\ndescription: custom plan\n---\n");
    write(path.join(repo, ".opencode/agents/docs.md"), "---\ndescription: Docs\nmode: primary\n---\n");
    write(path.join(home, ".config/opencode/agent/helper.md"), "---\nmode: subagent\n---\n");
    const rows = listAgents({ provider: "opencode", projectPath: repo, env: { HOME: home } });
    assert.deepEqual(
      rows.map((r) => `${r.name}:${r.source}`),
      ["build:builtin", "plan:project", "docs:project"],
    );
  });

  it("lists nothing for CLIs without --agent", () => {
    write(path.join(repo, ".claude/agents/x.md"), "x");
    assert.deepEqual(listAgents({ provider: "codex", projectPath: repo, env: { HOME: home } }), []);
  });
});

describe("cli agents: argv", () => {
  it("claude and opencode emit --agent only when set", () => {
    for (const id of ["claude", "opencode"]) {
      const entry = getProvider(id);
      const without = entry.buildArgs({ prompt: "p" });
      assert.ok(!without.includes("--agent"), id);
      const args = entry.buildArgs({ prompt: "p", agent: "reviewer" });
      assert.equal(args[args.indexOf("--agent") + 1], "reviewer", id);
    }
    // opencode keeps the prompt last.
    const oc = getProvider("opencode").buildArgs({ prompt: "PROMPT", agent: "plan" });
    assert.equal(oc[oc.length - 1], "PROMPT");
  });

  it("advertises supportsAgents only on claude and opencode", () => {
    const flagged = listProviders({ which: () => null, env: {} })
      .filter((p) => p.supportsAgents)
      .map((p) => p.id)
      .sort();
    assert.deepEqual(flagged, ["claude", "opencode"]);
  });
});

describe("cli agents: setAgent service", () => {
  let tmpDir;
  let store;
  let project;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-agents-svc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
  });
  afterEach(async () => {
    await rmTree(tmpDir);
  });

  it("persists a valid name, clears with null, rejects unsafe names and other CLIs", () => {
    const t = services.createThread(store, { projectId: project.id, title: "T" });
    services.setProvider(store, { threadId: t.id, provider: "claude" });
    assert.equal(services.setAgent(store, { threadId: t.id, agent: "reviewer" }).agent, "reviewer");
    assert.equal(store.getThread(t.id).agent, "reviewer");
    assert.throws(() => services.setAgent(store, { threadId: t.id, agent: "x; rm -rf ~" }), /Invalid agent/);
    assert.throws(() => services.setAgent(store, { threadId: t.id, agent: "-p" }), /Invalid agent/);
    assert.equal(services.setAgent(store, { threadId: t.id, agent: null }).agent, null);

    services.setAgent(store, { threadId: t.id, agent: "reviewer" });
    services.setProvider(store, { threadId: t.id, provider: "codex" });
    assert.equal(store.getThread(t.id).agent, null, "provider switch clears the agent");
    assert.throws(() => services.setAgent(store, { threadId: t.id, agent: "reviewer" }), /does not support/);
  });
});
