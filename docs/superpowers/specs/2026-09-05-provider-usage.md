# Provider account usage

Request: `/usage` shows actual provider quota consumption and resets, including
five-hour and weekly windows wherever the account reports them. Lead plans,
researches, and reviews; Grok workers implement.

## Plan and status

The requested coder-threads issue tools are absent from this session. No GitHub
issue was created through another channel. This document records the research
and handoff until Planboard becomes available.

- [x] Trace command routing, local history, provider registry, and IPC.
- [x] Confirm primary quota sources and probe Grok without a model turn.
- [x] Grok workers implement native RPC collection, managed adapters, and UI.
- [x] Lead reviews diffs and tests the combined implementation.
- [ ] Rendered UI inspection (blocked by session tool permissions).
- [x] Land reviewed worker changes and record remaining provider limitations.

## Design

`/usage` opens account quotas, independently of whether a thread has context.
`/context` retains the existing context breakdown. Local cost/token history is
separate. Add `usage.providerLimits()` rather than slowing `usage.byDay()`.

Return one row per real provider. Each row has provider, status (`ok`,
`unavailable`, `error`), windows, fetchedAt, and optional sanitized message.
Each window has label, usedPercent, resetsAt, and windowSeconds. IPC timestamps
are epoch milliseconds. Missing consumption is unavailable, never zero.
Percentages must be finite and nonnegative; preserve reported overages above
100 in text, capping only the visual bar at 100.
Show actual period duration; do not invent a five-hour period for weekly-only
accounts. Preserve distinct model-scoped windows where reported.

Collectors use read-only provider sources, bounded requests, and process cleanup.
They never send an LLM prompt. Login material stays in the main process and must
not enter errors, logs, tests, or renderer data. Prefer native CLI RPCs so the
provider manages its own login. Provider failure must not hide other results.

## Research, 2026-09-05

| Provider | Evidence and implementation direction |
| --- | --- |
| Codex | Official app-server `account/rateLimits/read`, also live verified with no prompt. Observed primary=10080 minutes, secondary=null, plus Spark 300/10080-minute pools and a reserve pool in `rateLimitsByLimitId`. Deduplicate the aggregate pool. Convert epoch seconds and duration minutes at the boundary. |
| Grok | Live probe: `grok agent --no-leader stdio`, ACP initialize, then `_x.ai/billing` with `{}`. No session or prompt required. Response `config.creditUsagePercent`, `config.currentPeriod.type/start/end`. Observed a weekly period; do not assume every billing period is weekly. |
| Claude | Official statusline reports five_hour/seven_day but only after an API response. A fresh fetch needs the CLI's verified usage endpoint/account source; statusline alone is insufficient. |
| Kimi | Official current kimi-code managed-usage source fetches `/coding/v1/usages`. Summary is weekly; limits include 300 TIME_UNIT_MINUTE and ISO resetTime. Decimal-string used/limit values. |
| OpenCode | CLI `stats` is local token/cost history, not account quotas. Go has real five-hour/weekly/monthly limits, but the documented server surface does not establish a general quota fetch. Requires an account-specific source; do not reuse local totals. |
| Cursor | Installed CLI help and official reference expose login status, not a verified account quota endpoint. Report unavailable unless a real source is established. |
| Muse | Installed help exposes offline MSP schema export and a stdio host. Exported the shipped schema successfully; no quota, rate-limit, or billing fields found. No account quota source established. |

Sources:

- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- https://docs.x.ai/build/cli/reference
- https://docs.x.ai/build/modes-and-commands
- https://code.claude.com/docs/en/statusline
- https://github.com/MoonshotAI/kimi-code/blob/main/packages/oauth/src/managed-usage.ts
- https://opencode.ai/docs/go/
- https://opencode.ai/docs/server/
- https://docs.cursor.com/en/cli/reference/parameters

## Worker ownership

- `9fe58588-2d88-4a9c-b4f8-a3771010cd75`: RPC collector, registry, shared types, IPC, stubs, backend tests.
- `fb242b5a-eab5-43ff-8ad4-7cd3015fdd07`: Claude/Kimi module and focused tests.
- `246c9e3f-a073-4240-a7fe-3a91ad446e3b`: quota UI, slash routing, renderer tests.

## Review targets

Verify used versus remaining semantics, missing/null fields, reset units, true
period labels, multiple Codex pools, expired snapshots, and account identity.
Exercise malformed responses, timeout cleanup, auth failures, and independent
provider failures. Confirm `/usage` without context and `/context` regression;
inspect focus, escape, refresh, error states, and IPC preload consistency.

## Review progress

Initial managed-adapter branch: `coder/fork-i-want-the-usage-command-to-show-th-fb242b`.
`node --test electron/test/provider-usage-managed.test.js` passed all 28 tests
(exit 0). Lead independently reproduced two uncovered bugs: an unknown Kimi
window unit became a weekly window, and finite extreme counts yielded an
infinite percentage. Returned to the worker for regression tests and fixes.
Also requested correction of expired macOS account handling, verification of
custom Claude account-directory selection, and preservation of body-read timeout
errors. Backend and UI workers remain in progress; no implementation is landed.

