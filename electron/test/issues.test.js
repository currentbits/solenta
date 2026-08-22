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
const {
  parseIssueRef,
  parseTicketRef,
  parseLinearIssueRef,
  issueStartPrompt,
  fetchIssue,
  setPlanStatus,
  reopenIssue,
  completeIssue,
  createIssue,
} = require("../issues.js");
const { writeFakeBin } = require("./support/fakeBin.js");

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
    assert.equal(parseIssueRef("ENG-123"), null);
    assert.equal(
      parseIssueRef("https://linear.app/acme/issue/ENG-123"),
      null,
    );
  });
});

describe("parseLinearIssueRef", () => {
  it("parses a linear.app issue URL", () => {
    assert.deepEqual(
      parseLinearIssueRef("https://linear.app/acme/issue/ENG-123"),
      {
        source: "linear",
        workspace: "acme",
        identifier: "ENG-123",
        team: "ENG",
        number: 123,
      },
    );
  });

  it("parses www, slug, query, and fragment on the URL", () => {
    assert.deepEqual(
      parseLinearIssueRef(
        "https://www.linear.app/acme/issue/eng-9/fix-login?foo=1#comment-2",
      ),
      {
        source: "linear",
        workspace: "acme",
        identifier: "ENG-9",
        team: "ENG",
        number: 9,
      },
    );
  });

  it("parses a bare TEAM-123 identifier", () => {
    assert.deepEqual(parseLinearIssueRef("  sol-42  "), {
      source: "linear",
      identifier: "SOL-42",
      team: "SOL",
      number: 42,
    });
  });

  it("returns null for GitHub refs and junk", () => {
    assert.equal(parseLinearIssueRef(""), null);
    assert.equal(parseLinearIssueRef("12"), null);
    assert.equal(parseLinearIssueRef("acme/demo#42"), null);
    assert.equal(
      parseLinearIssueRef("https://github.com/acme/demo/issues/1"),
      null,
    );
    assert.equal(parseLinearIssueRef("ENG-0"), null);
  });
});

describe("parseTicketRef", () => {
  it("routes Linear and GitHub without mixing them", () => {
    assert.equal(parseTicketRef("ENG-12").source, "linear");
    assert.equal(parseTicketRef("12").source, "github");
    assert.equal(
      parseTicketRef("https://github.com/a/b/issues/3").source,
      "github",
    );
    assert.equal(
      parseTicketRef("https://linear.app/a/issue/ENG-3").source,
      "linear",
    );
    assert.equal(parseTicketRef("not-an-issue"), null);
  });
});

