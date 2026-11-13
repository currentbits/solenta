# Local CLI usage adoption

Implemented for [Solenta #2002](https://github.com/currentbits/solenta/issues/2002),
following the [Synara feature research](2026-11-12-synara.md).

Usage now offers **Solenta runs** and **CLI sessions** as separate sources.
CLI sessions reads Claude/Codex files on the host serving this connection,
including sessions launched by Solenta. The two reports overlap and must not
be added together. The live spend ledger and budget limits are unchanged.

## Implementation

- Reuse Solenta's Claude/Codex home resolvers and configured instance environments.
  Discover Claude `projects` (including subagents), and Codex `sessions` and
  `archived_sessions`. Equivalent physical roots are scanned once; nested
  symlink files/directories are ignored.
- Stream bounded lines and cache only usage fields and identities. No prompt,
  response content, working directory or conversation title enters the report
  or cache. No threads, transcripts or spend records are created.
- Claude message IDs collapse repeated content blocks and copied history,
  retaining the fullest usage snapshot and earliest observed timestamp.
- Codex request usage uses `last_token_usage`, with cache reads/writes removed
  from the inclusive input count. Reasoning is already included in output.
  Stable turn/session identities plus canonical cumulative counters distinguish
  repeated notifications from equally sized distinct requests.
- Fork copies retain their earliest observed date. A fork's ancestry must be
  completely available in the scan before unmatched fork events can be counted;
  missing/ambiguous ancestry is flagged and skipped. No timestamp-gap heuristic
  or counter-magnitude guess is used.
- Apply the existing **user-configured model prices** to the read-only report.
  These are estimates, not subscription charges. Missing prices and incomplete
  coverage remain visible. There is no bundled or newly inferred price table.
- Reuse Usage's model/day charts and provider/range filters. Response counts
  are labelled as responses; project/thread attribution and wasted-spend
  accounting remain in Solenta runs. Source changes clear the previous report
  immediately and reject late results from the old source.

The implementation was informed by Synara's
[reader](https://github.com/Emanuele-web04/synara/blob/83e0533b23099908ee14e4fecacd5ed702f4d453/apps/server/src/transcriptUsage.ts)
and [parsers](https://github.com/Emanuele-web04/synara/blob/83e0533b23099908ee14e4fecacd5ed702f4d453/apps/server/src/transcriptUsageParsers.ts)
at the researched revision, plus usage-only field inspection of installed CLI
logs. This is a Solenta implementation using its own accounting/UI contracts;
Synara's time-based fork suppression and built-in pricing were not copied.

## Bounds and coverage

The report covers up to 90 local calendar days. Only files modified in that
window are read. Each scan admits at most 10,000 paths, 512 MiB of newly read
files and 200,000 unique usage records; lines over 1 MiB and paths deeper than
eight levels are skipped. Limits, unreadable/changing files, unsupported usage
and missing prices appear in the UI. An ancestor outside the scan window can
therefore leave a fork uncounted, with incomplete coverage explicitly shown.

Unchanged files are not reopened. Growing or replaced files are fully re-read,
including a previously incomplete final line. Refresh can warm additional files
after the byte limit; it never silently changes an incomplete scan into a claim
of complete coverage. There is no on-disk cache or background scan.

## Verification

Focused tests cover content-block/fork/subagent deduplication, identical-sized
Codex requests, retimed copied history, missing ancestry, malformed counters,
symlinks, configured-home deduplication, partial lines, changed/deleted files,
unreadable files, scan limits, pricing and budget isolation. Mounted Usage/App
tests verify source routing, replacement rather than addition, unavailable
costs, coverage notices and late-response isolation.
The final focused run passed 28 scanner/pricing/budget-cap tests and 86
renderer/usage/contract/App tests, plus typecheck and `git diff --check`.

A read-only scan of this host's actual logs completed successfully and reported
its partial coverage. The CLI source was also exercised in real Electron with
the browser-dev fixture; its rendered chart, response labels and unavailable
price notices were captured and inspected. No signed package or installed-app
upgrade was tested.

The expanded budget-spend suite has five date-sensitive failures: fixed August
2026 fixtures are now pruned during reload. All five also reproduce on the
unchanged pre-feature baseline `cb41c9a8`. They are a separate suggested task;
the budget-cap tests and the new scanner's ledger-isolation check pass.

## Outside Solenta scope (#2013)

Follow-up inspired by Synara [#2109](https://github.com/Emanuele-web04/synara/pull/2109).
Usage now has three sources: **Solenta runs** (the ledger), **Outside Solenta**,
and **All CLI sessions** (the original overlapping report).

- **Ownership.** A response is Solenta's when its provider session id belongs to
  a Solenta thread (trashed threads and Claude accounting checkpoints included)
  and it is timestamped at or after the thread's creation. An imported session
  keeps its id, so its pre-import history stays outside Solenta. Claude subagent
  sidechains carry the parent session id. Codex spawned subagents inherit the
  parent's ownership; CLI forks do not. Ownership follows the stable response
  identity (Claude message id, Codex turn + cumulative counters), so a Solenta
  response copied into a resume or fork stays Solenta's and counts once.
- **Known ceiling.** If a Solenta session is later resumed from Terminal into the
  same file, those responses stay Solenta's. Splitting them would need
  per-response run windows. Sessions whose thread was deleted (not trashed),
  rewound or moved count as outside.
- **Incremental reads.** Each file resumes from its last consumed newline when
  the inode is the same, the file has not shrunk, and a hash of its first and
  last 4 KiB before the offset still matches. Truncation, replacement or
  in-place rewrite re-reads from byte 0 (`rereadFiles`). Codex parse state carries
  across appends. Bytes appended during a scan wait for the next scan. Only
  shrink/replace mid-read discards the file. An unterminated tail is incomplete
  and re-read later. An overlong line split across appends is skipped once. Logs
  that vanish are reported as `missingFiles`.
- **Homes.** The default Claude/Codex homes and each instance home are listed by
  id. The picker scans one home or all of them, and deduplication runs only
  within the selection.
- **Cost.** A per-response `costUSD` (older Claude Code logs) is CLI-reported.
  Every other response is priced only from the user's model prices (API-rate
  estimate). Unpriced tokens stay unpriced and are listed. Neither figure is a
  subscription charge. Claude's cumulative `cost-state` rows, which a resume
  restores, are ignored. Solenta's exact saved-counter resume classification
  (#1961) is unchanged; Synara's first-result omission was not adopted.
- **Ledger.** Both log scopes are computed per request and never call or write
  the spend/usage ledger, so external history never reaches today's spend cap.

A read-only scan of this host's logs and live store took about 1–2 s. It
excluded about 17k Solenta-run responses and kept about 3k outside
Solenta. It reported partial coverage because of the existing 512 MiB per-scan
read bound, which warms more files on each refresh.
