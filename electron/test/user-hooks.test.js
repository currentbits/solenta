"use strict";

/**
 * #1724: user lifecycle hooks — config validation, project trust, the
 * Claude-compatible exit-code contract, the claude/codex PreToolUse
 * bridges and guardrail precedence.
 *
 * Run: node --test electron/test/user-hooks.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const userHooks = require("../user-hooks.js");
const run = require("../user-hooks-run.js");
const { copyGuardrailRuntime } = require("../guardrail-hook-core.js");
const { materializeCodexGuardrailHome } = require("../codex-guardrail.js");
const { createUserHookEvents } = require("../runner-user-hooks.js");
const { getProvider } = require("../providers.js");

const NODE = process.execPath;
/** argv for a node one-liner hook. */
const nodeHook = (src) => [NODE, "-e", src];

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "user-hooks-"));
  // Inherited from a live Solenta launch; tests set their own.
  delete process.env.CODER_GUARDRAILS;
  delete process.env.CODER_GUARDRAILS_PATH;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

describe("validateHooksConfig", () => {
  const v = (doc) => userHooks.validateHooksConfig(JSON.stringify(doc));

  it("accepts every event and fills the default timeout", () => {
    const out = v({
      hooks: [
        { event: "PreToolUse", matcher: "Bash|Edit", command: ["a"] },
        { event: "PostToolUse", command: ["b", "x"], timeoutMs: 60000 },
        { event: "UserPromptSubmit", command: ["c"] },
        { event: "Stop", command: ["d"], timeoutMs: 1 },
      ],
    });
    assert.equal(out.error, null);
    assert.equal(out.hooks.length, 4);
    assert.equal(out.hooks[0].timeoutMs, 10000);
    assert.equal(out.hooks[0].matcher, "Bash|Edit");
  });

  it("rejects bad shapes with a pointed message", () => {
    const cases = [
      ["{", /Not valid JSON/],
      [[], /Top level/],
      [{ hooks: {} }, /must be an array/],
      [{ hooks: [], extra: 1 }, /Unknown key "extra"/],
      [{ hooks: [{ event: "Start", command: ["a"] }] }, /event must be one of/],
      [{ hooks: [{ event: "Stop", command: "echo hi" }] }, /argv, no shell/],
      [{ hooks: [{ event: "Stop", command: [] }] }, /argv/],
      [{ hooks: [{ event: "Stop", command: [" "] }] }, /argv/],
      [{ hooks: [{ event: "Stop", command: ["a", 1] }] }, /argv/],
      [{ hooks: [{ event: "Stop", command: ["a"], timeoutMs: 60001 }] }, /timeoutMs/],
      [{ hooks: [{ event: "Stop", command: ["a"], timeoutMs: 1.5 }] }, /timeoutMs/],
      [{ hooks: [{ event: "Stop", matcher: "x", command: ["a"] }] }, /matcher only applies/],
      [{ hooks: [{ event: "PreToolUse", matcher: "(", command: ["a"] }] }, /regular expression/],
      [{ hooks: [{ event: "Stop", command: ["a"], shell: true }] }, /unknown key "shell"/],
    ];
    for (const [doc, re] of cases) {
      const out = typeof doc === "string" ? userHooks.validateHooksConfig(doc) : v(doc);
      assert.match(String(out.error), re, JSON.stringify(doc));
      assert.deepEqual(out.hooks, []);
    }
  });

  it("an invalid file surfaces in the list and runs nothing", () => {
    writeJson(path.join(tmp, "hooks.json"), { hooks: [{ event: "Nope", command: ["a"] }] });
    const list = userHooks.listHooks({ userDataPath: tmp });
    assert.match(list.user.error, /event must be one of/);
    assert.deepEqual(userHooks.effectiveHooks({ userDataPath: tmp }), []);
    // and prepareRunHooks does not throw
    assert.equal(
      userHooks.prepareRunHooks({ userDataPath: tmp, threadId: "t1", cwd: tmp }),
      null,
    );
  });
});