Initial UI branch: `coder/fork-i-want-the-usage-command-to-show-th-246c9e`.
Lead ran the renderer harness against providerQuota, providerUsage,
composerSlashActions, slashCommands, and usageView: all 45 tests passed (exit 0).
Command separation and local history preservation are covered. Requested fixes
for modal focus containment/restoration, advancing displayed age/reset times,
explicit stale data after refresh failure, and concurrent refresh prevention.
Temporary duplicate quota types must be replaced with the shared IPC contract
before integration. A rendered preview remains outstanding.

Initial backend commit `31251c2a` omitted the queued Grok research and additional
Codex pools. Worker is incorporating those changes and removing duplicate managed
adapters. Lead ran its updated in-progress RPC suite with
`NODE_PATH=/Users/willem/code/coder/node_modules node --test electron/test/provider-usage.test.js`:
20 tests passed (exit 0). The dependency path is necessary because this worker
checkout has no node_modules. Closed stdin/EPIPE handling, fixed error messages,
and final managed-module integration still require review.

Temporary review-only assembly of managed `f00f4258`, backend `9fdb01a8`, and
UI `3ae47266` applied cleanly over the lead checkout. No branch was merged.
`npm run typecheck` passed including preload synchronization (exit 0), and
both backend test files passed together: 55 tests (exit 0). Remaining review
changes are still being built. Local preview startup was blocked by the lead
sandbox with `listen EPERM` on loopback; visual review is not yet complete.

Managed adapters final review passed at `6e05a709`. Lead inspected the keychain
precedence correction and scoped Claude weekly windows, then reran its focused
suite: all 37 tests passed (exit 0). Managed code is ready for combined review;
backend process fixes and UI accessibility/refresh fixes are still in progress.

Backend `d7be72bd` plus managed `6e05a709`: 56 focused backend tests passed
together (exit 0). Process error handling now uses fixed messages and handles
stdin errors. Lead reproduced a remaining Codex aggregation defect: when
`rateLimitsByLimitId` includes both the aggregate duplicate and another pool,
the normalizer skips the duplicate then returns other pools without ever
emitting the aggregate. Returned for correction and a regression requiring the
main weekly quota exactly once alongside Spark. Required-module and Windows
test registration cleanup remain part of the final backend revision.

Backend `3b1ab01b` passes 21 focused tests (exit 0) and restores the main
Codex aggregate. Review identified one remaining identity bug: a distinct pool
with identical quota values is mistaken for the aggregate duplicate. Worker
is correcting deduplication to use pool identity and adding that regression.

UI `bd1b480d` passes all 50 focused renderer tests (exit 0) in the temporary
review assembly, covering modal focus/restore, refresh locking and stale state.
The assembly excludes its overlapping `src/devCoder.ts` change pending worker
coordination. Shared-type cleanup and overage presentation are still being
finalized. A standalone bundle of the actual dialog compiled successfully;
Playwright rendering was rejected because the tool requires approval and this
session has approval policy never. No visual validation is claimed.

Backend final review passed at `076c4e76`: aggregate deduplication now uses
pool identity, and its regression preserves the reserve pool even when all
quota values equal the main pool. In the review-only assembly with managed
`6e05a709`, both backend suites pass: 59 tests, exit 0. Both backend branches
are ready for landing approval; UI final contract cleanup remains in progress.

## Landing decision

All three worker implementations are reviewed and merged into this task after explicit user approval. Landing order:

1. `coder/fork-i-want-the-usage-command-to-show-th-fb242b` (`6e05a709`): Claude/Kimi adapters.
2. `coder/fork-i-want-the-usage-command-to-show-th-9fe585` (`076c4e76`): Codex/Grok collectors and shared IPC.
3. `coder/fork-i-want-the-usage-command-to-show-th-246c9e` (`1d79063e`): quota UI and command routing.

Final UI uses shared types and direct IPC, preserves numeric overages while
capping bars, and removes its devCoder overlap. Final combined review snapshot
passes typecheck and preload sync, 53 renderer tests, and 59 backend tests
(all exit 0). Rendering could not be inspected because Playwright requires
approval unavailable in this session. The preview is explicitly seeded demo data.

Provider coverage is real quota collection for Codex, Grok, Claude, and Kimi,
subject to login and available windows. Cursor, OpenCode, and Muse explicitly
report unavailable because no verified account source was established. This
is not full quota support for all providers. User approved all three merges,
and each host-side merge succeeded.

Final merged-checkout verification: 59 backend tests, 53 renderer tests,
typecheck and preload synchronization pass (exit 0). Visual inspection remains
unverified under this session's tool permissions. No release was performed.
