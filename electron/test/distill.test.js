"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");
const { IPC_HANDLERS } = require("../ipc.js");
const {
  distillThread,
  fallbackDistill,
  parseDistilled,
} = require("../distill.js");

/** Write an executable fake fm that runs `body` as node. */
function writeFakeFm(dir, body) {
  const bin = path.join(dir, "fake-fm");
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function thread(over = {}) {
  return {
    id: "t1",
    projectId: "p1",
    title: "Fix the flaky login test",
    provider: "claude",
    model: "opus",
    status: "done",
    ...over,
  };
}

function makeStore(th, messages) {
  return {
    getThread: (id) => (id === th.id ? th : null),
    getMessages: (id) => (id === th.id ? messages : []),
  };
}

function firstUser(text) {
  return [
    { id: "m-user", role: "user", text, createdAt: 1 },
    {
      id: "m-asst",
      role: "assistant",
      text: "I'll look at the failing spec.",
      createdAt: 2,
    },
    {
      id: "m-tool",
      role: "tool",
      text: "Read: auth.spec.ts",
      tool: { name: "Read" },
      createdAt: 3,
    },
  ];
}

function assertPhaseShape(phase, { provider, model }) {
  assert.equal(typeof phase.name, "string");
  assert.ok(phase.name.trim());
  assert.ok(phase.name.length <= 24);
  assert.equal(typeof phase.agentCount, "number");
  assert.ok(Number.isInteger(phase.agentCount));
  assert.ok(phase.agentCount >= 1 && phase.agentCount <= 4);
  assert.equal(typeof phase.instruction, "string");
  assert.ok(phase.instruction.trim());
  assert.equal(phase.provider, provider);
  assert.equal(phase.model, model);
}

function assertDraft(draft, { provider, model, minPhases = 1 }) {
  assert.ok(draft && typeof draft.name === "string" && draft.name.trim());
  assert.ok(Array.isArray(draft.phases));
  assert.ok(draft.phases.length >= minPhases);
  assert.ok(draft.phases.length <= 6);
  for (const phase of draft.phases) {
    assertPhaseShape(phase, { provider, model });
  }
}

const WELL_FORMED = {
  name: "Fix login flake",
  phases: [
    {
      name: "repro",
      agentCount: 1,
      instruction: "Reproduce the failing login test.",
    },
    {
      name: "fix",
      agentCount: 2,
      instruction: "Fix the flake without changing behaviour.",
    },
    {
      name: "verify",
      agentCount: 1,
      instruction: "Re-run the login spec and confirm it is green.",
    },
  ],
};

describe("distillThread", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-distill-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to a single phase when fm is unavailable", async () => {
    const th = thread();
    const store = makeStore(th, firstUser("Fix the flaky login test in auth.spec.ts"));
    const draft = await distillThread(store, th.id, {
      env: { ...process.env, CODER_FM_BIN: "/nope/fm" },
    });
    assertDraft(draft, { provider: "claude", model: "opus" });
    assert.equal(draft.phases.length, 1);
    assert.equal(draft.phases[0].name, "repeat");
    assert.match(draft.phases[0].instruction, /Fix the flaky login test/);
    assert.equal(draft.name, th.title);
  });

  it("parses a well-formed fm response into 2-4 stamped phases", async () => {
    const th = thread({ provider: "grok", model: "grok-4" });
    const store = makeStore(th, firstUser("Fix the flaky login test"));
    const bin = writeFakeFm(
      tmpDir,
      `console.log(${JSON.stringify(JSON.stringify(WELL_FORMED))});`,
    );
    const draft = await distillThread(store, th.id, {
      env: { ...process.env, CODER_FM_BIN: bin },
    });
    assertDraft(draft, { provider: "grok", model: "grok-4", minPhases: 2 });
    assert.equal(draft.name, "Fix login flake");
    assert.equal(draft.phases.length, 3);
    assert.equal(draft.phases[0].name, "repro");
    assert.equal(draft.phases[1].agentCount, 2);
    assert.equal(draft.phases[1].provider, "grok");
    assert.equal(draft.phases[1].model, "grok-4");
  });

  it("falls back when fm returns garbage instead of an invalid template", async () => {
    const th = thread();
    const prompt = "Ship the release checklist";
    const store = makeStore(th, firstUser(prompt));
    const bin = writeFakeFm(tmpDir, `console.log("lol not json at all");`);
    const draft = await distillThread(store, th.id, {
      env: { ...process.env, CODER_FM_BIN: bin },
    });
    const expected = fallbackDistill(th, firstUser(prompt));
    assert.deepEqual(draft, expected);
    assertDraft(draft, { provider: "claude", model: "opus" });
  });

  it("falls back when fm JSON has no usable phases", async () => {
    const th = thread();
    const store = makeStore(th, firstUser("Do a thing"));
    const junk = { name: "Empty", phases: [{ name: "", instruction: "" }] };
    const bin = writeFakeFm(
      tmpDir,
      `console.log(${JSON.stringify(JSON.stringify(junk))});`,
    );
    const draft = await distillThread(store, th.id, {
      env: { ...process.env, CODER_FM_BIN: bin },
    });
    assert.equal(draft.phases[0].name, "repeat");
    assert.match(draft.phases[0].instruction, /Do a thing/);
  });

  it("does not reject when the injected fmRun throws", async () => {
    const th = thread();
    const store = makeStore(th, firstUser("Do a thing"));
    const draft = await distillThread(store, th.id, {
      fmRun: async () => {
        throw new Error("fm exploded");
      },
    });
    assert.equal(draft.phases[0].name, "repeat");
  });

  it("rejects an unknown thread", async () => {
    const store = makeStore(thread(), []);
    await assert.rejects(
      () => distillThread(store, "missing", { env: { CODER_FM_BIN: "/nope/fm" } }),
      /Unknown thread/,
    );
  });
});

