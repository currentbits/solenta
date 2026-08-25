/**
 * skills:pickImport stays on the main-process dialog. The renderer cannot
 * supply a local path, and cancel returns null.
 * Run: node --test electron/test/skill-import-ipc.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IPC_HANDLERS } = require("../ipc.js");
const { SKILL_DIRS } = require("../skills.js");
const skillImports = require("../skillImports.js");

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-skill-ipc-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("skills:pickImport IPC", () => {
  it("opens a Markdown/ZIP dialog, ignores a renderer path, and returns null on cancel", async () => {
    let dialogOpts = null;
    let opened = 0;
    const evil = path.join(tmp, "evil.md");
    fs.writeFileSync(evil, "---\ndescription: Evil\n---\n\nNo.\n");
    const ctx = {
      userDataPath: path.join(tmp, "user-data"),
      dialog: {
        showOpenDialog: async (opts) => {
          opened += 1;
          dialogOpts = opts;
          return { canceled: true, filePaths: [] };
        },
      },
    };
    const result = await IPC_HANDLERS["skills:pickImport"](ctx, {
      path: evil,
      sourcePath: evil,
      filePath: evil,
    });
    assert.equal(result, null);
    assert.equal(opened, 1);
    assert.ok(dialogOpts);
    const extensions = (dialogOpts.filters || []).flatMap((f) => f.extensions);
    assert.ok(extensions.includes("md"));
    assert.ok(extensions.includes("zip"));
    assert.ok(
      (dialogOpts.properties || []).includes("openFile"),
      "picker must choose a file, not a destination directory",
    );
    assert.equal(fs.existsSync(path.join(ctx.userDataPath, "skill-imports")), false);
  });

  it("does not honor failTarget or afterTargetWrite from the renderer request", async () => {
    const home = path.join(tmp, "home");
    const userDataPath = path.join(tmp, "user-data");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const src = path.join(tmp, "ipc-skill.md");
      fs.writeFileSync(
        src,
        "---\nname: ipc-skill\ndescription: IPC hook leak\n---\n\nBody.\n",
      );
      const ctx = {
        userDataPath,
        dialog: {
          showOpenDialog: async () => ({ canceled: false, filePaths: [src] }),
        },
      };
      const preview = await IPC_HANDLERS["skills:pickImport"](ctx);
      let threw = false;
      const result = await IPC_HANDLERS["skills:installImport"](ctx, {
        previewId: preview.previewId,
        selected: ["ipc-skill"],
        replace: false,
        trustPluginCode: false,
        failTarget: "claude",
        afterTargetWrite: () => {
          threw = true;
          throw new Error("renderer must not trigger this");
        },
      });
      assert.equal(threw, false);
      assert.deepEqual(result.installed.map((s) => s.name), ["ipc-skill"]);
      assert.equal(
        fs.existsSync(path.join(SKILL_DIRS({ HOME: home }).claude, "ipc-skill", "SKILL.md")),
        true,
      );
    } finally {
      if (prevHome == null) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("ignores renderer runner/argv/shell fields and constructs its own runner", async () => {
    const captured = [];
    const orig = skillImports.installImport;
    const evil = async () => {
      throw new Error("renderer runner must not run");
    };
    skillImports.installImport = async (opts) => {
      captured.push(opts);
      return { installed: [], plugins: [] };
    };
    try {
      await IPC_HANDLERS["skills:installImport"](
        { userDataPath: path.join(tmp, "user-data") },
        {
          previewId: "a".repeat(32),
          selected: ["ipc-skill"],
          replace: false,
          trustPluginCode: true,
          runFile: evil,
          runner: evil,
          argv: ["-c", "rm -rf /"],
          binary: "bash",
          shell: true,
        },
      );
      assert.equal(captured.length, 1);
      assert.equal(typeof captured[0].runFile, "function");
      assert.notEqual(captured[0].runFile, evil);
      assert.equal(captured[0].shell, undefined);
      assert.equal(captured[0].argv, undefined);
      assert.equal(captured[0].request.runFile, undefined);
      assert.equal(captured[0].request.runner, undefined);
      assert.equal(captured[0].request.argv, undefined);
      assert.equal(captured[0].request.binary, undefined);
      assert.equal(captured[0].request.shell, undefined);
      assert.equal(captured[0].request.trustPluginCode, true);
    } finally {
      skillImports.installImport = orig;
    }
  });

  it("coerces only exact true into trustPluginCode", async () => {
    const captured = [];
    const orig = skillImports.installImport;
    skillImports.installImport = async (opts) => {
      captured.push(opts);
      return { installed: [], plugins: [] };
    };
    try {
      await IPC_HANDLERS["skills:installImport"](
        { userDataPath: path.join(tmp, "user-data") },
        {
          previewId: "b".repeat(32),
          selected: ["ipc-skill"],
          trustPluginCode: 1,
        },
      );
      assert.equal(captured[0].request.trustPluginCode, false);
    } finally {
      skillImports.installImport = orig;
    }
  });

  it("lists and catalogs through ctx.userDataPath so registry-backed installs are visible", async () => {
    const home = path.join(tmp, "home");
    const userDataPath = path.join(tmp, "user-data");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const md = path.join(tmp, "reg-skill.md");
      fs.writeFileSync(
        md,
        "---\nname: reg-skill\ndescription: Registry visible\n---\n\nBody.\n",
      );
      const ctx = {
        userDataPath,
        dialog: {
          showOpenDialog: async () => ({ canceled: false, filePaths: [md] }),
        },
      };
      const preview = await IPC_HANDLERS["skills:pickImport"](ctx);
      await IPC_HANDLERS["skills:installImport"](ctx, {
        previewId: preview.previewId,
        selected: ["reg-skill"],
        replace: false,
        trustPluginCode: false,
      });
      const listed = await IPC_HANDLERS["skills:list"](ctx, {});
      const row = listed.find((s) => s.name === "reg-skill");
      assert.equal(row.provenance, "added");
      assert.equal(typeof row.origin?.packageId, "string");
      const catalog = await IPC_HANDLERS["skills:catalog"](ctx);
      assert.equal(catalog[0].id, "ponytail");
      assert.equal(catalog[0].installed, false);
    } finally {
      if (prevHome == null) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});