describe("project trust", () => {
  let project;
  beforeEach(() => {
    project = path.join(tmp, "repo");
    writeJson(path.join(project, ".solenta", "hooks.json"), {
      hooks: [{ event: "Stop", command: ["echo", "one"] }],
    });
  });

  it("project hooks run only after approval of that exact hash", () => {
    const opts = { userDataPath: tmp, projectPath: project };
    let list = userHooks.listHooks(opts);
    assert.equal(list.project.trusted, false);
    assert.deepEqual(userHooks.effectiveHooks(opts), []);

    userHooks.approveProjectHooks({ ...opts, hash: list.project.hash });
    list = userHooks.listHooks(opts);
    assert.equal(list.project.trusted, true);
    assert.deepEqual(userHooks.effectiveHooks(opts).map((h) => h.id), ["project:0"]);
  });

  it("a content change drops trust until re-approved", () => {
    const opts = { userDataPath: tmp, projectPath: project };
    userHooks.approveProjectHooks({ ...opts, hash: userHooks.listHooks(opts).project.hash });
    writeJson(path.join(project, ".solenta", "hooks.json"), {
      hooks: [{ event: "Stop", command: ["curl", "evil"] }],
    });
    const list = userHooks.listHooks(opts);
    assert.equal(list.project.trusted, false);
    assert.deepEqual(userHooks.effectiveHooks(opts), []);
    userHooks.approveProjectHooks({ ...opts, hash: list.project.hash });
    assert.equal(userHooks.effectiveHooks(opts)[0].command[0], "curl");
  });

  it("refuses to approve a hash the file no longer has", () => {
    const opts = { userDataPath: tmp, projectPath: project };
    const stale = userHooks.listHooks(opts).project.hash;
    writeJson(path.join(project, ".solenta", "hooks.json"), { hooks: [] });
    assert.throws(
      () => userHooks.approveProjectHooks({ ...opts, hash: stale }),
      /changed since you reviewed it/,
    );
    assert.equal(userHooks.listHooks(opts).project.trusted, false);
  });

  it("user hooks need no approval and come first", () => {
    writeJson(path.join(tmp, "hooks.json"), { hooks: [{ event: "Stop", command: ["u"] }] });
    const opts = { userDataPath: tmp, projectPath: project };
    userHooks.approveProjectHooks({ ...opts, hash: userHooks.listHooks(opts).project.hash });
    assert.deepEqual(userHooks.effectiveHooks(opts).map((h) => h.id), ["user:0", "project:0"]);
  });
});

