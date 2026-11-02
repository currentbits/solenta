# Solenta vs Claude Squad

Choose Solenta if you want desktop worktree threads with shared local memory, verification and an issue-backed planboard. Choose Claude Squad if you want a terminal interface for configurable local agent programs with tmux and Git worktrees.

Facts checked on **2 November 2026**. “Claude Squad” here means [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad). The comparison uses its own repository and documentation, rather than similarly named products.

## Documented differences

| Area | Solenta | Claude Squad |
| --- | --- | --- |
| Platforms | Desktop releases for macOS, Windows and Linux. [Downloads](./#install) | Terminal interface requiring tmux. Release configuration lists macOS, Linux and Windows build targets; those targets alone do not establish tested native Windows compatibility. [README](https://github.com/smtg-ai/claude-squad#readme), [build configuration](https://github.com/smtg-ai/claude-squad/blob/main/.goreleaser.yaml) |
| Agents | Claude Code, Codex, Cursor, Kimi, Grok, OpenCode and Muse Code, using installed CLIs. [Threads](docs.html#threads) | README names Claude Code, Codex, Gemini and Aider and documents a configurable program command. The repository description also names OpenCode and Amp. [Repository and README](https://github.com/smtg-ai/claude-squad) |
| Isolation | A thread can have its own Git worktree and branch. [Worktrees](docs.html#worktrees) | tmux sessions and per-task Git worktrees. [How it works](https://github.com/smtg-ai/claude-squad#how-it-works) |
| Shared memory | Local SQLite, full-text and vector search over token-gated MCP. [Memory](docs.html#memory) | Not assessed in this comparison. The README alone does not establish whether equivalent persistent memory is available. [README](https://github.com/smtg-ai/claude-squad#readme) |
| Issues | A planboard backed by GitHub or GitLab issues. [Views](docs.html#views) | Issue-board behavior was not assessed. A GitHub CLI prerequisite alone does not establish a planboard. [README](https://github.com/smtg-ai/claude-squad#readme) |
| Verification | A configured verify command must exit 0 for a thread to settle green. [Verification](docs.html#guardrails) | README describes review and checkout controls. An enforced verification gate was not assessed here. [README](https://github.com/smtg-ai/claude-squad#readme) |
| Spend caps | A daily budget blocks new runs after the cap is reached. [Spend](docs.html#spend) | Hard spend-cap behavior was not assessed. [README](https://github.com/smtg-ai/claude-squad#readme) |
| License | MIT. [License](https://github.com/currentbits/solenta/blob/main/LICENSE) | AGPL-3.0. [License](https://github.com/smtg-ai/claude-squad/blob/main/LICENSE.md) |
| Price | Free app; bring your own agent subscriptions or API keys. [FAQ](./#faq) | The repository provides source and installation instructions. This comparison makes no subscription-price claim; the source license alone is not a pricing statement. [README](https://github.com/smtg-ai/claude-squad#readme) |

“Not assessed” means this comparison does not establish whether a feature is present or absent. Check the current repository and try the workflow before relying on those rows.

## Choose Solenta if

- You want a desktop interface with stored project memory shared between supported agent sessions.
- You want a planboard on your GitHub or GitLab issues alongside worktree threads.
- You want a configured verify command and a daily budget in that interface.

## Choose Claude Squad if

- You prefer a terminal interface and already use tmux.
- You want its documented configurable agent-program command.
- Its worktree, review and checkout controls fit your existing terminal workflow.

## Bring existing CLI sessions into Solenta

Add the repository as a Solenta project, open the caret beside **New thread**, choose a supported provider's import action, and select its sessions. Re-importing appends new turns without duplicating the thread. This imports provider CLI history; it does not import Claude Squad's own session database. See [import, eject and reclaim](docs.html#cli-sessions).

Keep any existing branches you still need. Start a small new worktree thread, configure verification, and review its changes through your normal Git workflow.

## Questions

### Are Solenta and Claude Squad both coding agents?

They run agent programs rather than replacing those programs. Solenta finds supported CLIs on your PATH. Claude Squad's README describes managing configurable agent programs in terminal sessions.

### Do Windows build targets prove native Windows support?

No. Claude Squad's release configuration lists Windows targets, but its README also requires tmux. This comparison has not verified a native Windows runtime setup.

### Can I import Claude Squad's database into Solenta?

This page does not claim a database importer. Solenta's documented import workflow imports existing sessions from supported provider CLIs, which is a different source of history.

## More comparisons

- [Solenta vs Conductor](compare/solenta-vs-conductor)
- [Conductor alternatives](alternatives/conductor)
- [Run AI coding agents in parallel](guides/run-coding-agents-in-parallel)
