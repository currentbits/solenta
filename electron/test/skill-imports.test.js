/**
 * Curated catalog, local/GitHub preview staging, and fan-out install.
 * Run: node --test electron/test/skill-imports.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { listCatalog } = require("../skillCatalog.js");
const {
  pickImport,
  previewImport,
  installImport,
  discardImport,
} = require("../skillImports.js");
const { listSkills, removeSkill, syncSkills, SKILL_DIRS } = require("../skills.js");

const PONYTAIL_SKILLS = [
  "ponytail",
  "ponytail-audit",
  "ponytail-debt",
  "ponytail-gain",
  "ponytail-help",
  "ponytail-review",
];
const PONYTAIL_URL = "https://github.com/DietrichGebert/ponytail";
const TTL_MS = 30 * 60 * 1000;

let tmp;
let userData;
let env;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-skill-imp-"));
  userData = path.join(tmp, "user-data");
  env = { HOME: path.join(tmp, "home") };
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(env.HOME, { recursive: true });
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function skillMd(name, description, extra = "") {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody for ${name}.\n`;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeSkill(base, name, content) {
  writeFile(path.join(base, name, "SKILL.md"), content);
}

function activate(...targets) {
  const dirs = SKILL_DIRS(env);
  for (const t of targets) {
    fs.mkdirSync(path.dirname(dirs[t]), { recursive: true });
  }
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
    const localChunk = Buffer.concat([local, name, data]);
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

function zipFromTree(root) {
  /** @type {Array<{ name: string, data: Buffer }>} */
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

function bufferResponse(buf) {
  const data = Buffer.from(buf);
  return {
    ok: true,
    status: 200,
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

function writePonytailShape(root) {
  for (const name of PONYTAIL_SKILLS) {
    writeSkill(path.join(root, "skills"), name, skillMd(name, `${name} helper`));
    writeFile(
      path.join(root, "skills", name, "references", "notes.md"),
      `${name} notes\n`,
    );
  }
  writeFile(
    path.join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "ponytail", description: "Claude plugin" }),
  );
  writeFile(
    path.join(root, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "ponytail" }),
  );
  writeFile(
    path.join(root, ".grok-plugin", "marketplace.json"),
    JSON.stringify({ name: "ponytail" }),
  );
  writeFile(path.join(root, "plugin.json"), JSON.stringify({ name: "ponytail" }));
  writeFile(path.join(root, "hooks", "ponytail-statusline.sh"), "#!/bin/sh\necho ok\n");
  writeFile(
    path.join(root, "hooks", "ponytail-statusline.ps1"),
    "Write-Output ok\n",
  );
  writeFile(path.join(root, "commands", "ponytail.md"), "# ponytail\n");
  writeSkill(
    path.join(root, ".openclaw", "skills"),
    "ponytail",
    skillMd("ponytail", "OpenClaw copy"),
  );
  writeSkill(
    path.join(root, "benchmarks", "eval"),
    "bench-skill",
    skillMd("bench-skill", "Benchmark skill"),
  );
}

function ponytailZipFetch() {
  const src = path.join(tmp, "gh", "DietrichGebert-ponytail-deadbeef");
  writePonytailShape(src);
  const zip = zipFromTree(path.join(tmp, "gh"));
  return async (url) => {
    const u = String(url);
    if (
      u.includes("codeload.github.com") &&
      u.includes("DietrichGebert/ponytail")
    ) {
      return bufferResponse(zip);
    }
    throw new Error(`unexpected fetch ${u}`);
  };
}

function leakPaths() {
  return [tmp, userData, env.HOME, path.sep + "skill-imports" + path.sep];
}

function assertNoPathLeak(value, extra = []) {
  const raw = JSON.stringify(value);
  assert.equal(raw.includes("skillRoot"), false, "preview leaked skillRoot");
  for (const p of [...leakPaths(), ...extra]) {
    assert.equal(raw.includes(p), false, `preview leaked path ${p}`);
  }
}

function importsRoot() {
  return path.join(userData, "skill-imports");
}

function readManifest(previewId) {
  return JSON.parse(
    fs.readFileSync(path.join(importsRoot(), previewId, "manifest.json"), "utf8"),
  );
}

function markerPath(target, name) {
  return path.join(SKILL_DIRS(env)[target], name, ".solenta-skill.json");
}

function readMarker(target, name) {
  return JSON.parse(fs.readFileSync(markerPath(target, name), "utf8"));
}

function registryPath() {
  return path.join(userData, "skills", "registry.json");
}

function readRegistry() {
  return JSON.parse(fs.readFileSync(registryPath(), "utf8"));
}

function stageSkillDir(previewId, name) {
  const manifest = readManifest(previewId);
  const row = (manifest.skills || []).find((s) => s.name === name);
  assert.ok(row, `preview is missing ${name}`);
  return path.join(importsRoot(), previewId, "stage", ...String(row.rel).split("/"));
}

async function previewMarkdown(name = "review-pr") {
  const src = path.join(tmp, `${name}.md`);
  fs.writeFileSync(src, skillMd(name, `${name} from markdown`));
  const dialog = {
    showOpenDialog: async () => ({ canceled: false, filePaths: [src] }),
  };
  return pickImport({ userDataPath: userData, dialog, env });
}

