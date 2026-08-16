/**
 * Attachments (issue #68): path classification, pasted-image persistence,
 * readback, and the runner storing them on the user message + appending the
 * CLI-only dispatch section.
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
const attachments = require("../attachments.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("attachments module", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-attach-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("classifies images and folders, skipping other files", () => {
    const png = path.join(tmpDir, "shot.PNG");
    const txt = path.join(tmpDir, "notes.txt");
    const dir = path.join(tmpDir, "specs");
    fs.writeFileSync(png, "x");
    fs.writeFileSync(txt, "x");
    fs.mkdirSync(dir);

    const out = attachments.classifyPaths([
      png,
      txt,
      dir,
      path.join(tmpDir, "missing.png"),
      "relative/path.png",
      "",
    ]);

    assert.deepEqual(out, [
      { kind: "image", path: png, name: "shot.PNG" },
      { kind: "folder", path: dir, name: "specs" },
    ]);
  });

  it("saves a pasted image under userData and reads it back as a data URL", () => {
    const bytes = Buffer.from("fake-png-bytes");
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;

    const saved = attachments.saveImage(tmpDir, "t1", dataUrl);
    assert.ok(saved, "saveImage must accept a png data URL");
    assert.equal(saved.kind, "image");
    assert.ok(saved.path.startsWith(path.join(tmpDir, "attachments", "t1")));
    assert.equal(fs.readFileSync(saved.path).toString(), "fake-png-bytes");

    const read = attachments.readImage(saved.path);
    assert.equal(read, dataUrl);

    // Thread isolation: another thread id lands in its own directory.
    const other = attachments.saveImage(tmpDir, "t2", dataUrl);
    assert.ok(other.path.startsWith(path.join(tmpDir, "attachments", "t2")));
  });

  it("refuses thread ids that escape the attachments dir (issue #127)", () => {
    const dataUrl = `data:image/png;base64,${Buffer.from("x").toString("base64")}`;
    for (const tid of [
      "../../escaped",
      "..",
      "a/b",
      "a\\b",
      path.join(tmpDir, "abs"),
      "C:evil",
      "t1\0",
      "",
    ]) {
      assert.equal(
        attachments.saveImage(tmpDir, tid, dataUrl),
        null,
        `threadId ${JSON.stringify(tid)} must be refused`,
      );
    }
    assert.deepEqual(
      fs.readdirSync(tmpDir),
      [],
      "nothing may be written outside a valid thread dir",
    );
  });

  it("rejects non-image payloads and paths", () => {
    assert.equal(
      attachments.saveImage(tmpDir, "t1", "data:text/plain;base64,aGk="),
      null,
      "non-image data URLs must be rejected",
    );
    assert.equal(attachments.saveImage(tmpDir, "t1", "not a data url"), null);

    const txt = path.join(tmpDir, "notes.txt");
    fs.writeFileSync(txt, "hello");
    assert.equal(attachments.readImage(txt), null, "text files must not read");
    assert.equal(
      attachments.readImage(path.join(tmpDir, "missing.png")),
      null,
      "missing files must not read",
    );
    assert.equal(
      attachments.readImage("relative.png"),
      null,
      "relative paths must not read",
    );
  });
});

describe("runner attachments", () => {
  let tmpDir;
  let store;
  let runner;
  let prevAgentCmd;

  beforeEach(async () => {
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-attach-run-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
    services.createThread(store, { projectId: project.id, title: "New Thread" });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("stores attachments on the user message and appends the dispatch section", async () => {
    // Fake agent: record argv (the dispatch prompt is the last one) in cwd.
    // No whitespace in the -e body (parseAgentCommand splits on whitespace).
    process.env.CODER_AGENT_CMD = `${process.execPath} -e require('fs').writeFileSync('argv.json',JSON.stringify(process.argv));process.stdout.write('ok');setTimeout(()=>process.exit(0),20)`;

    const thread = store.getThreads()[0];
    const repo = path.join(tmpDir, "app");
    const image = path.join(tmpDir, "pic.png");
    const folder = path.join(tmpDir, "specs");
    fs.writeFileSync(image, "x");
    fs.mkdirSync(folder);

    await runner.startRun({
      threadId: thread.id,
      prompt: "look at these",
      attachments: [
        { kind: "image", path: image, name: "pic.png" },
        { kind: "folder", path: folder, name: "specs" },
        // Malformed entries must be dropped, never forwarded to the CLI.
        { kind: "file", path: "/etc/passwd", name: "passwd" },
        { kind: "image", path: "relative.png", name: "relative.png" },
      ],
    });

    await waitFor(() => store.getThread(thread.id)?.status === "done");

    const messages = store.getMessages(thread.id);
    const userMsg = messages.find((m) => m.role === "user");
    assert.ok(userMsg, "user message must exist");
    assert.equal(
      userMsg.text,
      "look at these",
      "transcript keeps the raw prompt, not the dispatch text",
    );
    assert.deepEqual(userMsg.attachments, [
      { kind: "image", path: image, name: "pic.png" },
      { kind: "folder", path: folder, name: "specs" },
    ]);

    const argv = JSON.parse(
      fs.readFileSync(path.join(repo, "argv.json"), "utf8"),
    );
    const dispatchPrompt = argv[argv.length - 1];
    assert.ok(
      dispatchPrompt.includes("look at these"),
      "dispatch prompt carries the prompt",
    );
    assert.ok(
      dispatchPrompt.includes(`- Image: ${image}`),
      "dispatch prompt lists the image path",
    );
    assert.ok(
      dispatchPrompt.includes(`- Folder: ${folder}`),
      "dispatch prompt lists the folder path",
    );
    assert.ok(
      !dispatchPrompt.includes("/etc/passwd"),
      "sanitized-out entries must not reach the CLI",
    );

    // Attachments survive a store reload (persistence round-trip).
    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    const persisted = reloaded
      .getMessages(thread.id)
      .find((m) => m.role === "user");
    assert.deepEqual(persisted.attachments, userMsg.attachments);
  });

  it("leaves prompt and message untouched without attachments", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e require('fs').writeFileSync('argv.json',JSON.stringify(process.argv));process.stdout.write('ok');setTimeout(()=>process.exit(0),20)`;

    const thread = store.getThreads()[0];
    const repo = path.join(tmpDir, "app");
    await runner.startRun({ threadId: thread.id, prompt: "plain turn" });
    await waitFor(() => store.getThread(thread.id)?.status === "done");

    const userMsg = store
      .getMessages(thread.id)
      .find((m) => m.role === "user");
    assert.equal(userMsg.attachments, undefined);

    const argv = JSON.parse(
      fs.readFileSync(path.join(repo, "argv.json"), "utf8"),
    );
    const dispatchPrompt = argv[argv.length - 1];
    assert.ok(!dispatchPrompt.includes("attached the following"));
  });
});
