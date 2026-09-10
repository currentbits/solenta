"use strict";

/**
 * PR workspace: repo templates + gh detail/comment/edit/close/ready/merge.
 * Run: node --test electron/test/pr-workspace.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { writeFakeBin } = require("./support/fakeBin.js");
const {
  collectPrTemplates,
  readPrTemplate,
  parsePrComments,
  parsePrDetailJson,
  viewPrDetail,
  editPr,
  commentPr,
  closePr,
  readyPr,
  mergePrAt,
} = require("../prWorkspace.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeFakeGh(dir) {
  const bin = path.join(dir, "fake-gh");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const statePath = process.env.CODER_FAKE_GH_STATE;
if (!statePath) {
  process.stderr.write("fake-gh: CODER_FAKE_GH_STATE not set\\n");
  process.exit(2);
}
function load() { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
function save(s) { fs.writeFileSync(statePath, JSON.stringify(s, null, 2), "utf8"); }
function flagValue(name) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return null;
  return args[i + 1];
}
const args = process.argv.slice(2);
const state = load();
state.calls = state.calls || [];
state.calls.push(args.slice());
save(state);
const scenario = state.scenario || "success";
if (scenario === "auth-fail") {
  process.stderr.write("To get started with GitHub CLI, please run:  gh auth login\\n");
  process.exit(1);
}
if (scenario === "missing") {
  process.stderr.write("gh: command not found\\n");
  process.exit(127);
}

function findPr(ref) {
  const prs = state.prs || {};
  if (prs[ref]) return prs[ref];
  const n = Number(ref);
  for (const key of Object.keys(prs)) {
    if (Number(prs[key].number) === n) return prs[key];
  }
  return null;
}

if (args[0] === "pr" && args[1] === "view") {
  const ref = args[2];
  const pr = findPr(ref);
  if (!pr) {
    process.stderr.write("no pull requests found for \\"" + ref + "\\"\\n");
    process.exit(1);
  }
  const jsonFields = (flagValue("--json") || "number,url,state").split(",");
  if (scenario === "unknown-json-field") {
    const extra = jsonFields.filter(function (f) {
      return f !== "number" && f !== "url" && f !== "state" && f !== "title" && f !== "body" && f !== "headRefName";
    });
    if (extra.length) {
      process.stderr.write("Unknown JSON field: \\"" + extra[0] + "\\"\\n");
      process.exit(1);
    }
  }
  const out = {
    number: pr.number,
    url: pr.url,
    state: pr.state || "OPEN",
    title: pr.title || "",
    body: pr.body || "",
    isDraft: Boolean(pr.isDraft),
    headRefName: pr.headRefName || "feat/x",
    baseRefName: pr.baseRefName || "main",
    author: { login: pr.author || "octocat" },
    comments: pr.comments || [],
  };
  if (pr.additions != null) out.additions = pr.additions;
  if (pr.deletions != null) out.deletions = pr.deletions;
  if (pr.mergeable) out.mergeable = pr.mergeable;
  process.stdout.write(JSON.stringify(out) + "\\n");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "comment") {
  const pr = findPr(args[2]);
  if (!pr) {
    process.stderr.write("no pull requests found\\n");
    process.exit(1);
  }
  const body = flagValue("--body") || "";
  pr.comments = pr.comments || [];
  pr.comments.push({
    author: { login: "me" },
    body: body,
    createdAt: "2026-09-10T12:00:00Z",
    url: pr.url + "#issuecomment-" + (pr.comments.length + 1),
  });
  save(state);
  process.stdout.write(pr.url + "#issuecomment-" + pr.comments.length + "\\n");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "edit") {
  const pr = findPr(args[2]);
  if (!pr) {
    process.stderr.write("no pull requests found\\n");
    process.exit(1);
  }
  const title = flagValue("--title");
  const body = flagValue("--body");
  if (title != null) pr.title = title;
  if (body != null) pr.body = body;
  save(state);
  process.stdout.write(pr.url + "\\n");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "close") {
  const pr = findPr(args[2]);
  if (!pr) {
    process.stderr.write("no pull requests found\\n");
    process.exit(1);
  }
  pr.state = "CLOSED";
  save(state);
  process.stdout.write(pr.url + "\\n");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "ready") {
  const pr = findPr(args[2]);
  if (!pr) {
    process.stderr.write("no pull requests found\\n");
    process.exit(1);
  }
  pr.isDraft = args.includes("--undo");
  save(state);
  process.stdout.write(pr.url + "\\n");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "merge") {
  const pr = findPr(args[2]);
  if (!pr) {
    process.stderr.write("no pull requests found\\n");
    process.exit(1);
  }
  if (!args.includes("--squash")) {
    process.stderr.write("fake-gh: expected --squash\\n");
    process.exit(1);
  }
  pr.state = "MERGED";
  pr.isDraft = false;
  save(state);
  process.stdout.write(pr.url + "\\n");
  process.exit(0);
}

process.stderr.write("fake-gh: unhandled argv " + JSON.stringify(args) + "\\n");
process.exit(2);
`;
  return writeFakeBin(bin, body);
}

describe("collectPrTemplates", () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-pr-tpl-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty when the checkout has no template", () => {
    assert.deepEqual(collectPrTemplates(tmp), []);
  });

  it("prefers .github/PULL_REQUEST_TEMPLATE.md as Default", async () => {
    fs.mkdirSync(path.join(tmp, ".github"));
    fs.writeFileSync(
      path.join(tmp, ".github", "PULL_REQUEST_TEMPLATE.md"),
      "## What\n",
    );
    const rows = collectPrTemplates(tmp);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Default");
    assert.equal(rows[0].body, "## What\n");
    const loaded = await readPrTemplate(tmp);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.body, "## What\n");
  });

  it("lists directory templates after the default file", () => {
    fs.mkdirSync(path.join(tmp, ".github", "PULL_REQUEST_TEMPLATE"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, ".github", "PULL_REQUEST_TEMPLATE.md"),
      "default\n",
    );
    fs.writeFileSync(
      path.join(tmp, ".github", "PULL_REQUEST_TEMPLATE", "bug.md"),
      "bug body\n",
    );
    fs.writeFileSync(
      path.join(tmp, ".github", "PULL_REQUEST_TEMPLATE", "feature.md"),
      "feat body\n",
    );
    const rows = collectPrTemplates(tmp);
    assert.equal(rows[0].name, "Default");
    assert.deepEqual(
      rows.slice(1).map((r) => r.name),
      ["bug", "feature"],
    );
  });

  it("readPrTemplate fails closed on a missing path", async () => {
    const loaded = await readPrTemplate(path.join(tmp, "nope"));
    assert.equal(loaded.ok, false);
    assert.equal(loaded.reason, "not a repo");
  });
});

describe("parsePrDetailJson / parsePrComments", () => {
  it("parses author login and comments", () => {
    const pr = parsePrDetailJson(
      JSON.stringify({
        number: 7,
        title: "Fix",
        body: "hello",
        url: "https://github.com/acme/demo/pull/7",
        state: "OPEN",
        isDraft: true,
        headRefName: "feat/x",
        author: { login: "ada" },
        comments: [
          {
            author: { login: "bob" },
            body: "lgtm",
            createdAt: "2026-09-10T12:00:00Z",
            url: "https://github.com/acme/demo/pull/7#issuecomment-1",
          },
        ],
      }),
    );
    assert.equal(pr.number, 7);
    assert.equal(pr.isDraft, true);
    assert.equal(pr.author, "ada");
    assert.equal(pr.comments.length, 1);
    assert.equal(pr.comments[0].author, "bob");
    assert.equal(pr.comments[0].body, "lgtm");
  });

  it("parsePrComments skips junk rows", () => {
    assert.deepEqual(parsePrComments(null), []);
    assert.equal(parsePrComments([null, { body: "x" }]).length, 1);
  });
});

describe("gh PR workspace actions", () => {
  let tmp;
  let repo;
  let statePath;
  let prevGhBin;
  let prevGhState;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-pr-ws-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);

    const fakeDir = path.join(tmp, "fake-bin");
    fs.mkdirSync(fakeDir);
    const fakeGh = writeFakeGh(fakeDir);
    statePath = path.join(tmp, "gh-state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        scenario: "success",
        calls: [],
        prs: {
          12: {
            number: 12,
            url: "https://github.com/acme/demo/pull/12",
            state: "OPEN",
            title: "Ship it",
            body: "from template",
            isDraft: true,
            headRefName: "feat/ship",
            comments: [],
          },
        },
      }),
      "utf8",
    );
    prevGhBin = process.env.CODER_GH_BIN;
    prevGhState = process.env.CODER_FAKE_GH_STATE;
    process.env.CODER_GH_BIN = fakeGh;
    process.env.CODER_FAKE_GH_STATE = statePath;
  });

  afterEach(() => {
    if (prevGhBin === undefined) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGhBin;
    if (prevGhState === undefined) delete process.env.CODER_FAKE_GH_STATE;
    else process.env.CODER_FAKE_GH_STATE = prevGhState;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function calls() {
    return JSON.parse(fs.readFileSync(statePath, "utf8")).calls;
  }

  it("viewPrDetail returns title, body, draft, comments", async () => {
    const result = await viewPrDetail(repo, 12);
    assert.equal(result.ok, true);
    assert.equal(result.pr.number, 12);
    assert.equal(result.pr.title, "Ship it");
    assert.equal(result.pr.body, "from template");
    assert.equal(result.pr.isDraft, true);
    assert.ok(calls().some((c) => c[0] === "pr" && c[1] === "view"));
  });

  it("commentPr posts the body and returns a url", async () => {
    const result = await commentPr(repo, { prNumber: 12, body: "please ship" });
    assert.equal(result.ok, true);
    assert.ok(String(result.url).includes("issuecomment"));
    const viewed = await viewPrDetail(repo, 12);
    assert.equal(viewed.pr.comments.length, 1);
    assert.equal(viewed.pr.comments[0].body, "please ship");
  });

  it("commentPr refuses an empty body", async () => {
    const result = await commentPr(repo, { prNumber: 12, body: "   " });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty comment");
  });

  it("editPr updates title and body", async () => {
    const result = await editPr(repo, {
      prNumber: 12,
      title: "Ship it now",
      body: "edited",
    });
    assert.equal(result.ok, true);
    assert.equal(result.pr.title, "Ship it now");
    assert.equal(result.pr.body, "edited");
  });

  it("readyPr clears the draft flag", async () => {
    const result = await readyPr(repo, { prNumber: 12 });
    assert.equal(result.ok, true);
    assert.equal(result.pr.isDraft, false);
  });

  it("readyPr undo restores draft", async () => {
    await readyPr(repo, { prNumber: 12 });
    const result = await readyPr(repo, { prNumber: 12, undo: true });
    assert.equal(result.ok, true);
    assert.equal(result.pr.isDraft, true);
  });

  it("closePr marks the PR CLOSED", async () => {
    const result = await closePr(repo, { prNumber: 12 });
    assert.equal(result.ok, true);
    assert.equal(result.pr.state, "CLOSED");
  });

  it("mergePrAt squash-merges", async () => {
    const result = await mergePrAt(repo, { prNumber: 12 });
    assert.equal(result.ok, true);
    assert.equal(result.pr.state, "MERGED");
    const mergeCall = calls().find((c) => c[0] === "pr" && c[1] === "merge");
    assert.ok(mergeCall.includes("--squash"));
  });

  it("viewPrDetail is in-band when the PR is missing", async () => {
    const result = await viewPrDetail(repo, 99);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "PR not found");
  });

  it("returns auth when gh is unauthenticated", async () => {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.scenario = "auth-fail";
    fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
    const result = await viewPrDetail(repo, 12);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "auth");
  });

  it("returns not a GitHub repo for a missing origin", async () => {
    const other = path.join(tmp, "other");
    fs.mkdirSync(other);
    git(other, ["init"]);
    const result = await viewPrDetail(other, 12);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not a GitHub repo");
  });
});