async function previewZipCollection() {
  const root = path.join(tmp, "zip-src");
  writeSkill(root, "review-pr", skillMd("review-pr", "Review a PR"));
  writeFile(path.join(root, "review-pr", "notes.md"), "old notes\n");
  writeSkill(root, "write-tests", skillMd("write-tests", "Add tests"));
  const zipPath = path.join(tmp, "skills.zip");
  fs.writeFileSync(zipPath, zipFromTree(root));
  const dialog = {
    showOpenDialog: async () => ({ canceled: false, filePaths: [zipPath] }),
  };
  return pickImport({ userDataPath: userData, dialog, env });
}

async function previewPonytailCatalog(fetchImpl = ponytailZipFetch()) {
  return previewImport({
    userDataPath: userData,
    input: { kind: "catalog", id: "ponytail" },
    fetchImpl,
    env,
  });
}

describe("listCatalog", () => {
  it("lists Ponytail and does not claim it is installed without a managed marker", () => {
    activate("claude");
    writeSkill(
      path.join(env.HOME, ".claude", "skills"),
      "ponytail",
      skillMd("ponytail", "Hand-rolled copy"),
    );
    const catalog = listCatalog({ env });
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].id, "ponytail");
    assert.equal(catalog[0].name, "Ponytail");
    assert.equal(catalog[0].publisher, "Dietrich Gebert");
    assert.equal(catalog[0].sourceUrl, PONYTAIL_URL);
    assert.equal(catalog[0].homepage, PONYTAIL_URL);
    assert.equal(typeof catalog[0].description, "string");
    assert.ok(catalog[0].description.length > 0);
    assert.equal(catalog[0].installed, false);
  });
});

describe("pickImport / local preview", () => {
  it("stages a local Markdown skill without exposing staging paths", async () => {
    activate("claude");
    const preview = await previewMarkdown("review-pr");
    assert.ok(preview);
    assert.match(preview.previewId, /^[a-f0-9]{32}$/);
    assert.equal(preview.source.kind, "local");
    assert.equal(preview.source.label, "review-pr.md");
    assert.equal(preview.skills.length, 1);
    assert.equal(preview.skills[0].name, "review-pr");
    assert.equal(preview.skills[0].description, "review-pr from markdown");
    assert.deepEqual(preview.skills[0].files, ["SKILL.md"]);
    assert.equal(typeof preview.skills[0].bytes, "number");
    assert.ok(preview.skills[0].bytes > 0);
    assert.equal(preview.skills[0].collision, false);
    assert.deepEqual(preview.plugins, []);
    assertNoPathLeak(preview, [path.join(tmp, "review-pr.md")]);
    assert.equal(fs.existsSync(path.join(importsRoot(), preview.previewId)), true);
  });

  it("stages a ZIP collection and flags collisions", async () => {
    activate("claude");
    writeSkill(
      path.join(env.HOME, ".claude", "skills"),
      "review-pr",
      skillMd("review-pr", "Already here"),
    );
    const preview = await previewZipCollection();
    assert.equal(preview.source.kind, "local");
    assert.equal(preview.source.label, "skills.zip");
    assert.deepEqual(
      preview.skills.map((s) => s.name),
      ["review-pr", "write-tests"],
    );
    const review = preview.skills.find((s) => s.name === "review-pr");
    const tests = preview.skills.find((s) => s.name === "write-tests");
    assert.equal(review.collision, true);
    assert.equal(tests.collision, false);
    assert.ok(review.files.includes("SKILL.md"));
    assert.ok(review.files.includes("notes.md"));
    assertNoPathLeak(preview);
  });

  it("returns null when the picker is cancelled", async () => {
    const preview = await pickImport({
      userDataPath: userData,
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      },
      env,
    });
    assert.equal(preview, null);
    assert.equal(fs.existsSync(importsRoot()), false);
  });

  it("ignores a renderer-supplied local path and only uses the dialog file", async () => {
    const evil = path.join(tmp, "evil.md");
    fs.writeFileSync(evil, skillMd("evil", "Should not be read"));
    const good = path.join(tmp, "good.md");
    fs.writeFileSync(good, skillMd("good", "From the dialog"));
    let opened = 0;
    const preview = await pickImport({
      userDataPath: userData,
      dialog: {
        showOpenDialog: async () => {
          opened += 1;
          return { canceled: false, filePaths: [good] };
        },
      },
      env,
      sourcePath: evil,
      path: evil,
    });
    assert.equal(opened, 1);
    assert.equal(preview.skills[0].name, "good");
    assert.equal(preview.skills[0].description, "From the dialog");
  });
});

