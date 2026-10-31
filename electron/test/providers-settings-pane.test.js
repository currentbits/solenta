"use strict";

// Settings › Providers (#1714): base-provider key env, OpenAI-compatible
// providers through opencode, model favourites/custom ids, live model fetch.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");
const inst = require("../providerInstances.js");
const providerAuth = require("../providerAuth.js");
const { fetchProviderModels, parseModels } = require("../providerModels.js");

const COMPAT = {
  id: "groq",
  name: "Groq",
  provider: "opencode",
  configDir: null,
  env: { [inst.OPENAI_COMPAT_KEY_ENV]: "gsk-secret" },
  openaiCompatible: {
    baseUrl: "https://api.groq.com/openai/v1/",
    modelsUrl: null,
    models: ["llama-4", "qwen-3"],
    defaultModel: "qwen-3",
    headers: { "X-Team": "core" },
  },
};

describe("base overlay env (#1714)", () => {
  it("accepts id === provider for providers whose runner applies it", () => {
    const [row] = inst.validateProviderInstances([
      { id: "cursor", name: "Cursor", provider: "cursor", env: { CURSOR_API_KEY: "k" } },
    ]);
    assert.equal(inst.isBaseOverlay(row), true);
    assert.throws(
      () => inst.validateProviderInstances([{ id: "kimi", name: "Kimi", provider: "kimi", env: {} }]),
      /not supported/,
    );
    // A named cursor instance is still not a thing.
    assert.throws(
      () => inst.validateProviderInstances([{ id: "work", name: "w", provider: "cursor", env: {} }]),
      /not supported/,
    );
  });

  it("rides base-provider threads only when the run is local", () => {
    const settings = {
      providerInstances: [
        { id: "claude", name: "Claude Code", provider: "claude", configDir: null, env: { ANTHROPIC_API_KEY: "sk-ant" } },
      ],
    };
    const thread = { provider: "claude", providerInstance: null };
    assert.deepEqual(inst.threadInstanceEnv(settings, thread, { local: true }), { ANTHROPIC_API_KEY: "sk-ant" });
    assert.equal(inst.threadInstanceEnv(settings, thread, { local: false }), undefined);
    assert.equal(inst.threadInstanceEnv(settings, thread), undefined, "opt-in, never by default");
    assert.equal(inst.threadInstanceEnv(settings, { provider: "codex" }, { local: true }), undefined);
  });
});

describe("OpenAI-compatible instances (#1714)", () => {
  it("validates the endpoint block", () => {
    const [row] = inst.validateProviderInstances([COMPAT]);
    assert.equal(row.openaiCompatible.defaultModel, "qwen-3");
    const bad = (patch) => () =>
      inst.validateProviderInstances([{ ...COMPAT, openaiCompatible: { ...COMPAT.openaiCompatible, ...patch } }]);
    assert.throws(bad({ baseUrl: "ftp://x" }), /Base URL/);
    assert.throws(bad({ models: [], modelsUrl: null }), /at least one model/);
    assert.throws(bad({ headers: { "bad header": "x" } }), /Invalid header/);
    assert.throws(
      () => inst.validateProviderInstances([{ ...COMPAT, openaiCompatible: undefined }]),
      /base URL/,
    );
    assert.throws(
      () => inst.validateProviderInstances([{ ...COMPAT, name: "OpenCode" }]),
      /reserved/,
    );
  });

  it("builds opencode's custom-provider config with the key as {env:}", () => {
    const cfg = inst.opencodeProviderConfig(COMPAT, ["extra-1"]);
    assert.deepEqual(cfg, {
      groq: {
        npm: "@ai-sdk/openai-compatible",
        name: "Groq",
        options: {
          baseURL: "https://api.groq.com/openai/v1/",
          apiKey: `{env:${inst.OPENAI_COMPAT_KEY_ENV}}`,
          headers: { "X-Team": "core" },
        },
        models: { "llama-4": { name: "llama-4" }, "qwen-3": { name: "qwen-3" }, "extra-1": { name: "extra-1" } },
      },
    });
    assert.equal(JSON.stringify(cfg).includes("gsk-secret"), false, "the key never lands in config JSON");
  });
});

describe("providerModels setting (#1714)", () => {
  it("keeps clean id lists, drops junk leniently, throws strictly", () => {
    assert.deepEqual(
      inst.parseProviderModels({ claude: { favorites: ["a", "a"], custom: [] }, x: { favorites: [] } }, false),
      { claude: { favorites: ["a"], custom: [] } },
    );
    assert.deepEqual(inst.parseProviderModels({ claude: { favorites: [3] } }, false), {});
    assert.throws(() => inst.parseProviderModels({ claude: { favorites: [3] } }, true), /favorites/);
  });
});

