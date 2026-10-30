/**
 * Pure folder-tree builder for the Changes panel / PR Code tab Tree view
 * (#1772). Both panes render a flat file list today; this turns that list
 * into a directory tree without touching either component's state.
 *
 * Single-child directory chains compress into one row ("src/components/thread"
 * instead of three nested rows) the way VS Code's explorer does: a directory
 * compresses into its child for as long as it holds nothing but that one
 * subdirectory.
 */

export interface FileTreeFile<F> {
  kind: "file";
  /** Full repo-relative path. */
  path: string;
  file: F;
}

export interface FileTreeDir<F> {
  kind: "dir";
  /** Full repo-relative path of this row, compressed chain included. */
  path: string;
  /** Display label, e.g. "components/thread" for a compressed chain. */
  name: string;
  children: FileTreeNode<F>[];
  /** Files anywhere below this row. */
  fileCount: number;
  additions: number;
  deletions: number;
}

export type FileTreeNode<F> = FileTreeFile<F> | FileTreeDir<F>;

type RawDir<F> = {
  dirs: Map<string, RawDir<F>>;
  files: F[];
};

function emptyRaw<F>(): RawDir<F> {
  return { dirs: new Map(), files: [] };
}

function insert<F extends { path: string }>(root: RawDir<F>, file: F): void {
  const parts = file.path.split("/").filter(Boolean);
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    let child = node.dirs.get(seg);
    if (!child) {
      child = emptyRaw();
      node.dirs.set(seg, child);
    }
    node = child;
  }
  node.files.push(file);
}

function sumStats<F extends { additions: number; deletions: number }>(
  children: FileTreeNode<F>[],
): { fileCount: number; additions: number; deletions: number } {
  let fileCount = 0;
  let additions = 0;
  let deletions = 0;
  for (const c of children) {
    if (c.kind === "file") {
      fileCount += 1;
      additions += c.file.additions;
      deletions += c.file.deletions;
    } else {
      fileCount += c.fileCount;
      additions += c.additions;
      deletions += c.deletions;
    }
  }
  return { fileCount, additions, deletions };
}

/** One raw directory, compressed down its single-child chain and converted. */
function buildDir<F extends { path: string; additions: number; deletions: number }>(
  name: string,
  raw: RawDir<F>,
  parentPath: string,
): FileTreeDir<F> {
  let label = name;
  let node = raw;
  // Compress while this directory holds nothing but one subdirectory.
  while (node.files.length === 0 && node.dirs.size === 1) {
    const [[childName, childRaw]] = node.dirs;
    label = `${label}/${childName}`;
    node = childRaw!;
  }
  const path = parentPath ? `${parentPath}/${label}` : label;
  const children = toNodes(node, path);
  return { kind: "dir", path, name: label, children, ...sumStats(children) };
}

function toNodes<F extends { path: string; additions: number; deletions: number }>(
  raw: RawDir<F>,
  parentPath: string,
): FileTreeNode<F>[] {
  const dirs = [...raw.dirs.entries()]
    .map(([name, childRaw]) => buildDir(name, childRaw, parentPath))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files: FileTreeFile<F>[] = raw.files
    .map((file) => ({ kind: "file" as const, path: file.path, file }))
    .sort((a, b) => a.path.localeCompare(b.path));
  // Dirs before files (#1772).
  return [...dirs, ...files];
}

/** Build a directory tree from a flat file list. Order of `files` does not matter. */
export function buildFileTree<
  F extends { path: string; additions: number; deletions: number },
>(files: F[]): FileTreeNode<F>[] {
  const root = emptyRaw<F>();
  for (const f of files) insert(root, f);
  return toNodes(root, "");
}

/** Every directory path in a tree, for "expand all" / tests. */
export function allDirPaths<F>(nodes: FileTreeNode<F>[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.kind === "dir") {
      out.push(n.path);
      out.push(...allDirPaths(n.children));
    }
  }
  return out;
}
