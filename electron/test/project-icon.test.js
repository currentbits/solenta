/**
 * Project icon resolver (#610): well-known favicon paths, t3.json /
 * solenta.json iconPath, HTML <link rel="icon">, user override, and
 * cache keyed by git-common-dir so worktrees reuse the main checkout.
 *
 * Run: node --test electron/test/project-icon.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  resolveIconPath,
  iconDataUrlFor,
  relativeIconPath,
  normalizeIconPath,
  clearIconCache,
  setGitCommonDirFn,
  ICON_EXTENSIONS,
} = require("../projectIcon.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { IPC_HANDLERS } = require("../ipc.js");

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#c00"/></svg>\n';

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root, rel, contents) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  return abs;
}

describe("projectIcon resolver", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-icon-"));
    clearIconCache();
    setGitCommonDirFn(null);
  });

  afterEach(() => {
    clearIconCache();
    setGitCommonDirFn(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the repo has no icon", () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    write(tmpDir, "README.md", "hi\n");
    assert.equal(resolveIconPath(tmpDir), null);
    assert.equal(iconDataUrlFor(tmpDir), null);
  });

  it("finds public/favicon.png", () => {
    const abs = write(tmpDir, "public/favicon.png", PNG_1X1);
    assert.equal(resolveIconPath(tmpDir), abs);
    const url = iconDataUrlFor(tmpDir);
    assert.ok(url && url.startsWith("data:image/png;base64,"));
  });

  it("finds static/favicon.svg, assets/icon.png, icon.png, and app-icon.ico", () => {
    const cases = [
      "static/favicon.svg",
      "assets/icon.png",
      "icon.png",
      "app-icon.ico",
    ];
    for (const rel of cases) {
      const root = fs.mkdtempSync(path.join(tmpDir, "c-"));
      const abs = write(root, rel, rel.endsWith(".svg") ? SVG : PNG_1X1);
      assert.equal(resolveIconPath(root), abs, rel);
    }
  });

  it("prefers a t3.json iconPath over well-known locations", () => {
    write(tmpDir, "public/favicon.png", PNG_1X1);
    const branded = write(tmpDir, "brand/logo.svg", SVG);
    write(tmpDir, "t3.json", JSON.stringify({ iconPath: "brand/logo.svg" }));
    assert.equal(resolveIconPath(tmpDir), branded);
  });

  it("reads solenta.json iconPath when t3.json is absent", () => {
    const branded = write(tmpDir, "assets/solenta.svg", SVG);
    write(tmpDir, "solenta.json", JSON.stringify({ iconPath: "assets/solenta.svg" }));
    assert.equal(resolveIconPath(tmpDir), branded);
  });

  it("solenta.json wins over t3.json when both declare iconPath", () => {
    const ours = write(tmpDir, "ours.svg", SVG);
    write(tmpDir, "theirs.png", PNG_1X1);
    write(tmpDir, "solenta.json", JSON.stringify({ iconPath: "ours.svg" }));
    write(tmpDir, "t3.json", JSON.stringify({ iconPath: "theirs.png" }));
    assert.equal(resolveIconPath(tmpDir), ours);
  });

  it("falls through when the checked-in iconPath is missing", () => {
    write(tmpDir, "t3.json", JSON.stringify({ iconPath: "missing.svg" }));
    const fallback = write(tmpDir, "favicon.png", PNG_1X1);
    assert.equal(resolveIconPath(tmpDir), fallback);
  });

  it("ignores invalid t3.json", () => {
    write(tmpDir, "t3.json", "{not json");
    const fallback = write(tmpDir, "public/favicon.png", PNG_1X1);
    assert.equal(resolveIconPath(tmpDir), fallback);
  });

  it("user override wins over t3.json and well-known paths", () => {
    write(tmpDir, "public/favicon.png", PNG_1X1);
    write(tmpDir, "t3.json", JSON.stringify({ iconPath: "brand/logo.svg" }));
    write(tmpDir, "brand/logo.svg", SVG);
    const picked = write(tmpDir, "custom/pick.png", PNG_1X1);
    assert.equal(resolveIconPath(tmpDir, "custom/pick.png"), picked);
  });

  it("missing user override falls through to automatic detection", () => {
    write(tmpDir, "gone.png", PNG_1X1);
    const auto = write(tmpDir, "public/favicon.png", PNG_1X1);
    fs.unlinkSync(path.join(tmpDir, "gone.png"));
    assert.equal(resolveIconPath(tmpDir, "gone.png"), auto);
  });

  it("reads <link rel=\"icon\"> from index.html and resolves under public/", () => {
    write(
      tmpDir,
      "index.html",
      '<html><head><link rel="icon" href="/brand.ico"></head></html>',
    );
    const abs = write(tmpDir, "public/brand.ico", PNG_1X1);
    assert.equal(resolveIconPath(tmpDir), abs);
  });

  it("reads shortcut-icon links and root-relative hrefs", () => {
    write(
      tmpDir,
      "public/index.html",
      "<html><link rel='shortcut icon' href='img/app.png'></html>",
    );
    const abs = write(tmpDir, "img/app.png", PNG_1X1);
    assert.equal(resolveIconPath(tmpDir), abs);
  });

  it("extracts icon metadata from a root.tsx-style object", () => {
    write(
      tmpDir,
      "src/root.tsx",
      `export default { links: [{ rel: "icon", href: "/logo.svg" }] };\n`,
    );
    const abs = write(tmpDir, "public/logo.svg", SVG);
    assert.equal(resolveIconPath(tmpDir), abs);
  });

  it("skips http(s) and data: hrefs", () => {
    write(
      tmpDir,
      "index.html",
      '<link rel="icon" href="https://cdn.example/favicon.png">',
    );
    write(
      tmpDir,
      "src/index.html",
      '<link rel="icon" href="data:image/png;base64,aaaa">',
    );
    assert.equal(resolveIconPath(tmpDir), null);
  });

  it("rejects path traversal in an override", () => {
    const outside = path.join(tmpDir, "..", "outside.png");
    fs.writeFileSync(outside, PNG_1X1);
    assert.equal(resolveIconPath(tmpDir, "../outside.png"), null);
    assert.equal(resolveIconPath(tmpDir, "/etc/passwd"), null);
    assert.throws(() => normalizeIconPath("../outside.png"), /relative/i);
    assert.throws(() => normalizeIconPath("/etc/passwd"), /relative/i);
  });

  it("normalizeIconPath accepts posix relatives and nulls Automatic", () => {
    assert.equal(normalizeIconPath("public/favicon.svg"), "public/favicon.svg");
    assert.equal(normalizeIconPath("custom\\\\pick.PNG"), "custom/pick.PNG");
    assert.equal(normalizeIconPath(""), null);
    assert.equal(normalizeIconPath(null), null);
    assert.throws(() => normalizeIconPath("readme.md"), /svg, png, ico/i);
  });

  it("relativeIconPath is posix and stays inside the root", () => {
    const abs = write(tmpDir, "assets/icon.png", PNG_1X1);
    assert.equal(relativeIconPath(tmpDir, abs), "assets/icon.png");
    assert.equal(relativeIconPath(tmpDir, path.join(tmpDir, "..", "x.png")), null);
  });

  it("skips directories that share a candidate name", () => {
    fs.mkdirSync(path.join(tmpDir, "favicon.png"));
    assert.equal(resolveIconPath(tmpDir), null);
  });

  it("refuses oversized files", () => {
    const big = Buffer.alloc(300 * 1024, 1);
    write(tmpDir, "icon.png", big);
    assert.equal(iconDataUrlFor(tmpDir), null);
  });

  it("caches by git common dir so a worktree reuses the main checkout", () => {
    const main = path.join(tmpDir, "main");
    const wt = path.join(tmpDir, "wt");
    fs.mkdirSync(main);
    fs.mkdirSync(wt);
    write(main, "public/favicon.png", PNG_1X1);
    setGitCommonDirFn(() => path.join(main, ".git"));
    const fromMain = resolveIconPath(main);
    const fromWt = resolveIconPath(wt);
    assert.equal(fromMain, path.join(main, "public/favicon.png"));
    assert.equal(fromWt, fromMain);
  });

  it("picks up an override file that appears after a cached fall-through", () => {
    write(tmpDir, "public/favicon.png", PNG_1X1);
    const first = iconDataUrlFor(tmpDir, "custom/pick.svg");
    assert.ok(first && first.startsWith("data:image/png"));
    write(tmpDir, "custom/pick.svg", SVG);
    const second = iconDataUrlFor(tmpDir, "custom/pick.svg");
    assert.ok(second && second.startsWith("data:image/svg+xml"));
  });

  it("does not re-run git for a cached common dir", () => {
    write(tmpDir, "icon.png", PNG_1X1);
    let calls = 0;
    setGitCommonDirFn((cwd) => {
      calls += 1;
      return path.join(cwd, ".git");
    });
    iconDataUrlFor(tmpDir);
    iconDataUrlFor(tmpDir);
    assert.equal(calls, 1);
  });
});

describe("projectIcon git worktree integration", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-icon-wt-"));
    clearIconCache();
    setGitCommonDirFn(null);
  });

  afterEach(() => {
    clearIconCache();
    setGitCommonDirFn(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a worktree checkout reuses the main repo's untracked favicon", () => {
    const main = path.join(tmpDir, "repo");
    fs.mkdirSync(main);
    git(main, ["init"]);
    git(main, ["config", "user.email", "test@example.com"]);
    git(main, ["config", "user.name", "Test"]);
    write(main, "README.md", "hi\n");
    git(main, ["add", "README.md"]);
    git(main, ["commit", "-m", "init"]);
    write(main, "public/favicon.png", PNG_1X1);
    write(main, ".gitignore", "public/favicon.png\n");

    const wt = path.join(tmpDir, "wt");
    git(main, ["worktree", "add", wt, "HEAD"]);
    assert.equal(
      fs.existsSync(path.join(wt, "public/favicon.png")),
      false,
      "gitignored file must not appear in the worktree",
    );
    const found = resolveIconPath(wt);
    assert.ok(found, "worktree must resolve to the main checkout's favicon");
    assert.equal(
      fs.realpathSync(found),
      fs.realpathSync(path.join(main, "public/favicon.png")),
    );
  });
});

describe("services project icon", () => {
  let tmpDir;
  let store;
  let repo;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-icon-svc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    write(repo, "README.md", "hi\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    clearIconCache();
  });

  afterEach(() => {
    clearIconCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("listProjects attaches iconUrl without persisting it", async () => {
    write(repo, "public/favicon.png", PNG_1X1);
    const project = await services.addProject(store, repo);
    assert.ok(project.iconUrl && project.iconUrl.startsWith("data:image/png"));
    assert.equal("iconUrl" in store.getProjects()[0], false);
    const listed = services.listProjects(store);
    assert.ok(listed[0].iconUrl && listed[0].iconUrl.startsWith("data:image/png"));
    assert.equal("iconUrl" in store.getProjects()[0], false);
  });

  it("updateProject stores iconPath and clears it on Automatic", async () => {
    write(repo, "custom/pick.svg", SVG);
    const project = await services.addProject(store, repo);
    const set = services.updateProject(store, project.id, {
      iconPath: "custom/pick.svg",
    });
    assert.equal(set.iconPath, "custom/pick.svg");
    assert.ok(set.iconUrl && set.iconUrl.startsWith("data:image/svg+xml"));
    assert.equal(store.getProjects()[0].iconPath, "custom/pick.svg");
    assert.equal("iconUrl" in store.getProjects()[0], false);

    const cleared = services.updateProject(store, project.id, { iconPath: null });
    assert.equal(cleared.iconPath, undefined);
    assert.equal("iconPath" in store.getProjects()[0], false);
  });

  it("a name-only patch leaves iconPath alone", async () => {
    write(repo, "icon.png", PNG_1X1);
    const project = await services.addProject(store, repo);
    services.updateProject(store, project.id, { iconPath: "icon.png" });
    const renamed = services.updateProject(store, project.id, { name: "ledger" });
    assert.equal(renamed.name, "ledger");
    assert.equal(renamed.iconPath, "icon.png");
  });

  it("rejects a traversal iconPath", async () => {
    const project = await services.addProject(store, repo);
    assert.throws(
      () =>
        services.updateProject(store, project.id, {
          iconPath: "../outside.png",
        }),
      /relative/i,
    );
  });

  it("pickProjectIcon returns a relative path inside the project", async () => {
    const abs = write(repo, "assets/icon.png", PNG_1X1);
    const project = await services.addProject(store, repo);
    const picked = await services.pickProjectIcon(store, project.id, {
      showOpenDialog: async () => ({ canceled: false, filePaths: [abs] }),
    });
    assert.deepEqual(
      { iconPath: picked.iconPath, hasUrl: Boolean(picked.iconUrl) },
      { iconPath: "assets/icon.png", hasUrl: true },
    );
  });

  it("pickProjectIcon returns null on cancel", async () => {
    const project = await services.addProject(store, repo);
    const picked = await services.pickProjectIcon(store, project.id, {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    });
    assert.equal(picked, null);
  });

  it("pickProjectIcon rejects a file outside the project", async () => {
    const outside = write(tmpDir, "outside.png", PNG_1X1);
    const project = await services.addProject(store, repo);
    await assert.rejects(
      () =>
        services.pickProjectIcon(store, project.id, {
          showOpenDialog: async () => ({
            canceled: false,
            filePaths: [outside],
          }),
        }),
      /inside the project/i,
    );
  });

  it("resolveProjectIcon Automatic ignores a stored override", async () => {
    write(repo, "public/favicon.png", PNG_1X1);
    write(repo, "custom/pick.svg", SVG);
    const project = await services.addProject(store, repo);
    services.updateProject(store, project.id, { iconPath: "custom/pick.svg" });
    const auto = services.resolveProjectIcon(store, project.id, null);
    assert.ok(auto.iconUrl && auto.iconUrl.startsWith("data:image/png"));
    const override = services.resolveProjectIcon(store, project.id);
    assert.ok(override.iconUrl && override.iconUrl.startsWith("data:image/svg+xml"));
  });
});

describe("projects:pickIcon / resolveIcon IPC", () => {
  let tmpDir;
  let store;
  let repo;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-icon-ipc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    write(repo, "README.md", "hi\n");
    project = await services.addProject(store, repo);
    clearIconCache();
  });

  afterEach(() => {
    clearIconCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("projects:pickIcon uses the dialog and stays inside the project", async () => {
    const abs = write(repo, "icon.svg", SVG);
    const ctx = {
      store,
      dialog: {
        showOpenDialog: async (opts) => {
          assert.ok(opts.filters.some((f) => f.extensions.includes("svg")));
          return { canceled: false, filePaths: [abs] };
        },
      },
    };
    const picked = await IPC_HANDLERS["projects:pickIcon"](ctx, {
      projectId: project.id,
    });
    assert.equal(picked.iconPath, "icon.svg");
    assert.ok(picked.iconUrl.startsWith("data:image/svg+xml"));
  });

  it("projects:resolveIcon returns the auto-detected data URL", async () => {
    write(repo, "favicon.png", PNG_1X1);
    clearIconCache();
    const ctx = { store };
    const resolved = await IPC_HANDLERS["projects:resolveIcon"](ctx, {
      projectId: project.id,
      iconPath: null,
    });
    assert.ok(resolved.iconUrl.startsWith("data:image/png"));
  });
});

describe("ICON_EXTENSIONS", () => {
  it("covers the T3 picker set", () => {
    for (const ext of ["svg", "png", "ico", "jpg", "jpeg", "gif", "avif", "webp"]) {
      assert.ok(ICON_EXTENSIONS.includes(ext), ext);
    }
  });
});
