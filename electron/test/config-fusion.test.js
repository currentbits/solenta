/**
 * Instruction-file Fusion (#1856): extraction, conflicts, block sync, status.
 * Run: node --test electron/test/config-fusion.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fusion = require("../configFusion.js");

const AGENTS = `# Repo

Shared notes for Codex and friends.

## Commands

- Install: \`npm install\`
- Test: \`npm test\`
- Build: \`npm run build\`

## Style

- Use 2-space indentation in TypeScript files.
- Keep commits small and focused.
`;

const CLAUDE = `# Claude notes

Claude-only: prefer the Edit tool over sed.

## Commands

\`\`\`bash
pnpm install
pnpm test
pnpm run build
\`\`\`

- Use 4-space indentation in TypeScript files.
`;

const CURSOR = `Always answer in English.
Run \`npm test\` before you commit.
`;

let tmp;
const write = (rel, body) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
const read = (rel) => fs.readFileSync(path.join(tmp, rel), "utf8");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("analyzeFiles", () => {
  const files = [
    { path: "AGENTS.md", content: AGENTS },
    { path: "CLAUDE.md", content: CLAUDE },
    { path: ".cursorrules", content: CURSOR },
  ];

  it("reports npm vs pnpm with exact file:line on every side", () => {
    const { conflicts } = fusion.analyzeFiles(files);
    const pm = conflicts.find((c) => c.key === "packageManager");
    assert.deepEqual(pm.options, [
      {
        value: "npm",
        sources: [
          { path: "AGENTS.md", line: 7 },
          { path: ".cursorrules", line: 2 },
        ],
      },
      { value: "pnpm", sources: [{ path: "CLAUDE.md", line: 8 }] },
    ]);
    const test = conflicts.find((c) => c.key === "test");
    assert.deepEqual(
      test.options.map((o) => [o.value, o.sources]),
      [
        ["npm test", [{ path: "AGENTS.md", line: 8 }, { path: ".cursorrules", line: 2 }]],
        ["pnpm test", [{ path: "CLAUDE.md", line: 9 }]],
      ],
    );
    assert.deepEqual(
      conflicts.find((c) => c.key === "build").options.map((o) => o.value),
      ["npm run build", "pnpm run build"],
    );
  });

  it("flags near-duplicate lines that disagree, and nothing for unique prose", () => {
    const { conflicts } = fusion.analyzeFiles(files);
    const lines = conflicts.filter((c) => c.key === "line");
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0].options, [
      {
        value: "Use 2-space indentation in TypeScript files.",
        sources: [{ path: "AGENTS.md", line: 13 }],
      },
      {
        value: "Use 4-space indentation in TypeScript files.",
        sources: [{ path: "CLAUDE.md", line: 13 }],
      },
    ]);
  });

  it("reports facts every file agrees on", () => {
    const { agreed, conflicts } = fusion.analyzeFiles([
      { path: "AGENTS.md", content: "Run `pnpm lint`.\n" },
      { path: "GEMINI.md", content: "```\npnpm lint\n```\n" },
    ]);
    assert.deepEqual(conflicts, []);
    assert.deepEqual(
      agreed.map((f) => [f.key, f.value, f.sources.length]),
      [
        ["packageManager", "pnpm", 2],
        ["lint", "pnpm lint", 2],
      ],
    );
  });

  it("does not let npx override the real package manager", () => {
    const { facts } = fusion.extractFileFacts({
      path: "AGENTS.md",
      content: "Typecheck: `npx tsc --noEmit`\nTest: `yarn test`\n",
    });
    assert.deepEqual(facts.packageManager, { value: "yarn", line: 2 });
  });
});

describe("applyBlock / planFusion", () => {
  it("replaces the block in place and leaves outside text byte-identical", () => {
    const before = "# Top\n\n<!-- solenta:fusion:start sha:abc -->\nold\n<!-- solenta:fusion:end -->\n\n## Tail\nkeep me\n";
    const after = fusion.applyBlock(
      before,
      "<!-- solenta:fusion:start sha:def -->\nnew\n<!-- solenta:fusion:end -->\n",
    );
    assert.equal(
      after,
      "# Top\n\n<!-- solenta:fusion:start sha:def -->\nnew\n<!-- solenta:fusion:end -->\n\n## Tail\nkeep me\n",
    );
  });

  it("appends after existing text when there is no block yet", () => {
    assert.equal(fusion.applyBlock("a", "B\n"), "a\n\nB\n");
    assert.equal(fusion.applyBlock("a\n", "B\n"), "a\n\nB\n");
  });

  it("builds the block from agreed facts plus picks, with a per-file diff", () => {
    const plan = fusion.planFusion(
      [
        { path: "AGENTS.md", content: AGENTS },
        { path: "CLAUDE.md", content: CLAUDE },
      ],
      { picks: { packageManager: "pnpm", test: "pnpm test" } },
    );
    const block = plan.after["AGENTS.md"].slice(AGENTS.length);
    assert.match(block, /- Package manager: pnpm\n/);
    assert.match(block, /- Test: `pnpm test`\n/);
    // Unpicked commands follow the picked package manager.
    assert.match(block, /- Build: `pnpm run build`\n/);
    assert.match(block, /- Install: `pnpm install`\n/);
    assert.ok(plan.after["AGENTS.md"].startsWith(AGENTS));
    const diff = plan.diffs.find((d) => d.path === "CLAUDE.md");
    assert.equal(diff.changed, true);
    assert.match(diff.diff, /^--- a\/CLAUDE\.md\n\+\+\+ b\/CLAUDE\.md\n@@ -11,3 \+11,15 @@/);
    assert.ok(diff.diff.split("\n").slice(3).every((l) => !l.startsWith("-")));
  });

  it("translates commands into another package manager, keeping script names", () => {
    const cases = [
      ["npm run build", "pnpm", "pnpm build"],
      ["npm test", "pnpm", "pnpm test"],
      ["npm install", "pnpm", "pnpm install"],
      ["npm ci", "yarn", "yarn install"],
      ["npx tsc --noEmit", "pnpm", "pnpm dlx tsc --noEmit"],
      ["npx tsc --noEmit", "yarn", "yarn dlx tsc --noEmit"],
      ["npx tsc --noEmit", "bun", "bunx tsc --noEmit"],
      ["npm run test:electron -- --watch", "bun", "bun run test:electron -- --watch"],
      ["pnpm lint", "npm", "npm run lint"],
      ["yarn test", "npm", "npm test"],
      ["pnpm dlx prettier .", "npm", "npx prettier ."],
      ["npm publish", "pnpm", "npm publish"],
      ["cargo test", "pnpm", "cargo test"],
      ["pnpm run build", "pnpm", "pnpm run build"],
    ];
    for (const [cmd, pm, want] of cases) {
      assert.equal(fusion.translateCommand(cmd, pm), want, `${cmd} under ${pm}`);
    }
  });

  it("pnpm picked: Test defaults to pnpm, agreed npm commands are translated", () => {
    const files = [
      { path: "AGENTS.md", content: "- Test: `npm test`\n- Build: `npm run build`\n- Lint: `npm run lint`\n" },
      { path: "CLAUDE.md", content: "- Test: `pnpm test`\n- Lint: `npm run lint`\n" },
      { path: "GEMINI.md", content: "- Test: `npm test`\n" },
    ];
    // npm is most cited, so pnpm only wins when picked.
    const unpicked = fusion.planFusion(files);
    assert.equal(unpicked.conflicts.find((c) => c.key === "packageManager").pick, "npm");
    assert.equal(unpicked.conflicts.find((c) => c.key === "test").pick, "npm test");

    const plan = fusion.planFusion(files, { picks: { packageManager: "pnpm" } });
    assert.equal(plan.conflicts.find((c) => c.key === "test").pick, "pnpm test");
    const block = plan.after["AGENTS.md"];
    assert.match(block, /- Test: `pnpm test`\n/);
    assert.match(block, /- Build: `pnpm build`\n/);
    assert.match(block, /- Lint: `pnpm lint`\n/);
    assert.doesNotMatch(block.slice(block.indexOf("solenta:fusion:start")), /`npm /);
    assert.deepEqual(
      plan.agreed.filter((f) => f.key !== "packageManager").map((f) => [f.value, f.fused]),
      [
        ["npm run build", "pnpm build"],
        ["npm run lint", "pnpm lint"],
      ],
    );

    // A command picked by hand is kept as picked, even against the manager.
    const manual = fusion.planFusion(files, { picks: { packageManager: "pnpm", test: "npm test" } });
    assert.match(manual.after["AGENTS.md"], /- Test: `npm test`\n/);
  });

  it("lets CLAUDE.md import AGENTS.md instead of a copy", () => {
    const plan = fusion.planFusion(
      [
        { path: "AGENTS.md", content: AGENTS },
        { path: "CLAUDE.md", content: CLAUDE },
      ],
      { importInClaude: true },
    );
    assert.match(plan.after["CLAUDE.md"], /sha:[0-9a-f]+ -->\n@AGENTS\.md\n<!-- solenta:fusion:end -->\n$/);
    assert.match(plan.after["AGENTS.md"], /## Shared instructions/);
  });
});

describe("syncFusion on disk", () => {
  it("writes only the ticked files, is idempotent, and tracks status by hash", () => {
    write("AGENTS.md", AGENTS);
    write("CLAUDE.md", CLAUDE);
    write(".cursorrules", CURSOR);

    const before = fusion.previewFusion(tmp, {});
    assert.deepEqual(
      before.files.map((f) => [f.path, f.kind]),
      [
        ["AGENTS.md", "agents"],
        ["CLAUDE.md", "claude"],
        [".cursorrules", "cursor"],
      ],
    );
    assert.equal(before.status.synced, false);

    const picks = { packageManager: "pnpm" };
    const first = fusion.syncFusion(tmp, { picks, paths: ["AGENTS.md", "CLAUDE.md"] });
    assert.deepEqual(first.written, ["AGENTS.md", "CLAUDE.md"]);
    assert.equal(read(".cursorrules"), CURSOR, "unticked file untouched");
    assert.ok(read("AGENTS.md").startsWith(AGENTS));
    assert.ok(read("CLAUDE.md").startsWith(CLAUDE));
    assert.equal(first.status.synced, true);
    assert.equal(typeof first.status.syncedAt, "number");

    // Re-plan picks up the previous choice and proposes no changes.
    const again = fusion.previewFusion(tmp, {});
    assert.equal(again.conflicts.find((c) => c.key === "packageManager").pick, "pnpm");
    assert.deepEqual(
      again.diffs.filter((d) => d.changed).map((d) => d.path),
      [".cursorrules"],
    );
    const agentsAfter = read("AGENTS.md");
    const second = fusion.syncFusion(tmp, { paths: ["AGENTS.md", "CLAUDE.md"] });
    assert.deepEqual(second.written, []);
    assert.equal(read("AGENTS.md"), agentsAfter);

    // Any change, even in a file without a block, flips the status.
    write(".cursorrules", `${CURSOR}Prefer small diffs.\n`);
    assert.equal(fusion.previewFusion(tmp, {}).status.synced, false);
  });

  it("refuses paths that are not discovered instruction files", () => {
    write("AGENTS.md", AGENTS);
    write("CLAUDE.md", CLAUDE);
    write("README.md", "# readme\n");
    const r = fusion.syncFusion(tmp, { paths: ["README.md", "../x.md"] });
    assert.deepEqual(r.written, []);
    assert.equal(read("README.md"), "# readme\n");
  });

  it("skips a CLAUDE.md symlinked to AGENTS.md so it is written once", () => {
    write("AGENTS.md", AGENTS);
    fs.symlinkSync("AGENTS.md", path.join(tmp, "CLAUDE.md"));
    write("GEMINI.md", CLAUDE);
    assert.deepEqual(
      fusion.discoverFusionFiles(tmp).map((f) => f.path),
      ["AGENTS.md", "GEMINI.md"],
    );
  });

  it("reads .cursor/rules/*.mdc", () => {
    write(path.join(".cursor", "rules", "style.mdc"), "---\nalwaysApply: true\n---\nRun `bun test`.\n");
    write("AGENTS.md", "Run `npm test`.\n");
    const plan = fusion.previewFusion(tmp, {});
    const pm = plan.conflicts.find((c) => c.key === "packageManager");
    assert.deepEqual(pm.options[1].sources, [{ path: ".cursor/rules/style.mdc", line: 4 }]);
  });
});

describe("Codex review regressions (#1862)", () => {
  // AGENTS.md says npm, CLAUDE.md says pnpm: a package-manager and a Test conflict.
  const A = "# A\n\n- Test: `npm test`\n";
  const C = "# C\n\n- Test: `pnpm test`\n";

  it("status reports disagreeing blocks and names the files", () => {
    write("AGENTS.md", A);
    write("CLAUDE.md", C);
    fusion.syncFusion(tmp, { picks: { packageManager: "npm" }, paths: ["AGENTS.md", "CLAUDE.md"] });
    assert.equal(fusion.previewFusion(tmp, { picks: { packageManager: "npm" } }).status.synced, true);

    fusion.syncFusion(tmp, { picks: { packageManager: "pnpm" }, paths: ["CLAUDE.md"] });
    assert.match(read("AGENTS.md"), /Package manager: npm/);
    assert.match(read("CLAUDE.md"), /Package manager: pnpm/);
    const status = fusion.previewFusion(tmp, {}).status;
    assert.equal(status.synced, false);
    assert.deepEqual(status.disagree, ["AGENTS.md", "CLAUDE.md"]);
  });

  it("treats CLAUDE.md's @AGENTS.md import as AGENTS.md's block", () => {
    write("AGENTS.md", A);
    write("CLAUDE.md", C);
    const r = fusion.syncFusion(tmp, { importInClaude: true, paths: ["AGENTS.md", "CLAUDE.md"] });
    assert.match(read("CLAUDE.md"), /\n@AGENTS\.md\n/);
    assert.deepEqual(r.status, { synced: true, syncedAt: r.status.syncedAt, disagree: [] });
  });

  it("preview matches the write when AGENTS.md is unticked with the import on", () => {
    write("AGENTS.md", A);
    write("CLAUDE.md", C);
    const opts = { importInClaude: true, paths: ["CLAUDE.md"] };
    const preview = fusion.previewFusion(tmp, opts);
    const claudeDiff = preview.diffs.find((d) => d.path === "CLAUDE.md").diff;
    assert.doesNotMatch(claudeDiff, /@AGENTS\.md/, "AGENTS.md has no block yet, so no import");
    assert.match(claudeDiff, /\+- Package manager:/);
    // AGENTS.md still gets a diff so it can be ticked again.
    assert.equal(preview.diffs.find((d) => d.path === "AGENTS.md").changed, true);
    fusion.syncFusion(tmp, opts);
    assert.equal(read("AGENTS.md"), A);
    const written = read("CLAUDE.md");
    for (const line of claudeDiff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"))) {
      assert.ok(written.includes(`${line.slice(1)}\n`), `written CLAUDE.md has ${line}`);
    }

    // Once AGENTS.md holds the shared block, the import applies even unticked.
    fusion.syncFusion(tmp, { paths: ["AGENTS.md"] });
    const again = fusion.previewFusion(tmp, opts);
    assert.match(again.diffs.find((d) => d.path === "CLAUDE.md").diff, /\+@AGENTS\.md/);
    fusion.syncFusion(tmp, opts);
    assert.match(read("CLAUDE.md"), /\n@AGENTS\.md\n/);
  });

  it("keeps an explicit command override across plans: sync, then re-plan, gives zero changes", () => {
    write("AGENTS.md", A);
    write("CLAUDE.md", C);
    const paths = ["AGENTS.md", "CLAUDE.md"];
    fusion.syncFusion(tmp, { picks: { packageManager: "pnpm", test: "npm test" }, paths });
    assert.match(read("AGENTS.md"), /keep:test -->/);
    assert.match(read("AGENTS.md"), /- Test: `npm test`\n/);
    const before = { a: read("AGENTS.md"), c: read("CLAUDE.md") };

    // Reopen: no picks from the UI. The override survives and nothing changes.
    const plan = fusion.previewFusion(tmp, {});
    assert.equal(plan.conflicts.find((c) => c.key === "packageManager").pick, "pnpm");
    assert.equal(plan.conflicts.find((c) => c.key === "test").pick, "npm test");
    assert.deepEqual(plan.diffs.filter((d) => d.changed), []);
    assert.equal(plan.status.synced, true);
    assert.deepEqual(fusion.syncFusion(tmp, { paths }).written, []);
    assert.deepEqual({ a: read("AGENTS.md"), c: read("CLAUDE.md") }, before);

    // Picking the manager's own command drops the override again.
    fusion.syncFusion(tmp, { picks: { test: "pnpm test" }, paths });
    assert.doesNotMatch(read("AGENTS.md"), /keep:/);
    assert.match(read("AGENTS.md"), /- Test: `pnpm test`\n/);
  });
});

describe("services.fusionPlan / fusionSync", () => {
  const services = require("../services.js");
  const storeFor = (project) => ({
    getProject: (id) => (id === project.id ? project : null),
  });

  it("plans and syncs a real checkout", () => {
    write("AGENTS.md", AGENTS);
    write("CLAUDE.md", CLAUDE);
    const store = storeFor({ id: "p1", path: tmp });
    const plan = services.fusionPlan(store, { projectId: "p1" });
    assert.equal(plan.projectId, "p1");
    assert.equal(plan.after, undefined, "full file bodies stay in main");
    const r = services.fusionSync(store, { projectId: "p1", paths: ["AGENTS.md"] });
    assert.deepEqual(r.written, ["AGENTS.md"]);
    assert.throws(() => services.fusionPlan(store, { projectId: "nope" }), /Unknown project/);
  });
});