describe("issueStartPrompt", () => {
  it("keeps the GitHub prefix post-merge scans for", () => {
    assert.equal(
      issueStartPrompt({
        number: 7,
        title: "Fix login",
        url: "https://github.com/a/b/issues/7",
        body: "steps",
      }),
      "GitHub issue #7: Fix login\nhttps://github.com/a/b/issues/7\n\nsteps",
    );
  });

  it("uses the Linear identifier so post-merge cannot treat it as GitHub", () => {
    const prompt = issueStartPrompt({
      source: "linear",
      identifier: "ENG-9",
      number: 9,
      title: "Fix login",
      url: "https://linear.app/acme/issue/ENG-9",
      body: "steps",
    });
    assert.equal(
      prompt,
      "Linear issue ENG-9: Fix login\nhttps://linear.app/acme/issue/ENG-9\n\nsteps",
    );
    assert.doesNotMatch(prompt, /GitHub issue #/);
  });
});

describe("fetchIssue", () => {
  let tmp;
  let repo;
  let prevGh;
  let argsPath;

  function writeFakeGh(scriptBody) {
    const bin = writeFakeBin(path.join(tmp, "fake-gh"), scriptBody);
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

  it("returns the issue and passes -R owner/repo from origin", async () => {
    const result = await fetchIssue(repo, "12");
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

  it("uses owner/repo from the pasted ref for -R", async () => {
    const result = await fetchIssue(repo, "other/app#8");
    assert.equal(result.ok, true);
    const args = JSON.parse(fs.readFileSync(argsPath, "utf8"));
    assert.equal(args[args.indexOf("-R") + 1], "other/app");
  });

  it("returns invalid issue reference without spawning gh", async () => {
    const result = await fetchIssue(repo, "not-an-issue");
    assert.deepEqual(result, { ok: false, reason: "invalid issue reference" });
    assert.equal(fs.existsSync(argsPath), false);
  });

  it("returns not a GitHub repo for a non-github origin", async () => {
    git(repo, ["remote", "set-url", "origin", "https://gitlab.com/acme/demo.git"]);
    const result = await fetchIssue(repo, "1");
    assert.deepEqual(result, { ok: false, reason: "not a GitHub repo" });
    assert.equal(fs.existsSync(argsPath), false);
  });

  it("returns gh missing when the binary is gone", async () => {
    process.env.CODER_GH_BIN = path.join(tmp, "definitely-missing-gh");
    const result = await fetchIssue(repo, "1");
    assert.deepEqual(result, { ok: false, reason: "gh missing" });
  });

  it("returns auth on gh auth failure", async () => {
    writeFakeGh(`#!/usr/bin/env node
process.stderr.write("To get started with GitHub CLI, please run: gh auth login\\n");
process.exit(1);
`);
    const result = await fetchIssue(repo, "1");
    assert.deepEqual(result, { ok: false, reason: "auth" });
  });

  it("returns issue not found when gh cannot resolve the number", async () => {
    writeFakeGh(`#!/usr/bin/env node
process.stderr.write("GraphQL: Could not resolve to an Issue with the number of 99.\\n");
process.exit(1);
`);
    const result = await fetchIssue(repo, "99");
    assert.deepEqual(result, { ok: false, reason: "issue not found" });
  });

  it("never throws on empty path or garbage gh JSON", async () => {
    assert.deepEqual(await fetchIssue("", "1"), {
      ok: false,
      reason: "not a GitHub repo",
    });
    writeFakeGh(`#!/usr/bin/env node
process.stdout.write("not-json\\n");
process.exit(0);
`);
    const result = await fetchIssue(repo, "1");
    assert.equal(result.ok, false);
    assert.match(result.reason, /unparseable issue JSON/);
  });
});

describe("fetchIssue Linear", () => {
  let prevKey;

  beforeEach(() => {
    prevKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
  });

  afterEach(() => {
    if (prevKey == null) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = prevKey;
  });

  function graphqlIssue(over = {}) {
    return {
      data: {
        issue: {
          identifier: "ENG-12",
          number: 12,
          title: "Fix the login",
          description: "Repro steps",
          url: "https://linear.app/acme/issue/ENG-12",
          ...over,
        },
      },
    };
  }

  it("fetches via GraphQL without requiring a GitHub remote", async () => {
    const calls = [];
    const result = await fetchIssue("/not-a-repo", "ENG-12", {
      linearApiKey: "lin_api_test",
      linearGraphql: async (args) => {
        calls.push(args);
        return graphqlIssue();
      },
    });
    assert.deepEqual(result, {
      ok: true,
      issue: {
        number: 12,
        title: "Fix the login",
        body: "Repro steps",
        url: "https://linear.app/acme/issue/ENG-12",
        source: "linear",
        identifier: "ENG-12",
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].identifier, "ENG-12");
    assert.equal(calls[0].apiKey, "lin_api_test");
  });

  it("accepts a linear.app URL", async () => {
    const result = await fetchIssue("", "https://linear.app/acme/issue/ENG-12", {
      linearApiKey: "k",
      linearGraphql: async () => graphqlIssue(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.issue.identifier, "ENG-12");
  });

  it("returns linear api key missing without calling GraphQL", async () => {
    let called = false;
    const result = await fetchIssue("", "ENG-1", {
      linearGraphql: async () => {
        called = true;
        return graphqlIssue();
      },
    });
    assert.deepEqual(result, { ok: false, reason: "linear api key missing" });
    assert.equal(called, false);
  });

  it("uses LINEAR_API_KEY when settings have none", async () => {
    process.env.LINEAR_API_KEY = "from-env";
    const keys = [];
    const result = await fetchIssue("", "ENG-12", {
      linearGraphql: async ({ apiKey }) => {
        keys.push(apiKey);
        return graphqlIssue();
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(keys, ["from-env"]);
  });

  it("maps GraphQL not-found and auth errors", async () => {
    assert.deepEqual(
      await fetchIssue("", "ENG-99", {
        linearApiKey: "k",
        linearGraphql: async () => ({
          errors: [{ message: "Entity not found" }],
        }),
      }),
      { ok: false, reason: "issue not found" },
    );
    assert.deepEqual(
      await fetchIssue("", "ENG-99", {
        linearApiKey: "k",
        linearGraphql: async () => {
          const err = new Error("auth");
          err.code = "auth";
          throw err;
        },
      }),
      { ok: false, reason: "auth" },
    );
  });

  it("maps HTTP 401 from fetch to auth", async () => {
    const result = await fetchIssue("", "ENG-1", {
      linearApiKey: "k",
      fetch: async () => ({
        status: 401,
        ok: false,
        text: async () => "{}",
      }),
    });
    assert.deepEqual(result, { ok: false, reason: "auth" });
  });

  it("never throws on a GraphQL throw", async () => {
    const result = await fetchIssue("", "ENG-1", {
      linearApiKey: "k",
      linearGraphql: async () => {
        throw new Error("socket hang up");
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /socket hang up/);
  });
});

describe("setPlanStatus", () => {
  let tmp;
  let repo;
  let prevGh;
  let callsPath;

  /** Fake gh that appends each invocation's args to callsPath. */
  function writeFakeGh(body) {
    const bin = writeFakeBin(
      path.join(tmp, "fake-gh"),
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

  it("adds the new plan label and removes the other two", async () => {
    assert.deepEqual(await setPlanStatus(repo, 5, "doing"), { ok: true });
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

  it("retries add-only when a removed label is not in the repo", async () => {
    writeFakeGh(`
if (args.includes("--remove-label")) {
  process.stderr.write("failed to update ...: 'plan:done' not found\\n");
  process.exit(1);
}
process.exit(0);
`);
    assert.deepEqual(await setPlanStatus(repo, 5, "doing"), { ok: true });
    const seen = calls();
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1], ["issue", "edit", "5", "--add-label", "plan:doing"]);
  });

  it("reports auth failure and never throws", async () => {
    writeFakeGh(`
process.stderr.write("To get started with GitHub CLI, please run: gh auth login\\n");
process.exit(1);
`);
    assert.deepEqual(await setPlanStatus(repo, 5, "doing"), { ok: false, reason: "auth" });
  });

  it("rejects a bad status or number without spawning gh", async () => {
    assert.deepEqual(await setPlanStatus(repo, 5, "nope"), {
      ok: false,
      reason: "unknown plan status: nope",
    });
    assert.deepEqual(await setPlanStatus(repo, 0, "doing"), {
      ok: false,
      reason: "invalid issue reference",
    });
    assert.deepEqual(calls(), []);
  });
});

describe("completeIssue", () => {
  let tmp;
  let repo;
  let prevGh;
  let callsPath;

  /** Fake gh: `issue view --json state,labels` answers with `row`. */
  function writeFakeGh(row) {
    const bin = writeFakeBin(
      path.join(tmp, "fake-gh"),
      `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = ${JSON.stringify(callsPath)};
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
prev.push(args);
fs.writeFileSync(file, JSON.stringify(prev));
if (args[1] === "view") process.stdout.write(${JSON.stringify(JSON.stringify(row))});
process.exit(0);
`,
    );
    process.env.CODER_GH_BIN = bin;
  }

  function calls() {
    return fs.existsSync(callsPath)
      ? JSON.parse(fs.readFileSync(callsPath, "utf8"))
      : [];
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-complete-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
    callsPath = path.join(tmp, "gh-calls.json");
    prevGh = process.env.CODER_GH_BIN;
  });

  afterEach(() => {
    if (prevGh == null) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGh;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("labels plan:done and closes an in-progress issue", async () => {
    writeFakeGh({ state: "OPEN", labels: [{ name: "plan:doing" }] });
    assert.deepEqual(await completeIssue(repo, 7, { comment: "landed" }), {
      ok: true,
    });
    const seen = calls();
    assert.deepEqual(seen[1], [
      "issue",
      "edit",
      "7",
      "--add-label",
      "plan:done",
      "--remove-label",
      "plan:todo,plan:doing",
    ]);
    assert.deepEqual(seen[2], ["issue", "close", "7", "--comment", "landed"]);
  });

  it("leaves an issue nobody started alone", async () => {
    writeFakeGh({ state: "OPEN", labels: [{ name: "plan:todo" }] });
    assert.deepEqual(await completeIssue(repo, 7, {}), {
      ok: true,
      skipped: "not in progress",
    });
    assert.equal(calls().length, 1);
  });

  it("is a no-op on an already closed issue", async () => {
    writeFakeGh({ state: "CLOSED", labels: [{ name: "plan:doing" }] });
    assert.deepEqual(await completeIssue(repo, 7, {}), {
      ok: true,
      skipped: "already closed",
    });
    assert.equal(calls().length, 1);
  });
});

describe("reopenIssue", () => {
  let tmp;
  let repo;
  let prevGh;
  let callsPath;

  function writeFakeGh(body) {
    const bin = writeFakeBin(
      path.join(tmp, "fake-gh"),
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
    );
    process.env.CODER_GH_BIN = bin;
  }

  function calls() {
    return fs.existsSync(callsPath)
      ? JSON.parse(fs.readFileSync(callsPath, "utf8"))
      : [];
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-reopen-"));
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

  it("reopens, comments, and moves the issue to plan:todo", async () => {
    assert.deepEqual(
      await reopenIssue(repo, 420, { comment: "it regressed" }),
      { ok: true },
    );
    const seen = calls();
    assert.deepEqual(seen[0], ["issue", "reopen", "420"]);
    assert.deepEqual(seen[1], [
      "issue",
      "comment",
      "420",
      "--body",
      "it regressed",
    ]);
    assert.deepEqual(seen[2], [
      "issue",
      "edit",
      "420",
      "--add-label",
      "plan:todo",
      "--remove-label",
      "plan:doing,plan:done",
    ]);
  });

  it("treats already-open as success and still comments + labels", async () => {
    writeFakeGh(`
if (args[0] === "issue" && args[1] === "reopen") {
  process.stderr.write("issue is not closed\\n");
  process.exit(1);
}
process.exit(0);
`);
    assert.deepEqual(await reopenIssue(repo, 7, { comment: "again" }), {
      ok: true,
    });
    const seen = calls();
    assert.equal(seen[0][1], "reopen");
    assert.equal(seen[1][1], "comment");
    assert.equal(seen[2][1], "edit");
  });

  it("rejects a bad number without spawning gh", async () => {
    assert.deepEqual(await reopenIssue(repo, 0, { comment: "x" }), {
      ok: false,
      reason: "invalid issue reference",
    });
    assert.deepEqual(calls(), []);
  });
});

describe("createIssue", () => {
  let tmp;
  let repo;
  let prevGh;
  let callsPath;

  function writeFakeGh(body) {
    const bin = writeFakeBin(
      path.join(tmp, "fake-gh"),
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
    );
    process.env.CODER_GH_BIN = bin;
  }

  function calls() {
    return fs.existsSync(callsPath)
      ? JSON.parse(fs.readFileSync(callsPath, "utf8"))
      : [];
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-create-issue-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
    callsPath = path.join(tmp, "gh-calls.json");
    prevGh = process.env.CODER_GH_BIN;
    writeFakeGh(`
process.stdout.write("https://github.com/acme/demo/issues/77\\n");
process.exit(0);
`);
  });

  afterEach(() => {
    if (prevGh == null) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGh;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates without --label then labels plan:todo", async () => {
    assert.deepEqual(
      await createIssue(repo, { title: "chip", body: "do the thing" }),
      {
        ok: true,
        number: 77,
        url: "https://github.com/acme/demo/issues/77",
      },
    );
    const seen = calls();
    assert.deepEqual(seen[0], [
      "issue",
      "create",
      "--title",
      "chip",
      "--body",
      "do the thing",
    ]);
    assert.equal(seen[0].includes("--label"), false);
    assert.deepEqual(seen[1], [
      "issue",
      "edit",
      "77",
      "--add-label",
      "plan:todo",
      "--remove-label",
      "plan:doing,plan:done",
    ]);
  });

  it("still succeeds when the plan:todo label ride-along fails", async () => {
    writeFakeGh(`
if (args[0] === "issue" && args[1] === "create") {
  process.stdout.write("https://github.com/acme/demo/issues/9\\n");
  process.exit(0);
}
process.stderr.write("'plan:todo' not found\\n");
process.exit(1);
`);
    assert.deepEqual(
      await createIssue(repo, { title: "chip", body: "x" }),
      { ok: true, number: 9, url: "https://github.com/acme/demo/issues/9" },
    );
  });

  it("reports auth failure and never throws", async () => {
    writeFakeGh(`
process.stderr.write("To get started with GitHub CLI, please run: gh auth login\\n");
process.exit(1);
`);
    assert.deepEqual(await createIssue(repo, { title: "chip", body: "x" }), {
      ok: false,
      reason: "auth",
    });
  });

  it("rejects a non-GitHub remote without spawning gh", async () => {
    git(repo, ["remote", "set-url", "origin", "https://gitlab.com/acme/demo.git"]);
    assert.deepEqual(await createIssue(repo, { title: "chip", body: "x" }), {
      ok: false,
      reason: "not a GitHub repo",
    });
    assert.deepEqual(calls(), []);
  });
});
