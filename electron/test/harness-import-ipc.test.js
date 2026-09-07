/**
 * harness:* IPC ignores renderer-supplied home/env/now and only scans
 * process.env homes.
 * Run: node --test electron/test/harness-import-ipc.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") return "electron";
  return origResolve.call(this, request, ...rest);
};
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      ipcMain: { handle() {} },
      app: { getPath: () => os.tmpdir(), getVersion: () => "0.0.0-test" },
      dialog: {},
      shell: {},
      nativeTheme: { themeSource: "system" },
      BrowserWindow: class {
        static getAllWindows() {
          return [];
        }
      },
    };
  }
  return origLoad.call(this, request, ...rest);
};

const { IPC_HANDLERS } = require("../ipc.js");
const { Store } = require("../store.js");
const { createSecrets } = require("../secrets.js");

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
let prevHome;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-harness-ipc-"));
  prevHome = process.env.HOME;
  process.env.HOME = path.join(tmp, "home");
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  if (prevHome == null) delete process.env.HOME;
  else process.env.HOME = prevHome;
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
    memory: {
      async search() {
        return [];
      },
      async store() {
        return { id: "x" };
      },
    },
    ...over,
  };
}

describe("harness import IPC", () => {
  it("detectSources does not take a renderer home path", async () => {
    fs.mkdirSync(path.join(process.env.HOME, ".claude"), { recursive: true });
    const evil = path.join(tmp, "evil-home");
    fs.mkdirSync(path.join(evil, ".cursor"), { recursive: true });
    const rows = await IPC_HANDLERS["harness:detectSources"](makeCtx(), {
      env: { HOME: evil },
      home: evil,
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId.claude.present, true);
    assert.equal(byId.cursor.present, false);
  });

  it("previewImport ignores renderer env and still finds the process home", async () => {
    const claude = path.join(process.env.HOME, ".claude");
    fs.mkdirSync(claude, { recursive: true });
    fs.writeFileSync(path.join(claude, "CLAUDE.md"), "# From process HOME\n");
    const preview = await IPC_HANDLERS["harness:previewImport"](makeCtx(), {
      source: "claude",
      env: { HOME: path.join(tmp, "other") },
      now: 1,
    });
    assert.ok(preview.instructions.some((i) => /From process HOME/.test(i.title)));
  });

  it("installImport only trusts plugin code when trustPluginCode is true", async () => {
    const claude = path.join(process.env.HOME, ".claude");
    fs.mkdirSync(path.join(claude, "plugins", "ponytail", "skills", "ponytail-help"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(claude, "plugins", "ponytail", "skills", "ponytail-help", "SKILL.md"),
      "---\nname: ponytail-help\ndescription: helper\n---\n\n# ponytail-help\n",
    );
    fs.mkdirSync(path.join(claude, "plugins", "ponytail", ".claude-plugin"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(claude, "plugins", "ponytail", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ponytail" }),
    );
    fs.mkdirSync(path.join(process.env.HOME, ".claude", "skills"), {
      recursive: true,
    });
    const preview = await IPC_HANDLERS["harness:previewImport"](makeCtx(), {
      source: "claude",
    });
    assert.ok(Array.isArray(preview.plugins));
    const result = await IPC_HANDLERS["harness:installImport"](makeCtx(), {
      previewId: preview.previewId,
      selected: ["skill:ponytail-help"],
      replace: false,
      trustLocal: false,
      trustPluginCode: 1,
    });
    assert.ok(Array.isArray(result.plugins));
    assert.ok(
      result.plugins.length === 0 ||
        result.plugins.every((p) => p.status === "skipped"),
    );
  });
});
