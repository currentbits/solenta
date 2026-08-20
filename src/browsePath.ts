/**
 * Typed/browsable project-path helpers (#609). Ported from T3's
 * client-runtime path + filesystem browse model so add-project and the
 * later clone destination step (#459) share one cursor: the query is both
 * the path input and the browse location.
 */

export interface FilesystemBrowseEntry {
  name: string;
  fullPath: string;
  /** Recent project path shown on the empty / ~/ query. */
  recent?: boolean;
}

export interface FilesystemBrowseResult {
  parentPath: string;
  entries: FilesystemBrowseEntry[];
}

export interface FsBrowseInput {
  /** Directory (or partial path) to list. Empty / `~` / `~/` lists home + frecency. */
  path: string;
  /** SSH `user@host`. Omit / empty = local filesystem. */
  environment?: string | null;
  /** Active project cwd; required to resolve `./` and `../`. */
  cwd?: string | null;
}

export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

export function isExplicitRelativeProjectPath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

function lastNonEmpty(values: readonly string[]): string | undefined {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i]) return values[i];
  }
  return undefined;
}

function isRootPath(value: string): boolean {
  return value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]$/.test(value);
}

function trimTrailingPathSeparators(value: string): string {
  if (value.length === 0 || isRootPath(value)) return value;
  const trimmed = value.startsWith("/")
    ? value.replace(/\/+$/g, "")
    : value.replace(/[\\/]+$/g, "");
  if (trimmed.length === 0) return value;
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

export function normalizeProjectPathForDispatch(value: string): string {
  return trimTrailingPathSeparators(value.trim());
}

export function normalizeProjectPathForComparison(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  if (isWindowsDrivePath(normalized) || isUncPath(normalized)) {
    return normalized.replaceAll("/", "\\").toLowerCase();
  }
  return normalized;
}

function getAbsolutePathKind(value: string): "unix" | "windows" | null {
  if (isWindowsDrivePath(value) || isUncPath(value)) return "windows";
  if (value.startsWith("/")) return "unix";
  return null;
}

function preferredPathSeparator(value: string): "/" | "\\" {
  const kind = getAbsolutePathKind(value);
  if (kind === "windows") return "\\";
  if (kind === "unix") return "/";
  return value.includes("\\") ? "\\" : "/";
}

export function hasTrailingPathSeparator(value: string): boolean {
  return (getAbsolutePathKind(value) === "unix" ? /\/$/ : /[\\/]$/).test(value);
}

function splitPathSegments(value: string, separator: "/" | "\\"): string[] {
  return value.split(separator === "/" ? /\/+/ : /[\\/]+/).filter(Boolean);
}

function getLastPathSeparatorIndex(value: string): number {
  if (getAbsolutePathKind(value) === "unix") return value.lastIndexOf("/");
  return Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
}

function splitAbsolutePath(value: string): {
  root: string;
  separator: "/" | "\\";
  segments: string[];
} | null {
  if (isWindowsDrivePath(value)) {
    const root = `${value.slice(0, 2)}\\`;
    const segments = splitPathSegments(value.slice(root.length), "\\");
    return { root, separator: "\\", segments };
  }
  if (isUncPath(value)) {
    const segments = splitPathSegments(value, "\\");
    const [server, share, ...rest] = segments;
    if (!server || !share) return null;
    return {
      root: `\\\\${server}\\${share}\\`,
      separator: "\\",
      segments: rest,
    };
  }
  if (value.startsWith("/")) {
    return {
      root: "/",
      separator: "/",
      segments: splitPathSegments(value.slice(1), "/"),
    };
  }
  return null;
}

export function isFilesystemBrowseQuery(value: string, platform = ""): boolean {
  const allowWindowsPaths = isWindowsPlatform(platform);
  return (
    value === "~" ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.startsWith("/") ||
    value.startsWith("~/") ||
    (allowWindowsPaths && isWindowsAbsolutePath(value))
  );
}

export function isUnsupportedWindowsProjectPath(
  value: string,
  platform: string,
): boolean {
  return isWindowsAbsolutePath(value) && !isWindowsPlatform(platform);
}

export function resolveProjectPathForDispatch(
  value: string,
  cwd?: string | null,
): string {
  const trimmedValue = value.trim();
  if (!isExplicitRelativeProjectPath(trimmedValue) || !cwd) {
    return normalizeProjectPathForDispatch(trimmedValue);
  }

  const absoluteBase = splitAbsolutePath(normalizeProjectPathForDispatch(cwd));
  if (!absoluteBase) {
    return normalizeProjectPathForDispatch(trimmedValue);
  }

  const nextSegments = [...absoluteBase.segments];
  for (const segment of trimmedValue.split(/[\\/]+/)) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      nextSegments.pop();
      continue;
    }
    nextSegments.push(segment);
  }

  const joinedPath = nextSegments.join(absoluteBase.separator);
  return normalizeProjectPathForDispatch(
    joinedPath.length === 0
      ? absoluteBase.root
      : `${absoluteBase.root}${joinedPath}`,
  );
}

export function findProjectByPath<
  T extends { path?: string; workspaceRoot?: string; cwd?: string },
