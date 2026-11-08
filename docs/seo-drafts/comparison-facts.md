# Comparison sources for owner review

Research for SL-BRIEF-02 in issue #1837. Checked on 2 November 2026. These notes
are outside `site/`; they make no published comparison claims. Competitor
selection, verdict sentences and fact sign-off still belong to the owner.

The proposed first pages are `/compare/solenta-vs-conductor` and
`/compare/solenta-vs-claude-squad`. Create the Conductor-alternatives hub only
after two approved comparisons exist. Do not translate a missing statement in
these sources into a claim that a product lacks a feature.

## Conductor

Owner verdict: TODO, two sentences.

| Row | Proposed factual cell | Primary source, checked 2026-11-02 |
| --- | --- | --- |
| Platforms | The desktop app is available for macOS. Conductor also advertises iOS, cloud workspaces and API access, so a product-wide "Mac-only" label would omit those options. | [Install](https://www.conductor.build/docs/installation), [home](https://www.conductor.build/) |
| Agents | Claude Code, Codex, Cursor and OpenCode. | [Agent overview](https://www.conductor.build/docs/reference/harnesses) |
| Isolation | Local workspaces have separate Git worktrees and branches. | [Workspaces](https://www.conductor.build/docs/concepts/workspaces-and-branches) |
| Shared memory | TODO: verify cross-provider persistent memory. Do not equate workspace notes with Solenta's memory server or claim absence. | [Workspaces](https://www.conductor.build/docs/concepts/workspaces-and-branches) |
| Issue tracker | Docs describe starting from GitHub and Linear issues. TODO: verify board behavior and other trackers. | [Issue workflow](https://www.conductor.build/docs/guides/issue-to-pr) |
| Verify gate | Actions run tests, and Checks collects CI and todos. Docs say merge may be blocked or discouraged by unresolved work. TODO: verify the precise enforcement before claiming equivalence to Solenta's verify command. | [Testing](https://www.conductor.build/docs/concepts/testing), [Checks](https://www.conductor.build/docs/reference/checks) |
| Spend caps | TODO: verify hard caps rather than usage display. | [Agent overview](https://www.conductor.build/docs/reference/harnesses), [pricing](https://www.conductor.build/pricing) |
| License | Terms describe the platform as proprietary and grant a client-software license. Owner checks this wording before publication. | [Terms](https://www.conductor.build/terms) |
| Price | The listed local Free tier is $0. Pro is $50 per month and Teams $60 per user per month. Agent subscriptions or keys are separate. Recheck before publication. | [Pricing](https://www.conductor.build/pricing), [agent overview](https://www.conductor.build/docs/reference/harnesses) |

The pricing page and homepage differ in how they describe cloud infrastructure.
That detail is unnecessary for the requested comparison and is excluded.

Choose-Conductor and choose-Solenta lists: TODO, owner writes these after the
facts above are approved. Avoid claiming either is best for an untested use.

## Claude Squad

Identity: the terminal application at `smtg-ai/claude-squad`. Search also returns
other projects using the name, so link to this repository explicitly.

Owner verdict: TODO, two sentences.

| Row | Proposed factual cell | Primary source, checked 2026-11-02 |
| --- | --- | --- |
| Platforms | Terminal interface. Release configuration lists macOS, Linux and Windows build targets. Runtime support, especially tmux on Windows, still needs verification before claiming platform compatibility. | [Repository](https://github.com/smtg-ai/claude-squad), [release configuration](https://github.com/smtg-ai/claude-squad/blob/main/.goreleaser.yaml) |
| Agents | README names Claude Code, Codex, Gemini and Aider and documents a configurable program command. Repository description also names OpenCode and Amp. Preserve this distinction rather than inventing one exhaustive list. | [README](https://github.com/smtg-ai/claude-squad#readme) |
| Isolation | tmux sessions and per-task Git worktrees. | [How it works](https://github.com/smtg-ai/claude-squad#how-it-works) |
| Shared memory | TODO: verify. Absence from this README does not establish lack of support. | [README](https://github.com/smtg-ai/claude-squad#readme) |
| Issue tracker | TODO: verify. A GitHub CLI prerequisite alone does not establish issue-board support. | [README](https://github.com/smtg-ai/claude-squad#readme) |
| Verify gate | TODO: verify. README describes review and checkout controls, which do not alone prove an enforced verification gate. | [README](https://github.com/smtg-ai/claude-squad#readme) |
| Spend caps | TODO: verify. | [README](https://github.com/smtg-ai/claude-squad#readme) |
| License | AGPL-3.0. | [License](https://github.com/smtg-ai/claude-squad/blob/main/LICENSE.md) |
| Price | TODO: owner verifies price wording. License availability alone is not a pricing statement. | [README](https://github.com/smtg-ai/claude-squad#readme) |

Choose-Claude-Squad and choose-Solenta lists: TODO, owner writes these after
fact review.

## Solenta cells

Use the current site's statements with their source links. Provider and tracker
wording must follow the owner's pending SL-P1-05 decision.

| Row | Existing documented fact | Source |
| --- | --- | --- |
| Platforms | Desktop releases for macOS, Windows and Linux. | [Install](https://solenta.app/#install) |
| Agents | Pending the owner's advertised provider list. | [Threads](https://solenta.app/docs.html#threads) |
| Isolation | A thread can run in its own worktree and branch. | [Worktrees](https://solenta.app/docs.html#worktrees) |
| Shared memory | Local SQLite, full-text and vector search over HTTP and MCP, bearer-token gated. | [Memory](https://solenta.app/docs.html#memory) |
| Issue tracker | Pending the owner's advertised tracker list. | [Views](https://solenta.app/docs.html#views) |
| Verify gate | A configured verify command must exit 0 for a thread to settle green. | [Verification](https://solenta.app/docs.html#guardrails) |
| Spend caps | A daily budget blocks new runs once reached. | [Spend](https://solenta.app/docs.html#spend) |
| License | MIT. | [Source](https://github.com/currentbits/solenta/blob/main/LICENSE) |
| Price | Free app with the user's agent subscriptions or API keys. | [Home FAQ](https://solenta.app/#faq) |

## Common migration section draft

Solenta can import existing CLI sessions from supported providers. Use the
caret beside New thread, select the project and the provider's import action,
then choose sessions. Re-importing appends new turns without duplicating the
thread. This imports provider sessions; it does not claim to import either
competitor's workspace database. Source:
[Import, eject and reclaim](https://solenta.app/docs.html#cli-sessions).

## Publication gates

Resolve every TODO, recheck each source and record owner fact sign-off. The
published comparison needs the owner's two-sentence verdict, choose-if lists,
migration section and three FAQs, plus WebPage, BreadcrumbList and matching
FAQPage. Add the canonical URL to sitemap, link it from home and footer, and add
it to llms.txt. Unknown fields must remain in this review document until
verified; they must not become negative claims in public tables.
