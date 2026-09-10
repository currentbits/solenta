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
  sessionIdForResume,
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

  it("registers claude, codex, grok, opencode, kimi, cursor, muse with expected kinds and models", () => {
    const ids = PROVIDERS.map((p) => p.id);
    assert.deepEqual(ids, [
      "claude",
      "codex",
      "grok",
      "opencode",
      "kimi",
      "cursor",
      "muse",
    ]);

    const claude = getProvider("claude");
    assert.equal(claude.kind, "claude-stream");
    assert.equal(claude.supportsResume, true);
    assert.equal(claude.supportsSteer, true);
    assert.ok(claude.models.includes("claude-opus-5"));
    assert.ok(claude.models.includes("claude-haiku-4-5"));

    const codex = getProvider("codex");
    assert.equal(codex.kind, "codex-json");
    assert.equal(codex.supportsResume, true);
    assert.equal(codex.supportsSteer, true);
    assert.equal(codex.sessionPinsModel, undefined);
    assert.ok(codex.models.includes("gpt-5.5"));
    assert.ok(codex.models.includes("gpt-6-astra"));
    assert.ok(codex.models.includes("gpt-5.6-sol"));
    assert.ok(codex.models.includes("gpt-5.6-terra"));
    assert.ok(codex.models.includes("gpt-5.3-codex-spark"));
    assert.equal(codex.models.includes("gpt-5.4-mini"), false);
    assert.ok(codex.models.length >= 5);
    const astra = codex.modelInfo.find((m) => m.id === "gpt-6-astra");
    assert.equal(astra.recommended, true);
    assert.equal(astra.contextTokens, 272_000);
    const sol = codex.modelInfo.find((m) => m.id === "gpt-5.6-sol");
    assert.equal(sol.recommended, undefined);
    assert.equal(sol.contextTokens, 272_000);
    const codexSpark = codex.modelInfo.find(
      (m) => m.id === "gpt-5.3-codex-spark",
    );
    assert.equal(codexSpark.contextTokens, 128_000);

    const grok = getProvider("grok");
    assert.equal(grok.kind, "claude-stream");
    assert.equal(grok.supportsResume, true);
    assert.deepEqual(grok.models, ["grok-4.6", "grok-4.5"]);

    const opencode = getProvider("opencode");
    assert.equal(opencode.kind, "opencode-json");
    assert.equal(opencode.supportsResume, true);
    assert.ok(opencode.models.includes("opencode/nemotron-3.5-lightning-free"));
    assert.ok(opencode.models.includes("opencode/ling-3.0-flash-fin-free"));
    assert.ok(
      opencode.models.includes("opencode/muse-spark-1.2-contributor-free"),
    );
    assert.ok(
      opencode.models.includes("opencode/muse-spark-1.3-contributor-free"),
    );
    assert.ok(!opencode.models.includes("opencode/hy3-free"));
    assert.ok(!opencode.models.includes("opencode/north-mini-code-free"));
    assert.ok(!opencode.models.includes("opencode/deepseek-v4-flash-free"));
    assert.ok(!opencode.models.includes("opencode/laguna-s-2.1-free"));
    assert.ok(opencode.models.length >= 4);
    const spark13 = opencode.modelInfo.find(
      (m) => m.id === "opencode/muse-spark-1.3-contributor-free",
    );
    assert.equal(spark13.recommended, true);
    assert.deepEqual(spark13.efforts, ["low", "medium", "high", "xhigh"]);
    // opencode -m requires provider/model form
    for (const id of opencode.models) {
      assert.ok(
        id.includes("/"),
        `opencode model id must be provider/model, got ${id}`,
      );
    }

    const kimi = getProvider("kimi");
    assert.equal(kimi.kind, "kimi-stream");
    assert.equal(kimi.supportsResume, true);
    assert.equal(kimi.name, "Kimi Code");
    assert.deepEqual(kimi.models, [
      "kimi-code/k3",
      "kimi-code/k3-256k",
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
    ]);

    const cursor = getProvider("cursor");
    assert.equal(cursor.kind, "cursor-stream");
    assert.equal(cursor.supportsResume, true);
    assert.equal(cursor.name, "Cursor");
    assert.ok(cursor.models.includes("auto"));
    assert.ok(cursor.models.includes("composer-2.5"));
    assert.ok(cursor.models.includes("claude-fable-5-1-high"));
    assert.ok(cursor.models.includes("gemini-3.8-flash-high"));
    assert.ok(!cursor.models.some((id) => id.startsWith("cursor-grok-4.5-")));
    assert.equal(cursor.models.length, 211);
    assert.equal(cursor.modelInfo[0].id, cursor.models[0]);
    // Live cursor-agent 2026.09.02-c22c1a3 --list-models has no Astra /
    // gpt-6-* rows. Effort is baked into Cursor ids; do not invent
    // gpt-6-astra-high style slugs the CLI does not print (#886).
    const inventedAstra = cursor.models.filter(
      (id) => /astra/i.test(id) || id.startsWith("gpt-6"),
    );
    assert.deepEqual(inventedAstra, []);
    assert.equal(
      cursor.modelInfo.some(
        (m) => /astra/i.test(m.id) || m.id.startsWith("gpt-6"),
      ),
      false,
    );

    const muse = getProvider("muse");
    assert.equal(muse.kind, "muse-json");
    assert.equal(muse.name, "Muse Code");
    assert.equal(muse.defaultBin, "muse");
    assert.equal(muse.binEnv, "CODER_MUSE_BIN");
    assert.equal(muse.supportsResume, true);
    assert.deepEqual(muse.models, ["muse-spark-1.3", "muse-spark-1.2"]);
    assert.deepEqual(muse.permissionModes, ["default", "bypassPermissions"]);
    assert.deepEqual(muse.efforts, ["low", "medium", "high", "xhigh", "ultra"]);
    const spark = muse.modelInfo.find((m) => m.id === "muse-spark-1.3");
    assert.equal(spark.recommended, true);
    assert.equal(spark.contextTokens, 1_048_576);
    assert.equal(spark.vendor, "Meta");
  });

  it("marks Codex Spark text-only; Astra/Sol/Terra/Luna/5.5 take images (#1167)", () => {
    // Live ~/.codex/models_cache.json (client 0.153.4): Spark
    // input_modalities is ["text"]; the others are ["text","image"].
    // Do not invent image support for Spark. Cursor gpt-5.4-mini-* ids
    // are a different catalog. Codex gpt-5.4-mini (if still listed) stays
    // unset — do not invent true or false.
    const codex = getProvider("codex");
    const byId = Object.fromEntries(
      (codex.modelInfo || []).map((m) => [m.id, m]),
    );
    assert.ok(
      !(byId["gpt-5.3-codex-spark"].inputModalities || []).includes("image"),
      "Spark input_modalities are text-only (#1167)",
    );
    for (const id of [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]) {
      assert.ok(
        (byId[id].inputModalities || []).includes("image"),
        `${id} lists text+image`,
      );
    }
  });

  it("every provider model has matching modelInfo in the same order with non-empty fields", () => {
    // Gate for the picker: models[i] and modelInfo[i] must be the same id in
    // the same order, and label/description/vendor must be non-empty strings.
    // Empty lists are honest when unverified; a non-empty list that mislabels
    // is not. Cardinality is asserted before the loop so deleting the whole
    // registry cannot pass silently.
    assert.ok(PROVIDERS.length >= 6, "expected six public providers");
    for (const entry of PROVIDERS) {
      assert.ok(Array.isArray(entry.models), `${entry.id}: models array`);
      assert.ok(Array.isArray(entry.modelInfo), `${entry.id}: modelInfo array`);
      assert.equal(
        entry.modelInfo.length,
        entry.models.length,
        `${entry.id}: modelInfo length must match models (got ${entry.modelInfo.length} vs ${entry.models.length})`,
      );
      // Every interactive provider we ship must expose at least one model so
      // the picker is not a bare text field. Update this if a provider is
      // deliberately left empty after verification fails.
      assert.ok(
        entry.models.length > 0,
        `${entry.id}: models must not be empty (picker would have nothing to pick)`,
      );
      for (let i = 0; i < entry.models.length; i++) {
        const id = entry.models[i];
        const info = entry.modelInfo[i];
        assert.equal(
          info.id,
          id,
          `${entry.id}: modelInfo[${i}].id (${info.id}) must equal models[${i}] (${id})`,
        );
        assert.equal(typeof info.label, "string", `${entry.id}/${id} label type`);
        assert.ok(
          info.label.trim().length > 0,
          `${entry.id}/${id}: empty label`,
        );
        assert.equal(
          typeof info.description,
          "string",
          `${entry.id}/${id} description type`,
        );
        assert.ok(
          info.description.trim().length > 0,
          `${entry.id}/${id}: empty description`,
        );
        assert.equal(
          typeof info.vendor,
          "string",
          `${entry.id}/${id} vendor type`,
        );
        assert.ok(
          info.vendor.trim().length > 0,
          `${entry.id}/${id}: empty vendor`,
        );
      }
      const recommended = entry.modelInfo.filter((m) => m.recommended);
      assert.ok(
        recommended.length <= 1,
        `${entry.id}: at most one recommended model`,
      );
    }
  });

  it("cursor snapshot does not invent Astra ids and copies live Fable 5.1 / Gemini 3.8 labels", () => {
    const cursor = getProvider("cursor");
    assert.ok(
      !cursor.models.some(
        (id) => /astra/i.test(id) || id.startsWith("gpt-6-") || id.includes("gpt-6-"),
      ),
      "cursor-agent 2026.09.02-c22c1a3 does not list Astra / gpt-6-*; do not invent them",
    );
    const fable = cursor.modelInfo.find((m) => m.id === "claude-fable-5-1-high");
    assert.equal(fable.label, "Claude Fable 5.1 1M (NO ZDR)");
    assert.equal(fable.description, fable.label);
    assert.equal(fable.vendor, "Anthropic");
    assert.equal(fable.contextTokens, 1000000);
    const gemini = cursor.modelInfo.find((m) => m.id === "gemini-3.8-flash-high");
    assert.equal(gemini.label, "Gemini 3.8 Flash High");
    assert.equal(gemini.description, gemini.label);
    assert.equal(gemini.vendor, "Google");
    assert.equal(gemini.contextTokens, undefined);
  });

  it("buildArgs: claude matches stream-json flags and adds --model when set", () => {
    const args = getProvider("claude").buildArgs({
      prompt: "hi",
      permissionMode: "plan",
      model: "claude-sonnet-5",
    });
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("stream-json"));
    assert.ok(args.includes("--input-format"));
    assert.ok(args.includes("--permission-prompt-tool"));
    assert.ok(args.includes("stdio"));
    assert.ok(args.includes("--permission-mode"));
    assert.ok(args.includes("plan"));
    const modelIdx = args.indexOf("--model");
    assert.ok(modelIdx >= 0);
    assert.equal(args[modelIdx + 1], "claude-sonnet-5");
    // Prompt travels over stdin (interactive mode), never argv.
    assert.ok(!args.includes("hi"));
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
    assert.equal(
      fresh[fresh.indexOf("--sandbox") + 1],
      "workspace-write",
      "fresh exec still needs --sandbox (issue #170)",
    );

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
    assert.ok(
      !resume.includes("--sandbox"),
      "codex exec resume rejects --sandbox (issue #795)",
    );
    assert.ok(resume.includes("--json"));
    assert.ok(
      resume.includes("--skip-git-repo-check"),
      "resume path should match fresh skip-git flag",
    );
    assert.equal(resume[resume.length - 1], "p3");
    const blob = fresh.join("\0");
    assert.equal(
      blob.includes("on-request"),
      false,
      "exec --json stays never-policy; interactive on-request is app-server JSON-RPC only",
    );
    assert.equal(blob.includes("approval_policy"), false);
    assert.equal(fresh.includes("app-server"), false);
    assert.equal(resume.join("\0").includes("on-request"), false);
  });

  it("buildArgs: Codex -i images after exec, before prompt; Spark is text-only (#176)", () => {
    const entry = getProvider("codex");
    const imgA = "/tmp/a.png";
    const imgB = "/tmp/b.png";
    const astra = entry.buildArgs({
      prompt: "look",
      model: "gpt-6-astra",
      images: [imgA, imgB],
    });
    assert.equal(astra[0], "exec");
    const iIdx = astra.indexOf("-i");
    assert.ok(iIdx > 0, `expected -i after exec: ${JSON.stringify(astra)}`);
    assert.ok(
      iIdx < astra.length - 1,
      `-i must sit before trailing prompt: ${JSON.stringify(astra)}`,
    );
    assert.equal(astra[iIdx + 1], imgA);
    assert.equal(astra[iIdx + 2], imgB);
    assert.ok(
      String(astra[iIdx + 3] || "").startsWith("-"),
      `image paths must be followed by a flag so FILE... cannot swallow the prompt: ${JSON.stringify(astra)}`,
    );
    assert.equal(astra[astra.length - 1], "look");
    assert.ok(!String(astra[astra.length - 1]).includes(imgA));

    const resume = entry.buildArgs({
      prompt: "again",
      sessionId: "sess-codex-9",
      model: "gpt-5.6-sol",
      images: [imgA],
    });
    assert.equal(resume[0], "exec");
    assert.equal(resume[1], "resume");
    const resumeI = resume.indexOf("-i");
    assert.ok(resumeI > resume.indexOf("exec"));
    assert.equal(resume[resumeI + 1], imgA);
    assert.ok(resumeI < resume.length - 1);
    assert.equal(resume[resume.length - 1], "again");

    const spark = entry.buildArgs({
      prompt: "look",
      model: "gpt-5.3-codex-spark",
      images: [imgA],
    });
    assert.ok(
      !spark.includes("-i"),
      `Spark is text-only and must not get -i: ${JSON.stringify(spark)}`,
    );
    assert.equal(spark[spark.length - 1], "look");
    assert.ok(!spark.includes(imgA));

    const sparkInfo = entry.modelInfo.find((m) => m.id === "gpt-5.3-codex-spark");
    assert.ok(sparkInfo);
    assert.ok(
      !(sparkInfo.inputModalities || []).includes("image"),
      "Spark input_modalities are text-only (#1167)",
    );
    for (const id of [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]) {
      const info = entry.modelInfo.find((m) => m.id === id);
      assert.ok(info, id);
      assert.ok(
        (info.inputModalities || []).includes("image"),
        `${id} lists text+image`,
      );
    }
  });

  it("buildArgs: grok claude-stream and opencode-json shapes", () => {
    const grokArgs = getProvider("grok").buildArgs({
      prompt: "hello",
      permissionMode: "default",
    });
    // Prompt is the last argv element (-p/--single value).
    assert.equal(grokArgs[grokArgs.length - 2], "-p");
    assert.equal(grokArgs[grokArgs.length - 1], "hello");
    assert.ok(grokArgs.includes("streaming-messages-json"));
    assert.ok(grokArgs.includes("--permission-mode"));
    assert.equal(
      grokArgs[grokArgs.indexOf("--permission-mode") + 1],
      "bypassPermissions",
    );
    assert.ok(grokArgs.includes("--always-approve"));
    assert.ok(!grokArgs.includes("auto"));
    assert.ok(!grokArgs.includes("--verbose"));
    assert.ok(grokArgs.includes("--include-partial-messages"));
    assert.ok(!grokArgs.some((a) => String(a).startsWith("--mcp-config")));

    const grokResume = getProvider("grok").buildArgs({
      prompt: "again",
      sessionId: "g-sess",
      model: "grok-4.6",
      permissionMode: "plan",
    });
    assert.equal(grokResume[grokResume.indexOf("--resume") + 1], "g-sess");
    assert.equal(grokResume[grokResume.indexOf("-m") + 1], "grok-4.6");
    assert.equal(
      grokResume[grokResume.indexOf("--permission-mode") + 1],
      "plan",
    );
    assert.equal(grokResume[grokResume.length - 1], "again");

    assert.deepEqual(getProvider("opencode").buildArgs({ prompt: "hello" }), [
      "run",
      "--format",
      "json",
      "--thinking",
      "hello",
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
    assert.equal(resume[resume.length - 1], "again");
  });

  it("buildArgs: cursor stream-json, prompt last, plan drops --force", () => {
    const args = getProvider("cursor").buildArgs({
      prompt: "hi cursor",
      model: "composer-2.5",
      sessionId: "sess-cursor-1",
      permissionMode: "default",
      reasoningEffort: "high",
    });
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("stream-json"));
    assert.ok(args.includes("--stream-partial-output"));
    assert.ok(args.includes("--trust"));
    assert.ok(args.includes("--force"));
    assert.ok(args.includes("--approve-mcps"));
    assert.equal(args[args.length - 1], "hi cursor");
    const modelIdx = args.indexOf("--model");
    assert.ok(modelIdx >= 0);
    assert.equal(args[modelIdx + 1], "composer-2.5");
    const resumeIdx = args.indexOf("--resume");
    assert.ok(resumeIdx >= 0);
    assert.equal(args[resumeIdx + 1], "sess-cursor-1");
    assert.ok(!args.includes("--worktree"));
    assert.ok(!args.includes("--effort"));
    assert.ok(!args.includes("--reasoning-effort"));

    const plan = getProvider("cursor").buildArgs({
      prompt: "plan it",
      permissionMode: "plan",
    });
    assert.ok(plan.includes("--mode"));
    assert.equal(plan[plan.indexOf("--mode") + 1], "plan");
    assert.ok(!plan.includes("--force"));
    assert.equal(plan[plan.length - 1], "plan it");
    assert.ok(!plan.includes("--worktree"));
    assert.ok(!plan.includes("--effort"));
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
    assert.equal(list.length, 7);
    assert.equal(list.find((p) => p.id === "claude").available, true);
    assert.equal(list.find((p) => p.id === "codex").available, false);
    assert.equal(list.find((p) => p.id === "grok").available, true);
    assert.equal(list.find((p) => p.id === "opencode").available, false);
    assert.equal(list.find((p) => p.id === "kimi").available, false);
    assert.equal(list.find((p) => p.id === "cursor").available, false);
    assert.equal(list.find((p) => p.id === "muse").available, false);
    assert.ok(!list.some((p) => p.id === "simulate"));
  });

  it("Codex snapshots inputModalities from the live cache (issue #1167)", () => {
    const codex = getProvider("codex");
    const byId = Object.fromEntries(codex.modelInfo.map((m) => [m.id, m]));
    assert.deepEqual(byId["gpt-6-astra"].inputModalities, ["text", "image"]);
    assert.deepEqual(byId["gpt-5.6-sol"].inputModalities, ["text", "image"]);
    assert.deepEqual(byId["gpt-5.6-terra"].inputModalities, ["text", "image"]);
    assert.deepEqual(byId["gpt-5.6-luna"].inputModalities, ["text", "image"]);
    assert.deepEqual(byId["gpt-5.5"].inputModalities, ["text", "image"]);
    assert.deepEqual(byId["gpt-5.3-codex-spark"].inputModalities, ["text"]);
    // Retired gpt-5.4-mini is not in the live list; do not invent image support.
    if (byId["gpt-5.4-mini"]) {
      assert.equal(byId["gpt-5.4-mini"].inputModalities, undefined);
    }

    const listed = listProviders({
      which: () => null,
      env: {},
      includeSimulate: false,
    }).find((p) => p.id === "codex");
    const spark = listed.modelInfo.find((m) => m.id === "gpt-5.3-codex-spark");
    const astra = listed.modelInfo.find((m) => m.id === "gpt-6-astra");
    assert.deepEqual(spark.inputModalities, ["text"]);
    assert.deepEqual(astra.inputModalities, ["text", "image"]);
  });

  it("listProviders advertises supportsSteer for Claude and Codex", () => {
    const which = () => null;
    const list = listProviders({ which, env: {}, includeSimulate: true });
    assert.equal(list.find((p) => p.id === "claude").supportsSteer, true);
    assert.equal(list.find((p) => p.id === "codex").supportsSteer, true);
    for (const id of ["grok", "opencode", "kimi", "cursor", "muse", "simulate"]) {
      assert.equal(
        list.find((p) => p.id === id).supportsSteer,
        false,
        `${id} must not advertise live-turn steering`,
      );
    }
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

describe("sessionIdForResume (#1020)", () => {
  const codex = getProvider("codex");
  const claude = getProvider("claude");

  it("keeps Codex resume across a model-only change (turn/start.model sticks)", () => {
    const thread = {
      sessionId: "sess-sol",
      model: "gpt-6-astra",
      ejected: false,
    };
    assert.equal(
      sessionIdForResume(codex, thread, { model: "gpt-5.6-sol" }),
      "sess-sol",
    );
    assert.equal(
      sessionIdForResume(codex, thread, { model: "gpt-6-astra" }),
      "sess-sol",
    );
  });

  it("keeps Claude resume across a model-only change", () => {
    assert.equal(
      sessionIdForResume(
        claude,
        { sessionId: "sess-1", model: "claude-sonnet-5" },
        { model: "claude-opus-5" },
      ),
      "sess-1",
    );
  });

  it("never resumes an ejected thread", () => {
    assert.equal(
      sessionIdForResume(
        codex,
        { sessionId: "sess-sol", model: "gpt-6-astra", ejected: true },
        { model: "gpt-6-astra" },
      ),
      null,
    );
  });

  it("keeps Codex resume when picker differs from sessionStartModel (turn/start.model)", () => {
    // Interactive app-server honors turn/start.model. sessionPinsModel is
    // unset, so a picker switch keeps the session. exec resume still
    // hydrates the original rollout; ejectCommand notes that separately.
    assert.equal(
      sessionIdForResume(
        codex,
        {
          sessionId: "sess-sol",
          model: "gpt-6-astra",
          sessionStartModel: "gpt-5.6-sol",
          ejected: false,
        },
        { model: "gpt-6-astra" },
      ),
      "sess-sol",
    );
  });

  it("sessionPinsModel providers skip resume when picker differs from sessionStartModel", () => {
    const pinned = { ...codex, sessionPinsModel: true };
    assert.equal(
      sessionIdForResume(
        pinned,
        {
          sessionId: "sess-sol",
          model: "gpt-6-astra",
          sessionStartModel: "gpt-5.6-sol",
          ejected: false,
        },
        { model: "gpt-6-astra" },
      ),
      null,
    );
  });
});
