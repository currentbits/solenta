import type { ConflictContext, ConflictFileBody } from "./shared/ipc";

export type { ConflictContext, ConflictFileBody };

/** Inputs for the one-click "let the agent resolve" prompt (#163). */
export type ConflictResolveInput = {
  files: ConflictFileBody[];
  omitted?: number;
  branch?: string | null;
  baseBranch?: string | null;
};

/**
 * Indented paths from a MERGE_CONFLICT: body (headline, then `  path` lines,
 * then a footer). Headlines and footers are unindented.
 */
export function parseConflictFiles(message: string): string[] {
  const files: string[] = [];
  for (const line of message.split("\n")) {
    const match = /^ {2}(\S.*)$/.exec(line);
    if (match) files.push(match[1].trim());
  }
  return files;
}

/** Build the user-turn prompt that hands a merge conflict back to the agent. */
export function buildConflictResolvePrompt(input: ConflictResolveInput): string {
  const files = input.files;
  const branch = (input.branch || "").trim();
  const base = (input.baseBranch || "").trim();
  const vs =
    branch && base
      ? `${branch} into ${base}`
      : branch
        ? branch
        : "this branch into the project default branch";

  const names = files.map((f) => `- ${f.path}`).join("\n");
  const omitted =
    input.omitted && input.omitted > 0
      ? `\n(${input.omitted} more conflicted ${input.omitted === 1 ? "file was" : "files were"} not attached)`
      : "";

  const snippets = files
    .map((file) => formatSnippet(file))
    .filter(Boolean)
    .join("\n\n");

  const snippetBlock = snippets
    ? `\n\nConflicted file contents:\n\n${snippets}`
    : "\n\nThe conflicted files are in this worktree with conflict markers. Read them there.";

  return `The merge of ${vs} hit conflicts. The conflict is already replayed in this worktree.

Conflicted files:
${names || "- (see git status in the worktree)"}${omitted}

Resolve every conflict in the worktree:
1. Edit each file so conflict markers are gone and the result is the intended combination of this branch and the incoming side.
2. git add each resolved file.
3. If MERGE_HEAD exists, finish the in-progress merge with git commit (the default merge message is fine).

Do not merge into the project checkout. Stop when the worktree has no conflict markers. A merge retry will follow.${snippetBlock}
`;
}

function formatSnippet(file: ConflictFileBody): string {
  if (file.binary) {
    return `### ${file.path}\n(binary file; resolve it in the worktree, do not dump it here)`;
  }
  if (!file.content) {
    return `### ${file.path}\n(read this file in the worktree; it still has conflict markers)`;
  }
  const note = file.truncated ? "\n(truncated)" : "";
  return `### ${file.path}${note}\n\`\`\`\n${file.content.replace(/\n$/, "")}\n\`\`\``;
}