describe("previewImport catalog / GitHub", () => {
  it("previews Ponytail by catalog id with plugin extras and exactly six skills", async () => {
    activate("claude");
    process.env.GITHUB_TOKEN = "ghs_should_never_leak";
    const fetchImpl = ponytailZipFetch();
    const preview = await previewImport({
      userDataPath: userData,
      input: {
        kind: "catalog",
        id: "ponytail",
        url: "https://github.com/evil/exfil",
      },
      fetchImpl,
      env,
    });
    assert.equal(preview.source.kind, "catalog");
    assert.equal(preview.source.label, "Ponytail");
    assert.deepEqual(
      preview.skills.map((s) => s.name),
      PONYTAIL_SKILLS,
    );
    assert.equal(preview.skills.length, 6);
    const kinds = preview.plugins.map((p) => p.activation.kind).sort();
    assert.deepEqual(kinds, [
      "claude-plugin",
      "codex-plugin",
      "commands",
      "grok-plugin",
      "hooks",
      "plugin",
    ]);
    for (const extra of preview.plugins) {
      assert.equal(typeof extra.provider, "string");
      assert.ok(extra.provider);
      assert.equal(typeof extra.label, "string");
      assert.ok(extra.label);
      assert.ok(Array.isArray(extra.executableFiles));
      assert.equal(extra.activation.status, "pending");
    }
    const hooks = preview.plugins.find((p) => p.activation.kind === "hooks");
    assert.ok(hooks.executableFiles.includes("hooks/ponytail-statusline.sh"));
    assert.ok(hooks.executableFiles.includes("hooks/ponytail-statusline.ps1"));
    assertNoPathLeak(preview);
    const leaked = JSON.stringify(preview);
    assert.equal(leaked.includes("ghs_should_never_leak"), false);
    const manifest = readManifest(preview.previewId);
    assert.equal(JSON.stringify(manifest).includes("ghs_should_never_leak"), false);
    assert.equal(manifest.sourceUrl, PONYTAIL_URL);
    assert.equal(manifest.catalogId, "ponytail");
  });

  it("previews a public GitHub URL through injected fetch", async () => {
    activate("claude");
    const src = path.join(tmp, "gh", "acme-tools-main");
    writeSkill(path.join(src, "skills"), "ship-it", skillMd("ship-it", "Ship it"));
    const zip = zipFromTree(path.join(tmp, "gh"));
    const fetchImpl = async (url) => {
      if (String(url).includes("codeload.github.com/acme/tools")) {
        return bufferResponse(zip);
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const preview = await previewImport({
      userDataPath: userData,
      input: { kind: "github", url: "https://github.com/acme/tools" },
      fetchImpl,
      env,
    });
    assert.equal(preview.source.kind, "github");
    assert.equal(preview.skills[0].name, "ship-it");
    assertNoPathLeak(preview);
  });

  it("rejects an unknown catalog id and never fetches a renderer URL", async () => {
    let fetches = 0;
    await assert.rejects(
      () =>
        previewImport({
          userDataPath: userData,
          input: { kind: "catalog", id: "not-a-real-item" },
          fetchImpl: async () => {
            fetches += 1;
            throw new Error("network");
          },
          env,
        }),
      /unknown catalog/i,
    );
    assert.equal(fetches, 0);
  });
});

describe("preview expiry and discard", () => {
  it("rejects expired and malformed preview ids and discards staging", async () => {
    activate("claude");
    const preview = await previewMarkdown();
    const previewId = preview.previewId;
    await discardImport({ userDataPath: userData, previewId });
    assert.equal(fs.existsSync(path.join(importsRoot(), previewId)), false);

    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          request: {
            previewId,
            selected: ["review-pr"],
            replace: false,
            trustPluginCode: false,
          },
          env,
        }),
      /not found|expired|invalid/i,
    );

    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          request: {
            previewId: "../escape",
            selected: ["review-pr"],
            replace: false,
            trustPluginCode: false,
          },
          env,
        }),
      /invalid/i,
    );
    assert.equal(fs.existsSync(path.join(userData, "escape")), false);

    const fresh = await previewMarkdown("other-skill");
    const now = Date.now() + TTL_MS + 1000;
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          request: {
            previewId: fresh.previewId,
            selected: ["other-skill"],
            replace: false,
            trustPluginCode: false,
          },
          env,
          now: () => now,
        }),
      /expired/i,
    );
    assert.equal(fs.existsSync(path.join(importsRoot(), fresh.previewId)), false);
  });

  it("cleans a stale preview when a new one is created", async () => {
    activate("claude");
    let now = 1_000_000;
    const firstSrc = path.join(tmp, "first-skill.md");
    fs.writeFileSync(firstSrc, skillMd("first-skill", "First"));
    const first = await pickImport({
      userDataPath: userData,
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [firstSrc] }),
      },
      env,
      now: () => now,
    });
    now += TTL_MS + 5;
    const secondSrc = path.join(tmp, "second-skill.md");
    fs.writeFileSync(secondSrc, skillMd("second-skill", "Second"));
    const second = await pickImport({
      userDataPath: userData,
      dialog: {
        showOpenDialog: async () => ({
          canceled: false,
          filePaths: [secondSrc],
        }),
      },
      env,
      now: () => now,
    });
    assert.equal(fs.existsSync(path.join(importsRoot(), first.previewId)), false);
    assert.equal(fs.existsSync(path.join(importsRoot(), second.previewId)), true);
  });
});

