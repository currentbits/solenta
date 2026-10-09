"use strict";

/**
 * listPrs: parse fixtures + unknown-JSON-field fallback.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  parsePrListJson,
  isUnknownJsonField,
  listPrs,
  listPrsRaw,
  setGithubApi,
} = require("../worktrees.js");
const { fakeGithubApi } = require("./support/fakeGithubApi.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const FULL_FIXTURE = `[
  {
    "number": 12,
    "title": "Add list view",
    "url": "https://github.com/acme/demo/pull/12",
    "state": "OPEN",
    "headRefName": "coder/add-list-view-abc",
    "isDraft": true,
    "additions": 40,
    "deletions": 3,
    "updatedAt": "2026-08-12T18:00:00Z"
  }
]`;

const FALLBACK_FIXTURE = `[
  {
    "number": 7,
    "title": "Older gh",
    "url": "https://github.com/acme/demo/pull/7",
    "state": "OPEN",
    "headRefName": "feat/old"
  }
]`;

describe("parsePrListJson", () => {
  it("parses the full field set including extras", () => {
    const prs = parsePrListJson(FULL_FIXTURE);
    assert.equal(prs.length, 1);
    assert.deepEqual(prs[0], {
      number: 12,
      title: "Add list view",
      url: "https://github.com/acme/demo/pull/12",
      state: "OPEN",
      headRefName: "coder/add-list-view-abc",
      isDraft: true,
      additions: 40,
      deletions: 3,
      updatedAt: "2026-08-12T18:00:00Z",
    });
  });

  it("omits extras when gh returned the short field set", () => {
    const prs = parsePrListJson(FALLBACK_FIXTURE);
    assert.equal(prs.length, 1);
    assert.equal(prs[0].number, 7);
    assert.equal(prs[0].headRefName, "feat/old");
    assert.equal(prs[0].isDraft, undefined);
    assert.equal(prs[0].additions, undefined);
    assert.equal(prs[0].deletions, undefined);
    assert.equal(prs[0].updatedAt, undefined);
  });

  it("treats empty stdout as an empty list", () => {
    assert.deepEqual(parsePrListJson(""), []);
  });

  it("throws on unparseable JSON", () => {
    assert.throws(() => parsePrListJson("not-json"), /unparseable PR list JSON/);
  });

  it("throws on a row missing number or url", () => {
    assert.throws(
      () => parsePrListJson('[{"title":"x"}]'),
      /incomplete PR list JSON/,
    );
  });
});

describe("isUnknownJsonField", () => {
  it("matches gh's unknown-field error text", () => {
    assert.equal(
      isUnknownJsonField('Unknown JSON field: "isDraft"'),
      true,
    );
    assert.equal(isUnknownJsonField("unknown field: additions"), true);
    assert.equal(isUnknownJsonField("HTTP 401: Bad credentials"), false);
  });
});

describe("listPrs fallback", () => {
  let tmp;
  let repo;
  let prevGh;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-listprs-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "1");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);

    const bin = writeFakeBin(
      path.join(tmp, "fake-gh"),
      `#!/usr/bin/env node
"use strict";
const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const fields = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
if (args[0] === "pr" && args[1] === "list") {
  if (fields.includes("isDraft")) {
    process.stderr.write('Unknown JSON field: "isDraft"\\n');
    process.exit(1);
  }
  process.stdout.write(${JSON.stringify(FALLBACK_FIXTURE)} + "\\n");
  process.exit(0);
}
process.stderr.write("unhandled " + JSON.stringify(args) + "\\n");
process.exit(2);
`,
    );
    prevGh = process.env.CODER_GH_BIN;
    process.env.CODER_GH_BIN = bin;
  });

  afterEach(async () => {
    setGithubApi(null);
    if (prevGh == null) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGh;
    await rmTree(tmp);
  });

  it("lists over the API, paging past 100 and keeping only OPEN by default (#1534)", async () => {
    const prs = Array.from({ length: 160 }, (_, i) => ({
      number: i + 1,
      url: `https://github.com/acme/demo/pull/${i + 1}`,
      title: `PR ${i + 1}`,
      headRefName: `b${i + 1}`,
      state: i >= 155 ? "MERGED" : "OPEN",
      additions: 3,
      deletions: 1,
      updatedAt: "2026-10-01T00:00:00Z",
    }));
    const api = fakeGithubApi({ prs });
    setGithubApi(api);
    const result = await listPrs(repo, { limit: 150 });
    assert.equal(result.ok, true);
    assert.equal(result.prs.length, 150);
    assert.equal(result.complete, false);
    assert.deepEqual(result.prs[0], {
      number: 155, title: "PR 155", url: "https://github.com/acme/demo/pull/155", state: "OPEN",
      headRefName: "b155", isDraft: false, additions: 3, deletions: 1, updatedAt: "2026-10-01T00:00:00Z",
    });
    assert.deepEqual(api.state.calls.map((c) => c.body.variables.first), [100, 50]);

    const raw = await listPrsRaw(repo, {
      fields: "number,title,url,state,headRefName,createdAt,mergedAt,closedAt,additions,deletions,reviews",
      extraArgs: ["--state", "all", "--limit", "100"],
    });
    assert.equal(raw.ok, true);
    assert.ok(raw.prs.some((p) => p.state === "MERGED"));
    assert.ok(Array.isArray(raw.prs[0].reviews));
  });

  it("falls back to gh when the API fails (#1534)", async () => {
    setGithubApi(fakeGithubApi({ failWith: 503 }));
    const result = await listPrs(repo);
    assert.equal(result.ok, true);
    assert.equal(result.prs[0].number, 7);
  });

  it("retries with the short field set when extras are unknown", async () => {
    const result = await listPrs(repo);
    assert.equal(result.ok, true);
    assert.equal(result.prs.length, 1);
    assert.equal(result.prs[0].number, 7);
    assert.equal(result.prs[0].headRefName, "feat/old");
    assert.equal(result.prs[0].isDraft, undefined);
  });

  it("returns not a GitHub repo without throwing", async () => {
    git(repo, ["remote", "set-url", "origin", "https://gitlab.com/acme/demo.git"]);
    const result = await listPrs(repo);
    assert.deepEqual(result, { ok: false, reason: "not a GitHub repo" });
  });
});

describe("async conversion regression (#228)", () => {
  it("the PR read helpers are async, the worktree write helper stays sync", () => {
    const worktrees = require("../worktrees.js");
    for (const name of [
      "listPrs",
      "prStatus",
      "prChecks",
      "defaultBranchAsync",
    ]) {
      assert.equal(worktrees[name].constructor.name, "AsyncFunction", name);
    }
    // The write flows still call this one synchronously on purpose.
    assert.equal(worktrees.defaultBranch.constructor.name, "Function");
  });
});

describe("listPrs completeness and limit", () => {
  let tmp;
  let repo;
  let prevGh;
  let argsPath;

  function installCountingGh(total) {
    argsPath = path.join(tmp, "gh-args.json");
    const bin = writeFakeBin(
      path.join(tmp, "fake-gh-limit"),
      `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
if (args[0] !== "pr" || args[1] !== "list") {
  process.stderr.write("unhandled " + JSON.stringify(args) + "\\n");
  process.exit(2);
}
const limitIdx = args.lastIndexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 30;
const n = Math.min(${total}, Number.isFinite(limit) ? limit : 30);
const rows = [];
for (let i = 1; i <= n; i++) {
  rows.push({
    number: i,
    title: "PR " + i,
    url: "https://github.com/acme/demo/pull/" + i,
    state: "OPEN",
    headRefName: "feat/" + i,
  });
}
process.stdout.write(JSON.stringify(rows) + "\\n");
`,
    );
    process.env.CODER_GH_BIN = bin;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-listprs-limit-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "1");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
    prevGh = process.env.CODER_GH_BIN;
  });

  afterEach(async () => {
    if (prevGh == null) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGh;
    await rmTree(tmp);
  });

  it("defaults to --limit 50 and reports a complete short page", async () => {
    installCountingGh(12);
    const result = await listPrs(repo);
    assert.equal(result.ok, true);
    assert.equal(result.prs.length, 12);
    assert.equal(result.complete, true);
    assert.equal(result.limit, 50);
    const args = JSON.parse(fs.readFileSync(argsPath, "utf8"));
    const limitIdx = args.lastIndexOf("--limit");
    assert.equal(args[limitIdx + 1], "50");
  });

  it("marks a full default page as incomplete", async () => {
    installCountingGh(75);
    const result = await listPrs(repo);
    assert.equal(result.ok, true);
    assert.equal(result.prs.length, 50);
    assert.equal(result.complete, false);
    assert.equal(result.limit, 50);
  });

  it("honours an explicit listPrs limit and stays bounded", async () => {
    installCountingGh(75);
    const page = await listPrs(repo, { limit: 100 });
    assert.equal(page.ok, true);
    assert.equal(page.prs.length, 75);
    assert.equal(page.complete, true);
    assert.equal(page.limit, 100);
    const args = JSON.parse(fs.readFileSync(argsPath, "utf8"));
    assert.equal(args[args.lastIndexOf("--limit") + 1], "100");

    const clamped = await listPrs(repo, { limit: 999 });
    assert.equal(clamped.ok, true);
    assert.equal(clamped.limit, 200);
    const clampedArgs = JSON.parse(fs.readFileSync(argsPath, "utf8"));
    assert.equal(clampedArgs[clampedArgs.lastIndexOf("--limit") + 1], "200");
  });

  it("leaves an explicit listPrsRaw extraArgs limit alone", async () => {
    installCountingGh(120);
    const raw = await listPrsRaw(repo, {
      extraArgs: ["--state", "all", "--limit", "100"],
    });
    assert.equal(raw.ok, true);
    assert.equal(raw.prs.length, 100);
    assert.equal("complete" in raw, false);
    const args = JSON.parse(fs.readFileSync(argsPath, "utf8"));
    assert.deepEqual(args.slice(-4), ["--state", "all", "--limit", "100"]);
  });
});
