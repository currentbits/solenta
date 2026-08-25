/**
 * Skill package import core: GitHub URL parsing, directory discovery,
 * ZIP extraction limits, Markdown staging, and mocked GitHub downloads.
 * Run: node --test electron/test/skill-packages.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const {
  parseGitHubSkillUrl,
  discoverSkillPackages,
  safeExtractZip,
  stageMarkdownSkill,
  stageGitHubSkill,
  MAX_ARCHIVE_BYTES,
  MAX_EXPANDED_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_FILE_BYTES,
} = require("../skillPackages.js");

const PONYTAIL_SKILLS = [
  "ponytail",
  "ponytail-audit",
  "ponytail-debt",
  "ponytail-gain",
  "ponytail-help",
  "ponytail-review",
];

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-skill-pkg-"));
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
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

function writePonytailShape(root) {
  for (const name of PONYTAIL_SKILLS) {
    writeSkill(path.join(root, "skills"), name, skillMd(name, `${name} helper`));
    writeFile(
      path.join(root, "skills", name, "references", "notes.md"),
      `${name} notes\n`,
    );
  }
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
  writeSkill(
    path.join(root, ".git", "hooks"),
    "git-skill",
    skillMd("git-skill", "Git hook skill"),
  );
  writeSkill(
    path.join(root, "node_modules", "pkg"),
    "dep-skill",
    skillMd("dep-skill", "Dependency skill"),
  );
  writeSkill(
    path.join(root, "__MACOSX", "skills"),
    "mac-skill",
    skillMd("mac-skill", "Resource fork skill"),
  );
}

/**
 * Minimal ZIP writer so tests can plant traversal, symlink, and size-limit
 * entries without a second dependency.
 * @param {Array<{
 *   name: string,
 *   data?: Buffer | string,
 *   symlink?: boolean,
 *   fifo?: boolean,
 *   directory?: boolean,
 *   compress?: boolean,
 *   uncompressedSize?: number,
 * }>} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "binary");
    const data = entry.directory
      ? Buffer.alloc(0)
      : Buffer.from(entry.data ?? "");
    const method = entry.compress ? 8 : 0;
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const uncompressedSize =
      entry.uncompressedSize != null ? entry.uncompressedSize : data.length;
    let extAttr = 0o100644 << 16;
    if (entry.symlink) extAttr = 0o120777 << 16;
    else if (entry.fifo) extAttr = 0o010644 << 16;
    else if (entry.directory) extAttr = 0o040755 << 16;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localChunk = Buffer.concat([local, name, compressed]);
    locals.push(localChunk);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(extAttr >>> 0, 38);
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

function writeZip(file, entries) {
  writeFile(file, buildZip(entries));
  return file;
}

function zipFromTree(root) {
  /** @type {Array<{ name: string, data: Buffer }>} */
  const entries = [];
  function walk(dir, rel) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, nextRel);
      else if (ent.isFile()) entries.push({ name: nextRel, data: fs.readFileSync(full) });
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

