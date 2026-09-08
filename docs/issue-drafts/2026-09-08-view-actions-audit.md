# Follow-up view and action audit

Audited commit: `6c7a6fbebb066942f7f5702084f1af1e0730319d`.
Roadmap: https://github.com/currentbits/solenta/issues/1130

1. **P1: Planboard task completion can show another project's cards and start the wrong issue**
2. **P2: Rejected PR and Planboard requests leave loading and Start task controls stuck**
3. **P2: Usage erases its report and Fleet hides failures when refresh requests reject**
4. **P2: Make the PR view searchable and expose open PRs beyond its silent 50-row limit**

## Verification

The mounted-component evidence command exited 0 with seven assertions confirming current defects and missing controls. The PR limit command exited 0 confirming the 50-row boundary. These are reproduction scripts, not tests of implemented fixes.

```sh
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types docs/issue-drafts/2026-09-08-view-actions-evidence.mjs
node docs/issue-drafts/2026-09-08-pr-list-limit-evidence.cjs
```

All fixtures are synthetic, with no real agent dispatch, GitHub requests or store mutations. View interactions were exercised in jsdom; this pass does not claim desktop visual verification. PlanboardView, PrListView, UsageView and FleetView blobs were checked against the default branch and matched the audited checkout.

No production source was changed. Issue bodies, acceptance criteria and duplicate distinctions are in [view-actions-audit.json](2026-09-08-view-actions-audit.json). Canonical issue URLs and publication state are in [view-actions-publication.json](2026-09-08-view-actions-publication.json).

## Boundaries

Existing first-pass issues #1122–#1125 remain the performance and Skills/Memory backlog. The follow-up does not revive shipped whole-store persistence work. Existing #427 owns offline forge caching and replay; the rejected-request issue is the smaller current UI recovery prerequisite. Existing #943 owns Activity/Digest failures, #942 return navigation, #945 Planboard search and #260 the larger PR attention inbox.

