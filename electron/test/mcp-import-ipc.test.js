/**
 * mcp.pickImport stays on the main-process dialog. The renderer cannot
 * supply a local path, fetch, clock, stored definitions, catalog URL,
 * runner, or sync hook.
 * Run: node --test electron/test/mcp-import-ipc.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IPC_HANDLERS } = require("../ipc.js");
const { Store } = require("../store.js");
const { createSecrets } = require("../secrets.js");
const mcpImports = require("../mcpImports.js");
const { resetMemorySupForTests } = require("../memory-sup.js");

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(plain) {
      return Buffer.from(`ENC(${plain})`, "utf8");
    },
    decryptString(buf) {
      const s = Buffer.from(buf).toString("utf8");
      if (!s.startsWith("ENC(") || !s.endsWith(")")) throw new Error("bad cipher");
      return s.slice(4, -1);
    },
  };
}

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mcp-imp-ipc-"));
  resetMemorySupForTests();
});

afterEach(() => {
  resetMemorySupForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeCtx(over = {}) {
  const secrets = createSecrets({
    safeStorage: fakeSafeStorage(),
    inElectron: true,
    log: () => {},
  });
  const store = new Store(path.join(tmp, "store.json"), { secrets });
  return {
    store,
    userDataPath: path.join(tmp, "user-data"),
    ...over,
  };
}

describe("mcp import IPC", () => {
  it("opens a JSON/ZIP dialog, ignores a renderer path, and returns null on cancel", async () => {
    let dialogOpts = null;
    let opened = 0;
    const evil = path.join(tmp, "evil.json");
    fs.writeFileSync(
      evil,
      JSON.stringify({ mcpServers: { evil: { url: "https://evil.example/mcp" } } }),
    );
    const ctx = makeCtx({
      dialog: {
        showOpenDialog: async (opts) => {
          opened += 1;
          dialogOpts = opts;
          return { canceled: true, filePaths: [] };
        },
      },
    });
    const result = await IPC_HANDLERS["mcp:pickImport"](ctx, {
      path: evil,
      sourcePath: evil,
      filePath: evil,
      fetchImpl: async () => {
        throw new Error("renderer fetch");
      },
      now: 1,
    });
    assert.equal(result, null);
    assert.equal(opened, 1);
    const extensions = (dialogOpts.filters || []).flatMap((f) => f.extensions);
    assert.ok(extensions.includes("json"));
    assert.ok(extensions.includes("zip"));
    assert.ok((dialogOpts.properties || []).includes("openFile"));
    assert.equal(fs.existsSync(path.join(ctx.userDataPath, "mcp-imports")), false);
  });

  it("allows JSON text but strips unrelated renderer fields from previewImport", async () => {
    let captured = null;
    const orig = mcpImports.previewImport;
    mcpImports.previewImport = async (opts) => {
      captured = opts;
      return { previewId: "a".repeat(32), source: { kind: "catalog", label: "x" }, servers: [] };
    };
    try {
      const ctx = makeCtx();
      const text = '{"mcpServers":{"x":{"url":"https://x.example/mcp"}}}';
      await IPC_HANDLERS["mcp:previewImport"](ctx, {
        kind: "json",
        text,
        url: "https://evil.example/mcp",
        fetchImpl: async () => {
          throw new Error("renderer fetch");
        },
        now: () => 0,
        current: [{ name: "injected" }],
        definitions: { x: { url: "https://evil.example/mcp" } },
      });
      assert.deepEqual(captured.input, { kind: "json", text });
      assert.equal(captured.fetchImpl, undefined);
      assert.equal(captured.now, undefined);

      await IPC_HANDLERS["mcp:previewImport"](ctx, {
        kind: "catalog",
        id: "context7",
        url: "https://evil.example/mcp",
        fetchImpl: async () => {
          throw new Error("renderer fetch");
        },
        now: () => 0,
        current: [{ name: "injected" }],
        definitions: { context7: { url: "https://evil.example/mcp" } },
      });
      assert.deepEqual(captured.input, { kind: "catalog", id: "context7" });
      assert.equal(captured.fetchImpl, undefined);
      assert.equal(captured.now, undefined);
    } finally {
      mcpImports.previewImport = orig;
    }
  });

  it("installs through store setSettings and ignores renderer save/sync/runner/clock", async () => {
    const ctx = makeCtx({
      dialog: {
        showOpenDialog: async () => ({
          canceled: false,
          filePaths: [
            (() => {
              const src = path.join(tmp, "ok.json");
              fs.writeFileSync(
                src,
                JSON.stringify({
                  mcpServers: { "ipc-tools": { url: "https://ipc.example.com/mcp" } },
                }),
              );
              return src;
            })(),
          ],
        }),
      },
    });
    const preview = await IPC_HANDLERS["mcp:pickImport"](ctx);
    let threw = false;
    const result = await IPC_HANDLERS["mcp:installImport"](ctx, {
      previewId: preview.previewId,
      selected: ["ipc-tools"],
      replace: false,
      trustLocalCommands: true,
      save: () => {
        threw = true;
        throw new Error("renderer save");
      },
      current: [],
      syncUserMcpServers: () => {
        threw = true;
        throw new Error("renderer sync");
      },
      runner: () => {
        threw = true;
      },
      now: 1,
      fetchImpl: async () => {
        threw = true;
      },
    });
    assert.equal(threw, false);
    assert.equal(result.installed[0].name, "ipc-tools");
    assert.equal(result.installed[0].url, "https://ipc.example.com/mcp");
    assert.equal(ctx.store.getSettings().mcpServers[0].name, "ipc-tools");
    const catalog = await IPC_HANDLERS["mcp:catalog"](ctx);
    assert.equal(catalog.length, 3);
    assert.equal(catalog.every((e) => e.installed === false), true);
  });

  it("coerces only exact true into trustLocalCommands and strips extra secret fields", async () => {
    const captured = [];
    const orig = mcpImports.installImport;
    mcpImports.installImport = async (opts) => {
      captured.push(opts);
      return { installed: [] };
    };
    try {
      const ctx = makeCtx();
      await IPC_HANDLERS["mcp:installImport"](ctx, {
        previewId: "b".repeat(32),
        selected: ["local-tools"],
        trustLocalCommands: 1,
        secrets: { abc: "ok" },
        save: () => {},
        fetchImpl: async () => {},
      });
      assert.equal(captured[0].request.trustLocalCommands, false);
      assert.deepEqual(captured[0].request.secrets, { abc: "ok" });
      assert.equal(captured[0].request.save, undefined);
      assert.equal(captured[0].save === undefined || captured[0].request.fetchImpl === undefined, true);
      assert.equal(typeof captured[0].save, "function");
    } finally {
      mcpImports.installImport = orig;
    }
  });
});
