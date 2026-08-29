/**
 * MCP catalog, JSON/ZIP/GitHub preview, and atomic install.
 * Never executes package scripts, clones, or starts MCP commands.
 * Run: node --test electron/test/mcp-imports.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { listCatalog, getCatalogEntry } = require("../mcpCatalog.js");
const {
  pickImport,
  previewImport,
  installImport,
  discardImport,
  PREVIEW_TTL_MS,
} = require("../mcpImports.js");

const TTL_MS = PREVIEW_TTL_MS || 30 * 60 * 1000;

let tmp;
let userData;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mcp-imp-"));
  userData = path.join(tmp, "user-data");
  fs.mkdirSync(userData, { recursive: true });
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "binary");
    const data = Buffer.from(entry.data ?? "");
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localChunk = Buffer.concat([local, name, compressedIfNeeded(data)]);
    locals.push(localChunk);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += localChunk.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

function compressedIfNeeded(data) {
  return data;
}

function zipFromTree(root) {
  const entries = [];
  function walk(dir, rel) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, nextRel);
      else if (ent.isFile()) {
        entries.push({ name: nextRel, data: fs.readFileSync(full) });
      }
    }
  }
  walk(root, "");
  return buildZip(entries);
}

function asyncBody(data) {
  const buf = Buffer.from(data);
  return {
    async *[Symbol.asyncIterator]() {
      yield buf;
    },
  };
}

function bufferResponse(buf, status = 200) {
  const data = Buffer.from(buf);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-length"
          ? String(data.length)
          : null;
      },
    },
    body: asyncBody(data),
  };
}

function redirectResponse(location) {
  return {
    ok: false,
    status: 302,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "location" ? location : null;
      },
    },
  };
}

function leakPaths() {
  return [tmp, userData, path.sep + "mcp-imports" + path.sep];
}

function assertNoLeak(value, secrets = []) {
  const raw = JSON.stringify(value);
  for (const s of secrets) {
    assert.equal(raw.includes(s), false, `leaked ${s}`);
  }
  for (const p of leakPaths()) {
    assert.equal(raw.includes(p), false, `leaked path ${p}`);
  }
  assert.equal(raw.includes("Bearer ${"), false, "leaked template adjacent text");
}

function importsRoot() {
  return path.join(userData, "mcp-imports");
}

function readManifest(previewId) {
  return JSON.parse(
    fs.readFileSync(path.join(importsRoot(), previewId, "manifest.json"), "utf8"),
  );
}

function manifestMode(previewId) {
  return fs.statSync(path.join(importsRoot(), previewId, "manifest.json")).mode & 0o777;
}

async function pickJson(obj, name = "mcp.json") {
  const src = path.join(tmp, name);
  writeFile(src, JSON.stringify(obj));
  return pickImport({
    userDataPath: userData,
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [src] }),
    },
  });
}

const TEMPLATE_DOC = {
  mcpServers: {
    "team-tools": {
      url: "https://tools.example.com/mcp",
      headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
    },
    "local-tools": {
      command: "/usr/bin/mcp-server",
      args: ["--stdio"],
      env: { API_KEY: "${API_KEY}" },
    },
  },
};

describe("listCatalog", () => {
  it("returns three main-owned entries with real metadata and no public secrets", () => {
    const catalog = listCatalog();
    assert.equal(catalog.length, 3);
    const byId = Object.fromEntries(catalog.map((e) => [e.id, e]));
    assert.ok(byId.context7);
    assert.equal(byId.context7.name, "Context7");
    assert.ok(byId.context7.description.length > 0);
    assert.ok(byId.context7.publisher);
    assert.equal(byId.context7.homepage, "https://context7.com");
    assert.equal(byId.context7.transport, "http");
    assert.match(byId.context7.risk, /remote|http/i);
    assert.deepEqual(byId.context7.requiredSecrets, []);
    assert.equal(byId.context7.installed, false);
    assert.equal(byId.context7.definition, undefined);
    assert.equal(byId.context7.url, undefined);

    assert.ok(byId.linear);
    assert.equal(byId.linear.homepage, "https://linear.app");
    assert.equal(byId.linear.transport, "http");
    assert.match(byId.linear.risk, /oauth/i);
    assert.deepEqual(byId.linear.requiredSecrets, []);

    assert.ok(byId.playwright);
    assert.equal(byId.playwright.transport, "stdio");
    assert.match(byId.playwright.risk, /trust|local|npx/i);
    assert.equal(byId.playwright.installed, false);

    const ctx = getCatalogEntry("context7");
    assert.equal(ctx.definition.url, "https://mcp.context7.com/mcp");
    assert.equal(ctx.definition.token, undefined);
    const lin = getCatalogEntry("linear");
    assert.equal(lin.definition.url, "https://mcp.linear.app/mcp");
    const pw = getCatalogEntry("playwright");
    assert.equal(pw.definition.command, "npx");
    assert.deepEqual(pw.definition.args, ["-y", "@playwright/mcp@latest"]);
    assert.equal(getCatalogEntry("not-real"), null);
    assert.equal(getCatalogEntry("https://evil.example/mcp"), null);
  });

  it("marks installed only for stored provenance curated plus catalogId", () => {
    const installed = listCatalog({
      servers: [
        { name: "context7", provenance: "curated", catalogId: "context7" },
        { name: "linear", provenance: "added", catalogId: "linear" },
        { name: "playwright", provenance: "curated" },
        { name: "other", provenance: "curated", catalogId: "missing" },
      ],
    });
    const byId = Object.fromEntries(installed.map((e) => [e.id, e]));
    assert.equal(byId.context7.installed, true);
    assert.equal(byId.linear.installed, false);
    assert.equal(byId.playwright.installed, false);
  });
});

describe("pickImport / local preview", () => {
  it("previews JSON without leaking secrets, templates, or staging paths", async () => {
    const preview = await pickJson(TEMPLATE_DOC);
    assert.match(preview.previewId, /^[a-f0-9]{32}$/);
    assert.equal(preview.source.kind, "local");
    const local = preview.servers.find((s) => s.name === "local-tools");
    assert.equal(local.transport, "stdio");
    assert.equal(local.trusted, false);
    assert.equal(local.command, "/usr/bin/mcp-server");
    assert.deepEqual(local.envNames, ["API_KEY"]);
    assert.equal(local.hasSecrets, true);
    assert.equal(local.collision, false);
    const remote = preview.servers.find((s) => s.name === "team-tools");
    assert.equal(remote.url, "https://tools.example.com/mcp");
    assert.deepEqual(remote.headerNames, ["Authorization"]);
    assert.ok(remote.requiredSecrets.some((d) => d.label === "GITHUB_TOKEN"));
    assert.ok(local.requiredSecrets.some((d) => d.label === "API_KEY"));
    assertNoLeak(preview, ["${GITHUB_TOKEN}", "${API_KEY}", "Bearer "]);
    assert.equal(manifestMode(preview.previewId), 0o600);
    const manifest = readManifest(preview.previewId);
    const storedRemote = manifest.servers.find((s) => s.stored.name === "team-tools");
    assert.equal(storedRemote.stored.headers.Authorization, "Bearer ${GITHUB_TOKEN}");
  });

  it("returns null on cancel and ignores a renderer-supplied path", async () => {
    const evil = path.join(tmp, "evil.json");
    writeFile(evil, JSON.stringify({ mcpServers: { evil: { url: "https://evil.example/mcp" } } }));
    const result = await pickImport({
      userDataPath: userData,
      path: evil,
      sourcePath: evil,
      filePath: evil,
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      },
    });
    assert.equal(result, null);
    assert.equal(fs.existsSync(importsRoot()), false);
  });

  it("marks grok unsupported when a stdio server needs cwd (#705)", async () => {
    const preview = await pickJson({
      mcpServers: {
        worker: {
          command: "/usr/bin/mcp-server",
          cwd: "/tmp/mcp-ok",
        },
        "no-cwd": {
          command: "/usr/bin/mcp-server",
        },
        docs: {
          type: "sse",
          url: "https://sse.example.com/mcp",
        },
      },
    });
    const byName = Object.fromEntries(preview.servers.map((s) => [s.name, s]));

    const grokWorker = byName.worker.providers.find((p) => p.id === "grok");
    assert.equal(grokWorker.supported, false);
    assert.match(grokWorker.note, /cwd/i);
    assert.equal(
      byName.worker.providers.find((p) => p.id === "claude").supported,
      true,
    );
    assert.equal(
      byName.worker.providers.find((p) => p.id === "cursor").supported,
      true,
    );

    const grokNoCwd = byName["no-cwd"].providers.find((p) => p.id === "grok");
    assert.equal(grokNoCwd.supported, true);
    assert.equal(grokNoCwd.note, undefined);

    const codexSse = byName.docs.providers.find((p) => p.id === "codex");
    assert.equal(codexSse.supported, false);
    assert.match(codexSse.note, /sse/i);
    assert.equal(
      byName.docs.providers.find((p) => p.id === "grok").supported,
      true,
    );
  });
});

describe("ZIP candidate discovery", () => {
  it("reads allowlisted candidates and ignores decoy trees and package scripts", async () => {
    const root = path.join(tmp, "zip-src");
    writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { "dot-mcp": { url: "https://dot.example.com/mcp" } } }),
    );
    writeFile(
      path.join(root, "mcp.json"),
      JSON.stringify({ mcpServers: { "root-mcp": { url: "https://root.example.com/mcp" } } }),
    );
    writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { cursor: { url: "https://cursor.example.com/mcp" } } }),
    );
    writeFile(
      path.join(root, ".vscode", "mcp.json"),
      JSON.stringify({ servers: { vscode: { url: "https://vscode.example.com/mcp" } } }),
    );
    writeFile(
      path.join(root, ".kimi-code", "mcp.json"),
      JSON.stringify({ mcpServers: { kimi: { url: "https://kimi.example.com/mcp" } } }),
    );
    writeFile(
      path.join(root, "claude_desktop_config.json"),
      JSON.stringify({ mcpServers: { claude: { url: "https://claude.example.com/mcp" } } }),
    );
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { postinstall: "touch pwned" },
        mcpServers: { pkg: { url: "https://pkg.example.com/mcp" } },
      }),
    );
    writeFile(
      path.join(root, "node_modules", "dep", "mcp.json"),
      JSON.stringify({ mcpServers: { decoy: { url: "https://decoy.example.com/mcp" } } }),
    );
    writeFile(
      path.join(root, ".git", "mcp.json"),
      JSON.stringify({ mcpServers: { git: { url: "https://git.example.com/mcp" } } }),
    );
    writeFile(
      path.join(root, "__MACOSX", "mcp.json"),
      JSON.stringify({ mcpServers: { mac: { url: "https://mac.example.com/mcp" } } }),
    );
    writeFile(
      path.join(root, "benchmarks", "mcp.json"),
      JSON.stringify({ mcpServers: { bench: { url: "https://bench.example.com/mcp" } } }),
    );
    writeFile(
      path.join(root, "notes.json"),
      JSON.stringify({ mcpServers: { notes: { url: "https://notes.example.com/mcp" } } }),
    );
    const zipPath = path.join(tmp, "mcp.zip");
    fs.writeFileSync(zipPath, zipFromTree(root));
    const preview = await pickImport({
      userDataPath: userData,
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [zipPath] }),
      },
    });
    const names = preview.servers.map((s) => s.name).sort();
    assert.deepEqual(names, [
      "claude",
      "cursor",
      "dot-mcp",
      "kimi",
      "pkg",
      "root-mcp",
      "vscode",
    ]);
    assert.equal(names.includes("decoy"), false);
    assert.equal(names.includes("notes"), false);
    assert.equal(fs.existsSync(path.join(tmp, "pwned")), false);
  });

  it("ignores package.json without mcpServers and rejects conflicting names", async () => {
    const okRoot = path.join(tmp, "pkg-only");
    writeFile(
      path.join(okRoot, "package.json"),
      JSON.stringify({ name: "x", scripts: { postinstall: "touch pwned" } }),
    );
    writeFile(
      path.join(okRoot, "mcp.json"),
      JSON.stringify({ mcpServers: { only: { url: "https://only.example.com/mcp" } } }),
    );
    const okZip = path.join(tmp, "ok.zip");
    fs.writeFileSync(okZip, zipFromTree(okRoot));
    const ok = await pickImport({
      userDataPath: userData,
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [okZip] }),
      },
    });
    assert.deepEqual(
      ok.servers.map((s) => s.name),
      ["only"],
    );
    assert.equal(fs.existsSync(path.join(tmp, "pwned")), false);

    const conflict = path.join(tmp, "conflict");
    writeFile(
      path.join(conflict, "mcp.json"),
      JSON.stringify({ mcpServers: { dup: { url: "https://a.example.com/mcp" } } }),
    );
    writeFile(
      path.join(conflict, ".mcp.json"),
      JSON.stringify({ mcpServers: { dup: { url: "https://b.example.com/mcp" } } }),
    );
    const conflictZip = path.join(tmp, "conflict.zip");
    fs.writeFileSync(conflictZip, zipFromTree(conflict));
    await assert.rejects(
      () =>
        pickImport({
          userDataPath: userData,
          dialog: {
            showOpenDialog: async () => ({ canceled: false, filePaths: [conflictZip] }),
          },
        }),
      /duplicate|conflict/i,
    );
  });

  it("inherits ZIP traversal rejection from safeExtractZip", async () => {
    const zipPath = path.join(tmp, "evil.zip");
    fs.writeFileSync(
      zipPath,
      buildZip([{ name: "../escape.json", data: "{}" }]),
    );
    await assert.rejects(
      () =>
        pickImport({
          userDataPath: userData,
          dialog: {
            showOpenDialog: async () => ({ canceled: false, filePaths: [zipPath] }),
          },
        }),
      /escape|travers/i,
    );
  });
});

describe("GitHub preview", () => {
  it("previews a repo zip, tree path, and ref-pinned blob/raw JSON", async () => {
    const ghRoot = path.join(tmp, "gh", "acme-tools-deadbeef");
    writeFile(
      path.join(ghRoot, "mcp.json"),
      JSON.stringify({ mcpServers: { "gh-root": { url: "https://gh.example.com/mcp" } } }),
    );
    writeFile(
      path.join(ghRoot, "nested", ".mcp.json"),
      JSON.stringify({ mcpServers: { "gh-nested": { url: "https://nested.example.com/mcp" } } }),
    );
    const zip = zipFromTree(path.join(tmp, "gh"));
    const blobJson = JSON.stringify({
      mcpServers: { "gh-blob": { url: "https://blob.example.com/mcp" } },
    });
    const calls = [];
    const fetchImpl = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("codeload.github.com") && u.includes("acme/tools")) {
        return bufferResponse(zip);
      }
      if (u.includes("raw.githubusercontent.com") && u.includes("mcp.json")) {
        return bufferResponse(blobJson);
      }
      if (u.includes("api.github.com") && u.includes("/contents/")) {
        return bufferResponse(blobJson);
      }
      throw new Error(`unexpected fetch ${u}`);
    };

    const repo = await previewImport({
      userDataPath: userData,
      input: { kind: "github", url: "https://github.com/acme/tools" },
      fetchImpl,
    });
    assert.equal(repo.source.kind, "github");
    assert.equal(repo.source.label, "acme/tools");
    assert.ok(repo.servers.some((s) => s.name === "gh-root"));
    assert.ok(calls.some((u) => u.includes("codeload.github.com")));

    const tree = await previewImport({
      userDataPath: userData,
      input: { kind: "github", url: "https://github.com/acme/tools/tree/main/nested" },
      fetchImpl,
    });
    assert.deepEqual(
      tree.servers.map((s) => s.name),
      ["gh-nested"],
    );

    const blob = await previewImport({
      userDataPath: userData,
      input: {
        kind: "github",
        url: "https://github.com/acme/tools/blob/abc123def/.mcp.json",
      },
      fetchImpl,
    });
    assert.equal(blob.servers[0].name, "gh-blob");

    const raw = await previewImport({
      userDataPath: userData,
      input: {
        kind: "github",
        url: "https://raw.githubusercontent.com/acme/tools/abc123def/mcp.json",
      },
      fetchImpl,
    });
    assert.equal(raw.servers[0].name, "gh-blob");
  });

  it("rejects a non-JSON blob, off-host redirect, and oversize response", async () => {
    await assert.rejects(
      () =>
        previewImport({
          userDataPath: userData,
          input: {
            kind: "github",
            url: "https://github.com/acme/tools/blob/main/README.md",
          },
          fetchImpl: async () => {
            throw new Error("must not fetch");
          },
        }),
      /json|candidate|mcp\.json/i,
    );
    await assert.rejects(
      () =>
        previewImport({
          userDataPath: userData,
          input: { kind: "github", url: "https://github.com/acme/tools" },
          fetchImpl: async () => redirectResponse("https://evil.example/payload.zip"),
        }),
      /redirect|host/i,
    );
    await assert.rejects(
      () =>
        previewImport({
          userDataPath: userData,
          input: { kind: "github", url: "https://github.com/acme/tools" },
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => String(26 * 1024 * 1024) },
            body: asyncBody(Buffer.alloc(1)),
          }),
        }),
      /25 MiB|limit/i,
    );
  });
});

describe("catalog preview", () => {
  it("previews by id from main-owned definitions and never fetches", async () => {
    let fetches = 0;
    const preview = await previewImport({
      userDataPath: userData,
      input: { kind: "catalog", id: "context7" },
      fetchImpl: async () => {
        fetches += 1;
        throw new Error("must not fetch catalog");
      },
    });
    assert.equal(fetches, 0);
    assert.equal(preview.source.kind, "catalog");
    assert.equal(preview.source.label, "Context7");
    assert.equal(preview.servers[0].name, "context7");
    assert.equal(preview.servers[0].url, "https://mcp.context7.com/mcp");
    assert.equal(preview.servers[0].trusted, undefined);
    const pw = await previewImport({
      userDataPath: userData,
      input: { kind: "catalog", id: "playwright" },
    });
    assert.equal(pw.servers[0].trusted, false);
    assert.equal(pw.servers[0].command, "npx");
    await assert.rejects(
      () =>
        previewImport({
          userDataPath: userData,
          input: { kind: "catalog", id: "not-a-real-item" },
          fetchImpl: async () => {
            throw new Error("must not fetch");
          },
        }),
      /unknown catalog/i,
    );
  });
});

describe("installImport", () => {
  function storeHarness(initial = []) {
    let servers = initial.slice();
    let calls = 0;
    return {
      get current() {
        return servers;
      },
      get calls() {
        return calls;
      },
      save(next) {
        calls += 1;
        servers = next;
        return next;
      },
    };
  }

  it("gates selected stdio on exact trustLocalCommands true", async () => {
    const preview = await pickJson(TEMPLATE_DOC);
    const store = storeHarness();
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          current: store.current,
          request: {
            previewId: preview.previewId,
            selected: ["local-tools"],
            replace: false,
            trustLocalCommands: 1,
            secrets: Object.fromEntries(
              preview.servers
                .find((s) => s.name === "local-tools")
                .requiredSecrets.map((d) => [d.id, "secret"]),
            ),
          },
          save: (next) => store.save(next),
        }),
      /trust/i,
    );
    assert.equal(store.calls, 0);
    assert.equal(fs.existsSync(path.join(importsRoot(), preview.previewId)), true);
  });

  it("substitutes secrets in main, rejects missing secrets, and does not leak templates", async () => {
    const preview = await pickJson(TEMPLATE_DOC);
    const remoteDesc = preview.servers.find((s) => s.name === "team-tools").requiredSecrets[0];
    const store = storeHarness();
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          current: store.current,
          request: {
            previewId: preview.previewId,
            selected: ["team-tools"],
            replace: false,
            trustLocalCommands: false,
            secrets: {},
          },
          save: (next) => store.save(next),
        }),
      /secret/i,
    );
    const result = await installImport({
      userDataPath: userData,
      current: store.current,
      request: {
        previewId: preview.previewId,
        selected: ["team-tools"],
        replace: false,
        trustLocalCommands: false,
        secrets: { [remoteDesc.id]: "ghp_installed" },
      },
      save: (next) => store.save(next),
    });
    assert.equal(store.current[0].headers.Authorization, "Bearer ghp_installed");
    assert.equal(store.current[0].provenance, "added");
    assert.equal(result.installed[0].url, "https://tools.example.com/mcp");
    assert.equal(result.installed[0].headers, undefined);
    assertNoLeak(result, ["ghp_installed", "Bearer ${GITHUB_TOKEN}", remoteDesc.id]);
    assert.equal(fs.existsSync(path.join(importsRoot(), preview.previewId)), false);
  });

  it("errors on collision unless replace upserts, and installs selected atomically", async () => {
    const preview = await pickJson({
      mcpServers: {
        one: { url: "https://one.example.com/mcp" },
        two: { url: "https://two.example.com/mcp" },
      },
    });
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          current: [{ name: "one", transport: "http", url: "https://old.example.com/mcp", enabled: true }],
          request: {
            previewId: preview.previewId,
            selected: ["one"],
            replace: false,
            trustLocalCommands: false,
          },
          save: () => {
            throw new Error("must not save");
          },
        }),
      /already exists|collision/i,
    );
    let saved;
    const result = await installImport({
      userDataPath: userData,
      current: [
        { name: "one", transport: "http", url: "https://old.example.com/mcp", enabled: true },
        { name: "keep", transport: "http", url: "https://keep.example.com/mcp", enabled: true },
      ],
      request: {
        previewId: preview.previewId,
        selected: ["one", "two"],
        replace: true,
        trustLocalCommands: false,
      },
      save: (next) => {
        saved = next;
        return next;
      },
    });
    assert.equal(saved.filter((s) => s.name === "keep").length, 1);
    assert.equal(saved.find((s) => s.name === "one").url, "https://one.example.com/mcp");
    assert.deepEqual(result.installed.map((s) => s.name).sort(), ["one", "two"]);
  });

  it("keeps settings unchanged when save/validation fails and leaves the preview", async () => {
    const preview = await pickJson({
      mcpServers: { ok: { url: "https://ok.example.com/mcp" } },
    });
    const original = [{ name: "keep", transport: "http", url: "https://keep.example.com/mcp", enabled: true }];
    let servers = original.slice();
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          current: servers,
          request: {
            previewId: preview.previewId,
            selected: ["ok"],
            replace: false,
            trustLocalCommands: false,
          },
          save: () => {
            throw new Error("disk full");
          },
        }),
      /disk full/,
    );
    assert.deepEqual(servers, original);
    assert.equal(fs.existsSync(path.join(importsRoot(), preview.previewId)), true);
    const result = await installImport({
      userDataPath: userData,
      current: servers,
      request: {
        previewId: preview.previewId,
        selected: ["ok"],
        replace: false,
        trustLocalCommands: false,
      },
      save: (next) => {
        servers = next;
        return next;
      },
    });
    assert.equal(result.installed[0].name, "ok");
    assert.equal(fs.existsSync(path.join(importsRoot(), preview.previewId)), false);
  });

  it("stamps catalog installs curated and stdio trusted only after the trust gate", async () => {
    const preview = await previewImport({
      userDataPath: userData,
      input: { kind: "catalog", id: "playwright" },
    });
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          current: [],
          request: {
            previewId: preview.previewId,
            selected: ["playwright"],
            replace: false,
            trustLocalCommands: false,
          },
          save: (next) => next,
        }),
      /trust/i,
    );
    const result = await installImport({
      userDataPath: userData,
      current: [],
      request: {
        previewId: preview.previewId,
        selected: ["playwright"],
        replace: false,
        trustLocalCommands: true,
      },
      save: (next) => next,
    });
    assert.equal(result.installed[0].provenance, "curated");
    assert.equal(result.installed[0].catalogId, "playwright");
    assert.equal(result.installed[0].trusted, true);
    assert.equal(result.installed[0].enabled, true);
  });

  it("expires, discards, and cleans stale previews", async () => {
    const preview = await pickJson({
      mcpServers: { ok: { url: "https://ok.example.com/mcp" } },
    });
    await discardImport({ userDataPath: userData, previewId: preview.previewId });
    assert.equal(fs.existsSync(path.join(importsRoot(), preview.previewId)), false);
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          current: [],
          request: {
            previewId: preview.previewId,
            selected: ["ok"],
            replace: false,
            trustLocalCommands: false,
          },
          save: (next) => next,
        }),
      /not found|expired|invalid/i,
    );

    const fresh = await pickJson({
      mcpServers: { later: { url: "https://later.example.com/mcp" } },
    });
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          current: [],
          now: Date.now() + TTL_MS + 1000,
          request: {
            previewId: fresh.previewId,
            selected: ["later"],
            replace: false,
            trustLocalCommands: false,
          },
          save: (next) => next,
        }),
      /expired/i,
    );
    assert.equal(fs.existsSync(path.join(importsRoot(), fresh.previewId)), false);
  });
});