function jsonResponse(body, status = 200) {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: asyncBody(raw),
    arrayBuffer: async () => {
      throw new Error("arrayBuffer should not be used");
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
    arrayBuffer: async () => {
      throw new Error("arrayBuffer should not be used");
    },
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

describe("parseGitHubSkillUrl", () => {
  it("accepts public github.com, tree, blob, raw, and codeload zip URLs", () => {
    assert.deepEqual(parseGitHubSkillUrl("https://github.com/dietrichgebert/ponytail"), {
      owner: "dietrichgebert",
      repo: "ponytail",
      ref: null,
      path: "",
      kind: "repo",
    });
    assert.deepEqual(
      parseGitHubSkillUrl("https://www.github.com/acme/tools.git"),
      {
        owner: "acme",
        repo: "tools",
        ref: null,
        path: "",
        kind: "repo",
      },
    );
    assert.deepEqual(
      parseGitHubSkillUrl("https://github.com/acme/tools/tree/main"),
      {
        owner: "acme",
        repo: "tools",
        ref: "main",
        path: "",
        kind: "tree",
      },
    );
    assert.deepEqual(
      parseGitHubSkillUrl("https://github.com/acme/tools/tree/main/skills/review"),
      {
        owner: "acme",
        repo: "tools",
        ref: "main",
        path: "skills/review",
        kind: "tree",
      },
    );
    assert.deepEqual(
      parseGitHubSkillUrl(
        "https://github.com/acme/tools/blob/main/skills/review/SKILL.md",
      ),
      {
        owner: "acme",
        repo: "tools",
        ref: "main",
        path: "skills/review/SKILL.md",
        kind: "blob",
      },
    );
    assert.deepEqual(
      parseGitHubSkillUrl(
        "https://raw.githubusercontent.com/acme/tools/main/skills/review/SKILL.md",
      ),
      {
        owner: "acme",
        repo: "tools",
        ref: "main",
        path: "skills/review/SKILL.md",
        kind: "raw",
      },
    );
    assert.deepEqual(
      parseGitHubSkillUrl("https://codeload.github.com/acme/tools/zip/main"),
      {
        owner: "acme",
        repo: "tools",
        ref: "main",
        path: "",
        kind: "zip",
      },
    );
    assert.deepEqual(
      parseGitHubSkillUrl(
        "https://codeload.github.com/acme/tools/zip/refs/heads/feat/slash",
      ),
      {
        owner: "acme",
        repo: "tools",
        ref: "feat/slash",
        path: "",
        kind: "zip",
      },
    );
    assert.deepEqual(
      parseGitHubSkillUrl(
        "https://github.com/acme/tools/archive/refs/heads/main.zip",
      ),
      {
        owner: "acme",
        repo: "tools",
        ref: "main",
        path: "",
        kind: "zip",
      },
    );
  });

  it("takes the first tree/blob segment as the ref and does not guess slash refs", () => {
    assert.deepEqual(
      parseGitHubSkillUrl("https://github.com/acme/tools/tree/feature/my-branch"),
      {
        owner: "acme",
        repo: "tools",
        ref: "feature",
        path: "my-branch",
        kind: "tree",
      },
    );
  });

  it("rejects encoded-slash refs as ambiguous with an actionable error", () => {
    assert.throws(
      () => parseGitHubSkillUrl("https://github.com/acme/tools/tree/feat%2Fslash"),
      /ambiguous|cannot be resolved|slash/i,
    );
    assert.throws(
      () =>
        parseGitHubSkillUrl(
          "https://github.com/acme/tools/blob/feat%2Fslash/SKILL.md",
        ),
      /ambiguous|cannot be resolved|slash/i,
    );
  });

  it("rejects credentials, non-HTTPS, and non-GitHub hosts", () => {
    const bad = [
      "http://github.com/acme/tools",
      "ftp://github.com/acme/tools",
      "https://user:pass@github.com/acme/tools",
      "https://user@github.com/acme/tools",
      "https://gitlab.com/acme/tools",
      "https://github.com.evil.com/acme/tools",
      "https://evil.com/github.com/acme/tools",
      "https://raw.githubusercontent.com.evil.com/acme/tools/main/SKILL.md",
      "https://codeload.github.com.evil.com/acme/tools/zip/main",
      "https://example.com/acme/tools",
    ];
    for (const input of bad) {
      assert.throws(() => parseGitHubSkillUrl(input), /https|github|credential|host/i, input);
    }
  });

  it("rejects blob/raw URLs that are not SKILL.md and unusable tree refs", () => {
    assert.throws(
      () => parseGitHubSkillUrl("https://github.com/acme/tools/blob/main/README.md"),
      /SKILL\.md/i,
    );
    assert.throws(
      () =>
        parseGitHubSkillUrl("https://raw.githubusercontent.com/acme/tools/main/README.md"),
      /SKILL\.md/i,
    );
    assert.throws(
      () => parseGitHubSkillUrl("https://github.com/acme/tools/tree/"),
      /ref/i,
    );
    assert.throws(
      () => parseGitHubSkillUrl("https://github.com/acme/tools/issues/1"),
      /github|unsupported|url/i,
    );
  });
});

describe("discoverSkillPackages", () => {
  it("preserves a complex skill directory and warns on executable-looking files", async () => {
    const root = path.join(tmp, "ship-it");
    writeFile(path.join(root, "SKILL.md"), skillMd("ship-it", "Ship the thing"));
    writeFile(path.join(root, "references", "api.md"), "api notes\n");
    writeFile(path.join(root, "examples", "ok.md"), "example\n");
    writeFile(path.join(root, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
    fs.chmodSync(path.join(root, "scripts", "run.sh"), 0o755);

    const packages = await discoverSkillPackages(path.join(tmp));
    assert.equal(packages.length, 1);
    const pkg = packages[0];
    assert.equal(pkg.name, "ship-it");
    assert.equal(pkg.description, "Ship the thing");
    assert.equal(pkg.skillRoot, root);
    assert.deepEqual(pkg.files, [
      "SKILL.md",
      "examples/ok.md",
      "references/api.md",
      "scripts/run.sh",
    ]);
    assert.equal(pkg.skillMdBytes, fs.statSync(path.join(root, "SKILL.md")).size);
    assert.equal(
      pkg.totalBytes,
      pkg.files.reduce((n, rel) => n + fs.statSync(path.join(root, rel)).size, 0),
    );
    assert.ok(pkg.warnings.some((w) => /executable/i.test(w) && /run\.sh/.test(w)));
  });

  it("prefers skills/* in a Ponytail-shaped collection and ignores decoy trees", async () => {
    writePonytailShape(tmp);
    const packages = await discoverSkillPackages(tmp);
    assert.deepEqual(
      packages.map((p) => p.name),
      PONYTAIL_SKILLS,
    );
    for (const pkg of packages) {
      assert.ok(pkg.skillRoot.endsWith(path.join("skills", pkg.name)));
      assert.ok(pkg.files.includes("SKILL.md"));
      assert.ok(pkg.files.includes("references/notes.md"));
      assert.match(pkg.description, /helper/);
    }
  });

  it("unwraps one GitHub archive wrapper directory", async () => {
    const wrap = path.join(tmp, "ponytail-main");
    writePonytailShape(wrap);
    const packages = await discoverSkillPackages(tmp);
    assert.deepEqual(
      packages.map((p) => p.name),
      PONYTAIL_SKILLS,
    );
    assert.ok(packages[0].skillRoot.startsWith(wrap));
  });

  it("rejects duplicate and invalid skill names", async () => {
    writeFile(path.join(tmp, "SKILL.md"), skillMd("dup", "Root copy"));
    writeSkill(path.join(tmp, "skills"), "dup", skillMd("dup", "Nested copy"));
    await assert.rejects(() => discoverSkillPackages(tmp), /duplicate/i);

    const invalid = path.join(tmp, "invalid");
    fs.mkdirSync(invalid);
    writeSkill(path.join(invalid, "skills"), "Legacy.Skill", skillMd("legacy", "Old"));
    await assert.rejects(() => discoverSkillPackages(invalid), /name|invalid/i);
  });

  it("does not follow symlinks out of a skill directory", async () => {
    const root = path.join(tmp, "safe-skill");
    writeFile(path.join(root, "SKILL.md"), skillMd("safe-skill", "Safe"));
    const outside = path.join(tmp, "secret.txt");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(root, "leak"));
    const packages = await discoverSkillPackages(tmp);
    assert.equal(packages.length, 1);
    assert.deepEqual(packages[0].files, ["SKILL.md"]);
    assert.ok(!packages[0].files.includes("leak"));
  });

  it("surfaces folded YAML descriptions from discovered SKILL.md files", async () => {
    writeFile(
      path.join(tmp, "ponytail", "SKILL.md"),
      [
        "---",
        "name: ponytail",
        "description: >",
        "  Forces the laziest solution that actually works, simplest, shortest, most",
        "  minimal.",
        "---",
        "",
        "# Ponytail",
        "",
      ].join("\n"),
    );
    const packages = await discoverSkillPackages(tmp);
    assert.equal(packages.length, 1);
    assert.match(packages[0].description, /Forces the laziest/);
    assert.notEqual(packages[0].description.trim(), ">");
  });
});

describe("safeExtractZip", () => {
  it("extracts a GitHub-wrapped collection and then discovers the six skills", async () => {
    const src = path.join(tmp, "src", "ponytail-main");
    writePonytailShape(src);
    const zipPath = path.join(tmp, "ponytail.zip");
    fs.writeFileSync(zipPath, zipFromTree(path.join(tmp, "src")));
    const out = path.join(tmp, "out");
    await safeExtractZip(zipPath, out);
    const packages = await discoverSkillPackages(out);
    assert.deepEqual(
      packages.map((p) => p.name),
      PONYTAIL_SKILLS,
    );
  });

  it("rejects traversal, absolute, drive, NUL, and symlink entries and cleans up", async () => {
    const cases = [
      [{ name: "../escape.txt", data: "x" }, /travers|parent|\.\./i],
      [{ name: "/etc/passwd", data: "x" }, /absolute|\//i],
      [{ name: "C:/Windows/win.ini", data: "x" }, /drive|absolute|windows/i],
      [{ name: "ok/\x00evil.txt", data: "x" }, /nul/i],
      [{ name: "mylink", data: "target", symlink: true }, /symlink|special/i],
      [{ name: "queue", data: "", fifo: true }, /special|fifo|type/i],
    ];
    for (const [entry, pattern] of cases) {
      const zipPath = path.join(tmp, `evil-${Buffer.from(entry.name).toString("hex")}.zip`);
      writeZip(zipPath, [entry]);
      const out = path.join(tmp, `out-${Buffer.from(entry.name).toString("hex")}`);
      await assert.rejects(() => safeExtractZip(zipPath, out), pattern);
      assert.equal(fs.existsSync(out), false, `partial output left for ${entry.name}`);
    }
  });

  it("enforces archive, expanded, entry-count, and per-file limits", async () => {
    const tooBigArchive = path.join(tmp, "huge.zip");
    fs.writeFileSync(tooBigArchive, Buffer.alloc(MAX_ARCHIVE_BYTES + 1));
    const out1 = path.join(tmp, "out-archive");
    await assert.rejects(() => safeExtractZip(tooBigArchive, out1), /25|archive|size/i);
    assert.equal(fs.existsSync(out1), false);

    const bomb = path.join(tmp, "bomb.zip");
    const pieces = Math.floor(MAX_EXPANDED_BYTES / MAX_FILE_BYTES) + 1;
    writeZip(
      bomb,
      Array.from({ length: pieces }, (_, i) => ({
        name: `bomb-${i}.bin`,
        data: Buffer.alloc(64),
        compress: true,
        uncompressedSize: MAX_FILE_BYTES,
      })),
    );
    const out2 = path.join(tmp, "out-bomb");
    await assert.rejects(() => safeExtractZip(bomb, out2), /100|expanded/i);
    assert.equal(fs.existsSync(out2), false);

    const many = path.join(tmp, "many.zip");
    writeZip(
      many,
      Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
        name: `f/${i}.txt`,
        data: "x",
      })),
    );
    const out3 = path.join(tmp, "out-many");
    await assert.rejects(() => safeExtractZip(many, out3), /2000|entr/i);
    assert.equal(fs.existsSync(out3), false);

    const fat = path.join(tmp, "fat.zip");
    writeZip(fat, [
      {
        name: "fat.bin",
        data: Buffer.alloc(64),
        compress: true,
        uncompressedSize: MAX_FILE_BYTES + 1,
      },
    ]);
    const out4 = path.join(tmp, "out-fat");
    await assert.rejects(() => safeExtractZip(fat, out4), /10|file|size/i);
    assert.equal(fs.existsSync(out4), false);
  });
});

describe("stageMarkdownSkill", () => {
  it("preserves original bytes including extra frontmatter and companions stay unused", async () => {
    const md = [
      "---",
      "name: extra-meta",
      "description: Does extra",
      "author: jane",
      "license: MIT",
      "compatibility: claude",
      "---",
      "",
      "# Extra",
      "",
      "Keep this body exactly.",
      "",
    ].join("\n");
    const src = path.join(tmp, "Extra Skill.md");
    fs.writeFileSync(src, md);
    const out = path.join(tmp, "staged");
    const pkg = await stageMarkdownSkill(src, out);
    assert.equal(pkg.name, "extra-meta");
    assert.equal(pkg.description, "Does extra");
    const copied = fs.readFileSync(path.join(pkg.skillRoot, "SKILL.md"));
    assert.deepEqual(copied, Buffer.from(md));
    assert.equal(pkg.skillMdBytes, Buffer.byteLength(md));
  });

  it("derives a slugged name from the filename when frontmatter has no name", async () => {
    const src = path.join(tmp, "My Cool Skill.md");
    fs.writeFileSync(src, "---\ndescription: Cool thing\n---\n\nHi.\n");
    const pkg = await stageMarkdownSkill(src, path.join(tmp, "staged-slug"));
    assert.equal(pkg.name, "my-cool-skill");
    assert.equal(pkg.description, "Cool thing");
  });

  it("requires a description and cleans up the staging directory on failure", async () => {
    const src = path.join(tmp, "empty.md");
    fs.writeFileSync(src, "# Only a heading\n");
    const out = path.join(tmp, "staged-fail");
    await assert.rejects(() => stageMarkdownSkill(src, out), /description/i);
    assert.equal(fs.existsSync(out), false);
  });
});

describe("stageGitHubSkill", () => {
  it("downloads a repo zip through fetchImpl and restricts discovery to the tree path", async () => {
    const src = path.join(tmp, "src", "tools-main");
    writeSkill(path.join(src, "skills"), "keep", skillMd("keep", "Keep me"));
    writeFile(path.join(src, "skills", "keep", "references", "a.md"), "a\n");
    writeSkill(path.join(src, "skills"), "other", skillMd("other", "Skip me"));
    const zip = zipFromTree(path.join(tmp, "src"));
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("codeload.github.com")) return bufferResponse(zip);
      throw new Error(`unexpected fetch ${url}`);
    };
    const out = path.join(tmp, "gh-tree");
    const result = await stageGitHubSkill(
      "https://github.com/acme/tools/tree/main/skills/keep",
      out,
      { fetchImpl },
    );
    assert.equal(result.source.kind, "tree");
    assert.equal(result.source.path, "skills/keep");
    assert.deepEqual(
      result.packages.map((p) => p.name),
      ["keep"],
    );
    assert.ok(result.packages[0].files.includes("references/a.md"));
    assert.ok(calls.every((c) => c.init && c.init.redirect === "manual"));
    assert.ok(
      calls.some((c) => String(c.url).startsWith("https://codeload.github.com/")),
    );
  });

  it("lists blob companions via the public Contents API without a token", async () => {
    const skillText = skillMd("review", "Review things");
    const fetchImpl = async (url, init) => {
      const u = String(url);
      assert.match(u, /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//);
      assert.equal(init.headers.Authorization, undefined);
      if (u.includes("/contents/skills/review")) {
        return jsonResponse([
          {
            type: "file",
            name: "SKILL.md",
            path: "skills/review/SKILL.md",
            size: skillText.length,
            download_url:
              "https://raw.githubusercontent.com/acme/tools/main/skills/review/SKILL.md",
          },
          {
            type: "file",
            name: "notes.md",
            path: "skills/review/notes.md",
            size: 6,
            download_url:
              "https://raw.githubusercontent.com/acme/tools/main/skills/review/notes.md",
          },
          {
            type: "dir",
            name: ".openclaw",
            path: "skills/review/.openclaw",
            url: "https://api.github.com/repos/acme/tools/contents/skills/review/.openclaw?ref=main",
          },
        ]);
      }
      if (u.includes("/contents/skills/review/.openclaw")) {
        throw new Error("must not follow ignored Contents directories");
      }
      if (u.endsWith("/skills/review/SKILL.md")) return bufferResponse(skillText);
      if (u.endsWith("/skills/review/notes.md")) return bufferResponse("notes\n");
      throw new Error(`unexpected fetch ${u}`);
    };
    const out = path.join(tmp, "gh-blob");
    const result = await stageGitHubSkill(
      "https://github.com/acme/tools/blob/main/skills/review/SKILL.md",
      out,
      { fetchImpl },
    );
    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0].name, "review");
    assert.deepEqual(result.packages[0].files.sort(), ["SKILL.md", "notes.md"]);
    assert.equal(
      fs.readFileSync(path.join(result.packages[0].skillRoot, "SKILL.md"), "utf8"),
      skillText,
    );
  });

  it("adds Authorization only when a token is provided", async () => {
    const skillText = skillMd("review", "Review things");
    const fetchImpl = async (url, init) => {
      assert.equal(init.headers.Authorization, "Bearer ghs_test");
      const u = String(url);
      if (u.includes("/contents/skills/review")) {
        return jsonResponse([
          {
            type: "file",
            name: "SKILL.md",
            path: "skills/review/SKILL.md",
            download_url:
              "https://raw.githubusercontent.com/acme/tools/main/skills/review/SKILL.md",
          },
        ]);
      }
      if (u.endsWith("/SKILL.md")) return bufferResponse(skillText);
      throw new Error(`unexpected fetch ${u}`);
    };
    const result = await stageGitHubSkill(
      "https://github.com/acme/tools/blob/main/skills/review/SKILL.md",
      path.join(tmp, "gh-blob-token"),
      { fetchImpl, githubToken: "ghs_test" },
    );
    assert.equal(result.packages[0].name, "review");
  });

  it("preserves nested companion paths for a root-level SKILL.md blob", async () => {
    const skillText = skillMd("root-skill", "Root skill");
    const fetchImpl = async (url) => {
      const u = String(url);
      if (/\/contents\/?(\?|$)/.test(u) || u.includes("/contents?ref=")) {
        return jsonResponse([
          {
            type: "file",
            name: "SKILL.md",
            path: "SKILL.md",
            download_url:
              "https://raw.githubusercontent.com/acme/tools/main/SKILL.md",
          },
          {
            type: "dir",
            name: "references",
            path: "references",
            url: "https://api.github.com/repos/acme/tools/contents/references?ref=main",
          },
          {
            type: "dir",
            name: "examples",
            path: "examples",
            url: "https://api.github.com/repos/acme/tools/contents/examples?ref=main",
          },
        ]);
      }
      if (u.includes("/contents/references")) {
        return jsonResponse([
          {
            type: "file",
            name: "notes.md",
            path: "references/notes.md",
            download_url:
              "https://raw.githubusercontent.com/acme/tools/main/references/notes.md",
          },
        ]);
      }
      if (u.includes("/contents/examples")) {
        return jsonResponse([
          {
            type: "file",
            name: "notes.md",
            path: "examples/notes.md",
            download_url:
              "https://raw.githubusercontent.com/acme/tools/main/examples/notes.md",
          },
        ]);
      }
      if (u.endsWith("/main/SKILL.md")) return bufferResponse(skillText);
      if (u.endsWith("/references/notes.md")) return bufferResponse("ref notes\n");
      if (u.endsWith("/examples/notes.md")) return bufferResponse("ex notes\n");
      throw new Error(`unexpected fetch ${u}`);
    };
    const result = await stageGitHubSkill(
      "https://github.com/acme/tools/blob/main/SKILL.md",
      path.join(tmp, "gh-root-blob"),
      { fetchImpl },
    );
    assert.equal(result.packages.length, 1);
    assert.deepEqual(result.packages[0].files.sort(), [
      "SKILL.md",
      "examples/notes.md",
      "references/notes.md",
    ]);
    assert.equal(
      fs.readFileSync(
        path.join(result.packages[0].skillRoot, "references", "notes.md"),
        "utf8",
      ),
      "ref notes\n",
    );
    assert.equal(
      fs.readFileSync(
        path.join(result.packages[0].skillRoot, "examples", "notes.md"),
        "utf8",
      ),
      "ex notes\n",
    );
  });

  it("returns an actionable error on Contents API 403/rate limit", async () => {
    const out = path.join(tmp, "gh-403");
    await assert.rejects(
      () =>
        stageGitHubSkill(
          "https://github.com/acme/tools/blob/main/skills/review/SKILL.md",
          out,
          {
            fetchImpl: async () => ({
              ok: false,
              status: 403,
              headers: { get: () => null },
              body: asyncBody(""),
            }),
          },
        ),
      /403|rate|token|auth|retry/i,
    );
    assert.equal(fs.existsSync(out), false);
  });

  it("rejects symlink and submodule Contents items instead of following them", async () => {
    const out = path.join(tmp, "gh-symlink");
    await assert.rejects(
      () =>
        stageGitHubSkill(
          "https://github.com/acme/tools/blob/main/skills/review/SKILL.md",
          out,
          {
            fetchImpl: async (url) => {
              if (String(url).includes("/contents/skills/review")) {
                return jsonResponse([
                  {
                    type: "file",
                    name: "SKILL.md",
                    path: "skills/review/SKILL.md",
                    download_url:
                      "https://raw.githubusercontent.com/acme/tools/main/skills/review/SKILL.md",
                  },
                  {
                    type: "symlink",
                    name: "leak",
                    path: "skills/review/leak",
                    target: "/etc/passwd",
                  },
                ]);
              }
              throw new Error(`unexpected fetch ${url}`);
            },
          },
        ),
      /symlink|special/i,
    );
    assert.equal(fs.existsSync(out), false);
  });

  it("enforces a shared Contents entry and declared-size budget", async () => {
    const tooMany = path.join(tmp, "gh-many");
    await assert.rejects(
      () =>
        stageGitHubSkill(
          "https://github.com/acme/tools/blob/main/skills/review/SKILL.md",
          tooMany,
          {
            fetchImpl: async (url) => {
              if (String(url).includes("/contents/skills/review")) {
                return jsonResponse(
                  Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
                    type: "file",
                    name: `f-${i}.md`,
                    path: `skills/review/f-${i}.md`,
                    size: 1,
                    download_url: `https://raw.githubusercontent.com/acme/tools/main/skills/review/f-${i}.md`,
                  })),
                );
              }
              throw new Error(`unexpected fetch ${url}`);
            },
          },
        ),
      /2000|entr/i,
    );
    assert.equal(fs.existsSync(tooMany), false);

    const tooFat = path.join(tmp, "gh-fat");
    await assert.rejects(
      () =>
        stageGitHubSkill(
          "https://github.com/acme/tools/blob/main/skills/review/SKILL.md",
          tooFat,
          {
            fetchImpl: async (url) => {
              if (String(url).includes("/contents/skills/review")) {
                return jsonResponse([
                  {
                    type: "file",
                    name: "SKILL.md",
                    path: "skills/review/SKILL.md",
                    size: 12,
                    download_url:
                      "https://raw.githubusercontent.com/acme/tools/main/skills/review/SKILL.md",
                  },
                  {
                    type: "file",
                    name: "fat.bin",
                    path: "skills/review/fat.bin",
                    size: MAX_FILE_BYTES + 1,
                    download_url:
                      "https://raw.githubusercontent.com/acme/tools/main/skills/review/fat.bin",
                  },
                ]);
              }
              throw new Error(`unexpected fetch ${url}`);
            },
          },
        ),
      /10|file/i,
    );
    assert.equal(fs.existsSync(tooFat), false);

    const tooBig = path.join(tmp, "gh-total");
    const pieces = Math.floor(MAX_EXPANDED_BYTES / MAX_FILE_BYTES) + 1;
    await assert.rejects(
      () =>
        stageGitHubSkill(
          "https://github.com/acme/tools/blob/main/skills/review/SKILL.md",
          tooBig,
          {
            fetchImpl: async (url) => {
              if (String(url).includes("/contents/skills/review")) {
                return jsonResponse(
                  Array.from({ length: pieces }, (_, i) => ({
                    type: "file",
                    name: `chunk-${i}.bin`,
                    path: `skills/review/chunk-${i}.bin`,
                    size: MAX_FILE_BYTES,
                    download_url: `https://raw.githubusercontent.com/acme/tools/main/skills/review/chunk-${i}.bin`,
                  })),
                );
              }
              throw new Error(`unexpected fetch ${url}`);
            },
          },
        ),
      /100|expanded|content/i,
    );
    assert.equal(fs.existsSync(tooBig), false);
  });

  it("rejects a redirect off the GitHub allowlist and oversize responses, then cleans up", async () => {
    const outEvil = path.join(tmp, "gh-evil");
    await assert.rejects(
      () =>
        stageGitHubSkill("https://github.com/acme/tools", outEvil, {
          fetchImpl: async () => redirectResponse("https://evil.example/payload.zip"),
        }),
      /redirect|host|github/i,
    );
    assert.equal(fs.existsSync(outEvil), false);

    const outSize = path.join(tmp, "gh-size");
    await assert.rejects(
      () =>
        stageGitHubSkill("https://github.com/acme/tools", outSize, {
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: {
              get(name) {
                return String(name).toLowerCase() === "content-length"
                  ? String(MAX_ARCHIVE_BYTES + 1)
                  : null;
              },
            },
            body: {
              async *[Symbol.asyncIterator]() {
                throw new Error("should not read an oversize body");
              },
            },
            arrayBuffer: async () => {
              throw new Error("should not read an oversize body");
            },
          }),
        }),
      /25|size|archive/i,
    );
    assert.equal(fs.existsSync(outSize), false);
  });

  it("aborts a stream without Content-Length just over the cap without buffering all input", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 1);
    let yielded = 0;
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 40; i += 1) {
            yielded += 1;
            yield chunk;
          }
        },
      },
      arrayBuffer: async () => {
        throw new Error("must not buffer via arrayBuffer");
      },
    });
    const out = path.join(tmp, "gh-stream");
    await assert.rejects(
      () => stageGitHubSkill("https://github.com/acme/tools", out, { fetchImpl }),
      /25|size|archive|limit/i,
    );
    assert.ok(yielded >= 26 && yielded <= 27, `read ${yielded} MiB-sized chunks`);
    assert.equal(fs.existsSync(out), false);
  });

  it("requires an injected fetchImpl so tests never touch the network", async () => {
    const out = path.join(tmp, "gh-nofetch");
    await assert.rejects(
      () => stageGitHubSkill("https://github.com/acme/tools", out, {}),
      /fetchImpl/i,
    );
    assert.equal(fs.existsSync(out), false);
  });
});
