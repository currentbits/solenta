# How to run AI coding agents in parallel

Review draft for SL-BRIEF-03 in issue #1837. This file is outside `site/` and is
not published. Owner review and the publisher-schema decision are pending.

Proposed URL: `/guides/run-coding-agents-in-parallel`

HTML title: `How to Run Claude Code, Codex and Cursor in Parallel`

Meta description: `Run several AI coding agents on one repo without conflicts: one git worktree per agent, a verify gate before merge, and a shared memory.`

Open a thread per task in Solenta. Each thread runs the agent CLI you pick in
its own git worktree, so parallel agents never share a working copy.

You can also create the worktrees yourself. Give each task a branch, run your
chosen agent from that task's directory, and review and test the result before
merging it.

## Create two worktrees by hand

Start in an existing Git repository with a committed `main` branch. The example
uses two new branches and two sibling directories. Choose different names if
these branches or directories already exist.

```sh
git worktree add -b agent/task-a ../task-a main
git worktree add -b agent/task-b ../task-b main
git worktree list
```

The list contains your original checkout and the two new directories. Task A
uses `agent/task-a`; task B uses `agent/task-b`. Run one installed agent CLI in
each task directory and give it a separate task.

Keep related changes together. Two worktrees prevent agents from overwriting
the same working files, but changes to the same code can still conflict when
you merge the branches. Review each branch and run the project's checks before
merging it through your normal Git or pull-request workflow.

## Keep processes and dependencies separate too

Worktrees isolate working files. They do not assign application ports or change
hard-coded data paths. Give development servers different ports and keep their
data and cache directories separate when the project needs that isolation.

Check the project's setup instructions in each worktree. Keep lockfile changes
with the branch that needs them and review competing dependency changes before
merging. A second checkout does not resolve incompatible dependency edits for
you.

Solenta's [dev-server documentation](https://solenta.app/docs.html#dev-servers)
describes its separate data, configuration, cache and temporary directories.
A claimed lane sets the port. Applications must respect those environment
settings; Solenta does not rewrite hard-coded ports or paths.

## Remove finished worktrees

After reviewing and merging the work, return to the original checkout. Remove
the working directories, then delete the finished branches:

```sh
git worktree remove ../task-a
git worktree remove ../task-b
git branch -d agent/task-a agent/task-b
git worktree list
```

The example ends with only the original checkout. These commands use no force
flags. If Git refuses removal or branch deletion, inspect the remaining changes
or unmerged commits before deciding what to keep.

## Run the same workflow in Solenta

1. Add the repository as a project and open a thread for the first task.
2. Choose a new worktree and the agent CLI you want to run.
3. Open another worktree thread for the second task. Give each thread a prompt
   that describes its own change.
4. Set the project's verify command. A thread settles green only after that
   command exits with code 0; a failing check keeps the thread open with its
   output attached.
5. Set a daily budget in Settings if you want to stop new runs once the cap is
   reached. Inspect the per-thread usage and cost in the composer footer.
6. Review each thread's diff and checks, then open and review its pull request.

Read the existing docs for
[worktrees and pull requests](https://solenta.app/docs.html#worktrees),
[verification](https://solenta.app/docs.html#guardrails), and
[spend guardrails](https://solenta.app/docs.html#spend).

## Use separate tasks or an agent team

Use separate threads for work that can be reviewed and merged independently.
When workers need a shared task list and direct messages, Solenta's orchestrator
can run them as a crew. Workers still have their own worktrees. The lead reviews
their results and integrates the work before the final verification and merge.

See [orchestration](https://solenta.app/docs.html#orchestration) for crew tasks,
worker permissions, handoffs and integration. Shared memory lets later sessions
recall stored project decisions and gotchas; it does not replace reviewing a
worker's diff.

## Questions

### Can Claude Code, Codex and Cursor work on one repository at once?

Yes. Give each task its own Git worktree and branch, then run the chosen agent
from that worktree. In Solenta, choose a worktree for each thread.

### Do worktrees prevent every merge conflict?

No. They keep working files separate while the agents run. Branches that change
the same code can still need conflict resolution when you merge them.

### Does an agent saying it is done mean the checks passed?

No. In Solenta, set a verify command and inspect its result. A thread settles
green only after that command exits with code 0.

## Publication checklist

- Owner reviews the facts and the UI instructions against the current release.
- Add TechArticle, FAQPage and BreadcrumbList after confirming publisher #org.
  The FAQ schema must exactly match the three visible answers above. Do not add
  HowTo markup.
- Add the canonical URL to sitemap and llms.txt. Link from home FAQ answer one
  and the docs worktrees section. Preserve the existing FAQ mirror contract.
- If docs URLs change first, update the links above to the approved topic URLs.

## Command verification

Verified on 2 November 2026 in a disposable repository with a committed `main`
branch. Every shell command shown above was run successfully. Additional checks
confirmed the worktrees used distinct branches, a file created in task A was
absent from task B, and cleanup left one worktree. No model calls, paid agent
sessions, force deletion or changes to the user's repository were used.
