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

  it("registers claude, codex, grok, opencode, kimi with expected kinds and models", () => {
    const ids = PROVIDERS.map((p) => p.id);
    assert.deepEqual(ids, ["claude", "codex", "grok", "opencode", "kimi"]);

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
    assert.equal(grok.kind, "claude-stream");
    assert.equal(grok.supportsResume, true);
    assert.deepEqual(grok.models, ["grok-4.5"]);

    const opencode = getProvider("opencode");
    assert.equal(opencode.kind, "opencode-json");
    assert.equal(opencode.supportsResume, true);

    const kimi = getProvider("kimi");
    assert.equal(kimi.kind, "kimi-stream");
    assert.equal(kimi.supportsResume, true);
    assert.equal(kimi.name, "Kimi Code");
    assert.deepEqual(kimi.models, [
      "k3",
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
    ]);
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

  it("buildArgs: grok claude-stream and opencode-json shapes", () => {
    const grokArgs = getProvider("grok").buildArgs({
      prompt: "hello",
      permissionMode: "default",
    });
    assert.equal(grokArgs[0], "-p");
    assert.equal(grokArgs[1], "hello");
    assert.ok(grokArgs.includes("streaming-messages-json"));
    assert.ok(grokArgs.includes("--permission-mode"));
    assert.ok(!grokArgs.includes("--verbose"));
    assert.ok(!grokArgs.some((a) => String(a).startsWith("--mcp-config")));

    const grokResume = getProvider("grok").buildArgs({
      prompt: "again",
      sessionId: "g-sess",
      model: "grok-4.5",
      permissionMode: "plan",
    });
    assert.equal(grokResume[grokResume.indexOf("--resume") + 1], "g-sess");
    assert.equal(grokResume[grokResume.indexOf("-m") + 1], "grok-4.5");
    assert.equal(
      grokResume[grokResume.indexOf("--permission-mode") + 1],
      "plan",
    );

    assert.deepEqual(getProvider("opencode").buildArgs({ prompt: "hello" }), [
      "run",
      "hello",
      "--format",
      "json",
    ]);
    const resume = getProvider("opencode").buildArgs({
      prompt: "again",
      sessionId: "ses_abc",
      model: "openai/gpt-4o",
    });
    assert.ok(resume.includes("-s"));
    assert.equal(resume[resume.indexOf("-s") + 1], "ses_abc");
    assert.ok(resume.includes("-m"));
    assert.equal(resume[resume.indexOf("-m") + 1], "openai/gpt-4o");
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
    assert.equal(list.length, 5);
    assert.equal(list.find((p) => p.id === "claude").available, true);
    assert.equal(list.find((p) => p.id === "codex").available, false);
    assert.equal(list.find((p) => p.id === "grok").available, true);
    assert.equal(list.find((p) => p.id === "opencode").available, false);
    assert.equal(list.find((p) => p.id === "kimi").available, false);
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

  it("isBinAvailable threads env into default which PATH lookup", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-prov-path-"));
    try {
      const binName = "coder-prov-envbin";
      const binPath = path.join(tmp, binName);
      fs.writeFileSync(binPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });
      // Prepend tmp to PATH so which can resolve the bare name from env only.
      const envHit = {
        ...process.env,
        PATH: `${tmp}${path.delimiter}${process.env.PATH || ""}`,
      };
      const envMiss = {
        ...process.env,
        PATH: `/nonexistent-coder-path${path.delimiter}/usr/bin`,
      };
      assert.equal(isBinAvailable(binName, undefined, envHit), true);
      assert.equal(isBinAvailable(binName, undefined, envMiss), false);
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