describe("provider list for Settings › Providers (#1714)", () => {
  let tmpDir;
  let store;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-providers-pane-"));
    store = new Store(path.join(tmpDir, "store.json"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hides base overlays, lists compat rows, applies custom ids and favourites", async () => {
    store.setSettings({
      providerInstances: [
        { id: "claude", name: "Claude Code", provider: "claude", configDir: null, env: { ANTHROPIC_API_KEY: "k" } },
        { id: "work", name: "work", provider: "claude", configDir: null, env: {} },
        COMPAT,
      ],
      providerModels: {
        claude: { favorites: ["my-custom"], custom: ["my-custom"] },
        "opencode:groq": { favorites: ["groq/qwen-3"], custom: [] },
      },
    });
    const list = await services.listProvidersForApi(store, { which: () => "/bin/true", env: {}, includeSimulate: false });
    assert.equal(list.some((p) => p.id === "claude:claude"), false);
    const claude = list.find((p) => p.id === "claude");
    assert.equal(claude.models[0], "my-custom", "favourite first");
    assert.equal(claude.modelInfo[0].id, "my-custom");
    assert.equal(claude.modelInfo[0].favorite, true, "marked so the composer picker can group it (#1802)");
    assert.equal(
      claude.modelInfo.find((m) => m.id === "claude-opus-5")?.favorite,
      undefined,
      "unstarred models stay unmarked",
    );
    const work = list.find((p) => p.id === "claude:work");
    assert.equal(work.models.includes("my-custom"), false, "prefs do not leak through shared arrays");
    const groq = list.find((p) => p.id === "opencode:groq");
    assert.equal(groq.name, "Groq");
    assert.deepEqual(groq.models, ["groq/qwen-3", "groq/llama-4"]);
    assert.equal(groq.modelInfo.find((m) => m.recommended)?.id, "groq/qwen-3");
    // The overlay probes as its base, not as a second row.
    assert.deepEqual(
      services.instanceAuthProbes(store).map((p) => p.ref),
      ["claude", "claude:work"],
    );
  });
});

describe("providerAuth logout (#1714)", () => {
  it("types the CLI's own logout command", () => {
    assert.equal(providerAuth.loginCommand("codex", { env: {}, logout: true }), "codex logout");
    assert.equal(providerAuth.loginCommand("claude", { env: {}, logout: true }), "claude auth logout");
    assert.equal(providerAuth.loginCommand("grok", { env: {}, logout: true }), null);
  });
});

describe("fetchProviderModels (#1714)", () => {
  const claudeSettings = (env) => ({
    providerInstances: [{ id: "claude", name: "Claude Code", provider: "claude", configDir: null, env }],
  });
  const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

  it("calls Anthropic /v1/models with x-api-key and anthropic-version", async () => {
    let seen;
    const models = await fetchProviderModels(
      claudeSettings({ ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_BASE_URL: "https://proxy.example/" }),
      "claude",
      {
        fetch: async (url, init) => {
          seen = { url, headers: init.headers };
          return ok({ data: [{ id: "claude-opus-5", display_name: "Opus 5", max_input_tokens: 1000000 }] })();
        },
      },
    );
    assert.equal(seen.url, "https://proxy.example/v1/models?limit=1000");
    assert.equal(seen.headers["x-api-key"], "sk-ant");
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    assert.deepEqual(models, [{ id: "claude-opus-5", label: "Opus 5", contextTokens: 1000000 }]);
  });

  it("calls {base}/models with a Bearer key and custom headers for a compat provider", async () => {
    let seen;
    await fetchProviderModels({ providerInstances: [COMPAT] }, "opencode:groq", {
      fetch: async (url, init) => {
        seen = { url, headers: init.headers };
        return ok([{ id: "llama-4" }])();
      },
    });
    assert.equal(seen.url, "https://api.groq.com/openai/v1/models");
    assert.equal(seen.headers.Authorization, "Bearer gsk-secret");
    assert.equal(seen.headers["X-Team"], "core");
  });

  it("explains a missing key, a rejected key, and a timeout", async () => {
    await assert.rejects(fetchProviderModels(claudeSettings({}), "claude", { fetch: ok({ data: [] }) }), /Add an API key/);
    await assert.rejects(fetchProviderModels({}, "cursor"), /no models endpoint/);
    await assert.rejects(
      fetchProviderModels(claudeSettings({ ANTHROPIC_API_KEY: "bad" }), "claude", {
        fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      }),
      /\(401\): the API key was rejected/,
    );
    await assert.rejects(
      fetchProviderModels(claudeSettings({ ANTHROPIC_API_KEY: "k" }), "claude", {
        timeoutMs: 20,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason));
          }),
      }),
      /did not answer within/,
    );
  });

  it("parses OpenAI {data}, bare arrays and string lists", () => {
    assert.deepEqual(parseModels({ data: [{ id: "a", context_length: 8 }, { id: "a" }] }), [
      { id: "a", label: "a", contextTokens: 8 },
    ]);
    assert.deepEqual(parseModels(["x"]), [{ id: "x", label: "x" }]);
    assert.throws(() => parseModels({ nope: 1 }), /unexpected shape/);
  });
});