describe("installImport", () => {
  it("fails clearly when no skill targets are active", async () => {
    const preview = await previewMarkdown();
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          request: {
            previewId: preview.previewId,
            selected: ["review-pr"],
            replace: false,
            trustPluginCode: false,
          },
          env,
        }),
      /no active skill targets/i,
    );
  });

  it("errors on collision by default and replace removes stale companions", async () => {
    activate("claude", "agents");
    const existing = path.join(env.HOME, ".claude", "skills", "review-pr");
    writeSkill(
      path.join(env.HOME, ".claude", "skills"),
      "review-pr",
      skillMd("review-pr", "Old copy"),
    );
    writeFile(path.join(existing, "stale.md"), "remove me\n");
    writeFile(path.join(existing, "references", "old.md"), "old ref\n");

    const preview = await previewZipCollection();
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          request: {
            previewId: preview.previewId,
            selected: ["review-pr"],
            replace: false,
            trustPluginCode: false,
          },
          env,
        }),
      /already exists|collision/i,
    );
    assert.equal(fs.readFileSync(path.join(existing, "stale.md"), "utf8"), "remove me\n");

    const result = await installImport({
      userDataPath: userData,
      request: {
        previewId: preview.previewId,
        selected: ["review-pr"],
        replace: true,
        trustPluginCode: false,
      },
      env,
    });
    assert.deepEqual(
      result.installed.map((s) => s.name),
      ["review-pr"],
    );
    assert.deepEqual(result.installed[0].installedIn, ["claude", "agents"]);
    assert.equal(fs.existsSync(path.join(existing, "stale.md")), false);
    assert.equal(fs.existsSync(path.join(existing, "references", "old.md")), false);
    assert.equal(fs.existsSync(path.join(existing, "notes.md")), true);
    assert.equal(fs.existsSync(path.join(existing, "SKILL.md")), true);
    assert.equal(fs.existsSync(markerPath("claude", "review-pr")), true);
    assert.equal(fs.existsSync(markerPath("agents", "review-pr")), true);
  });

  it("rolls back earlier targets when a later target fails", async () => {
    activate("claude", "agents");
    const dest = path.join(env.HOME, ".claude", "skills", "review-pr");
    writeSkill(
      path.join(env.HOME, ".claude", "skills"),
      "review-pr",
      skillMd("review-pr", "Keep this"),
    );
    writeFile(path.join(dest, "keep-me.md"), "prior companion\n");
    const preview = await previewMarkdown("review-pr");
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          request: {
            previewId: preview.previewId,
            selected: ["review-pr"],
            replace: true,
            trustPluginCode: false,
          },
          env,
          afterTargetWrite: (target) => {
            if (target === "agents") {
              throw new Error("Could not install skills to every target");
            }
          },
        }),
      /could not install|forced|target/i,
    );
    assert.equal(
      fs.readFileSync(path.join(dest, "SKILL.md"), "utf8").includes("Keep this"),
      true,
    );
    assert.equal(
      fs.readFileSync(path.join(dest, "keep-me.md"), "utf8"),
      "prior companion\n",
    );
    assert.equal(fs.existsSync(path.join(SKILL_DIRS(env).agents, "review-pr")), false);
  });

  it("strips a spoofed marker and writes a main-owned curated marker", async () => {
    activate("claude");
    const preview = await previewPonytailCatalog();
    const staged = path.join(importsRoot(), preview.previewId);
    const skillDir = path.join(staged, "stage");
    const walk = [skillDir];
    let planted = false;
    while (walk.length) {
      const dir = walk.pop();
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk.push(full);
        if (ent.name === "SKILL.md" && path.basename(dir) === "ponytail") {
          writeFile(
            path.join(dir, ".solenta-skill.json"),
            JSON.stringify({
              provenance: "curated",
              catalogId: "evil-catalog",
              token: "ghs_spoof",
            }),
          );
          planted = true;
        }
      }
    }
    assert.equal(planted, true);

    const result = await installImport({
      userDataPath: userData,
      request: {
        previewId: preview.previewId,
        selected: ["ponytail"],
        replace: false,
        trustPluginCode: true,
      },
      env,
    });
    assert.deepEqual(result.installed[0].installedIn, ["claude"]);
    assert.ok(result.plugins.length > 0);
    const marker = readMarker("claude", "ponytail");
    assert.match(marker.installId, /^[a-f0-9]{32}$/);
    assert.equal(marker.provenance, undefined);
    assert.equal(marker.catalogId, undefined);
    assert.equal(marker.token, undefined);
    assert.equal(typeof marker.sourceLabel, "string");
    assert.ok(marker.sourceLabel);
    assert.equal(JSON.stringify(marker).includes("ghs_spoof"), false);
    assert.equal(JSON.stringify(result).includes("ghs_spoof"), false);

    const registry = readRegistry();
    const rec = registry.installs[marker.installId];
    assert.ok(rec);
    assert.equal(rec.provenance, "curated");
    assert.equal(rec.catalogId, "ponytail");
    assert.equal(rec.sourceUrl, PONYTAIL_URL);
    assert.equal(rec.name, "ponytail");
    assert.equal(typeof rec.packageId, "string");
    assert.ok(rec.packageId);
    assert.equal(typeof rec.importedAt, "string");
    assert.ok(rec.importedAt);
    assert.equal(JSON.stringify(registry).includes("ghs_spoof"), false);
    assert.equal(JSON.stringify(registry).includes("ghs_should_never_leak"), false);
    const leftovers = fs
      .readdirSync(path.join(userData, "skills"))
      .filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);

    const unverified = listSkills(null, env).find((s) => s.name === "ponytail");
    assert.equal(unverified.provenance, "added");
    const listed = listSkills(null, env, userData);
    const row = listed.find((s) => s.name === "ponytail");
    assert.equal(row.provenance, "curated");
    assert.equal(row.origin.catalogId, "ponytail");
    assert.equal(row.source, "claude");
    const catalog = listCatalog({ env, userDataPath: userData });
    assert.equal(catalog[0].installed, true);
  });

  it("skips plugin extras when trustPluginCode is false", async () => {
    activate("claude");
    const preview = await previewPonytailCatalog();
    const calls = [];
    const result = await installImport({
      userDataPath: userData,
      request: {
        previewId: preview.previewId,
        selected: ["ponytail-help"],
        replace: false,
        trustPluginCode: false,
      },
      env,
      runFile: async (binary, args, opts) => {
        calls.push({ binary, args, opts });
        throw new Error("runner must not be called");
      },
    });
    assert.equal(calls.length, 0);
    assert.ok(result.plugins.length > 0);
    assert.ok(result.plugins.every((p) => p.status === "skipped"));
  });

  it("does not activate local ZIP extras even when trusted", async () => {
    activate("claude");
    const root = path.join(tmp, "local-pony");
    writePonytailShape(root);
    const preview = await pickImport({
      userDataPath: userData,
      dialog: {
        showOpenDialog: async () => ({
          canceled: false,
          filePaths: [
            (() => {
              const zipPath = path.join(tmp, "local-pony.zip");
              fs.writeFileSync(zipPath, zipFromTree(root));
              return zipPath;
            })(),
          ],
        }),
      },
      env,
    });
    const calls = [];
    const result = await installImport({
      userDataPath: userData,
      request: {
        previewId: preview.previewId,
        selected: ["ponytail-help"],
        replace: false,
        trustPluginCode: true,
      },
      env,
      runFile: async (binary, args) => {
        calls.push({ binary, args });
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(calls.length, 0);
    assert.ok(result.plugins.length > 0);
    assert.ok(result.plugins.every((p) => p.status === "unsupported"));
    assert.equal(
      fs.existsSync(path.join(SKILL_DIRS(env).claude, "ponytail-help", "SKILL.md")),
      true,
    );
  });

  it("activates trusted GitHub extras, keeps skills if Codex fails, and succeeds Grok", async () => {
    activate("claude");
    const preview = await previewPonytailCatalog();
    const dest = path.join(SKILL_DIRS(env).claude, "ponytail-help", "SKILL.md");
    const calls = [];
    const result = await installImport({
      userDataPath: userData,
      request: {
        previewId: preview.previewId,
        selected: ["ponytail-help"],
        replace: false,
        trustPluginCode: true,
      },
      env,
      runFile: async (binary, args, opts) => {
        calls.push({ binary, args, opts });
        assert.equal(opts && opts.shell, undefined);
        if (binary === "codex" && args[1] === "marketplace") {
          const err = new Error("codex marketplace add failed");
          err.stderr = `${"nope ".repeat(80)}${path.join(userData, "skill-imports")}/stage ghs_should_never_leak`;
          throw err;
        }
        return { stdout: "ok", stderr: "" };
      },
    });
    assert.equal(fs.existsSync(dest), true, "skill files must survive plugin failure");
    const byProvider = Object.fromEntries(
      result.plugins.map((row) => [row.provider, row]),
    );
    assert.equal(byProvider.codex.status, "failed");
    assert.equal(byProvider.grok.status, "activated");
    assert.equal(byProvider.claude.status, "manual");
    assert.deepEqual(byProvider.claude.instructions, [
      "/plugin marketplace add DietrichGebert/ponytail",
      "/plugin install ponytail@ponytail",
    ]);
    assert.equal(byProvider.plugin.status, "covered");
    assert.equal(byProvider.hooks.status, "covered");
    assert.equal(byProvider.commands.status, "covered");
    assert.ok(byProvider.codex.error.length <= 200);
    assert.equal(byProvider.codex.error.includes("ghs_should_never_leak"), false);
    assert.equal(JSON.stringify(result).includes(userData), false);
    assert.deepEqual(
      calls.map((c) => [c.binary, c.args[1]]),
      [
        ["codex", "marketplace"],
        ["grok", "install"],
      ],
    );
    assert.deepEqual(calls[1].args, [
      "plugin",
      "install",
      "DietrichGebert/ponytail",
      "--trust",
    ]);
  });

  it("does not activate a tree-ref preview even when trusted", async () => {
    activate("claude");
    const preview = await previewPonytailCatalog();
    const manifestPath = path.join(
      importsRoot(),
      preview.previewId,
      "manifest.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.sourceUrl = "https://github.com/DietrichGebert/ponytail/tree/main";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const calls = [];
    const result = await installImport({
      userDataPath: userData,
      request: {
        previewId: preview.previewId,
        selected: ["ponytail-help"],
        replace: false,
        trustPluginCode: true,
      },
      env,
      runFile: async (binary, args) => {
        calls.push({ binary, args });
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(calls.length, 0);
    assert.ok(result.plugins.length > 0);
    assert.ok(result.plugins.every((p) => p.status === "unsupported"));
    assert.ok(
      result.plugins.every(
        (p) =>
          p.error ===
          "Provider plugin activation cannot safely pin the previewed ref.",
      ),
    );
    assert.ok(result.plugins.every((p) => !p.instructions && !p.commands));
  });

  it("treats a non-boolean trustPluginCode as untrusted", async () => {
    activate("claude");
    const preview = await previewPonytailCatalog();
    const calls = [];
    const result = await installImport({
      userDataPath: userData,
      request: {
        previewId: preview.previewId,
        selected: ["ponytail-help"],
        replace: false,
        trustPluginCode: 1,
      },
      env,
      runFile: async (binary, args) => {
        calls.push({ binary, args });
        throw new Error("runner must not be called");
      },
    });
    assert.equal(calls.length, 0);
    assert.ok(result.plugins.every((p) => p.status === "skipped"));
  });

  it("does not copy source symlinks into the destination", async () => {
    activate("claude");
    const root = path.join(tmp, "link-src");
    writeSkill(root, "linked", skillMd("linked", "Has a link"));
    const secret = path.join(tmp, "secret.txt");
    fs.writeFileSync(secret, "do not copy\n");
    const zipPath = path.join(tmp, "linked.zip");
    fs.writeFileSync(zipPath, zipFromTree(root));
    const preview = await pickImport({
      userDataPath: userData,
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [zipPath] }),
      },
      env,
    });
    fs.symlinkSync(secret, path.join(importsRoot(), preview.previewId, "stage", "linked", "leak"));
    await installImport({
      userDataPath: userData,
      request: {
        previewId: preview.previewId,
        selected: ["linked"],
        replace: false,
        trustPluginCode: false,
      },
      env,
    });
    const dest = path.join(SKILL_DIRS(env).claude, "linked");
    assert.equal(fs.existsSync(path.join(dest, "leak")), false);
    assert.equal(fs.existsSync(path.join(dest, "SKILL.md")), true);
  });

  it("preserves markers and companions when syncing drift", async () => {
    activate("claude", "agents");
    const preview = await previewMarkdown("ship-it");
    await installImport({
      userDataPath: userData,
      request: {
        previewId: preview.previewId,
        selected: ["ship-it"],
        replace: false,
        trustPluginCode: false,
      },
      env,
    });
    const agentsDir = path.join(SKILL_DIRS(env).agents, "ship-it");
    fs.rmSync(agentsDir, { recursive: true, force: true });
    assert.deepEqual(syncSkills(env), { copied: 1, skills: ["ship-it"] });
    assert.deepEqual(readMarker("agents", "ship-it"), readMarker("claude", "ship-it"));
    assert.equal(fs.existsSync(path.join(agentsDir, "SKILL.md")), true);
  });
});

describe("listSkills provenance", () => {
  it("treats a missing or malformed marker as added", () => {
    activate("claude");
    writeSkill(
      path.join(env.HOME, ".claude", "skills"),
      "hand-rolled",
      skillMd("hand-rolled", "Unmanaged"),
    );
    writeSkill(
      path.join(env.HOME, ".claude", "skills"),
      "broken",
      skillMd("broken", "Bad marker"),
    );
    writeFile(
      path.join(env.HOME, ".claude", "skills", "broken", ".solenta-skill.json"),
      "{not json",
    );
    const list = listSkills(null, env);
    assert.equal(list.find((s) => s.name === "hand-rolled").provenance, "added");
    assert.equal(list.find((s) => s.name === "broken").provenance, "added");
    assert.equal(list.find((s) => s.name === "hand-rolled").origin, undefined);
  });

  it("does not trust a provider-local marker by shape", () => {
    activate("claude");
    writeSkill(
      path.join(env.HOME, ".claude", "skills"),
      "ponytail",
      skillMd("ponytail", "Spoofed"),
    );
    writeFile(
      path.join(env.HOME, ".claude", "skills", "ponytail", ".solenta-skill.json"),
      JSON.stringify({
        provenance: "curated",
        catalogId: "ponytail",
        installId: "a".repeat(32),
        sourceLabel: "Ponytail",
        sourceUrl: PONYTAIL_URL,
      }),
    );
    const row = listSkills(null, env, userData).find((s) => s.name === "ponytail");
    assert.equal(row.provenance, "added");
    assert.equal(row.origin, undefined);
    assert.equal(listCatalog({ env, userDataPath: userData })[0].installed, false);
  });

  it("treats fictional install IDs and unknown catalog IDs as added", () => {
    activate("claude");
    writeSkill(
      path.join(env.HOME, ".claude", "skills"),
      "ponytail",
      skillMd("ponytail", "Fake registry"),
    );
    const installId = "b".repeat(32);
    writeFile(
      path.join(env.HOME, ".claude", "skills", "ponytail", ".solenta-skill.json"),
      JSON.stringify({ installId, sourceLabel: "Ponytail" }),
    );
    fs.mkdirSync(path.join(userData, "skills"), { recursive: true });
    fs.writeFileSync(
      registryPath(),
      JSON.stringify({
        version: 1,
        installs: {
          [installId]: {
            name: "ponytail",
            provenance: "curated",
            catalogId: "not-in-catalog",
            sourceLabel: "Ponytail",
            sourceUrl: PONYTAIL_URL,
          },
        },
      }),
    );
    const unknownCatalog = listSkills(null, env, userData).find(
      (s) => s.name === "ponytail",
    );
    assert.equal(unknownCatalog.provenance, "added");

    writeFile(
      path.join(env.HOME, ".claude", "skills", "ponytail", ".solenta-skill.json"),
      JSON.stringify({ installId: "c".repeat(32), sourceLabel: "Ponytail" }),
    );
    const unknownId = listSkills(null, env, userData).find(
      (s) => s.name === "ponytail",
    );
    assert.equal(unknownId.provenance, "added");
  });

  it("does not apply a registry record to a differently named skill directory", () => {
    activate("claude");
    writeSkill(
      path.join(env.HOME, ".claude", "skills"),
      "ponytail",
      skillMd("ponytail", "Owned install"),
    );
    writeSkill(
      path.join(env.HOME, ".claude", "skills"),
      "ship-it",
      skillMd("ship-it", "Copied marker"),
    );
    const installId = "e".repeat(32);
    const marker = JSON.stringify({ installId, sourceLabel: "Ponytail" });
    writeFile(
      path.join(env.HOME, ".claude", "skills", "ponytail", ".solenta-skill.json"),
      marker,
    );
    writeFile(
      path.join(env.HOME, ".claude", "skills", "ship-it", ".solenta-skill.json"),
      marker,
    );
    fs.mkdirSync(path.join(userData, "skills"), { recursive: true });
    fs.writeFileSync(
      registryPath(),
      `${JSON.stringify({
        version: 1,
        installs: {
          [installId]: {
            name: "ponytail",
            provenance: "curated",
            catalogId: "ponytail",
            sourceLabel: "Ponytail",
            sourceUrl: PONYTAIL_URL,
            packageId: "ponytail",
            importedAt: "2026-08-24T18:00:00.000Z",
          },
        },
      })}\n`,
    );
    const listed = listSkills(null, env, userData);
    const owned = listed.find((s) => s.name === "ponytail");
    const copied = listed.find((s) => s.name === "ship-it");
    assert.equal(owned.provenance, "curated");
    assert.equal(owned.origin.catalogId, "ponytail");
    assert.equal(copied.provenance, "added");
    assert.equal(copied.origin, undefined);
    assert.equal(listCatalog({ env, userDataPath: userData })[0].installed, true);
  });

  it("prefers a later registry-verified curated copy over an earlier unmanaged one", () => {
    activate("claude", "agents");
    writeSkill(
      path.join(env.HOME, ".claude", "skills"),
      "ponytail",
      skillMd("ponytail", "Unmanaged first"),
    );
    writeSkill(
      path.join(env.HOME, ".agents", "skills"),
      "ponytail",
      skillMd("ponytail", "Managed later"),
    );
    const installId = "d".repeat(32);
    writeFile(
      path.join(env.HOME, ".agents", "skills", "ponytail", ".solenta-skill.json"),
      JSON.stringify({ installId, sourceLabel: "Ponytail" }),
    );
    fs.mkdirSync(path.join(userData, "skills"), { recursive: true });
    fs.writeFileSync(
      registryPath(),
      `${JSON.stringify({
        version: 1,
        installs: {
          [installId]: {
            name: "ponytail",
            provenance: "curated",
            catalogId: "ponytail",
            sourceLabel: "Ponytail",
            sourceUrl: PONYTAIL_URL,
            packageId: "ponytail",
            importedAt: "2026-08-24T18:00:00.000Z",
          },
        },
      })}\n`,
    );
    const row = listSkills(null, env, userData).find((s) => s.name === "ponytail");
    assert.equal(row.provenance, "curated");
    assert.equal(row.origin.catalogId, "ponytail");
    assert.equal(row.origin.sourceUrl, PONYTAIL_URL);
    assert.equal(row.source, "claude");
    assert.deepEqual(row.installedIn, ["claude", "agents"]);
    assert.equal(listCatalog({ env, userDataPath: userData })[0].installed, true);
  });

  it("marks project skills as project even when a marker is present", () => {
    activate("claude");
    const project = path.join(tmp, "proj");
    writeSkill(
      path.join(project, ".claude", "skills"),
      "local-rules",
      skillMd("local-rules", "Repo rules"),
    );
    writeFile(
      path.join(project, ".claude", "skills", "local-rules", ".solenta-skill.json"),
      JSON.stringify({ provenance: "curated", catalogId: "ponytail" }),
    );
    const row = listSkills(project, env).find((s) => s.source === "project");
    assert.equal(row.provenance, "project");
    assert.equal(row.name, "local-rules");
  });
});

describe("install safety and cleanup", () => {
  it("rejects a symlinked skill root and leaves destinations untouched", async () => {
    activate("claude");
    const preview = await previewMarkdown("review-pr");
    const real = stageSkillDir(preview.previewId, "review-pr");
    const decoy = path.join(tmp, "decoy-skill");
    writeSkill(path.dirname(decoy), "decoy-skill", skillMd("review-pr", "Decoy"));
    fs.rmSync(real, { recursive: true, force: true });
    fs.symlinkSync(decoy, real);
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          request: {
            previewId: preview.previewId,
            selected: ["review-pr"],
            replace: false,
            trustPluginCode: false,
          },
          env,
        }),
      /real directory|symlink/i,
    );
    assert.equal(fs.existsSync(path.join(SKILL_DIRS(env).claude, "review-pr")), false);
    assert.equal(fs.existsSync(path.join(importsRoot(), preview.previewId, "incoming")), false);
  });

  it("rejects a deleted stage root and does not write destinations or leftover incoming", async () => {
    activate("claude");
    const preview = await previewMarkdown("review-pr");
    fs.rmSync(stageSkillDir(preview.previewId, "review-pr"), {
      recursive: true,
      force: true,
    });
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          request: {
            previewId: preview.previewId,
            selected: ["review-pr"],
            replace: false,
            trustPluginCode: false,
          },
          env,
        }),
      /missing|unreadable|SKILL\.md/i,
    );
    assert.equal(fs.existsSync(path.join(SKILL_DIRS(env).claude, "review-pr")), false);
    assert.equal(fs.existsSync(path.join(importsRoot(), preview.previewId, "incoming")), false);
    assert.equal(fs.existsSync(registryPath()), false);
  });

  it("rejects a malformed createdAt and does not delete the valid preview being installed", async () => {
    activate("claude");
    const valid = await previewMarkdown("keep-me");
    const bad = await previewMarkdown("review-pr");
    const badManifest = path.join(importsRoot(), bad.previewId, "manifest.json");
    const parsed = JSON.parse(fs.readFileSync(badManifest, "utf8"));
    parsed.createdAt = "not-a-timestamp";
    fs.writeFileSync(badManifest, `${JSON.stringify(parsed, null, 2)}\n`);
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          request: {
            previewId: bad.previewId,
            selected: ["review-pr"],
            replace: false,
            trustPluginCode: false,
          },
          env,
        }),
      /invalid/i,
    );
    assert.equal(fs.existsSync(path.join(importsRoot(), valid.previewId)), true);
    const stillValid = await installImport({
      userDataPath: userData,
      request: {
        previewId: valid.previewId,
        selected: ["keep-me"],
        replace: false,
        trustPluginCode: false,
      },
      env,
    });
    assert.deepEqual(stillValid.installed.map((s) => s.name), ["keep-me"]);
  });
});

