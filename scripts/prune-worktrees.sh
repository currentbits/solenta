#!/usr/bin/env bash
# prune-worktrees.sh — clean up landed agentmux/* branches and their worktrees.
#
# A branch counts as LANDED only when merging it into main would change
# nothing: git merge-tree --write-tree main <branch> produces main's own tree.
# (Squash merges defeat both git branch --merged and three-dot diffs; this
# predicate proves content equivalence.) Anything else is SKIPPED and
# reported, never deleted, including branches whose files main has since
# rewritten: those cannot be proven landed automatically.
#
# DRY RUN by default: prints the plan. Pass --apply to execute.
set -euo pipefail
cd "$(dirname "$0")/.."

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

WORKTREE_BASE="$HOME/Library/Application Support/AgentMux/worktrees"

landed=0
skipped=0

MAIN_TREE=$(git rev-parse 'main^{tree}')

for branch in $(git for-each-ref --format='%(refname:short)' refs/heads/agentmux); do
  merged_tree=$(git merge-tree --write-tree main "$branch" 2>/dev/null | head -1 || true)
  if [[ "$merged_tree" != "$MAIN_TREE" ]]; then
    echo "SKIP   $branch (merge would change main; not provably landed)"
    skipped=$((skipped + 1))
    continue
  fi

  id="${branch#agentmux/}"
  wt="$WORKTREE_BASE/coder-$id"
  echo "LANDED $branch"
  landed=$((landed + 1))

  if [[ -d "$wt" ]]; then
    if [[ "$APPLY" == "1" ]]; then
      if git worktree remove "$wt" 2>/dev/null; then
        echo "       removed worktree $wt"
      else
        echo "       WARN: worktree dirty or locked, skipped: $wt"
        continue
      fi
    else
      echo "       would remove worktree $wt"
    fi
  fi

  if [[ "$APPLY" == "1" ]]; then
    git branch -D "$branch" >/dev/null
    echo "       deleted branch $branch"
  else
    echo "       would delete branch $branch"
  fi
done

echo
echo "landed: $landed, skipped: $skipped$( [[ "$APPLY" == "1" ]] || echo '  (dry run; pass --apply to execute)')"
