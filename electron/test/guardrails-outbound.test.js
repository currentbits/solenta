"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { setupWorktree, createPr, push, commit } = require("../worktrees.js");
const { suggestCommitMessage } = require("../commitmsg.js");

const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const FAKE_GH_TOKEN = `ghp_${"a".repeat(36)}`;

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Minimal offline `gh` fake, same CODER_GH_BIN / CODER_FAKE_GH_STATE pattern
 * as worktrees.test.js. No network.
 * @param {string} dir
 */
function writeFakeGh(dir) {
  const bin = path.join(dir, "fake-gh");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
const statePath = process.env.CODER_FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
state.calls = state.calls || [];
state.calls.push(args.slice());
state.prs = state.prs || {};
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
function save() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}
save();
if (args[0] === "pr" && args[1] === "view") {
  const pr = state.prs[args[2]];
  if (!pr) {
    process.stderr.write("no pull requests found for branch\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(pr) + "\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const head = flagValue("--head");
  const number = state.nextNumber || 42;
  state.nextNumber = number + 1;
  const url = "https://github.com/acme/demo/pull/" + number;
  state.prs[head] = { number: number, url: url, state: "OPEN" };
  state.createCount = (state.createCount || 0) + 1;
  save();
  process.stdout.write(url + "\\n");
  process.exit(0);
}
process.exit(2);
`,
    { mode: 0o755 },
  );
  return bin;
}

describe("guardrails outbound", () => {
  let tmpDir;
  let store;
  let repo;
  let thread;
  let worktreeBase;
  const prevGhBin = process.env.CODER_GH_BIN;
  const prevGhState = process.env.CODER_FAKE_GH_STATE;
  const prevGuardrails = process.env.CODER_GUARDRAILS;

  beforeEach(async () => {
    delete process.env.CODER_GUARDRAILS;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-outguard-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");

    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    try {
      git(repo, ["checkout", "-b", "main"]);
    } catch {
      // already on main/master
    }

    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "Outbound scan",
    });
  });

  afterEach(() => {
    try {
      const t = store.getThread(thread.id);
      if (t && t.worktreePath && fs.existsSync(t.worktreePath)) {
        try {
          git(repo, ["worktree", "remove", "--force", t.worktreePath]);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevGhBin === undefined) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGhBin;
    if (prevGhState === undefined) delete process.env.CODER_FAKE_GH_STATE;
    else process.env.CODER_FAKE_GH_STATE = prevGhState;
    if (prevGuardrails === undefined) delete process.env.CODER_GUARDRAILS;
    else process.env.CODER_GUARDRAILS = prevGuardrails;
  });

  function preparePr() {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "feat\n");
    git(setup.worktreePath, ["add", "feature.txt"]);
    git(setup.worktreePath, ["commit", "-m", "feature commit"]);

    const bare = path.join(tmpDir, "remote.git");
    git(tmpDir, ["init", "--bare", bare]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
    git(repo, ["remote", "set-url", "--push", "origin", bare]);

    const fakeDir = path.join(tmpDir, "fake-bin");
    fs.mkdirSync(fakeDir, { recursive: true });
    const fakeGh = writeFakeGh(fakeDir);
    const statePath = path.join(tmpDir, "gh-state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({ scenario: "success", prs: {}, calls: [], nextNumber: 42 }),
      "utf8",
    );
    process.env.CODER_GH_BIN = fakeGh;
    process.env.CODER_FAKE_GH_STATE = statePath;
    return { setup, statePath };
  }

  it("refuses a PR body containing a fake AWS key and never prints the raw key", async () => {
    const { statePath } = preparePr();

    await assert.rejects(
      createPr({
        store,
        threadId: thread.id,
        title: "Ship feature",
        body: `Uses ${FAKE_AWS_KEY} for S3`,
        draft: false,
        broadcast: () => {},
      }),
      (err) => {
        assert.match(err.message, /Blocked by Solenta guardrails/i);
        assert.match(err.message, /secret\.aws-key/);
        assert.ok(
          !err.message.includes(FAKE_AWS_KEY),
          `raw key leaked in error: ${err.message}`,
        );
        return true;
      },
    );

    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      (state.calls || []).some((c) => c[0] === "pr" && c[1] === "create"),
      false,
      "gh pr create must not run when the body is blocked",
    );
  });

  it("lets a clean PR body through", async () => {
    const { setup, statePath } = preparePr();

    const info = await createPr({
      store,
      threadId: thread.id,
      title: "Ship feature",
      body: "Adds feature.txt",
      draft: false,
      broadcast: () => {},
    });

    assert.equal(info.number, 42);
    assert.equal(info.created, true);
    assert.equal(info.branch, setup.branch);

    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(
      state.calls.some((c) => c[0] === "pr" && c[1] === "create"),
      "expected gh pr create",
    );
  });

  it("refuses a generated commit message that contains a token", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    const fakeBin = path.join(tmpDir, "fake-claude");
    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
console.log("feat: leak ${FAKE_GH_TOKEN}");
`,
    );
    fs.chmodSync(fakeBin, 0o755);

    await assert.rejects(
      suggestCommitMessage({
        store,
        threadId: thread.id,
        env: {
          ...process.env,
          CODER_CLAUDE_BIN: fakeBin,
          CODER_FM_DISABLE: "1",
        },
      }),
      (err) => {
        assert.match(err.message, /Blocked by Solenta guardrails/i);
        assert.match(err.message, /secret\.github-token/);
        assert.ok(
          !err.message.includes(FAKE_GH_TOKEN),
          `raw token leaked in error: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("refuses a commit whose message contains a token", () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    assert.throws(
      () =>
        commit({
          store,
          threadId: thread.id,
          message: `feat: leak ${FAKE_GH_TOKEN}`,
        }),
      (err) => {
        assert.match(err.message, /Blocked by Solenta guardrails/i);
        assert.match(err.message, /secret\.github-token/);
        assert.ok(!err.message.includes(FAKE_GH_TOKEN));
        return true;
      },
    );
    assert.match(git(repo, ["status", "--porcelain"]), /\?\? a\.txt/);
  });

  it("refuses a push whose outgoing diff contains a secret", () => {
    const bare = path.join(tmpDir, "remote.git");
    git(tmpDir, ["init", "--bare", bare]);
    git(repo, ["remote", "add", "origin", bare]);

    // Establish origin/<branch> so the next push scans origin/branch..HEAD.
    push({ store, threadId: thread.id, broadcast: () => {} });

    fs.writeFileSync(path.join(repo, "creds.txt"), `${FAKE_AWS_KEY}\n`);
    git(repo, ["add", "creds.txt"]);
    git(repo, ["commit", "-m", "add creds"]);

    const before = git(bare, ["rev-parse", "HEAD"]);
    assert.throws(
      () => push({ store, threadId: thread.id, broadcast: () => {} }),
      (err) => {
        assert.match(err.message, /Blocked by Solenta guardrails/i);
        assert.match(err.message, /secret\.aws-key/);
        assert.ok(
          !err.message.includes(FAKE_AWS_KEY),
          `raw key leaked in error: ${err.message}`,
        );
        return true;
      },
    );
    assert.equal(git(bare, ["rev-parse", "HEAD"]), before);
  });
});