describe("parseDistilled", () => {
  const th = thread();

  it("accepts fenced JSON and stamps the thread provider/model", () => {
    const raw = "Sure.\n```json\n" + JSON.stringify(WELL_FORMED) + "\n```\n";
    const draft = parseDistilled(raw, th);
    assert.equal(draft.name, "Fix login flake");
    assert.equal(draft.phases.length, 3);
    assert.equal(draft.phases[0].provider, "claude");
    assert.equal(draft.phases[0].model, "opus");
  });

  it("clamps a wild agentCount rather than rejecting the template", () => {
    const raw = JSON.stringify({
      name: "Clamp me",
      phases: [
        { name: "one", agentCount: 99, instruction: "Do the work." },
        { name: "two", agentCount: 0, instruction: "Check the work." },
      ],
    });
    const draft = parseDistilled(raw, th);
    assert.equal(draft.phases[0].agentCount, 4);
    assert.equal(draft.phases[1].agentCount, 1);
  });

  it("returns null for non-JSON", () => {
    assert.equal(parseDistilled("not json", th), null);
    assert.equal(parseDistilled(null, th), null);
    assert.equal(parseDistilled("", th), null);
  });
});

describe("save-ready shape", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-distill-save-"));
    store = new Store(path.join(tmpDir, "store.json"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fallback and parsed drafts survive workflows.save", async () => {
    const th = thread({ model: null });
    const messages = firstUser("Fix the flaky login test");
    const fallback = fallbackDistill(th, messages);
    const parsed = parseDistilled(JSON.stringify(WELL_FORMED), th);
    const savedFallback = services.saveTemplate(store, fallback);
    const savedParsed = services.saveTemplate(store, parsed);
    assert.equal(savedFallback.phases[0].name, "repeat");
    assert.equal(savedParsed.phases.length, 3);
    assert.equal(savedParsed.phases[0].provider, "claude");
    assert.equal(savedParsed.phases[0].model, null);
  });
});

describe("threads:distill IPC", () => {
  it("returns a draft and does not persist a template", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-distill-ipc-"));
    const prevDisable = process.env.CODER_FM_DISABLE;
    process.env.CODER_FM_DISABLE = "1";
    try {
      const store = new Store(path.join(tmpDir, "store.json"));
      const repo = path.join(tmpDir, "repo");
      fs.mkdirSync(repo);
      store.setProjects([
        { id: "p1", slug: "p1", name: "p1", path: repo },
      ]);
      const created = services.createThread(store, {
        projectId: "p1",
        title: "Ship checklist",
      });
      store.appendMessage(created.id, {
        id: "m-user",
        role: "user",
        text: "Walk the release checklist",
        createdAt: Date.now(),
      });
      const before = store.listTemplates().length;
      const draft = await IPC_HANDLERS["threads:distill"](
        { store },
        { threadId: created.id },
      );
      assertDraft(draft, {
        provider: created.provider,
        model: created.model,
      });
      assert.equal(store.listTemplates().length, before);
      assert.equal(typeof IPC_HANDLERS["runs:distill"], "function");
    } finally {
      if (prevDisable === undefined) delete process.env.CODER_FM_DISABLE;
      else process.env.CODER_FM_DISABLE = prevDisable;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