describe("project trust covers repo scripts (#1737)", () => {
  let project;
  let worktree;
  let opts;
  const hooksFile = () => path.join(project, ".solenta", "hooks.json");
  const writeHooks = (hooks) => writeJson(hooksFile(), { hooks });
  const approve = () =>
    userHooks.approveProjectHooks({ ...opts, hash: userHooks.listHooks(opts).project.hash });
  // Prints which copy ran and from where.
  const script = (who) =>
    `process.stdout.write(JSON.stringify({who:${JSON.stringify(who)},cwd:process.cwd()}))`;

  beforeEach(() => {
    // realpath: macOS tmp is a symlink, and refs resolve through it
    project = path.join(fs.realpathSync(tmp), "repo");
    worktree = path.join(tmp, "worktree");
    for (const [root, who] of [[project, "checkout"], [worktree, "worktree"]]) {
      writeJson(path.join(root, "tools", "hook.js"), script(who));
      writeJson(path.join(root, "scripts", "check.sh"), "#!/bin/sh\necho ok\n");
      fs.chmodSync(path.join(root, "scripts", "check.sh"), 0o755);
    }
    opts = { userDataPath: tmp, projectPath: project };
  });

  it("script-free hooks keep the plain hooks.json hash, so old approvals hold", () => {
    writeHooks([{ event: "Stop", command: [NODE, "-e", "console.log(1)"] }, { event: "Stop", command: ["echo", "hi"] }]);
    const plain = require("node:crypto").createHash("sha256").update(fs.readFileSync(hooksFile())).digest("hex");
    const list = userHooks.listHooks(opts);
    assert.equal(list.project.hash, plain);
    assert.deepEqual(list.project.hooks.map((h) => h.scripts), [[], []]);
    // a trust.json written before #1737
    writeJson(path.join(tmp, "user-hooks", "trust.json"), { [list.project.path]: plain });
    assert.equal(userHooks.listHooks(opts).project.trusted, true);
    assert.equal(userHooks.effectiveHooks(opts)[0].verify, undefined);
  });

  it("finds script arguments in every interpreter form and skips flags and words", () => {
    const outside = path.join(tmp, "outside.js");
    fs.writeFileSync(outside, "");
    const refs = (command) => userHooks.scriptRefs(project, command).map((r) => [r.index, r.path]);
    assert.deepEqual(refs(["./scripts/check.sh"]), [[0, "scripts/check.sh"]]);
    assert.deepEqual(refs(["bash", "scripts/check.sh", "--strict"]), [[1, "scripts/check.sh"]]);
    assert.deepEqual(refs(["node", "-r", "./tools/hook.js", "tools/hook.js"]), [[2, "tools/hook.js"], [3, "tools/hook.js"]]);
    assert.deepEqual(refs([NODE, path.join(project, "tools", "hook.js")]), [[1, "tools/hook.js"]]);
    // inline code is already in hooks.json; flags, missing files, dirs and outside paths are not scripts
    assert.deepEqual(refs(["bash", "-c", "./scripts/check.sh && echo done"]), []);
    assert.deepEqual(refs([NODE, "-e", "require('./tools/hook.js')"]), []);
    assert.deepEqual(refs(["node", "--require=missing.js", "missing.js", "tools", `--x=${outside}`, outside]), []);
    // --flag=path pins the value and keeps the flag for the rewrite
    const [flagRef] = userHooks.scriptRefs(project, ["node", "--require=./tools/hook.js", "-e", "1"]);
    assert.deepEqual([flagRef.index, flagRef.path, flagRef.prefix], [1, "tools/hook.js", "--require="]);
    assert.deepEqual(refs(["npx", "eslint", "."]), []);
    if (process.platform !== "win32") {
      // a bare argv[0] is a PATH lookup, not the repo file of that name
      writeJson(path.join(project, "make"), "");
      assert.deepEqual(refs(["make", "lint"]), []);
    }
  });

  it("a symlink escaping the project is not a repo script; one inside resolves to its target", { skip: process.platform === "win32" }, () => {
    const outside = path.join(tmp, "outside.sh");
    fs.writeFileSync(outside, "echo outside\n");
    fs.symlinkSync(outside, path.join(project, "scripts", "escape.sh"));
    fs.symlinkSync(path.join(project, "scripts", "check.sh"), path.join(project, "scripts", "alias.sh"));
    assert.deepEqual(userHooks.scriptRefs(project, ["sh", "scripts/escape.sh"]), []);
    const [ref] = userHooks.scriptRefs(project, ["sh", "scripts/alias.sh"]);
    assert.equal(ref.path, "scripts/check.sh");
    assert.equal(ref.abs, path.join(project, "scripts", "check.sh"));
  });

  it("containment follows Windows path rules", () => {
    const w = path.win32;
    assert.equal(userHooks.isInside("C:\\repo", "C:\\repo\\scripts\\check.ps1", w), true);
    assert.equal(userHooks.isInside("C:\\repo", "c:\\REPO\\scripts\\check.ps1", w), true);
    assert.equal(userHooks.isInside("C:\\repo", "C:\\repo2\\check.ps1", w), false);
    assert.equal(userHooks.isInside("C:\\repo", "D:\\repo\\check.ps1", w), false);
    assert.equal(userHooks.isInside("C:\\repo", "C:\\repo", w), false);
    assert.equal(userHooks.isInside("/repo", "/repo/..x/y", path.posix), true);
    assert.equal(userHooks.isInside("/repo", "/other/y", path.posix), false);
  });

  it("editing a referenced script in the checkout drops trust; a vanished one too", () => {
    writeHooks([{ event: "Stop", command: [NODE, "tools/hook.js"] }]);
    const before = userHooks.listHooks(opts).project;
    assert.notEqual(before.hash, require("node:crypto").createHash("sha256").update(fs.readFileSync(hooksFile())).digest("hex"));
    approve();
    assert.equal(userHooks.listHooks(opts).project.trusted, true);

    fs.writeFileSync(path.join(project, "tools", "hook.js"), "require('child_process').exec('curl evil')");
    assert.equal(userHooks.listHooks(opts).project.trusted, false);
    assert.deepEqual(userHooks.effectiveHooks(opts), []);
    approve();
    assert.equal(userHooks.listHooks(opts).project.trusted, true);

    fs.rmSync(path.join(project, "tools", "hook.js"));
    assert.equal(userHooks.listHooks(opts).project.trusted, false);
  });

  it("refuses an approval when a script changed after review", () => {
    writeHooks([{ event: "Stop", command: [NODE, "tools/hook.js"] }]);
    const seen = userHooks.listHooks(opts).project.hash;
    fs.writeFileSync(path.join(project, "tools", "hook.js"), "// swapped");
    assert.throws(
      () => userHooks.approveProjectHooks({ ...opts, hash: seen }),
      /a script it runs changed since you reviewed it/,
    );
  });

  it("rewrites script arguments to the checkout copy and runs it, never the worktree's", async () => {
    writeHooks([{ event: "Stop", command: [NODE, "tools/hook.js"] }, { event: "Stop", command: ["./scripts/check.sh", "-v"] }]);
    approve();
    const prepared = userHooks.prepareRunHooks({ ...opts, threadId: "t1", cwd: worktree });
    assert.deepEqual(prepared.hooks.map((h) => h.command), [
      [NODE, path.join(project, "tools", "hook.js")],
      [path.join(project, "scripts", "check.sh"), "-v"],
    ]);
    assert.deepEqual(prepared.hooks[0].verify.map((s) => s.path), ["scripts/check.sh", "tools/hook.js"]);

    // the agent edits the worktree copy: no effect on what runs
    fs.writeFileSync(path.join(worktree, "tools", "hook.js"), script("tampered"));
    const out = await userHooks.runThreadEvent({ userDataPath: tmp, threadId: "t1", event: "Stop" });
    const got = JSON.parse(out.results[0].stdout);
    assert.equal(got.who, "checkout");
    assert.equal(fs.realpathSync(got.cwd), fs.realpathSync(worktree));
  });

  it("re-checks script hashes before spawning: a swapped script does not run", async () => {
    const marker = path.join(tmp, "ran");
    writeJson(path.join(project, "tools", "hook.js"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`);
    writeHooks([{ event: "Stop", command: [NODE, "tools/hook.js"] }, { event: "Stop", command: ["echo", "plain"] }]);
    approve();
    userHooks.prepareRunHooks({ ...opts, threadId: "t1", cwd: worktree });

    // swapped in the checkout after the run resolved its hooks
    fs.writeFileSync(path.join(project, "tools", "hook.js"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "evil")`);
    const out = await userHooks.runThreadEvent({ userDataPath: tmp, threadId: "t1", event: "Stop" });
    assert.equal(fs.existsSync(marker), false);
    // the whole approved set is void, so the script-free project hook stops too
    assert.deepEqual(out.results.map((r) => r.exitCode), [null, null]);
    assert.match(out.warnings[0], /Hook project:0 did not run: tools\/hook\.js changed since the project hooks were approved\. Re-approve/);
    assert.equal(userHooks.listHooks(opts).project.trusted, false);
    assert.match(userHooks.lastResults(tmp)["project:0"].error, /Re-approve/);
  });

  it("user hooks are never rewritten", () => {
    writeJson(path.join(tmp, "hooks.json"), { hooks: [{ event: "Stop", command: [NODE, "tools/hook.js"] }] });
    const [h] = userHooks.effectiveHooks(opts);
    assert.deepEqual(h.command, [NODE, "tools/hook.js"]);
    assert.equal(h.verify, undefined);
    assert.equal(userHooks.listHooks(opts).user.hooks[0].scripts, undefined);
  });

  it("the list shows each hook's scripts with their hashes", () => {
    writeHooks([{ event: "Stop", command: ["bash", "scripts/check.sh"] }]);
    const [row] = userHooks.listHooks(opts).project.hooks;
    const sha = require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(project, "scripts", "check.sh"))).digest("hex");
    assert.deepEqual(row.scripts, [{ path: "scripts/check.sh", sha256: sha }]);
    assert.deepEqual(row.command, ["bash", "scripts/check.sh"]);
  });
});

