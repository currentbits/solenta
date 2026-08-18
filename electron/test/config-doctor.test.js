/**
 * Agent-config doctor (#412): six-axis lint, memory coverage, generate.
 * Run: node --test electron/test/config-doctor.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const doctor = require("../configDoctor.js");

const STRONG = `# Repo

## Commands

\`\`\`bash
npm install
npm test
pnpm run lint
\`\`\`

## Architecture

Entry points live in \`src/main.tsx\` and \`electron/main.js\`.
Workers are spawned from \`electron/runner.js\`.
Shared types sit in \`src/shared/ipc.ts\`.

## Gotchas

Never write exploits. Do not fall back to the checkout when worktree setup fails.
Must not treat display slugs as memory project keys.

## Workflow

1. Lint
2. Test
3. Commit
`;

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cfgdoc-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel, body) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

describe("gradeFor", () => {
  it("maps the Anthropic bands", () => {
    assert.equal(doctor.gradeFor(95), "A");
    assert.equal(doctor.gradeFor(90), "A");
    assert.equal(doctor.gradeFor(70), "B");
    assert.equal(doctor.gradeFor(50), "C");
    assert.equal(doctor.gradeFor(30), "D");
    assert.equal(doctor.gradeFor(29), "F");
    assert.equal(doctor.gradeFor(0), "F");
  });
});

describe("discoverAgentConfigFiles", () => {
  it("finds root siblings and one-level package files, not node_modules", () => {
    write("AGENTS.md", "# a\n");
    write("CLAUDE.md", "# c\n");
    write(path.join(".github", "copilot-instructions.md"), "# copilot\n");
    write(path.join("packages", "api", "CLAUDE.md"), "# pkg\n");
    write(path.join("node_modules", "x", "CLAUDE.md"), "# ignore\n");
    write(path.join("packages", "node_modules", "AGENTS.md"), "# ignore\n");

    const found = doctor.discoverAgentConfigFiles(tmp).map((f) => f.path);
    assert.deepEqual(found.sort(), [
      ".github/copilot-instructions.md",
      "AGENTS.md",
      "CLAUDE.md",
      "packages/api/CLAUDE.md",
    ]);
  });

  it("returns [] for a missing or non-directory root", () => {
    assert.deepEqual(doctor.discoverAgentConfigFiles(path.join(tmp, "nope")), []);
    write("file.txt", "x");
    assert.deepEqual(doctor.discoverAgentConfigFiles(path.join(tmp, "file.txt")), []);
  });
});

describe("scoreAgentConfig", () => {
  it("scores an empty file as F with an empty-file issue", () => {
    const r = doctor.scoreAgentConfig("");
    assert.equal(r.grade, "F");
    assert.equal(r.score, 0);
    assert.ok(r.issues.some((i) => /empty/i.test(i.message)));
  });

  it("scores a comprehensive file in the A/B band", () => {
    write("src/main.tsx", "x");
    write("electron/main.js", "x");
    write("electron/runner.js", "x");
    write("src/shared/ipc.ts", "x");
    const r = doctor.scoreAgentConfig(STRONG, { root: tmp });
    assert.ok(r.score >= 70, `expected >= 70, got ${r.score}`);
    assert.ok(r.grade === "A" || r.grade === "B", r.grade);
    const byId = Object.fromEntries(r.axes.map((a) => [a.id, a.score]));
    assert.equal(byId.commands, 15);
    assert.equal(byId.architecture, 20);
    assert.equal(byId.patterns, 15);
    assert.equal(byId.actionability, 10);
  });

  it("penalizes filler on conciseness", () => {
    const padded =
      "This document provides a comprehensive guide. It is important to follow best practices. As an AI you should consider generally typical advice. " +
      "word ".repeat(80);
    const clean = "# Title\n\n" + "word ".repeat(130);
    const a = doctor.scoreAgentConfig(padded).axes.find((x) => x.id === "conciseness");
    const b = doctor.scoreAgentConfig(clean).axes.find((x) => x.id === "conciseness");
    assert.ok(a.score < b.score, `${a.score} should be < ${b.score}`);
  });

  it("drops currency when referenced files are missing", () => {
    const body = "# Map\n\nSee `src/does-not-exist.ts` and `electron/ghost.js`.\n";
    const r = doctor.scoreAgentConfig(body, { root: tmp });
    const cur = r.axes.find((a) => a.id === "currency");
    assert.equal(cur.score, 0);
    assert.ok(r.issues.some((i) => /do not exist/i.test(i.message)));
  });

  it("reports memory entries missing from the file", () => {
    const r = doctor.scoreAgentConfig("# hi\n", {
      memoryEntries: [
        { id: "1", type: "convention", title: "Worktree setup is fail-closed" },
        { id: "2", type: "task", title: "Ignore me I am a task" },
      ],
    });
    assert.equal(r.memory.considered, 1);
    assert.equal(r.memory.covered, 0);
    assert.equal(r.memory.missing[0].id, "1");
    assert.ok(r.issues.some((i) => /missing from this file/i.test(i.message)));
  });
});

describe("lintAgentConfigFiles", () => {
  it("grades a repo with no agent files as F", () => {
    const r = doctor.lintAgentConfigFiles([], {});
    assert.equal(r.grade, "F");
    assert.equal(r.score, 0);
    assert.equal(r.files.length, 0);
    assert.ok(r.issues.some((i) => /No AGENTS\.md/i.test(i.message)));
  });

  it("averages file scores and prefixes issues with the path", () => {
    const r = doctor.lintAgentConfigFiles(
      [
        { path: "AGENTS.md", bytes: 2, content: "" },
        { path: "CLAUDE.md", bytes: STRONG.length, content: STRONG },
      ],
      { root: tmp },
    );
    assert.equal(r.files.length, 2);
    assert.ok(r.issues.some((i) => i.message.startsWith("AGENTS.md:")));
    assert.equal(r.score, Math.round((r.files[0].score + r.files[1].score) / 2));
  });
});

describe("selectSourceEntries / renderGeneratedMarkdown", () => {
  const entries = [
    {
      id: "c1",
      type: "convention",
      title: "Fail closed on worktrees",
      body: "Never fall back to the checkout.",
      importance: 5,
    },
    {
      id: "s1",
      type: "strategy",
      title: "When adding IPC, update every surface",
      body: "ipc.ts, preload, wireClient, fakeCoder, devCoder.",
      importance: 4,
    },
    {
      id: "k1",
      type: "knowledge",
      title: "Memory project key is the repo basename",
      body: "Display slugs do not match.",
      importance: 4,
      citations: [{ kind: "file", path: "memory-server/src/project-key.js" }],
    },
    {
      id: "k-low",
      type: "knowledge",
      title: "Trivia",
      body: "skip me",
      importance: 1,
    },
    { id: "t1", type: "task", title: "Open PR", body: "nope", importance: 5 },
    { id: "r1", type: "run", title: "a run", body: "nope", importance: 5 },
  ];

  it("keeps conventions, strategies, and verified/high knowledge; drops tasks and runs", () => {
    const picked = doctor.selectSourceEntries(entries);
    assert.deepEqual(
      picked.map((e) => e.id),
      ["c1", "s1", "k1"],
    );
  });

  it("renders sections and the generated marker", () => {
    const md = doctor.renderGeneratedMarkdown({ name: "solenta", entries });
    assert.match(md, /^# solenta/m);
    assert.match(md, /generated-by: solenta-config-doctor/);
    assert.match(md, /## Conventions/);
    assert.match(md, /Fail closed on worktrees/);
    assert.match(md, /## Strategies/);
    assert.match(md, /## Decisions and gotchas/);
    assert.match(md, /Memory project key is the repo basename/);
    assert.doesNotMatch(md, /Open PR/);
    assert.doesNotMatch(md, /Trivia/);
  });

  it("says memory is empty when nothing qualifies", () => {
    const md = doctor.renderGeneratedMarkdown({
      name: "empty",
      entries: [{ id: "t", type: "task", title: "x", body: "y" }],
    });
    assert.match(md, /Empty memory/);
  });
});

describe("write + preview", () => {
  it("previews AGENTS.md and CLAUDE.md on an empty repo", () => {
    const files = doctor.previewGeneratedFiles({
      root: tmp,
      name: "demo",
      memoryEntries: [
        {
          type: "convention",
          title: "Use pnpm",
          body: "The repo is pnpm-only.",
          importance: 5,
        },
      ],
    });
    assert.deepEqual(
      files.map((f) => f.path),
      ["AGENTS.md", "CLAUDE.md"],
    );
    assert.equal(files[0].exists, false);
    assert.match(files[0].content, /Use pnpm/);
    assert.equal(files[0].content, files[1].content);
  });

  it("does not create CLAUDE.md on preview when only AGENTS.md already exists", () => {
    write("AGENTS.md", "# old\n");
    const files = doctor.previewGeneratedFiles({
      root: tmp,
      name: "demo",
      memoryEntries: [],
    });
    assert.deepEqual(
      files.map((f) => f.path),
      ["AGENTS.md"],
    );
    assert.equal(files[0].exists, true);
  });

  it("writes only allowed basenames and refuses path escape", () => {
    const preview = doctor.previewGeneratedFiles({
      root: tmp,
      name: "demo",
      memoryEntries: [
        { type: "convention", title: "Hello", body: "World", importance: 4 },
      ],
    });
    const written = doctor.writeAgentConfigFiles(tmp, preview);
    assert.deepEqual(written, ["AGENTS.md", "CLAUDE.md"]);
    const body = fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8");
    assert.match(body, /Hello/);
    assert.match(body, /generated-by: solenta-config-doctor/);

    assert.throws(
      () =>
        doctor.writeAgentConfigFiles(tmp, [
          { path: "../outside.md", content: "no" },
        ]),
      /Invalid agent-config path|Refusing/,
    );
    assert.throws(
      () =>
        doctor.writeAgentConfigFiles(tmp, [
          { path: "README.md", content: "no" },
        ]),
      /Refusing to write README\.md/,
    );
  });

  it("refuses a missing checkout", () => {
    assert.throws(
      () =>
        doctor.writeAgentConfigFiles(path.join(tmp, "missing"), [
          { path: "AGENTS.md", content: "# x\n" },
        ]),
      /local checkout/,
    );
  });
});

describe("memoryCoverage", () => {
  it("treats a title as covered when half its tokens appear", () => {
    const cov = doctor.memoryCoverage(
      "Worktree isolation is fail-closed. Never fall back.",
      [
        {
          id: "1",
          type: "convention",
          title: "Worktree setup is fail-closed",
        },
      ],
    );
    assert.equal(cov.covered, 1);
    assert.equal(cov.missing.length, 0);
  });
});

describe("services.lintAgentConfig / writeAgentConfig", () => {
  const services = require("../services.js");

  function storeFor(project) {
    return { getProject: (id) => (id === project.id ? project : null) };
  }

  it("rejects an unknown project and a missing checkout", async () => {
    await assert.rejects(
      () => services.lintAgentConfig(storeFor({ id: "p" }), { projectId: "nope" }),
      /Unknown project/,
    );
    await assert.rejects(
      () =>
        services.lintAgentConfig(storeFor({ id: "p", path: path.join(tmp, "gone") }), {
          projectId: "p",
        }),
      /local checkout/,
    );
  });

  it("lints a real checkout and writes from memory", async () => {
    write("package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    const store = storeFor({ id: "p1", name: "demo", path: tmp });
    const entries = {
      c1: {
        id: "c1",
        type: "convention",
        title: "Always run the electron tests",
        body: "npm run test:electron",
        importance: 5,
        citations: [],
      },
    };
    const memory = {
      async recent({ type }) {
        return type === "convention" ? [entries.c1] : [];
      },
      async get({ id }) {
        return entries[id];
      },
    };
    const lint = await services.lintAgentConfig(store, { projectId: "p1" }, { memory });
    assert.equal(lint.projectId, "p1");
    assert.equal(lint.grade, "F");
    assert.equal(lint.memory.considered, 1);
    assert.equal(lint.memory.covered, 0);

    const preview = await services.previewAgentConfig(
      store,
      { projectId: "p1" },
      { memory },
    );
    assert.ok(preview.files.some((f) => f.path === "AGENTS.md"));
    assert.match(preview.files[0].content, /Always run the electron tests/);

    const written = await services.writeAgentConfig(
      store,
      { projectId: "p1" },
      { memory },
    );
    assert.ok(written.written.includes("AGENTS.md"));
    const body = fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8");
    assert.match(body, /Always run the electron tests/);

    const relint = await services.lintAgentConfig(store, { projectId: "p1" }, { memory });
    assert.equal(relint.memory.covered, 1);
  });

  it("lint survives a down memory server; generate does not", async () => {
    const store = storeFor({ id: "p1", name: "demo", path: tmp });
    const down = {
      async recent() {
        throw new Error("Memory server is not running.");
      },
    };
    const lint = await services.lintAgentConfig(store, { projectId: "p1" }, { memory: down });
    assert.equal(lint.memory.considered, 0);
    await assert.rejects(
      () => services.previewAgentConfig(store, { projectId: "p1" }, { memory: down }),
      /Memory server is not running/,
    );
  });
});
