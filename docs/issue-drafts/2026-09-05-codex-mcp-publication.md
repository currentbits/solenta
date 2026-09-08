# Codex sessions advertise Planboard MCP writes but omit issue tools and reject authorized GitHub writes

Published as [#927](https://github.com/currentbits/solenta/issues/927). Independently verified open with `plan:todo`. Grok's first-party issue tools succeeded for all seven publications; the Codex session's tool exposure/approval behavior differed.

## Problem
A Solenta Codex session cannot publish explicitly requested Planboard issues. The prompt requires coder-threads issue_list, issue_create, issue_set_plan and issue_complete, but none are callable. A host-side GitHub connector can read issues, while create_issue is rejected before execution.

## Observed evidence (2026-09-05)
- Current project is currentbits/solenta, with a GitHub origin.
- User explicitly requested separate issues and then explicitly asked to retry.
- The enabled tool catalogue has coder-threads task_*, work_suggest and thread_* tools, but no issue_* tools.
- A direct JavaScript availability check returned typeof tools.mcp__coder_threads__issue_create === "undefined".
- github_search_issues and github_fetch_issue succeeded. They verified #916, #918 and #919 as closed with plan:done.
- github_create_issue, with repository currentbits/solenta and label plan:todo, repeatedly returned: "MCP tool call requires approval, but approval policy is never".
- coder-threads task_add/task_claim/task_release and work_suggest succeeded, so MCP as a whole is not unavailable.
- Direct read-only host discovery was blocked by the sandbox's private-network policy. No gh writes were attempted.
- Six confirmed app defects remain ready to file in docs/issue-drafts/2026-09-05-app-audit.json.
- The user subsequently explicitly authorized delegating publication to the Grok pool. `thread_fork(pool="grok", worktree=false)` succeeded and created worker `c34ce7bb-3714-481c-91e3-1335267db074`. Its issue_list and issue_create calls succeeded; it published product issues #921–#926 and operational issue #927. The lead verified all seven are open with plan:todo.

## Investigation targets
electron/orchServer.js already implements the four Planboard handlers and registers them only when opts.planboard is true. The HTTP handler derives that flag from the bound project selected through the MCP URL's projectId and planboardNoteFor(project.path). Check the installed host version, per-provider URL binding, tool discovery/cache on resumed Codex sessions, and the approval classification of authorized first-party writes.

These are investigation targets, not proven root causes. Do not conflate missing tool registration with an approval rejection: both were observed and may need different fixes.

Related: #849 (first-party Planboard tools), #846 (Grok forks blocked under never), #847 (managed worktree Git permissions). This is the observed Codex runtime integration failure after the issue handlers exist in source.

## Expected behavior
- A Codex session for a GitHub-backed project actually exposes the Planboard tools its prompt requires.
- Same-project issue publication explicitly requested by the user can execute through the intended host-side path, or the session presents a usable approval mechanism.
- Non-GitHub projects and cross-project writes retain their current restrictions.
- The prompt and error messages reflect effective capabilities, rather than sending the agent through unavailable tools and repeated blocked fallbacks.
- No broad sandbox bypass, local-token workaround or gh-write workaround is required.

## Acceptance
- Integration coverage verifies the actual tools/list response for a project-bound Codex launch and resume, not just exported handlers.
- A user-authorized create -> plan:todo operation succeeds in the supported Codex permission configuration.
- Tests distinguish absent registration, stale discovery, missing project binding, and approval-policy rejection.
- A non-GitHub project omits issue tools and Planboard write instructions consistently.
- Confirm the Grok delegation outcome and whether the fault is provider-specific.