describe("contract", () => {
  const hook = (src, extra = {}) => ({ id: "user:0", event: "PreToolUse", command: nodeHook(src), ...extra });

  it("sends the JSON payload on stdin and runs in cwd", async () => {
    const out = path.join(tmp, "payload.json");
    const r = await run.runOne(
      hook(`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({p:JSON.parse(s),cwd:process.cwd()}))})`),
      { event: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      tmp,
    );
    assert.equal(r.exitCode, 0);
    const got = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(got.p.tool_name, "Bash");
    assert.deepEqual(got.p.tool_input, { command: "ls" });
    assert.equal(fs.realpathSync(got.cwd), fs.realpathSync(tmp));
  });

  it("exit 0 continues, exit 2 blocks with stderr, other exits warn", async () => {
    const ok = await run.runHooks({ hooks: [hook("process.exit(0)")], event: "PreToolUse", payload: {}, toolName: "Bash" });
    assert.equal(ok.blocked, false);
    assert.deepEqual(ok.warnings, []);

    const warn = await run.runHooks({ hooks: [hook("console.error('meh');process.exit(1)")], event: "PreToolUse", payload: {}, toolName: "Bash" });
    assert.equal(warn.blocked, false);
    assert.match(warn.warnings[0], /exited 1: meh/);

    const blocked = await run.runHooks({
      hooks: [
        hook("process.exit(0)"),
        { ...hook("console.error('no rm please');process.exit(2)"), id: "user:1" },
        { ...hook("process.exit(0)"), id: "user:2" },
      ],
      event: "PreToolUse",
      payload: {},
      toolName: "Bash",
    });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.reason, "no rm please");
    assert.equal(blocked.blockedBy, "user:1");
    // the first block stops the rest
    assert.deepEqual(blocked.results.map((r) => r.id), ["user:0", "user:1"]);
  });

  it("matcher is an anchored tool-name regex", async () => {
    const h = { ...hook("process.exit(2)"), matcher: "Edit|Write" };
    assert.equal((await run.runHooks({ hooks: [h], event: "PreToolUse", payload: {}, toolName: "Bash" })).blocked, false);
    assert.equal((await run.runHooks({ hooks: [h], event: "PreToolUse", payload: {}, toolName: "MultiEdit" })).blocked, false);
    assert.equal((await run.runHooks({ hooks: [h], event: "PreToolUse", payload: {}, toolName: "Write" })).blocked, true);
  });

  it("UserPromptSubmit stdout adds context (JSON or plain text)", async () => {
    const out = await run.runHooks({
      hooks: [
        { id: "a", event: "UserPromptSubmit", command: nodeHook(`console.log(JSON.stringify({additionalContext:"ticket ABC-1"}))`) },
        { id: "b", event: "UserPromptSubmit", command: nodeHook(`console.log(JSON.stringify({hookSpecificOutput:{additionalContext:"nested"}}))`) },
        { id: "c", event: "UserPromptSubmit", command: nodeHook(`console.log("plain")`) },
      ],
      event: "UserPromptSubmit",
      payload: { prompt: "hi" },
    });
    assert.deepEqual(out.contexts, ["ticket ABC-1", "nested", "plain"]);
  });

  it("a timeout kills the whole process tree", { timeout: 15000 }, async () => {
    const pidFile = path.join(tmp, "grandchild.pid");
    const r = await run.runOne(
      hook(
        `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});` +
          `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`,
        { timeoutMs: 1500 },
      ),
      {},
      tmp,
    );
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    assert.match(r.error, /timed out after 1500 ms/);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((res) => setTimeout(res, 50));
      } catch {
        alive = false;
      }
    }
    if (alive) process.kill(pid, "SIGKILL");
    assert.equal(alive, false, "grandchild survived the timeout");
  });

  it("argv is never shell-interpreted", async () => {
    const marker = path.join(tmp, "pwned");
    const r = await run.runOne(
      {
        id: "x",
        event: "Stop",
        command: [NODE, "-e", "process.stdout.write(process.argv[1])", `$HOME; touch ${marker}`],
      },
      {},
      tmp,
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, `$HOME; touch ${marker}`);
    assert.equal(fs.existsSync(marker), false);
  });

  it("a missing binary is a warning, not a crash", async () => {
    const out = await run.runHooks({
      hooks: [{ id: "x", event: "Stop", command: [path.join(tmp, "nope")] }],
      event: "Stop",
      payload: {},
    });
    assert.equal(out.blocked, false);
    assert.match(out.warnings[0], /ENOENT/);
  });
});

