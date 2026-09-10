/**
 * Inventory cost for Skills tab load: registry snapshot reuse, no paired
 * rescan, and SKILL.md alias reuse. Run: node --test electron/test/skills-inventory.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { listSkills, listSkillsAsync, SKILL_DIRS } = require("../skills.js");
const { listCatalog } = require("../skillCatalog.js");
const { registryPath } = require("../skillRegistry.js");

const PONYTAIL_URL = "https://github.com/DietrichGebert/ponytail";

let tmp;
let userData;
let env;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-skill-inv-"));
  userData = path.join(tmp, "user-data");
  env = { HOME: path.join(tmp, "home") };
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(env.HOME, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function skillMd(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody for ${name}.\n`;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function activate(...targets) {
  const dirs = SKILL_DIRS(env);
  for (const t of targets) {
    fs.mkdirSync(path.dirname(dirs[t]), { recursive: true });
  }
}

function countReads(fn) {
  const orig = fs.readFileSync;
  let registry = 0;
  let skillMdReads = 0;
  fs.readFileSync = (file, ...rest) => {
    const text = String(file);
    if (text.endsWith(`${path.sep}registry.json`)) registry += 1;
    if (text.endsWith(`${path.sep}SKILL.md`)) skillMdReads += 1;
    return orig.call(fs, file, ...rest);
  };
  try {
    const result = fn();
    return { result, registry, skillMdReads };
  } finally {
    fs.readFileSync = orig;
  }
}

function plantManagedCopies(count, targets) {
  activate(...targets);
  const dirs = SKILL_DIRS(env);
  /** @type {Record<string, object>} */
  const installs = {};
  for (let i = 0; i < count; i += 1) {
    const name = `skill-${String(i).padStart(3, "0")}`;
    const installId = String(i).padStart(32, "0");
    const content = skillMd(name, `Does ${name}`);
    const marker = JSON.stringify({ installId });
    for (const target of targets) {
      writeFile(path.join(dirs[target], name, "SKILL.md"), content);
      writeFile(path.join(dirs[target], name, ".solenta-skill.json"), marker);
    }
    installs[installId] = {
      name,
      provenance: i === 0 ? "curated" : "added",
      ...(i === 0
        ? {
            catalogId: "ponytail",
            sourceLabel: "Ponytail",
            sourceUrl: PONYTAIL_URL,
          }
        : {}),
    };
  }
  writeFile(
    registryPath(userData),
    `${JSON.stringify({ version: 1, installs }, null, 2)}\n`,
  );
}

