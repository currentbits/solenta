/**
 * Shared add-project browse-path helpers (#609).
 *
 * Run: node --import=./test/support/render.mjs --test test/browsePath.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendBrowsePathSegment,
  canNavigateUp,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  findExistingAddProject,
  findProjectByPath,
  getAddProjectInitialQuery,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getCloneDirectoryName,
  getFilesystemBrowsePath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isFilesystemBrowseQuery,
  isUnsupportedWindowsProjectPath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
  resolveAddProjectPath,
  resolveProjectPathForDispatch,
} from "../src/browsePath";

describe("add-project browse path", () => {
  it("seeds the typed path with ~/", () => {
    assert.equal(getAddProjectInitialQuery(""), "~/");
    assert.equal(getAddProjectInitialQuery("   "), "~/");
    assert.equal(getAddProjectInitialQuery("/work"), "/work/");
    assert.equal(getAddProjectInitialQuery("C:\\work"), "C:\\work\\");
  });

  it("derives the browse target and navigation state", () => {
    assert.deepEqual(getFilesystemBrowsePath("~/projects/t3"), {
      isBrowsing: true,
      directoryPath: "~/projects/",
      filterQuery: "t3",
      parentPath: "~/",
      canBrowseUp: true,
    });
    assert.equal(
      getFilesystemBrowsePath("C:\\Users\\test", "MacIntel").isBrowsing,
      false,
    );
    assert.equal(getFilesystemBrowsePath("~").directoryPath, "~/");
    assert.equal(getFilesystemBrowsePath("~/").canBrowseUp, false);
  });

  it("only treats windows-style paths as browse queries on windows", () => {
    assert.equal(isFilesystemBrowseQuery("C:\\Work\\Repo\\", "MacIntel"), false);
    assert.equal(isFilesystemBrowseQuery("C:\\Work\\Repo\\", "Win32"), true);
    assert.equal(
      isUnsupportedWindowsProjectPath("C:\\Work\\Repo\\", "MacIntel"),
      true,
    );
    assert.equal(
      isUnsupportedWindowsProjectPath("C:\\Work\\Repo\\", "Win32"),
      false,
    );
  });

  it("filters names, hidden directories, and exact matches", () => {
    const entries = [
      { name: ".config", fullPath: "/Users/test/.config" },
      { name: "Code", fullPath: "/Users/test/Code" },
      { name: "codething", fullPath: "/Users/test/codething" },
    ];
    assert.deepEqual(filterFilesystemBrowseEntries(entries, "co"), {
      visibleEntries: entries.slice(1, 3),
      exactEntry: null,
    });
    assert.deepEqual(
      filterFilesystemBrowseEntries(entries, "").visibleEntries,
      entries.slice(1),
    );
    assert.deepEqual(
      filterFilesystemBrowseEntries(entries, ".").visibleEntries,
      entries.slice(0, 1),
    );
    assert.deepEqual(
      filterFilesystemBrowseEntries(entries, "Code").exactEntry,
      entries[1],
    );
  });

  it("navigates browse paths with matching separators", () => {
    assert.equal(appendBrowsePathSegment("/repo/", "src"), "/repo/src/");
    assert.equal(
      appendBrowsePathSegment("C:\\Work\\", "Repo"),
      "C:\\Work\\Repo\\",
    );
    assert.equal(getBrowseParentPath("/repo/src/"), "/repo/");
    assert.equal(getBrowseParentPath("C:\\Work\\Repo\\"), "C:\\Work\\");
    assert.equal(getBrowseParentPath("\\\\server\\share\\"), null);
    assert.equal(
      getBrowseParentPath("\\\\server\\share\\repo\\"),
      "\\\\server\\share\\",
    );
    assert.equal(getBrowseParentPath("C:\\"), null);
    assert.equal(hasTrailingPathSeparator("/repo/src/"), true);
    assert.equal(hasTrailingPathSeparator("/repo/src"), false);
    assert.equal(getBrowseDirectoryPath("/repo/src"), "/repo/");
    assert.equal(getBrowseLeafPathSegment("/repo/src"), "src");
    assert.equal(canNavigateUp("~/repo"), false);
    assert.equal(canNavigateUp("~/repo/"), true);
  });

  it("resolves relative paths from the active project cwd", () => {
    assert.deepEqual(
      resolveAddProjectPath({
        rawPath: "../next",
        platform: "Linux",
        currentProjectCwd: "/work/current",
      }),
      { ok: true, path: "/work/next" },
    );
    assert.equal(
      resolveProjectPathForDispatch("./docs", "/repo/app"),
      "/repo/app/docs",
    );
    assert.equal(isExplicitRelativeProjectPath("../docs"), true);
    assert.equal(isExplicitRelativeProjectPath("/repo/docs"), false);
  });

  it("rejects unsupported windows paths on non-windows environments", () => {
    assert.deepEqual(
      resolveAddProjectPath({
        rawPath: "C:\\repo",
        platform: "MacIntel",
        currentProjectCwd: null,
      }),
      {
        ok: false,
        error:
          "Windows-style paths are only supported on Windows environments.",
      },
    );
  });

  it("rejects relative paths without an active project", () => {
    assert.deepEqual(
      resolveAddProjectPath({
        rawPath: "./docs",
        platform: "Linux",
        currentProjectCwd: null,
      }),
      {
        ok: false,
        error: "Relative paths require an active project in this environment.",
      },
    );
  });

  it("finds existing projects by normalized path, scoped by remote host", () => {
    const projects = [
      { id: "other", path: "/repo", remoteHost: "dev@box", remotePath: "/repo" },
      { id: "local", path: "/repo/" },
    ];
    assert.equal(
      findExistingAddProject({ projects, path: "/repo" })?.id,
      "local",
    );
    assert.equal(
      findExistingAddProject({
        projects,
        path: "/repo",
        remoteHost: "dev@box",
        remotePath: "/repo/",
      })?.id,
      "other",
    );
    assert.equal(
      findProjectByPath([{ id: "p", cwd: "C:\\Work\\Repo" }], "C:/Work/Repo/")
        ?.id,
      "p",
    );
  });

  it("normalizes trailing separators for dispatch and comparison", () => {
    assert.equal(normalizeProjectPathForDispatch(" /repo/app/ "), "/repo/app");
    assert.equal(normalizeProjectPathForComparison("/repo/app/"), "/repo/app");
    assert.equal(
      normalizeProjectPathForComparison("C:/Work/Repo/"),
      "c:\\work\\repo",
    );
    assert.equal(inferProjectTitleFromPath("/repo/app/"), "app");
  });

  it("proposes the clone destination inside the selected directory", () => {
    assert.equal(
      getCloneDestinationPath("~/Projects/", "repo"),
      "~/Projects/repo",
    );
    assert.equal(
      getCloneDestinationPath("~/Projects", "repo"),
      "~/Projects/repo",
    );
    assert.equal(
      getCloneDestinationPath("C:\\work\\", "repo"),
      "C:\\work\\repo",
    );
    assert.equal(getCloneDestinationPath("~/Projects/", null), "~/Projects/");
    assert.equal(getCloneDirectoryName("https://github.com/owner/repo.git"), "repo");
    assert.equal(getCloneDirectoryName("git@github.com:owner/repo.git"), "repo");
    assert.equal(getCloneDirectoryName("owner/repo"), "repo");
  });

  it("keeps pinned clone destinations from producing repo/repo", () => {
    assert.equal(
      getCloneDestinationBrowsePath({
        browseDirectoryPath: "~/Projects/",
        selectedDirectoryName: "work",
        cloneDirectoryName: "repo",
        caseSensitive: true,
      }),
      "~/Projects/work/repo",
    );
    assert.equal(
      getCloneDestinationBrowsePath({
        browseDirectoryPath: "~/Projects/",
        selectedDirectoryName: "repo",
        cloneDirectoryName: "repo",
        caseSensitive: true,
      }),
      "~/Projects/repo/",
    );
    assert.equal(
      getCloneDestinationBrowsePath({
        browseDirectoryPath: "C:\\Projects\\",
        selectedDirectoryName: "Repo",
        cloneDirectoryName: "repo",
        caseSensitive: false,
      }),
      "C:\\Projects\\Repo\\",
    );
  });

  it("only commits the latest browse navigation", async () => {
    const navigation = createBrowseNavigationCoordinator();
    let firstResolve!: () => void;
    let secondResolve!: () => void;
    const first = new Promise<void>((r) => {
      firstResolve = r;
    });
    const second = new Promise<void>((r) => {
      secondResolve = r;
    });
    const commits: string[] = [];
    const firstRun = navigation.run(() => first, () => {
      commits.push("first");
    });
    const secondRun = navigation.run(() => second, () => {
      commits.push("second");
    });
    secondResolve();
    assert.equal(await secondRun, true);
    firstResolve();
    assert.equal(await firstRun, false);
    assert.deepEqual(commits, ["second"]);
  });
});