describe("registry transactions", () => {
  it("updates the registry only after a replace succeeds and rolls it back on failure", async () => {
    activate("claude", "agents");
    const first = await previewPonytailCatalog();
    await installImport({
      userDataPath: userData,
      request: {
        previewId: first.previewId,
        selected: ["ponytail"],
        replace: false,
        trustPluginCode: false,
      },
      env,
    });
    const before = readMarker("claude", "ponytail");
    const oldId = before.installId;
    const oldRec = readRegistry().installs[oldId];
    assert.equal(oldRec.catalogId, "ponytail");

    const second = await previewPonytailCatalog();
    await assert.rejects(
      () =>
        installImport({
          userDataPath: userData,
          request: {
            previewId: second.previewId,
            selected: ["ponytail"],
            replace: true,
            trustPluginCode: false,
          },
          env,
          afterTargetWrite: (target) => {
            if (target === "agents") {
              throw new Error("Could not install skills to every target");
            }
          },
        }),
      /could not install/i,
    );
    assert.equal(readMarker("claude", "ponytail").installId, oldId);
    assert.deepEqual(readRegistry().installs[oldId], oldRec);
    assert.equal(Object.keys(readRegistry().installs).length, 1);

    const third = await previewPonytailCatalog();
    await installImport({
      userDataPath: userData,
      request: {
        previewId: third.previewId,
        selected: ["ponytail"],
        replace: true,
        trustPluginCode: false,
      },
      env,
    });
    const next = readMarker("claude", "ponytail");
    assert.notEqual(next.installId, oldId);
    const registry = readRegistry();
    assert.equal(registry.installs[oldId], undefined);
    assert.equal(registry.installs[next.installId].catalogId, "ponytail");
    assert.equal(registry.installs[next.installId].provenance, "curated");
  });

  it("removeSkill drops only that skill's registry rows; discard leaves the registry alone", async () => {
    activate("claude");
    const first = await previewMarkdown("keep-me");
    await installImport({
      userDataPath: userData,
      request: {
        previewId: first.previewId,
        selected: ["keep-me"],
        replace: false,
        trustPluginCode: false,
      },
      env,
    });
    const keepId = readMarker("claude", "keep-me").installId;
    const second = await previewMarkdown("drop-me");
    await installImport({
      userDataPath: userData,
      request: {
        previewId: second.previewId,
        selected: ["drop-me"],
        replace: false,
        trustPluginCode: false,
      },
      env,
    });
    const pending = await previewMarkdown("never-installed");
    await discardImport({ userDataPath: userData, previewId: pending.previewId });
    assert.ok(readRegistry().installs[keepId]);
    assert.equal(fs.existsSync(path.join(importsRoot(), pending.previewId)), false);

    removeSkill({ name: "drop-me" }, env, userData);
    const registry = readRegistry();
    assert.ok(registry.installs[keepId]);
    assert.equal(
      Object.values(registry.installs).some((rec) => rec.name === "drop-me"),
      false,
    );
    assert.equal(listSkills(null, env, userData).some((s) => s.name === "keep-me"), true);
  });
});