/** Resolved thread file with one PreToolUse hook that records its payload. */
function prepare(threadId, provider, hookSrc) {
  writeJson(path.join(tmp, "hooks.json"), {
    hooks: [{ event: "PreToolUse", matcher: "Bash", command: nodeHook(hookSrc) }],
  });
  return userHooks.prepareRunHooks({ userDataPath: tmp, threadId, provider, model: "m1", cwd: tmp });
}

const recordAndBlock = (out) =>
  `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(out)},s);` +
  `if(JSON.parse(s).tool_input.command.includes("deploy")){console.error("no deploys");process.exit(2)}})`;

describe("routing: claude", () => {
  it("buildArgs puts the user hook into --settings", () => {
    const hooks = userHooks.claudeSettingsHooks("/rt", [
      { event: "PreToolUse", command: ["a"], timeoutMs: 5000 },
    ]);
    const args = getProvider("claude").buildArgs({ userHooks: hooks });
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    const h = settings.hooks.PreToolUse[0];
    assert.equal(h.matcher, "*");
    assert.match(h.hooks[0].command, /user-hooks-run\.js" PreToolUse$/);
    assert.equal(h.hooks[0].timeout, 16);
    assert.equal(userHooks.claudeSettingsHooks("/rt", [{ event: "Stop", command: ["a"] }]), null);
  });

  it("the settings hook script blocks on exit 2 with Solenta's thread facts", () => {
    const seen = path.join(tmp, "seen.json");
    const { file } = prepare("t-claude", "claude", recordAndBlock(seen));
    const runtime = copyGuardrailRuntime(path.join(tmp, "runtime"));
    const env = { ...process.env, SOLENTA_USER_HOOKS: file, SOLENTA_WORKTREE: tmp };
    const claudePayload = (command) =>
      JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command } });

    const blocked = spawnSync(NODE, [path.join(runtime, "user-hooks-run.js"), "PreToolUse"], {
      input: claudePayload("npm run deploy"),
      encoding: "utf8",
      env,
    });
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /no deploys/);
    const p = JSON.parse(fs.readFileSync(seen, "utf8"));
    assert.equal(p.thread_id, "t-claude");
    assert.equal(p.provider, "claude");
    assert.equal(p.model, "m1");
    assert.equal(p.session_id, "s");
    assert.equal(p.event, "PreToolUse");

    const ok = spawnSync(NODE, [path.join(runtime, "user-hooks-run.js"), "PreToolUse"], {
      input: claudePayload("npm test"),
      encoding: "utf8",
      env,
    });
    assert.equal(ok.status, 0);
    // last run is recorded for Settings
    assert.equal(userHooks.lastResults(tmp)["user:0"].exitCode, 0);
  });
});

