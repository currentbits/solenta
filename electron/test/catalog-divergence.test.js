/**
 * Snapshot vs local CLI catalog (issue #745).
 * Run: node --test electron/test/catalog-divergence.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const catalog = require("../catalogDivergence.js");
const {
  listProviders,
  probeCatalogCli,
  catalogCliProbeStarted,
  resetCatalogCliCache,
  getProvider,
} = require("../providers.js");
const { listProvidersForApi } = require("../services.js");

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coder-catalog-"));
}

function write(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
}

beforeEach(() => {
  resetCatalogCliCache();
});

afterEach(() => {
  resetCatalogCliCache();
});

describe("diffCatalog / formatCatalogNote", () => {
  it("returns extra live and extra snapshot in source order, unique", () => {
    const diff = catalog.diffCatalog(
      ["a", "b", "b", "c"],
      ["c", "d", "d", "e"],
    );
    assert.deepEqual(diff, {
      extraLive: ["d", "e"],
      extraSnapshot: ["a", "b"],
    });
  });

  it("is a no-op when live is missing (do not warn)", () => {
    assert.equal(catalog.diffCatalog(["a"], null), null);
    assert.equal(catalog.diffCatalog(["a"], undefined), null);
  });

  it("treats an empty live list as a real catalog", () => {
    assert.deepEqual(catalog.diffCatalog(["a"], []), {
      extraLive: [],
      extraSnapshot: ["a"],
    });
  });

  it("formats one line and caps ids at 3", () => {
    const note = catalog.formatCatalogNote({
      name: "Codex",
      extraLive: ["gpt-5.6-sol", "x", "y", "z"],
      extraSnapshot: ["gpt-5.6-terra"],
    });
    assert.equal(
      note,
      "Codex CLI lists gpt-5.6-sol, x, y, and 1 more; snapshot does not. Snapshot lists gpt-5.6-terra; CLI does not. Use Custom... for unlisted ids.",
    );
  });

  it("omits Custom... when the CLI only dropped snapshot ids", () => {
    const note = catalog.formatCatalogNote({
      name: "OpenCode",
      extraLive: [],
      extraSnapshot: ["opencode/north-mini-code-free"],
    });
    assert.equal(
      note,
      "Snapshot lists opencode/north-mini-code-free; CLI does not.",
    );
  });

  it("returns null when both sides match", () => {
    assert.equal(
      catalog.formatCatalogNote({
        name: "Grok",
        extraLive: [],
        extraSnapshot: [],
      }),
      null,
    );
  });
});

describe("parsers", () => {
  it("codex keeps visibility=list slugs and drops hide", () => {
    assert.deepEqual(
      catalog.parseCodexCache({
        client_version: "0.144.1",
        models: [
          { slug: "gpt-5.6-sol", visibility: "list" },
          { slug: "gpt-5.5", visibility: "list" },
          { slug: "codex-auto-review", visibility: "hide" },
          { slug: "no-vis" },
        ],
      }),
      ["gpt-5.6-sol", "gpt-5.5"],
    );
    assert.equal(catalog.parseCodexCache({}), null);
    assert.equal(catalog.parseCodexCache(null), null);
  });

  it("grok cache skips hidden models", () => {
    assert.deepEqual(
      catalog.parseGrokCache({
        models: {
          "grok-4.6": { hidden: false },
          "grok-4.5": { info: { hidden: false } },
          ghost: { hidden: true },
        },
      }),
      ["grok-4.6", "grok-4.5"],
    );
    assert.equal(catalog.parseGrokCache({ models: [] }), null);
  });

  it("kimi toml uses [models.\"...\"] alias keys", () => {
    const text = `
default_model = "kimi-code/k3"
[models."kimi-code/k3"]
model = "k3"
[thinking]
effort = "high"
[models."kimi-code/k3-256k"]
model = "k3-256k"
`;
    assert.deepEqual(catalog.parseKimiToml(text), [
      "kimi-code/k3",
      "kimi-code/k3-256k",
    ]);
  });

  it("opencode models is one provider/model id per line", () => {
    assert.deepEqual(
      catalog.parseOpencodeModels(
        "Warning: ignored\nopencode/hy3-free\nopencode/big-pickle\nnot-an-id\n",
      ),
      ["opencode/hy3-free", "opencode/big-pickle"],
    );
    assert.equal(catalog.parseOpencodeModels("nope\n"), null);
  });

  it("cursor-agent --list-models is `id - Label`", () => {
    assert.deepEqual(
      catalog.parseCursorListModels(
        "Available models\n\nauto - Auto (current, default)\ngpt-5.6-sol-high - GPT-5.6 Sol 1M High\n",
      ),
      ["auto", "gpt-5.6-sol-high"],
    );
    assert.equal(catalog.parseCursorListModels("Available models\n"), null);
  });

  it("grok models command lists starred/dashed ids", () => {
    assert.deepEqual(
      catalog.parseGrokModelsOutput(
        "You are logged in with grok.com.\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n",
      ),
      ["grok-4.6", "grok-4.5"],
    );
  });
});

describe("readLiveIds / attachCatalogNotes", () => {
  it("missing cache is no warning", () => {
    const home = tmpHome();
    try {
      assert.equal(catalog.readLiveIds("codex", { home, env: {} }), null);
      const rows = [
        { id: "codex", name: "Codex", models: ["gpt-5.5"] },
        { id: "claude", name: "Claude Code", models: ["claude-opus-5"] },
      ];
      catalog.attachCatalogNotes(rows, { home, env: {} });
      assert.equal(rows[0].catalogNote, undefined);
      assert.equal(rows[1].catalogNote, undefined);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not guess a Claude listing", () => {
    assert.equal(
      catalog.readLiveIds("claude", {
        home: "/nonexistent",
        env: {},
        cliCache: new Map([["claude", ["mythos"]]]),
      }),
      null,
    );
  });

  it("codex note uses visibility=list only and does not merge into models", () => {
    const home = tmpHome();
    try {
      write(
        path.join(home, ".codex", "models_cache.json"),
        JSON.stringify({
          models: [
            { slug: "gpt-5.6-sol", visibility: "list" },
            { slug: "gpt-5.5", visibility: "list" },
            { slug: "codex-auto-review", visibility: "hide" },
          ],
        }),
      );
      const snapshot = ["gpt-5.5", "gpt-5.4-mini"];
      const rows = [{ id: "codex", name: "Codex", models: snapshot.slice() }];
      catalog.attachCatalogNotes(rows, { home, env: {} });
      assert.match(rows[0].catalogNote, /gpt-5\.6-sol/);
      assert.match(rows[0].catalogNote, /gpt-5\.4-mini/);
      assert.equal(rows[0].catalogNote.includes("codex-auto-review"), false);
      assert.deepEqual(rows[0].models, snapshot);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("kimi and grok file caches match → no note", () => {
    const home = tmpHome();
    try {
      write(
        path.join(home, ".grok", "models_cache.json"),
        JSON.stringify({
          models: { "grok-4.6": { hidden: false }, "grok-4.5": { hidden: false } },
        }),
      );
      write(
        path.join(home, ".kimi-code", "config.toml"),
        `[models."kimi-code/k3"]\n[models."kimi-code/k3-256k"]\n`,
      );
      const rows = [
        { id: "grok", name: "Grok", models: ["grok-4.6", "grok-4.5"] },
        {
          id: "kimi",
          name: "Kimi Code",
          models: ["kimi-code/k3", "kimi-code/k3-256k"],
        },
      ];
      catalog.attachCatalogNotes(rows, { home, env: {} });
      assert.equal(rows[0].catalogNote, undefined);
      assert.equal(rows[1].catalogNote, undefined);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("opencode/cursor notes come from the CLI cache, never models.json", () => {
    const rows = [
      {
        id: "opencode",
        name: "OpenCode",
        models: ["opencode/north-mini-code-free"],
      },
    ];
    catalog.attachCatalogNotes(rows, {
      home: "/nonexistent",
      env: {},
      cliCache: new Map([
        ["opencode", ["opencode/hy3-free", "opencode/big-pickle"]],
      ]),
    });
    assert.match(rows[0].catalogNote, /hy3-free/);
    assert.match(rows[0].catalogNote, /north-mini-code-free/);
    assert.deepEqual(rows[0].models, ["opencode/north-mini-code-free"]);
  });

  it("corrupt JSON is no warning", () => {
    const home = tmpHome();
    try {
      write(path.join(home, ".codex", "models_cache.json"), "{not json");
      assert.equal(catalog.readLiveIds("codex", { home, env: {} }), null);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("listProviders catalog notes", () => {
  it("isolated home does not spawn and does not warn", () => {
    const home = tmpHome();
    try {
      let spawned = 0;
      const list = listProviders({
        which: () => null,
        env: {},
        includeSimulate: false,
        home,
        runCli: async () => {
          spawned += 1;
          return "";
        },
      });
      assert.equal(spawned, 0, "listProviders must not spawn CLIs");
      for (const p of list) {
        assert.equal(p.catalogNote, undefined, p.id);
        assert.ok(Array.isArray(p.models));
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not rewrite the snapshot when a cache diverges", () => {
    const home = tmpHome();
    try {
      const snap = getProvider("codex").models.slice();
      write(
        path.join(home, ".codex", "models_cache.json"),
        JSON.stringify({
          models: [
            { slug: "live-only-model", visibility: "list" },
            { slug: snap[0], visibility: "list" },
          ],
        }),
      );
      const list = listProviders({
        which: () => null,
        env: {},
        includeSimulate: false,
        home,
      });
      const codex = list.find((p) => p.id === "codex");
      assert.deepEqual(codex.models, snap);
      assert.match(codex.catalogNote, /live-only-model/);
      assert.match(codex.catalogNote, /Custom\.\.\./);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("CLI catalog probes", () => {
  it("does not spawn Claude, and caches OpenCode/Cursor listings", async () => {
    const calls = [];
    const home = tmpHome();
    try {
      const which = (bin) =>
        bin === "opencode" || bin === "cursor-agent" || bin === "claude"
          ? bin
          : null;
      await probeCatalogCli({
        which,
        env: {},
        home,
        runCli: async (bin, args) => {
          calls.push({ bin, args });
          if (bin === "opencode") return "opencode/live-only-free\nopencode/big-pickle\n";
          if (bin === "cursor-agent") return "auto - Auto\ncomposer-2.5 - Composer 2.5\n";
          throw new Error(`unexpected ${bin}`);
        },
      });
      assert.equal(
        calls.some((c) => c.bin === "claude"),
        false,
        "claude --help is not a model listing",
      );
      assert.deepEqual(
        calls.map((c) => [c.bin, c.args[0]]),
        [
          ["opencode", "models"],
          ["cursor-agent", "--list-models"],
        ],
      );

      const list = listProviders({
        which: () => null,
        env: {},
        includeSimulate: false,
        home,
      });
      const oc = list.find((p) => p.id === "opencode");
      assert.match(oc.catalogNote, /live-only-free/);
      assert.equal(
        oc.models.includes("opencode/live-only-free"),
        false,
        "must not merge live ids into the picker",
      );
      const cursor = list.find((p) => p.id === "cursor");
      // Snapshot is the full --list-models dump; a 2-id live list diverges both ways.
      assert.ok(cursor.catalogNote);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("failed or timed-out CLI is no warning", async () => {
    const home = tmpHome();
    try {
      await probeCatalogCli({
        which: (bin) => (bin === "opencode" ? bin : null),
        env: {},
        home,
        runCli: async () => {
          throw new Error("timeout");
        },
      });
      const list = listProviders({
        which: () => null,
        env: {},
        includeSimulate: false,
        home,
      });
      assert.equal(list.find((p) => p.id === "opencode").catalogNote, undefined);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("first providers.list does not wait; the second awaits the probe", async () => {
    const home = tmpHome();
    let finish;
    const gate = new Promise((resolve) => {
      finish = resolve;
    });
    try {
      assert.equal(catalogCliProbeStarted(), false);
      const first = listProvidersForApi(null, {
        which: (bin) => (bin === "opencode" ? bin : null),
        env: {},
        home,
        includeSimulate: false,
        runCli: async () => {
          await gate;
          return "opencode/live-only-free\n";
        },
      });
      assert.equal(first instanceof Promise, true);
      const boot = await first;
      assert.equal(boot.find((p) => p.id === "opencode").catalogNote, undefined);
      assert.equal(catalogCliProbeStarted(), true);

      const secondP = listProvidersForApi(null, {
        which: (bin) => (bin === "opencode" ? bin : null),
        env: {},
        home,
        includeSimulate: false,
      });
      finish();
      const second = await secondP;
      assert.match(
        second.find((p) => p.id === "opencode").catalogNote,
        /live-only-free/,
      );
    } finally {
      finish();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