>(projects: ReadonlyArray<T>, candidatePath: string): T | undefined {
  const normalizedCandidate = normalizeProjectPathForComparison(candidatePath);
  if (normalizedCandidate.length === 0) return undefined;
  return projects.find((project) => {
    const cwd = project.path ?? project.workspaceRoot ?? project.cwd;
    return cwd
      ? normalizeProjectPathForComparison(cwd) === normalizedCandidate
      : false;
  });
}

export function findExistingAddProject<
  T extends { path: string; remoteHost?: string; remotePath?: string },
>(input: {
  projects: ReadonlyArray<T>;
  path: string;
  remoteHost?: string | null;
  remotePath?: string | null;
}): T | null {
  const host = (input.remoteHost ?? "").trim();
  if (host) {
    const rpath = normalizeProjectPathForComparison(input.remotePath ?? "");
    if (!rpath) return null;
    return (
      input.projects.find(
        (project) =>
          (project.remoteHost ?? "").trim() === host &&
          normalizeProjectPathForComparison(project.remotePath ?? "") ===
            rpath,
      ) ?? null
    );
  }
  const found = findProjectByPath(
    input.projects.filter((project) => !project.remoteHost),
    input.path,
  );
  return found ?? null;
}

export function inferProjectTitleFromPath(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  const absolutePath = splitAbsolutePath(normalized);
  if (absolutePath) {
    return lastNonEmpty(absolutePath.segments) ?? normalized;
  }
  return lastNonEmpty(normalized.split(/[/\\]/)) ?? normalized;
}

export function getBrowseLeafPathSegment(currentPath: string): string {
  const lastSeparatorIndex = getLastPathSeparatorIndex(currentPath);
  return currentPath.slice(lastSeparatorIndex + 1);
}

export function getBrowseDirectoryPath(currentPath: string): string {
  if (hasTrailingPathSeparator(currentPath)) return currentPath;
  const lastSeparatorIndex = getLastPathSeparatorIndex(currentPath);
  return lastSeparatorIndex < 0
    ? currentPath
    : currentPath.slice(0, lastSeparatorIndex + 1);
}

export function ensureBrowseDirectoryPath(currentPath: string): string {
  const trimmed = currentPath.trim();
  if (trimmed.length === 0 || hasTrailingPathSeparator(trimmed)) return trimmed;
  return `${trimmed}${preferredPathSeparator(trimmed)}`;
}

export function appendBrowsePathSegment(
  currentPath: string,
  segment: string,
): string {
  const separator = preferredPathSeparator(currentPath);
  return `${getBrowseDirectoryPath(currentPath)}${segment}${separator}`;
}

export function getBrowseParentPath(currentPath: string): string | null {
  const trimmed = normalizeProjectPathForDispatch(currentPath);
  const absolutePath = splitAbsolutePath(trimmed);
  if (absolutePath) {
    if (absolutePath.segments.length === 0) return null;
    if (absolutePath.segments.length === 1) return absolutePath.root;
    const parentSegments = absolutePath.segments
      .slice(0, -1)
      .join(absolutePath.separator);
    return `${absolutePath.root}${parentSegments}${absolutePath.separator}`;
  }

  const separator = preferredPathSeparator(currentPath);
  const lastSeparatorIndex = getLastPathSeparatorIndex(trimmed);
  if (lastSeparatorIndex < 0) return null;
  if (lastSeparatorIndex === 2 && /^[a-zA-Z]:/.test(trimmed)) {
    return `${trimmed.slice(0, 2)}${separator}`;
  }
  return trimmed.slice(0, lastSeparatorIndex + 1);
}

export function canNavigateUp(currentPath: string): boolean {
  return (
    hasTrailingPathSeparator(currentPath) &&
    getBrowseParentPath(currentPath) !== null
  );
}

export function getAddProjectInitialQuery(
  baseDirectory: string | null | undefined,
): string {
  const trimmed = baseDirectory?.trim() ?? "";
  return trimmed.length === 0 ? "~/" : ensureBrowseDirectoryPath(trimmed);
}

export function getFilesystemBrowsePath(query: string, platform = "") {
  const normalized = query.trim() === "~" ? "~/" : query;
  const isBrowsing = isFilesystemBrowseQuery(normalized, platform);
  const directoryPath = isBrowsing ? getBrowseDirectoryPath(normalized) : "";
  const filterQuery =
    isBrowsing && !hasTrailingPathSeparator(normalized)
      ? getBrowseLeafPathSegment(normalized)
      : "";
  const parentPath = isBrowsing ? getBrowseParentPath(directoryPath) : null;

  return {
    isBrowsing,
    directoryPath,
    filterQuery,
    parentPath,
    canBrowseUp: isBrowsing && canNavigateUp(directoryPath),
  };
}

