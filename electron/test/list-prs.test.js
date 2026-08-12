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
} = require("../worktrees.js");

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

    const bin = path.join(tmp, "fake-gh");
    fs.writeFileSync(
      bin,
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
      { mode: 0o755 },
    );
    prevGh = process.env.CODER_GH_BIN;
    process.env.CODER_GH_BIN = bin;
  });

  afterEach(() => {
    if (prevGh == null) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGh;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("retries with the short field set when extras are unknown", () => {
    const result = listPrs(repo);
    assert.equal(result.ok, true);
    assert.equal(result.prs.length, 1);
    assert.equal(result.prs[0].number, 7);
    assert.equal(result.prs[0].headRefName, "feat/old");
    assert.equal(result.prs[0].isDraft, undefined);
  });

  it("returns not a GitHub repo without throwing", () => {
    git(repo, ["remote", "set-url", "origin", "https://gitlab.com/acme/demo.git"]);
    const result = listPrs(repo);
    assert.deepEqual(result, { ok: false, reason: "not a GitHub repo" });
  });
});