describe("routing: codex", () => {
  it("the overlay hook runs user hooks after a guardrail allow", () => {
    const seen = path.join(tmp, "seen.json");
    const { file, hooks } = prepare("t-codex", "codex", recordAndBlock(seen));
    const dest = path.join(tmp, "codex-home");
    materializeCodexGuardrailHome({ dest, timeoutSec: userHooks.preToolBudgetSec(hooks) });
    const hj = JSON.parse(fs.readFileSync(path.join(dest, "hooks.json"), "utf8"));
    assert.equal(hj.hooks.PreToolUse[0].hooks[0].timeout, 21);
    // trust hash in config.toml was computed with the same timeout
    assert.match(fs.readFileSync(path.join(dest, "config.toml"), "utf8"), /trusted_hash = "sha256:/);

    const script = path.join(dest, "solenta-hooks", "guardrail-hook.js");
    const env = { ...process.env, SOLENTA_USER_HOOKS: file, SOLENTA_WORKTREE: tmp, CODER_GUARDRAILS: "off" };
    const codexPayload = (command) =>
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
    const blocked = spawnSync(NODE, [script], { input: codexPayload("deploy now"), encoding: "utf8", env });
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /no deploys/);
    assert.equal(JSON.parse(fs.readFileSync(seen, "utf8")).provider, "codex");

    const ok = spawnSync(NODE, [script], { input: codexPayload("ls"), encoding: "utf8", env });
    assert.equal(ok.status, 0);
  });

  it("without user hooks the overlay keeps its 10 s budget", () => {
    const dest = path.join(tmp, "codex-home");
    materializeCodexGuardrailHome({ dest });
    const hj = JSON.parse(fs.readFileSync(path.join(dest, "hooks.json"), "utf8"));
    assert.equal(hj.hooks.PreToolUse[0].hooks[0].timeout, 10);
  });
});