export function filterFilesystemBrowseEntries(
  entries: ReadonlyArray<FilesystemBrowseEntry>,
  query: string,
): {
  visibleEntries: FilesystemBrowseEntry[];
  exactEntry: FilesystemBrowseEntry | null;
} {
  const lowerQuery = query.toLowerCase();
  const showHidden = query.startsWith(".");
  const visibleEntries = entries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(lowerQuery) &&
      (showHidden || !entry.name.startsWith(".") || Boolean(entry.recent)),
  );
  const exactEntry =
    query.length > 0
      ? (visibleEntries.find((entry) => entry.name === query) ?? null)
      : null;
  return { visibleEntries, exactEntry };
}

export function filterPinnedBrowseEntries(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  filterQuery: string;
  pinnedDirectoryName: string;
  caseSensitive: boolean;
}): ReturnType<typeof filterFilesystemBrowseEntries> {
  const namesMatch = (left: string, right: string) =>
    input.caseSensitive
      ? left === right
      : left.toLowerCase() === right.toLowerCase();
  const visibleFilterQuery = namesMatch(
    input.filterQuery,
    input.pinnedDirectoryName,
  )
    ? ""
    : input.filterQuery;
  const { visibleEntries } = filterFilesystemBrowseEntries(
    input.browseEntries,
    visibleFilterQuery,
  );
  const exactEntry =
    input.filterQuery.length > 0
      ? (input.browseEntries.find((entry) =>
          namesMatch(entry.name, input.filterQuery),
        ) ?? null)
      : null;
  return { visibleEntries, exactEntry };
}

export function getCloneDirectoryName(
  repositoryOrRemoteUrl: string | null | undefined,
): string {
  const withoutQuery =
    (repositoryOrRemoteUrl ?? "").split(/[?#]/)[0]?.trim() ?? "";
  const schemeIndex = withoutQuery.indexOf("://");
  const hasHost =
    schemeIndex >= 0 || /^[^/\\:]+@[^/\\:]+:/.test(withoutQuery);
  const pathPart =
    schemeIndex >= 0
      ? withoutQuery.slice(schemeIndex + "://".length)
      : withoutQuery;
  const segments = pathPart
    .split(/[/\\:]+/)
    .filter((segment) => segment.trim().length > 0);
  if (hasHost && segments.length < 2) return "";

  const lastSegment = segments.at(-1)?.trim() ?? "";
  if (hasHost && segments.length === 2 && /^\d+$/.test(lastSegment)) return "";
  return lastSegment.endsWith(".git")
    ? lastSegment.slice(0, -".git".length)
    : lastSegment;
}

export function getCloneDestinationPath(
  directoryPath: string,
  directoryName: string | null | undefined,
): string {
  const name = directoryName?.trim() ?? "";
  if (name.length === 0) return directoryPath;
  return `${ensureBrowseDirectoryPath(directoryPath)}${name}`;
}

export function getCloneDestinationBrowsePath(input: {
  browseDirectoryPath: string;
  selectedDirectoryName: string;
  cloneDirectoryName: string;
  caseSensitive: boolean;
}): string {
  const selectedDirectoryPath = appendBrowsePathSegment(
    input.browseDirectoryPath,
    input.selectedDirectoryName,
  );
  const selectedDirectoryMatches = input.caseSensitive
    ? input.selectedDirectoryName === input.cloneDirectoryName
    : input.selectedDirectoryName.toLowerCase() ===
      input.cloneDirectoryName.toLowerCase();
  return selectedDirectoryMatches
    ? selectedDirectoryPath
    : getCloneDestinationPath(selectedDirectoryPath, input.cloneDirectoryName);
}

export function resolveAddProjectPath(input: {
  rawPath: string;
  currentProjectCwd?: string | null;
  platform: string;
}): { ok: true; path: string } | { ok: false; error: string } {
  const rawPath = input.rawPath.trim();
  if (rawPath.length === 0) {
    return { ok: false, error: "Enter a project path." };
  }
  if (isUnsupportedWindowsProjectPath(rawPath, input.platform)) {
    return {
      ok: false,
      error: "Windows-style paths are only supported on Windows environments.",
    };
  }
  if (
    isExplicitRelativeProjectPath(rawPath) &&
    !input.currentProjectCwd
  ) {
    return {
      ok: false,
      error: "Relative paths require an active project in this environment.",
    };
  }
  const path = resolveProjectPathForDispatch(rawPath, input.currentProjectCwd);
  return path.length === 0
    ? { ok: false, error: "Enter a project path." }
    : { ok: true, path };
}

export function createBrowseNavigationCoordinator() {
  let generation = 0;
  return {
    invalidate: () => {
      generation += 1;
    },
    run: async (load: () => Promise<void>, commit: () => void) => {
      const navigationGeneration = ++generation;
      await load();
      if (navigationGeneration !== generation) return false;
      commit();
      return true;
    },
  };
}

/** Path used as the browse cursor once a clone folder is pinned onto it. */
export function browseQueryForSubmit(
  query: string,
  exactEntry: FilesystemBrowseEntry | null,
  parentPath: string | null,
): string {
  const trimmed = query.trim();
  if (hasTrailingPathSeparator(trimmed) || trimmed === "~") {
    return parentPath || normalizeProjectPathForDispatch(trimmed);
  }
  return exactEntry?.fullPath ?? trimmed;
}
