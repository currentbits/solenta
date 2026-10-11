"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  parseRepoWorkflow,
  serializeRepoWorkflow,
  loadRepoWorkflow,
} = require("../repoWorkflow.js");

it("#164: serialize/parse round-trips a template, model and multiline instruction included", () => {
  const template = {
    name: "Plan and Verify",
    phases: [
      { name: "seed", agentCount: 1, instruction: "Plan.\n\n- one\n- two", provider: "claude", model: null },
      { name: "check", agentCount: 3, instruction: "Verify.", provider: "codex", model: "gpt-5" },
    ],
  };
  assert.deepEqual(parseRepoWorkflow(serializeRepoWorkflow(template)), template);
  assert.throws(
    () => parseRepoWorkflow("# X\n\n## a\nprovidr: claude\n\nx"),
    /unknown key "providr"/,
  );
});

it("#164: loadRepoWorkflow prefers WORKFLOW.md, falls back to .solenta/workflow.md, null when absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-repowf-"));
  try {
    assert.equal(loadRepoWorkflow(dir), null);
    fs.mkdirSync(path.join(dir, ".solenta"));
    fs.writeFileSync(path.join(dir, ".solenta", "workflow.md"), "# Dot\n\n## a\nprovider: claude\n\nx\n");
    assert.equal(loadRepoWorkflow(dir).name, "Dot");
    fs.writeFileSync(path.join(dir, "WORKFLOW.md"), "# Top\n\n## a\nprovider: claude\n\nx\n");
    assert.equal(loadRepoWorkflow(dir).name, "Top");
    fs.writeFileSync(path.join(dir, "WORKFLOW.md"), "# Top\n");
    assert.throws(() => loadRepoWorkflow(dir), /^Error: WORKFLOW\.md: Template must have between 1 and 6 phases/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("#164: exportTemplateToRepo writes into the thread checkout and asks before overwriting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-repowf-"));
  try {
    const repo = path.join(dir, "app");
    fs.mkdirSync(repo);
    require("node:child_process").execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const store = new Store(path.join(dir, "store.json"));
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, { projectId: project.id, title: "t" });
    const file = path.join(repo, "WORKFLOW.md");

    assert.deepEqual(
      services.exportTemplateToRepo(store, { id: "standard", threadId: thread.id }),
      { written: true, path: file },
    );
    assert.equal(loadRepoWorkflow(repo).name, "Plan and Verify");

    fs.writeFileSync(file, "mine");
    assert.equal(
      services.exportTemplateToRepo(store, { id: "standard", threadId: thread.id }).written,
      false,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "mine");
    services.exportTemplateToRepo(store, { id: "standard", threadId: thread.id, overwrite: true });
    assert.match(fs.readFileSync(file, "utf8"), /^# Plan and Verify\n/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