describe("guardrail precedence", () => {
  const flag = () => {
    const f = path.join(tmp, "guardrails-enabled");
    fs.writeFileSync(f, "1");
    return f;
  };
  const marker = () => path.join(tmp, "hook-ran");
  const touch = () => `require("fs").writeFileSync(${JSON.stringify(marker())},"1")`;

  it("codex: a guardrail deny wins and the user hook never runs", () => {
    const { file } = prepare("t1", "codex", touch());
    const dest = path.join(tmp, "codex-home");
    materializeCodexGuardrailHome({ dest });
    const r = spawnSync(NODE, [path.join(dest, "solenta-hooks", "guardrail-hook.js")], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
      encoding: "utf8",
      env: { ...process.env, SOLENTA_USER_HOOKS: file, SOLENTA_WORKTREE: tmp, CODER_GUARDRAILS_PATH: flag() },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Blocked by Solenta guardrails/);
    assert.equal(fs.existsSync(marker()), false);
  });

  it("claude: a hard guardrail deny wins; a hook exit 0 cannot allow it", () => {
    const { file } = prepare("t2", "claude", touch());
    const runtime = copyGuardrailRuntime(path.join(tmp, "runtime"));
    const r = spawnSync(NODE, [path.join(runtime, "user-hooks-run.js"), "PreToolUse"], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
      encoding: "utf8",
      env: { ...process.env, SOLENTA_USER_HOOKS: file, SOLENTA_WORKTREE: tmp, CODER_GUARDRAILS_PATH: flag() },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Blocked by Solenta guardrails/);
    assert.equal(fs.existsSync(marker()), false);
  });
});

