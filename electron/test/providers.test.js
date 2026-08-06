const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PROVIDERS,
  getProvider,
  resolveBin,
  isBinAvailable,
  listProviders,
} = require("../providers.js");

describe("providers registry", () => {
  let prevSimulate;
  let prevClaude;
  let prevCodex;
  let prevGrok;
  let prevOpencode;

  beforeEach(() => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevClaude = process.env.CODER_CLAUDE_BIN;
    prevCodex = process.env.CODER_CODEX_BIN;
    prevGrok = process.env.CODER_GROK_BIN;
    prevOpencode = process.env.CODER_OPENCODE_BIN;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_CLAUDE_BIN;
    delete process.env.CODER_CODEX_BIN;
    delete process.env.CODER_GROK_BIN;
    delete process.env.CODER_OPENCODE_BIN;
  });

  afterEach(() => {
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevClaude === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevClaude;
    if (prevCodex === undefined) delete process.env.CODER_CODEX_BIN;
    else process.env.CODER_CODEX_BIN = prevCodex;
    if (prevGrok === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrok;
    if (prevOpencode === undefined) delete process.env.CODER_OPENCODE_BIN;
    else process.env.CODER_OPENCODE_BIN = prevOpencode;
  });

  it("registers claude, codex, grok, opencode with expected kinds and models", () => {
    const ids = PROVIDERS.map((p) => p.id);
    assert.deepEqual(ids, ["claude", "codex", "grok", "opencode"]);

    const claude = getProvider("claude");
    assert.equal(claude.kind, "claude-stream");
    assert.equal(claude.supportsResume, true);
    assert.ok(claude.models.includes("claude-opus-5"));
    assert.ok(claude.models.includes("claude-haiku-4-5"));

    const codex = getProvider("codex");
    assert.equal(codex.kind, "codex-json");
    assert.equal(codex.supportsResume, true);
    assert.deepEqual(codex.models, []);

    const grok = getProvider("grok");
    assert.equal(grok.kind, "text");
    assert.equal(grok.supportsResume, false);

    const opencode = getProvider("opencode");
    assert.equal(opencode.kind, "text");
    assert.equal(opencode.supportsResume, false);
  });

  it("buildArgs: claude matches stream-json flags and adds --model when set", () => {
    const args = getProvider("claude").buildArgs({
      prompt: "hi",
      permissionMode: "plan",
      model: "claude-sonnet-5",
    });
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("stream-json"));
    assert.ok(args.includes("--permission-mode"));
    assert.ok(args.includes("plan"));
    const modelIdx = args.indexOf("--model");
    assert.ok(modelIdx >= 0);
    assert.equal(args[modelIdx + 1], "claude-sonnet-5");
    assert.equal(args[args.length - 1], "hi");
    assert.ok(!args.includes("--resume"));
  });

  it("buildArgs: claude adds --resume when sessionId set", () => {
    const args = getProvider("claude").buildArgs({
      prompt: "again",
      sessionId: "sess-1",
      permissionMode: "default",
    });
    const idx = args.indexOf("--resume");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "sess-1");
  });

  it("buildArgs: codex fresh and resume shapes", () => {
    const fresh = getProvider("codex").buildArgs({ prompt: "p1" });
    assert.deepEqual(fresh.slice(0, 3), [
      "exec",
      "--json",
      "--skip-git-repo-check",
    ]);
    assert.equal(fresh[fresh.length - 1], "p1");

    const withModel = getProvider("codex").buildArgs({
      prompt: "p2",
      model: "o3",
    });
    const mIdx = withModel.indexOf("-m");
    assert.ok(mIdx >= 0);
    assert.equal(withModel[mIdx + 1], "o3");

    const resume = getProvider("codex").buildArgs({
      prompt: "p3",
      sessionId: "sess-codex-9",
    });
    assert.equal(resume[0], "exec");
    assert.equal(resume[1], "resume");
    assert.equal(resume[2], "sess-codex-9");
    assert.ok(resume.includes("--json"));
    assert.ok(
      resume.includes("--skip-git-repo-check"),
      "resume path should match fresh skip-git flag",
    );
    assert.equal(resume[resume.length - 1], "p3");
  });

  it("buildArgs: grok and opencode text shapes", () => {
    assert.deepEqual(getProvider("grok").buildArgs({ prompt: "hello" }), [
      "-p",
      "hello",
    ]);
    assert.deepEqual(getProvider("opencode").buildArgs({ prompt: "hello" }), [
      "run",
      "hello",
    ]);
  });

  it("resolveBin uses env overrides", () => {
    const claude = getProvider("claude");
    assert.equal(resolveBin(claude, {}), "claude");
    assert.equal(
      resolveBin(claude, { CODER_CLAUDE_BIN: "/tmp/fake-claude" }),
      "/tmp/fake-claude",
    );
    assert.equal(
      resolveBin(getProvider("codex"), { CODER_CODEX_BIN: "/x/codex" }),
      "/x/codex",
    );
  });

  it("listProviders availability via injected which (PATH-less)", () => {
    const which = (bin) => (bin === "claude" || bin === "grok" ? bin : null);
    const list = listProviders({ which, env: {}, includeSimulate: false });
    assert.equal(list.length, 4);
    assert.equal(list.find((p) => p.id === "claude").available, true);
    assert.equal(list.find((p) => p.id === "codex").available, false);
    assert.equal(list.find((p) => p.id === "grok").available, true);
    assert.equal(list.find((p) => p.id === "opencode").available, false);
    assert.ok(!list.some((p) => p.id === "simulate"));
  });

  it("listProviders includes simulate only when CODER_SIMULATE=1", () => {
    const which = () => null;
    const without = listProviders({
      which,
      env: {},
      includeSimulate: false,
    });
    assert.ok(!without.some((p) => p.id === "simulate"));

    const withSim = listProviders({
      which,
      env: { CODER_SIMULATE: "1" },
    });
    assert.ok(withSim.some((p) => p.id === "simulate"));
    const sim = withSim.find((p) => p.id === "simulate");
    assert.equal(sim.available, true);
    assert.equal(sim.supportsResume, false);
  });

  it("isBinAvailable with absolute path uses existsSync, not PATH", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-prov-"));
    try {
      const bin = path.join(tmp, "mybin");
      fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
      assert.equal(isBinAvailable(bin, () => null), true);
      assert.equal(
        isBinAvailable(path.join(tmp, "missing"), () => null),
        false,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("listProviders re-checks availability each call (not process-lifetime cache)", () => {
    let available = true;
    const which = (bin) => (bin === "claude" && available ? bin : null);
    const a = listProviders({ which, env: {}, includeSimulate: false });
    assert.equal(a.find((p) => p.id === "claude").available, true);
    available = false;
    const b = listProviders({ which, env: {}, includeSimulate: false });
    assert.equal(b.find((p) => p.id === "claude").available, false);
  });
});
