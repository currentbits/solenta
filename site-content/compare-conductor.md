# Solenta vs Conductor

Choose Solenta if you want a free, MIT-licensed desktop app for parallel agent CLIs, shared local memory and a planboard on GitHub or GitLab issues. Choose Conductor if you want its documented local Mac workspaces, cloud workspaces and mobile access.

Facts checked on **2 November 2026** against the primary sources linked below. This compares documented workflows, rather than benchmark results. A feature marked “not assessed” needs a hands-on check before it should decide your choice.

## Documented differences

| Area | Solenta | Conductor |
| --- | --- | --- |
| Platforms | Desktop releases for macOS, Windows and Linux. [Downloads](./#install) | The desktop app is available for macOS. Conductor also advertises iOS, cloud workspaces and API access. [Install](https://www.conductor.build/docs/installation), [product](https://www.conductor.build/) |
| Agents | Claude Code, Codex, Cursor, Kimi, Grok, OpenCode and Muse Code, using installed CLIs. [Threads](docs.html#threads) | Claude Code, Codex, Cursor and OpenCode. [Agent overview](https://www.conductor.build/docs/reference/harnesses) |
| Isolation | A thread can have its own Git worktree and branch. [Worktrees](docs.html#worktrees) | Local workspaces have separate Git worktrees and branches. [Workspaces](https://www.conductor.build/docs/concepts/workspaces-and-branches) |
| Shared memory | Local SQLite, full-text and vector search, exposed over token-gated MCP. [Memory](docs.html#memory) | Persistent cross-provider memory was not assessed in this comparison. Workspace context alone does not establish equivalence. [Workspaces](https://www.conductor.build/docs/concepts/workspaces-and-branches) |
| Issues | A planboard backed by the project's GitHub or GitLab issues. [Views](docs.html#views) | The documented issue workflow starts from GitHub and Linear issues. This does not establish an equivalent board. [Issue to PR](https://www.conductor.build/docs/guides/issue-to-pr) |
| Verification | A configured verify command must exit 0 for a thread to settle green. [Verification](docs.html#guardrails) | Actions run tests; Checks gathers CI, reviews and todos. Docs describe merge being blocked or discouraged by unresolved work. Exact enforcement was not tested here. [Testing](https://www.conductor.build/docs/concepts/testing), [Checks](https://www.conductor.build/docs/reference/checks) |
| Spend caps | A daily budget blocks new runs after the cap is reached. [Spend](docs.html#spend) | Hard spend-cap behavior was not assessed in this comparison. [Agent accounts](https://www.conductor.build/docs/reference/harnesses), [pricing](https://www.conductor.build/pricing) |
| License | MIT. [License](https://github.com/currentbits/solenta/blob/main/LICENSE) | Conductor's terms describe its platform as proprietary and grant a client-software license. [Terms](https://www.conductor.build/terms) |
| Price | Free app; bring your own agent subscriptions or API keys. [FAQ](./#faq) | Listed local Free tier: $0. Pro: $50/month. Teams: $60/user/month. Agent subscriptions or keys are separate. [Pricing](https://www.conductor.build/pricing), [agent accounts](https://www.conductor.build/docs/reference/harnesses) |

“Not assessed” means this comparison does not establish whether the feature is present or absent. Prices and supported agents can change; check the linked product pages before choosing a plan.

## Choose Solenta if

- You want its documented shared memory to carry stored project decisions between agent sessions.
- You want a desktop workflow for GitHub or GitLab issues, worktree threads and a configured verification command.
- You want to inspect and change the app under the MIT license.

## Choose Conductor if

- Its documented cloud workspaces, mobile app or API fit how you want to access your work.
- You use its supported agent harnesses and want its workspace and Checks workflow.
- You want the documented GitHub or Linear issue-to-PR workflow.

## Bring existing CLI sessions into Solenta

Add your repository as a Solenta project. Open the caret beside **New thread**, select the provider's import action, and choose the sessions to import. Re-importing appends new turns without duplicating the thread. This imports supported provider CLI sessions; it does not import Conductor's workspace database. See [import, eject and reclaim](docs.html#cli-sessions).

Try a small task in a new worktree, set the project's verify command, and review the diff before merging. Existing branches remain ordinary Git branches.

## Questions

### Can both apps run agents in separate Git worktrees?

Yes. Solenta documents worktree threads, and Conductor documents separate worktrees and branches for local workspaces. Worktrees isolate working files; they do not guarantee conflict-free merges.

### Is Conductor only a Mac app?

Its desktop installation docs describe macOS. Its product page also advertises iOS, cloud workspaces and API access, so describing the entire product as Mac-only would omit those options.

### Does this comparison prove Conductor lacks shared memory or spend caps?

No. Those behaviors were not assessed here. The linked sources and the comparison's scope do not establish that either feature is absent.

## More comparisons

- [Solenta vs Claude Squad](compare/solenta-vs-claude-squad)
- [Conductor alternatives](alternatives/conductor)
- [Run AI coding agents in parallel](guides/run-coding-agents-in-parallel)