describe("skill inventory scan cost", () => {
  it("reads the registry once per listSkills, not once per provider copy", () => {
    const targets = ["claude", "agents", "codex"];
    const count = 40;
    plantManagedCopies(count, targets);

    const { result, registry, skillMdReads } = countReads(() =>
      listSkills(null, env, userData),
    );

    assert.equal(result.length, count);
    assert.equal(
      registry,
      1,
      `registry.json reads should be O(1) per inventory, got ${registry}`,
    );
    assert.equal(
      skillMdReads,
      count * targets.length,
      "each distinct provider copy is still read unless it aliases the same file",
    );
    const curated = result.find((s) => s.name === "skill-000");
    assert.equal(curated.provenance, "curated");
    assert.equal(curated.origin.catalogId, "ponytail");
  });

  it("does not rescan every SKILL.md when listing the catalog after Skills", () => {
    const targets = ["claude", "agents", "codex"];
    const count = 40;
    plantManagedCopies(count, targets);

    const first = countReads(() => listSkills(null, env, userData));
    const second = countReads(() => listCatalog({ env, userDataPath: userData }));

    assert.equal(first.result.length, count);
    assert.equal(second.result[0].installed, true);
    assert.equal(
      second.skillMdReads,
      0,
      `listCatalog must not duplicate a full inventory; SKILL.md reads=${second.skillMdReads}`,
    );
    assert.ok(
      second.registry <= 1,
      `listCatalog registry reads should stay O(1), got ${second.registry}`,
    );
  });

  it("reuses parsed SKILL.md for provider aliases of the same file", () => {
    activate("claude", "agents", "codex");
    const dirs = SKILL_DIRS(env);
    const agents = path.join(dirs.agents, "linked");
    writeFile(path.join(agents, "SKILL.md"), skillMd("linked", "Linked"));
    fs.mkdirSync(dirs.claude, { recursive: true });
    fs.mkdirSync(dirs.codex, { recursive: true });
    fs.symlinkSync(
      path.join("..", "..", ".agents", "skills", "linked"),
      path.join(dirs.claude, "linked"),
    );
    fs.symlinkSync(
      path.join("..", "..", ".agents", "skills", "linked"),
      path.join(dirs.codex, "linked"),
    );

    const { result, skillMdReads } = countReads(() => listSkills(null, env));
    const row = result.find((s) => s.name === "linked");
    assert.deepEqual(row.installedIn, ["claude", "agents", "codex"]);
    assert.equal(row.description, "Linked");
    assert.equal(
      skillMdReads,
      1,
      `aliases of one physical SKILL.md should be read once, got ${skillMdReads}`,
    );
  });

  it("still skips a dangling skill symlink", () => {
    activate("claude", "agents");
    const dirs = SKILL_DIRS(env);
    fs.mkdirSync(dirs.claude, { recursive: true });
    fs.symlinkSync(
      path.join("..", "..", ".agents", "skills", "missing"),
      path.join(dirs.claude, "missing"),
    );
    writeFile(
      path.join(dirs.agents, "present", "SKILL.md"),
      skillMd("present", "Here"),
    );

    const list = listSkills(null, env);
    assert.deepEqual(
      list.map((s) => s.name),
      ["present"],
    );
    assert.deepEqual(list[0].installedIn, ["agents"]);
  });

  it("sees disk and registry edits on the next inventory, not a stale cache", () => {
    activate("claude");
    const claude = path.join(env.HOME, ".claude", "skills");
    writeFile(path.join(claude, "one", "SKILL.md"), skillMd("one", "First"));

    assert.deepEqual(
      listSkills(null, env, userData).map((s) => s.name),
      ["one"],
    );

    writeFile(path.join(claude, "two", "SKILL.md"), skillMd("two", "Second"));
    const installId = "a".repeat(32);
    writeFile(
      path.join(claude, "two", ".solenta-skill.json"),
      JSON.stringify({ installId }),
    );
    writeFile(
      registryPath(userData),
      `${JSON.stringify({
        version: 1,
        installs: {
          [installId]: {
            name: "two",
            provenance: "curated",
            catalogId: "ponytail",
            sourceLabel: "Ponytail",
            sourceUrl: PONYTAIL_URL,
          },
        },
      })}\n`,
    );

    const listed = listSkills(null, env, userData);
    assert.deepEqual(
      listed.map((s) => s.name),
      ["one", "two"],
    );
    assert.equal(listed.find((s) => s.name === "two").provenance, "curated");
    assert.equal(listCatalog({ env, userDataPath: userData })[0].installed, true);

    fs.rmSync(path.join(claude, "two"), { recursive: true, force: true });
    const afterRemove = listSkills(null, env, userData);
    assert.deepEqual(
      afterRemove.map((s) => s.name),
      ["one"],
    );
    assert.equal(listCatalog({ env, userDataPath: userData })[0].installed, false);
  });

  it("listSkillsAsync matches listSkills and yields to the event loop", async () => {
    const targets = ["claude", "agents", "codex"];
    plantManagedCopies(80, targets);

    const syncList = listSkills(null, env, userData);
    const asyncList = await listSkillsAsync(null, env, userData);
    assert.deepEqual(asyncList, syncList);

    let ticks = 0;
    let ping = true;
    const schedule = () => {
      setImmediate(() => {
        if (!ping) return;
        ticks += 1;
        schedule();
      });
    };
    schedule();
    try {
      await listSkillsAsync(null, env, userData);
    } finally {
      ping = false;
    }
    assert.ok(
      ticks > 0,
      `async inventory must yield so the event loop can tick; ticks=${ticks}`,
    );
  });
});
