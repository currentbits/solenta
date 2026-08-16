"use strict";

/**
 * parseIssueRef fixtures + fetchIssue/setPlanStatus mapping
 * (fake gh via CODER_GH_BIN).
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseIssueRef, fetchIssue, setPlanStatus } = require("../issues.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("parseIssueRef", () => {
  it("parses a github issues URL", () => {
    assert.deepEqual(
      parseIssueRef("https://github.com/owner/repo/issues/123"),
      { number: 123, owner: "owner", repo: "repo" },
    );
  });

  it("parses www, trailing slash, and fragment on the URL", () => {
    assert.deepEqual(
      parseIssueRef(
        "https://www.github.com/acme/demo/issues/9/#issuecomment-1",
      ),
      { number: 9, owner: "acme", repo: "demo" },
    );
  });

  it("parses owner/repo#123", () => {
    assert.deepEqual(parseIssueRef("acme/demo#42"), {
      number: 42,
      owner: "acme",
      repo: "demo",
    });
  });

  it("parses a bare number", () => {
    assert.deepEqual(parseIssueRef("  7  "), { number: 7 });
  });

  it("returns null for empty, zero, and non-issue text", () => {
    assert.equal(parseIssueRef(""), null);
    assert.equal(parseIssueRef("   "), null);
    assert.equal(parseIssueRef("0"), null);
    assert.equal(parseIssueRef("#12"), null);
    assert.equal(parseIssueRef("https://github.com/owner/repo/pull/123"), null);
    assert.equal(parseIssueRef("https://gitlab.com/owner/repo/issues/1"), null);
    assert.equal(parseIssueRef("not-an-issue"), null);
  });
});

describe("fetchIssue", () => {
  let tmp;
  let repo;
  let prevGh;
  let argsPath;

  function writeFakeGh(scriptBody) {
    const bin = path.join(tmp, "fake-gh");
    fs.writeFileSync(bin, scriptBody, { mode: 0o755 });
    process.env.CODER_GH_BIN = bin;
    return bin;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-issues-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "1");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);

    argsPath = path.join(tmp, "gh-args.json");
    prevGh = process.env.CODER_GH_BIN;
    writeFakeGh(`#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
if (args[0] === "issue" && args[1] === "view") {
  const number = Number(args[2]);
  process.stdout.write(JSON.stringify({
    number,
    title: "Fix the login",
    body: "Repro steps",
    url: "https://github.com/acme/demo/issues/" + number
  }) + "\\n");
  process.exit(0);
}
process.stderr.write("unhandled " + JSON.stringify(args) + "\\n");
process.exit(2);
`);
  });

  afterEach(() => {
    if (prevGh == null) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGh;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the issue and passes -R owner/repo from origin", () => {
    const result = fetchIssue(repo, "12");
    assert.deepEqual(result, {
      ok: true,
      issue: {
        number: 12,
        title: "Fix the login",
        body: "Repro steps",
        url: "https://github.com/acme/demo/issues/12",
      },
    });
    const args = JSON.parse(fs.readFileSync(argsPath, "utf8"));
    assert.deepEqual(args, [
      "issue",
      "view",
      "12",
      "--json",
      "number,title,body,url",
      "-R",
      "acme/demo",
    ]);
  });

  it("uses owner/repo from the pasted ref for -R", () => {
    const result = fetchIssue(repo, "other/app#8");
    assert.equal(result.ok, true);
    const args = JSON.parse(fs.readFileSync(argsPath, "utf8"));
    assert.equal(args[args.indexOf("-R") + 1], "other/app");
  });

  it("returns invalid issue reference without spawning gh", () => {
    const result = fetchIssue(repo, "not-an-issue");
    assert.deepEqual(result, { ok: false, reason: "invalid issue reference" });
    assert.equal(fs.existsSync(argsPath), false);
  });

  it("returns not a GitHub repo for a non-github origin", () => {
    git(repo, ["remote", "set-url", "origin", "https://gitlab.com/acme/demo.git"]);
    const result = fetchIssue(repo, "1");
    assert.deepEqual(result, { ok: false, reason: "not a GitHub repo" });
    assert.equal(fs.existsSync(argsPath), false);
  });

  it("returns gh missing when the binary is gone", () => {
    process.env.CODER_GH_BIN = path.join(tmp, "definitely-missing-gh");
    const result = fetchIssue(repo, "1");
    assert.deepEqual(result, { ok: false, reason: "gh missing" });
  });

  it("returns auth on gh auth failure", () => {
    writeFakeGh(`#!/usr/bin/env node
process.stderr.write("To get started with GitHub CLI, please run: gh auth login\\n");
process.exit(1);
`);
    const result = fetchIssue(repo, "1");
    assert.deepEqual(result, { ok: false, reason: "auth" });
  });

  it("returns issue not found when gh cannot resolve the number", () => {
    writeFakeGh(`#!/usr/bin/env node
process.stderr.write("GraphQL: Could not resolve to an Issue with the number of 99.\\n");
process.exit(1);
`);
    const result = fetchIssue(repo, "99");
    assert.deepEqual(result, { ok: false, reason: "issue not found" });
  });

  it("never throws on empty path or garbage gh JSON", () => {
    assert.deepEqual(fetchIssue("", "1"), {
      ok: false,
      reason: "not a GitHub repo",
    });
    writeFakeGh(`#!/usr/bin/env node
process.stdout.write("not-json\\n");
process.exit(0);
`);
    const result = fetchIssue(repo, "1");
    assert.equal(result.ok, false);
    assert.match(result.reason, /unparseable issue JSON/);
  });
});

describe("setPlanStatus", () => {
  let tmp;
  let repo;
  let prevGh;
  let callsPath;

  /** Fake gh that appends each invocation's args to callsPath. */
  function writeFakeGh(body) {
    const bin = path.join(tmp, "fake-gh");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = ${JSON.stringify(callsPath)};
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
prev.push(args);
fs.writeFileSync(file, JSON.stringify(prev));
${body}
`,
      { mode: 0o755 },
    );
    process.env.CODER_GH_BIN = bin;
  }

  function calls() {
    return fs.existsSync(callsPath)
      ? JSON.parse(fs.readFileSync(callsPath, "utf8"))
      : [];
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-plan-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
    callsPath = path.join(tmp, "gh-calls.json");
    prevGh = process.env.CODER_GH_BIN;
    writeFakeGh("process.exit(0);");
  });

  afterEach(() => {
    if (prevGh == null) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGh;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("adds the new plan label and removes the other two", () => {
    assert.deepEqual(setPlanStatus(repo, 5, "doing"), { ok: true });
    assert.deepEqual(calls(), [
      [
        "issue",
        "edit",
        "5",
        "--add-label",
        "plan:doing",
        "--remove-label",
        "plan:todo,plan:done",
      ],
    ]);
  });

  it("retries add-only when a removed label is not in the repo", () => {
    writeFakeGh(`
if (args.includes("--remove-label")) {
  process.stderr.write("failed to update ...: 'plan:done' not found\\n");
  process.exit(1);
}
process.exit(0);
`);
    assert.deepEqual(setPlanStatus(repo, 5, "doing"), { ok: true });
    const seen = calls();
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1], ["issue", "edit", "5", "--add-label", "plan:doing"]);
  });

  it("reports auth failure and never throws", () => {
    writeFakeGh(`
process.stderr.write("To get started with GitHub CLI, please run: gh auth login\\n");
process.exit(1);
`);
    assert.deepEqual(setPlanStatus(repo, 5, "doing"), { ok: false, reason: "auth" });
  });

  it("rejects a bad status or number without spawning gh", () => {
    assert.deepEqual(setPlanStatus(repo, 5, "nope"), {
      ok: false,
      reason: "unknown plan status: nope",
    });
    assert.deepEqual(setPlanStatus(repo, 0, "doing"), {
      ok: false,
      reason: "invalid issue reference",
    });
    assert.deepEqual(calls(), []);
  });
});
