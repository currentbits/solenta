/**
 * #514: multi-folder projects. project.path is primary; project.folders are
 * read/search folders whose writes ask until a per-folder grant.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { getProvider } = require("../providers.js");
const { folderFor, foldersNoteFor } = require("../projectFolders.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

function waitFor(predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Records argv + the stdin prompt, raises one Write can_use_tool, records the reply. */
function writeFakeClaude(dir) {
  return writeFakeBin(path.join(dir, "fake-claude"), `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const out = process.env.CODER_FAKE_DIR;
fs.writeFileSync(out + "/argv.json", JSON.stringify(process.argv.slice(2)));
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: "sess-mf", model: "m" });
let buf = "";
let asked = false;
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "user" && !asked) {
      asked = true;
      fs.writeFileSync(out + "/prompt.json", JSON.stringify(msg));
      emit({ type: "control_request", request_id: "req-mf", request: {
        subtype: "can_use_tool", tool_name: "Write",
        input: { file_path: process.env.CODER_FAKE_TARGET, content: "hi" } } });
    } else if (msg.type === "control_response") {
      fs.writeFileSync(out + "/ctrl.json", JSON.stringify(msg));
      emit({ type: "result", subtype: "success", result: "done",
        usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0,
        num_turns: 1, session_id: "sess-mf" });
    }
  }
});
setTimeout(() => process.exit(1), 30000);
`);
}

describe("multi-folder projects (#514)", () => {
  let tmpDir;
  let store;
  let project;
  let lib;
  const saved = {};
  const ENV = [
    "CODER_SIMULATE", "CODER_AGENT_CMD", "CODER_CLAUDE_BIN", "CODER_FAKE_DIR",
    "CODER_FAKE_TARGET", "CODER_GROK_MCP_DISABLE", "CODER_GUARDRAILS",
  ];

  beforeEach(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_GUARDRAILS;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coder-mf-")));
    const repo = path.join(tmpDir, "app");
    lib = path.join(tmpDir, "lib");
    fs.mkdirSync(repo);
    fs.mkdirSync(lib);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    store = new Store(path.join(tmpDir, "store.json"));
    project = await services.addProject(store, repo);
  });

  afterEach(async () => {
    await rmTree(tmpDir);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("updateProject validates, de-duplicates, skips the primary, and clears", () => {
    const updated = services.updateProject(store, project.id, {
      folders: [lib, ` ${lib} `, project.path, ""],
    });
    assert.deepEqual(updated.folders, [lib]);
    assert.throws(
      () => services.updateProject(store, project.id, { folders: ["rel/dir"] }),
      /absolute/,
    );
    assert.throws(
      () => services.updateProject(store, project.id, { folders: [path.join(tmpDir, "nope")] }),
      /not found/,
    );
    assert.throws(
      () => services.updateProject(store, project.id, {
        remoteHost: "a@b", remotePath: "/srv", folders: [lib],
      }),
      /local projects/,
    );
    // Untouched folders survive unrelated patches; turning remote drops them.
    assert.deepEqual(services.updateProject(store, project.id, { name: "x" }).folders, [lib]);
    const remote = services.updateProject(store, project.id, { remoteHost: "a@b", remotePath: "/srv" });
    assert.equal(remote.folders, undefined);
    services.updateProject(store, project.id, { remoteHost: "", folders: [lib] });
    const cleared = services.updateProject(store, project.id, { folders: null });
    assert.equal(cleared.folders, undefined);
  });

  it("claude argv: one --add-dir per folder, ask rules for ungranted, merged settings", () => {
    const claude = getProvider("claude");
    const args = claude.buildArgs({
      addDirs: ["/a/lib", "/b/svc"],
      askWriteDirs: ["/b/svc/"],
      fast: true,
      model: "claude-opus-5-5",
    });
    assert.ok(args.includes("--add-dir=/a/lib"));
    assert.ok(args.includes("--add-dir=/b/svc"));
    const settings = args.filter((a, i) => args[i - 1] === "--settings");
    assert.equal(settings.length, 1);
    assert.deepEqual(JSON.parse(settings[0]), {
      fastMode: true,
      permissions: { ask: ["Edit(//b/svc/**)"] },
    });
    assert.equal(claude.buildArgs({}).includes("--settings"), false);
  });

  it("folderFor and the prompt note", () => {
    assert.equal(folderFor("/a/lib/x.js", ["/a/lib"]), "/a/lib");
    assert.equal(folderFor("/a/library/x.js", ["/a/lib"]), null);
    assert.equal(folderFor("../lib/x.js", ["/a/lib"], "/a/app"), "/a/lib");
    assert.equal(foldersNoteFor({ path: "/a/app" }, {}), "");
    const note = foldersNoteFor(
      { path: "/a/app", folders: ["/a/lib", "/a/svc"] },
      { folderWriteGrants: ["/a/svc"] },
    );
    assert.match(note, /\/a\/lib \(read and search only\)/);
    assert.match(note, /\/a\/svc \(writes granted\)/);
    assert.equal(foldersNoteFor({ remoteHost: "a@b", folders: ["/a/lib"] }, {}), "");
  });

  it("claude run: secondary write asks with a folder grant; allowFolder persists it", async () => {
    services.updateProject(store, project.id, { folders: [lib] });
    const thread = services.createThread(store, { projectId: project.id, title: "mf" });
    process.env.CODER_CLAUDE_BIN = writeFakeClaude(tmpDir);
    process.env.CODER_FAKE_DIR = tmpDir;
    process.env.CODER_FAKE_TARGET = path.join(lib, "x.txt");
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    const runner = createRunner({ store, core, pushFn() {}, tickMs: 15, userDataPath: tmpDir });
    try {
      await runner.startRun({ threadId: thread.id, prompt: "edit lib" });
      await waitFor(() => runner.getPendingPermission(thread.id) != null);
      const pending = runner.getPendingPermission(thread.id);
      assert.equal(pending.folderGrant, lib);

      const argv = readJson(path.join(tmpDir, "argv.json"));
      assert.ok(argv.includes(`--add-dir=${lib}`), argv.join(" "));
      const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
      assert.deepEqual(settings.permissions.ask, [`Edit(/${lib}/**)`]);
      const prompt = JSON.stringify(readJson(path.join(tmpDir, "prompt.json")));
      assert.match(prompt, /\[Project folders\]/);

      runner.respondPermission({
        threadId: thread.id, requestId: pending.requestId, decision: "allowFolder",
      });
      await waitFor(() => readJson(path.join(tmpDir, "ctrl.json")) !== undefined);
      const ctrl = readJson(path.join(tmpDir, "ctrl.json"));
      assert.equal(ctrl.response.response.behavior, "allow");
      assert.deepEqual(store.getThread(thread.id).folderWriteGrants, [lib]);
      assert.ok(store.getMessages(thread.id).some((m) => m.text === `Writes allowed in ${lib}`));
    } finally {
      runner.stopAll();
    }
  });
});
