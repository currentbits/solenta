/**
 * #262: governance matrix — normalize, match, precedence, fail-closed paths.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parsePolicy,
  normalizeCommand,
  normalizeCall,
  actionHash,
  evaluate,
} = require("../governance.js");

const ALLOW = { decision: "allow", rule: null, reason: "" };

function ev(toolName, rawInput, rules, extra = {}) {
  return evaluate({
    toolName,
    rawInput,
    worktreePath: extra.worktreePath || null,
    policy:
      rules === null ? null : { defaultAction: extra.defaultAction || "ask", rules },
    builtin: extra.builtin || ALLOW,
    sessionAllows: extra.sessionAllows,
  });
}

describe("governance normalize", () => {
  it("strips invisible Unicode, env prefixes, and collapses whitespace", () => {
    assert.equal(
      normalizeCommand("FOO=1  BAR=x  npm​   publish\t--tag beta"),
      "npm publish --tag beta",
    );
    assert.equal(normalizeCommand("   "), null);
    assert.equal(normalizeCommand(undefined), null);
  });

  it("NFKC folds fullwidth lookalikes", () => {
    assert.equal(normalizeCommand("ｎｐｍ publish"), "npm publish");
  });

  it("same canonical action hashes the same", () => {
    const a = normalizeCall("Bash", { command: "FOO=1 npm  test" }, null);
    const b = normalizeCall(" bash ", { command: "npm test" }, null);
    assert.equal(actionHash(a), actionHash(b));
    const c = normalizeCall("Bash", { command: "npm test -- x" }, null);
    assert.notEqual(actionHash(a), actionHash(c));
  });

  it("extracts hosts from url fields and command URLs", () => {
    const call = normalizeCall(
      "Bash",
      { command: "curl https://API.Example.com/x && wget http://b.test/y" },
      null,
    );
    assert.deepEqual(call.hosts, ["api.example.com", "b.test"]);
    const fetch = normalizeCall("WebFetch", { url: "https://Docs.Rs/x" }, null);
    assert.deepEqual(fetch.hosts, ["docs.rs"]);
  });
});

describe("governance paths", () => {
  let dir;
  before(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gov-path-")));
    fs.mkdirSync(path.join(dir, "src"));
    fs.symlinkSync(path.join(dir, "src"), path.join(dir, "link"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("canonicalizes a new file under a symlinked dir to its real target", () => {
    const call = normalizeCall("Write", { file_path: "link/new.ts" }, dir);
    assert.equal(call.path, `${dir}/src/new.ts`);
  });

  it("write rule matches worktree-relative globs and real paths", () => {
    const r = ev(
      "Write",
      { file_path: "link/a.ts" },
      [{ kind: "write", match: "src/*", action: "deny" }],
      { worktreePath: dir },
    );
    assert.equal(r.decision, "deny");
    assert.equal(r.layer, "profile.deny");
  });

  it("fails closed when a write path cannot be canonicalized", () => {
    const loop = path.join(dir, "loop");
    fs.symlinkSync(loop, loop);
    const r = ev("Write", { file_path: `${loop}/x` }, [], {
      worktreePath: dir,
      defaultAction: "allow",
    });
    assert.equal(r.decision, "deny");
    assert.equal(r.layer, "normalize");
  });

  it("does not fail closed for a read of an odd path", () => {
    const loop = path.join(dir, "loop2");
    fs.symlinkSync(loop, loop);
    const r = ev("Read", { file_path: `${loop}/x` }, [], { worktreePath: dir });
    assert.notEqual(r.layer, "normalize");
  });
});

describe("governance precedence", () => {
  it("deny wins over allow regardless of rule order", () => {
    const r = ev("Bash", { command: "npm publish" }, [
      { kind: "tool", match: "bash", action: "allow" },
      { kind: "bash", match: "npm publish", action: "deny" },
    ]);
    assert.equal(r.decision, "deny");
    assert.equal(r.layer, "profile.deny");
    assert.equal(r.rule, "bash:npm publish");
  });

  it("block beats deny and ask", () => {
    const r = ev("Bash", { command: "npm publish --tag x" }, [
      { kind: "bash", match: "npm *", action: "ask" },
      { kind: "bash", match: "npm publish", action: "deny" },
      { kind: "bash", match: "npm publish", action: "block" },
    ]);
    assert.equal(r.layer, "profile.block");
  });

  it("bash deny matches any chained subcommand", () => {
    const r = ev("Bash", { command: "cd app && npm publish" }, [
      { kind: "bash", match: "npm publish", action: "block" },
    ]);
    assert.equal(r.layer, "profile.block");
  });

  it("bash allow must cover every subcommand", () => {
    const rules = [{ kind: "bash", match: "git status", action: "allow" }];
    assert.equal(ev("Bash", { command: "git status -s" }, rules).layer, "profile.allow");
    assert.equal(
      ev("Bash", { command: "git status; rm -rf build" }, rules).layer,
      "profile.default",
    );
  });

  it("bash allow never vouches for shell substitution", () => {
    const rules = [{ kind: "bash", match: "echo", action: "allow" }];
    assert.equal(ev("Bash", { command: "echo $(cat x)" }, rules).decision, "ask");
    assert.equal(ev("Bash", { command: "echo `id`" }, rules).decision, "ask");
  });

  it("builtin deny cannot be lifted by a profile allow", () => {
    const r = ev(
      "Write",
      { file_path: "/repo/.github/workflows/ci.yml" },
      [{ kind: "write", match: "*", action: "allow" }],
      {
        builtin: { decision: "deny", rule: "protected.ci", reason: "owned" },
      },
    );
    assert.equal(r.decision, "deny");
    assert.equal(r.layer, "builtin");
  });

  it("profile ask beats a session grant", () => {
    const call = normalizeCall("Bash", { command: "npm publish" }, null);
    const r = ev(
      "Bash",
      { command: "npm publish" },
      [{ kind: "bash", match: "npm publish", action: "ask" }],
      { sessionAllows: new Set([actionHash(call)]) },
    );
    assert.equal(r.layer, "profile.ask");
  });

  it("session grant beats builtin ask and the default", () => {
    const call = normalizeCall("Bash", { command: "curl https://x.test" }, null);
    const r = ev("Bash", { command: "curl https://x.test" }, [], {
      builtin: { decision: "ask", rule: "shell.egress", reason: "net" },
      sessionAllows: new Set([actionHash(call)]),
    });
    assert.equal(r.decision, "allow");
    assert.equal(r.layer, "session");
  });

  it("builtin ask beats a profile default allow", () => {
    const r = ev("Bash", { command: "curl https://x.test" }, [], {
      defaultAction: "allow",
      builtin: { decision: "ask", rule: "shell.egress", reason: "net" },
    });
    assert.equal(r.decision, "ask");
    assert.equal(r.layer, "builtin");
  });

  it("network and tool globs are case-insensitive", () => {
    assert.equal(
      ev("WebFetch", { url: "https://evil.Example.com/" }, [
        { kind: "network", match: "*.EXAMPLE.com", action: "deny" },
      ]).layer,
      "profile.deny",
    );
    assert.equal(
      ev("mcp__github__create_issue", {}, [
        { kind: "tool", match: "MCP__GITHUB__*", action: "allow" },
      ]).layer,
      "profile.allow",
    );
  });

  it("absent policy defaults to ask", () => {
    const r = ev("Read", { file_path: "/tmp/x" }, null);
    assert.equal(r.decision, "ask");
    assert.equal(r.layer, "profile.default");
  });

  it("AskUserQuestion and ExitPlanMode skip the matrix", () => {
    const rules = [{ kind: "tool", match: "*", action: "allow" }];
    for (const tool of ["AskUserQuestion", "ExitPlanMode"]) {
      const r = ev(tool, {}, rules, { defaultAction: "allow" });
      assert.equal(r.decision, "ask", tool);
      assert.equal(r.layer, "builtin", tool);
    }
  });
});

describe("governance policy schema", () => {
  const good = {
    defaultAction: "ask",
    rules: [{ kind: "bash", match: "  npm publish ", action: "block" }],
  };

  it("keeps a well-formed policy and trims matches", () => {
    assert.deepEqual(parsePolicy(good, true), {
      defaultAction: "ask",
      rules: [{ kind: "bash", match: "npm publish", action: "block" }],
    });
  });

  it("junk heals to null leniently and throws strictly", () => {
    for (const junk of [
      "x",
      { defaultAction: "deny", rules: [] },
      { defaultAction: "ask", rules: [{ kind: "exec", match: "x", action: "deny" }] },
      { defaultAction: "ask", rules: [{ kind: "bash", match: " ", action: "deny" }] },
      { defaultAction: "ask", rules: [{ kind: "bash", match: "x", action: "maybe" }] },
      {
        defaultAction: "ask",
        rules: Array.from({ length: 41 }, () => ({ kind: "tool", match: "x", action: "ask" })),
      },
    ]) {
      assert.equal(parsePolicy(junk, false), null);
      assert.throws(() => parsePolicy(junk, true), /policy/);
    }
  });
});
