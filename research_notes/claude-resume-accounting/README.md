# Claude fresh-process resume accounting investigation

Investigated 2026-11-08. Planboard investigation: [#1960](https://github.com/currentbits/solenta/issues/1960). Proposed implementation: [#1961](https://github.com/currentbits/solenta/issues/1961).

**Conclusion:** a source-supported compatibility failure is reproduced with synthetic restored-session frames through the real runner and Store reload. No live account overcharge, billing discrepancy, or prevalence was measured. No production fix is included.

## Source boundary

- Latest fetched main: `24119d5fc6f5ed438e3e78c991e8fc2f1ed7c703`. The investigation uses an isolated archive of that revision, not this thread's older host checkout.
- [#1956](https://github.com/currentbits/solenta/pull/1956) merged as `4dbae5ef`; reviewed its full accounting change and head `0a1420cb515dc2bc58a9f788d4b581302ce27487`. Its `electron/claude-usage.js` matches latest main byte-for-byte (SHA-256 `d02a30993983f40e4b01ad2f465ebecc6260199e44ae92de9f8befb18efdf2e5`). The final PR-head adjustment concerns sparse/advisor reconciliation, not persisted session baselines.
- [#1945](https://github.com/currentbits/solenta/issues/1945) covers partial measurements, Stop/exit/steer and per-model reconciliation. [#1435](https://github.com/currentbits/solenta/issues/1435) covers warm-process cumulative cost. Neither establishes correct accounting after a completed turn and a new CLI process. Existing issue searches for Claude resume/restart/baseline/accounting found no dedicated issue for this case. Codex's `sessionUsageBaseline` is a separate contract and remains untouched.
- Solenta does **not** pin an Agent SDK or Claude CLI dependency in `package.json`/`package-lock.json`. It resolves an external/configurable executable. `providers.js` builds native `-p --input-format stream-json --output-format stream-json` and `--resume <sessionId>` arguments. Checked-in captured fixtures report Claude Code **2.1.283**. The installed external package is **2.1.318**; it was inspected as bytes, never executed.

## Primary protocol evidence

[Anthropic's current cost-tracking documentation](https://code.claude.com/docs/en/agent-sdk/cost-tracking#accumulate-costs-across-multiple-calls) says normal exit saves session totals and a later resumed/forked SDK or print-mode call restores them. It dates the older zero-at-resume behavior to versions before **2.1.277**. Result `usage` and cumulative `modelUsage` have different scopes; do not subtract a session baseline from ordinary per-turn `usage`.

Verified against the exact **2.1.283 darwin-arm64 native package** from [Anthropic's npm distribution](https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/2.1.283), without running it:

- Downloaded tarball integrity verified against package metadata: `sha512-GczpJ+FvnOYvxn6XPGHbdqJEZMves6Vc0WKS/g1N2eG39EKKAHxG77e+w4Rjtmf8xgCxNY36Jf/IOfbcyus4zA==`.
- Extracted executable SHA-256: `d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e`.
- Embedded source byte offsets: `yxt` at approximately `183592661` builds a session `cost-state` record; `Bie` at `183593224` restores cost and per-model totals from that record, with an explicit absent-record branch. Native print continue/resume calls it near `199211632` and `199218787`. The result builder reads the same cost ledger and model map near `190863980`; `mg` near `175542957` reads ledger total USD. The SDK wire-schema descriptions near `177501286` and `177502369` independently describe restoration of prior totals.
- Consequently, version alone is insufficient: even a new CLI can resume a transcript without saved cost-state. The fixture must explicitly distinguish restored totals from reset totals.

The installed **2.1.318** native executable (SHA-256 `677a2ea7bf576cedd20e191d973914ed8a41796f53a63b1923381ddc4d5b5e7d`) has the equivalent save/restore and print-resume paths. It also declares an optional internal `model_usage_since_last_result` field that 2.1.283's result schema lacks. That is a possible separately verified source of explicit deltas, not a portable replacement assumed by this investigation.

No binary, proprietary source dump, credentials, live transcripts or settings are committed here. Native offsets are locators, not stable APIs.

## Solenta data flow

In latest main:

1. `electron/claude-usage.js:74` reads `handle.lastModelUsage`; `:121` reads `handle.lastTotalCostUsd`. Missing handle fields mean zero. Reconciliation also retains `unattributedModelUsage` on that handle.
2. `electron/runner-provider-claude.js:1563` and `:1597` create a fresh handle without loading a persisted Claude baseline. `:1627` reuses an existing handle only for a live warm process.
3. `recordMeasuredUsage` at `:666` adds the resulting batch to stored thread usage, `recordSpend`, and per-model `recordUsage` rows. Stored cumulative thread usage is not a provider-session baseline.
4. `electron/runner-claude-sessions.js` retains handles only in its in-memory Map and deletes them at process disposal. `electron/store-migrate.js` and `store-usage-methods.js` restore thread/session IDs and accumulated usage but do not initialize the Claude handle counters. The existing `sessionUsageBaseline` readers are in the Codex runner only.

Thus the old warm-process cost assumption predates #1956. #1956's helper retains it and now uses cumulative model summaries more generally, which also makes old-model token duplication visible in the synthetic restart case. This is separate from its interrupted-turn fixes.

## Reproduction and controls

`fixtures.json` is explicitly synthetic. All amounts and wire model identities are supplied, not priced or inferred. The main runner test completes turn one, kills only its fake child, waits for exit, flushes and reloads the temporary Store, creates a new runner, verifies `--resume` and a distinct PID, then sends a warm follow-up on that second process.

| Case | Provider facts | Current outcome |
| --- | --- | --- |
| Completed turn | Model A: 10 input, $0.01 | 10 input, $0.01 |
| All three turns on one handle | Per-turn inputs 10 / 4 / 2; cumulative dollars .01 / .03 / .04 | Correct total: 16 input, $0.04 |
| Restart after completed turn; restored summary adds model B | New turn: 4 input, $0.02; result includes prior model A and cumulative $0.03 | Batch incorrectly records 14 input and $0.03; Store becomes 24 input and $0.04 |
| Warm follow-up after that restart | New turn: 2 input, $0.01; cumulative result $0.04 | This batch is correct, but Store ends at **26 input and $0.05**, including daily spend $0.05 |
| Legacy/reset resume | New process summaries start without old model A; $0.02 then $0.03 | Correct lifetime total $0.04; blindly seeding old handle cost would undercount |
| Existing captured 2.1.283 restart | `restart-before` contains **no result**; `restart-resumed` has one result | Does not establish duplication after a completed turn; raw model identity and reported dollars preserved |

The helper and real-runner reproductions assert the **observed faulty behavior** to make the investigation repeatable; green probe results do not mean the defect is fixed. They must become expected-correct regression assertions during implementation. The captured control reads only checked-in fixture files, not a user's Claude history.

Run from this branch with an isolated archive/build of the audited main:

```sh
mkdir -p /tmp/solenta-claude-resume-audit
git archive 24119d5fc6f5ed438e3e78c991e8fc2f1ed7c703 | tar -x -C /tmp/solenta-claude-resume-audit
# Supply normal project dependencies there, then compile its core:
node /path/to/typescript/bin/tsc -p /tmp/solenta-claude-resume-audit/core/tsconfig.json
SOLENTA_AUDIT_ROOT=/tmp/solenta-claude-resume-audit node --experimental-strip-types --test research_notes/claude-resume-accounting/repro.cjs
```

Verification: **5/5 investigation probes**, plus **11/11 existing Claude usage helper tests** on audited main. The first sandboxed runner probe passed with an egress-proxy loopback warning; an approved unrestricted rerun passed all five without that warning. Environment is replaced before loading app modules, HOME/userData/Store are temporary, PATH contains only Node and system utilities, and `CODER_CLAUDE_BIN` points to the generated fake. The only provider package access was public download/static inspection. No paid turns or real credentials/settings were used.

## Minimal proposed design (not implemented)

Use a separate versioned **Claude session accounting checkpoint**. Scope it by provider/account reference, execution target/config-home identity and native session ID, with explicit reset/fork provenance. A bounded record on the thread is enough for its current native session; this is not a transcript database. Do not reuse or change Codex's checkpoint.

- Persist raw accepted provider `total_cost_usd` and sparse `modelUsage` snapshots, the CLI version/established protocol scope, and the existing reconciliation state needed to distinguish previously accounted observations from unknown model measurements. Keep raw SDK totals distinct from ledger deltas. Do not use `usageByThread`, `costByModel`, today's totals, model picker labels, or prices to manufacture a baseline.
- Hydrate a new handle from a matching session checkpoint **only when restoration of the same accounting epoch is established**. Preserve the existing warm-handle path. Model/effort-driven respawns must use the same rule as app reloads. A new session, account/target mismatch or explicit reset must not inherit the old checkpoint.
- The CLI version threshold is necessary compatibility information, not proof of restored state. Before trusting subtraction, establish the starting provider snapshot/reset through a verified no-generation protocol capability or explicit known launch provenance. This investigation does not claim Solenta currently has such a handshake. A first resumed result larger than the old total cannot distinguish restored history from a reset process with a larger new turn. A smaller result is also not permission to guess missing historical dollars.
- For pre-2.1.277/reset protocols, retain a fresh process baseline of zero and warm-process subtraction. For a migrated/imported/ambiguous resumed session with no trustworthy start baseline, keep the provider's raw session totals but mark the current-turn cumulative-derived delta unavailable; retain directly observed current-turn fields. Do not charge all historical spend, silently label it zero, infer missing USD, or rewrite historical ledger rows. Later warm results can again produce directly known deltas.
- Update the checkpoint and its corresponding ledger additions in the same Store save transaction/snapshot, guarded by current run/session ownership. Normalize finite nonnegative numbers and sparse fields on reload. Existing stores migrate to an absent checkpoint, not an inferred one. In-process-only unknown measurements require explicit coverage rather than being assigned a later model name.

Implementation acceptance coverage:

1. Replace the restart reproduction's faulty expectations with $0.03/14 inputs after resume and $0.04/16 after the follow-up; assert thread, spend and per-model ledgers agree. Keep raw SDK totals unchanged.
2. Save/reload the new checkpoint across two app lifetimes and a model/effort respawn; verify no old model A delta appears on the resumed day. Verify observed model B remains its exact wire identity regardless of current picker/alias.
3. Migrate an old Store with existing totals but no checkpoint: preserve all history, retain uncertainty and do not backfill from transcripts. Cover absent/malformed/sparse checkpoints, unknown models and already-accounted partial observations.
4. Cover old protocol reset with both lower **and higher** next-process totals, a modern transcript without saved cost-state, unknown CLI version, genuine new sessions, account/remote-target changes, forked source totals and explicit same-session reset epochs. Do not classify ambiguous scope from magnitude alone.
5. Save/reload ledger and checkpoint together; replay the same accepted result without another charge, reject stale-run checkpoint writes, and ensure process death between accepted results does not invent missing amounts. Exact recovery across an unavailable provider checkpoint remains unavailable.

These are proposed acceptance criteria on #1961. No historical transcript aggregation, automatic spend repair, Stop/exit/steer change, or Codex reconciliation change is included.