describe("runner events", () => {
  function fakeCtx() {
    const messages = [];
    return {
      messages,
      store: {
        save() {},
        getMessages: () => messages,
      },
      userDataPath: tmp,
      appendMessage: (threadId, role, text) => messages.push({ role, text }),
      pushDetail() {},
    };
  }

  it("UserPromptSubmit adds context or blocks the prompt", async () => {
    writeJson(path.join(tmp, "hooks.json"), {
      hooks: [
        { event: "UserPromptSubmit", command: nodeHook(`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).prompt;if(p.includes("secret")){console.error("no secrets");process.exit(2)}console.log(JSON.stringify({additionalContext:"ctx for "+p}))})`) },
      ],
    });
    const ctx = fakeCtx();
    const ev = createUserHookEvents(ctx);
    assert.ok(ev.prepare({ threadId: "t", provider: "kimi", cwd: tmp }));
    const ok = await ev.beforePrompt("t", "r", "hello");
    assert.equal(ok.blocked, false);
    assert.equal(ok.context, "\n\n[Hook context]\nctx for hello");
    const no = await ev.beforePrompt("t", "r", "my secret");
    assert.equal(no.blocked, true);
    assert.equal(no.reason, "no secrets");
  });

  it("PreToolUse is best effort off claude/codex and skipped on native providers", async () => {
    writeJson(path.join(tmp, "hooks.json"), {
      hooks: [{ event: "PreToolUse", command: nodeHook(`console.error("nope");process.exit(2)`) }],
    });
    const ctx = fakeCtx();
    const ev = createUserHookEvents(ctx);
    ev.prepare({ threadId: "t", provider: "cursor", cwd: tmp });
    await ev.toolStarted("t", "r", { id: "1", name: "Shell", input: '{"command":"ls"}' });
    assert.match(ctx.messages[0].text, /Hook blocked Shell: nope \(cursor has no pre-tool hook/);

    ev.prepare({ threadId: "t", provider: "claude", cwd: tmp });
    assert.equal(ev.toolStarted("t", "r", { id: "2", name: "Bash" }), null);
    assert.ok(ev.nativePreTool("t"));
  });

  it("PostToolUse gets the tool's input and output; Stop gets the last message", async () => {
    const out = path.join(tmp, "events.jsonl");
    const rec = `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>require("fs").appendFileSync(${JSON.stringify(out)},s))`;
    writeJson(path.join(tmp, "hooks.json"), {
      hooks: [
        { event: "PostToolUse", command: nodeHook(rec) },
        { event: "Stop", command: nodeHook(rec) },
      ],
    });
    const ctx = fakeCtx();
    ctx.messages.push({ role: "tool", tool: { id: "9", name: "Bash", input: '{"command":"ls"}', output: "a\nb", done: true } });
    const ev = createUserHookEvents(ctx);
    ev.prepare({ threadId: "t", provider: "codex", cwd: tmp });
    await ev.toolFinished("t", "r", "9", "Bash");
    await ev.turnDone("t", "r", "all done");
    const [post, stop] = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(post.event, "PostToolUse");
    assert.deepEqual(post.tool_input, { command: "ls" });
    assert.equal(post.tool_response, "a\nb");
    assert.equal(stop.event, "Stop");
    assert.equal(stop.last_assistant_message, "all done");
  });

  it("remote runs get no hooks", () => {
    writeJson(path.join(tmp, "hooks.json"), { hooks: [{ event: "Stop", command: ["x"] }] });
    const ev = createUserHookEvents(fakeCtx());
    assert.equal(ev.prepare({ threadId: "t", provider: "claude", cwd: "/r", remote: true }), null);
    assert.equal(ev.has("t", "Stop"), false);
  });
});

describe("testHook", () => {
  it("runs one hook with a sample payload and records the result", async () => {
    writeJson(path.join(tmp, "hooks.json"), {
      hooks: [{ event: "PreToolUse", command: nodeHook(`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.error(JSON.parse(s).tool_name);process.exit(3)})`) }],
    });
    const r = await userHooks.testHook({ userDataPath: tmp, id: "user:0" });
    assert.equal(r.exitCode, 3);
    assert.equal(r.output, "Bash");
    assert.equal(userHooks.listHooks({ userDataPath: tmp }).user.hooks[0].lastRun.exitCode, 3);
    await assert.rejects(userHooks.testHook({ userDataPath: tmp, id: "user:9" }), /No hook/);
  });
});
