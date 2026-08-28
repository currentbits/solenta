# Flatten daily-driver UI (#727)

Plan: `docs/superpowers/plans/2026-08-27-flatten-daily-driver-ui.md`
Spec: `docs/superpowers/specs/2026-08-27-flatten-daily-driver-ui-design.md`
Branch: `coder/i-got-this-feedback-look-at-it-and-see-w-ef1bfc`
Task 1 base: `a454a70d`

Task 1: complete (commits a454a70d..622b9a5d, review clean)
Minor for final triage: chrome hover still uses --card-hover not spec --overlay-hover; contract test does not lock .btn[data-active]; ruleBody remains first-match (ghost describe uses allRuleBodies).
Task 2: complete (commits 622b9a5d..d978540c, review clean)
Minor for final triage: contract tests do not lock chip/rail; leftover 1px on .gitBtn/.prState/.teamStatus/.serverCount/.syncBadge inside Environment.
Task 3: complete (commits d978540c..5fc93018, review clean)
Minor for final triage: .userEditTextarea:focus lost its border cue; transcript tests thinner than restyle; leftover boxed .inboundCard/.reviewBar/.emptyStarterChip/.notesPanel/.divergenceCard.
Task 4: complete (commits 5fc93018..b8621410, review clean)
Minor for final triage: .buildCaret still has a --blue-border split seam.

Final whole-branch review (a454a70d..b8621410): ready to merge. No Critical/Important.
Follow-up leftovers: Environment inner .gitBtn etc; .reviewBar/.inboundCard; .userEditTextarea focus cue; hover --overlay-hover; .buildCaret seam.
Focused tests: 220 pass / 0 fail (flatten + thread/env/composer/header).
Task 3: pending
Task 4: pending

---

# Issue 248 — iOS Simulator integration (leftover from this worktree; not this plan)

Plan sequence:
1. `2026-08-25-ios-simulator-01-run-artifacts.md`
2. `2026-08-25-ios-simulator-02-device-service.md`
3. `2026-08-25-ios-simulator-03-native-helper-pane.md`
4. `2026-08-25-ios-simulator-04-agent-tools.md`

Known baseline: `npm test` reaches 1,616 renderer tests with 1,614 pass and two unrelated failures in `test/mcpImportTwins.test.ts` (catalog entries/status).

Plan 01 Task 1: complete (commit 58cf71b0, spec compliant, quality approved; 107 focused tests and typecheck pass).
Minor review notes for final triage: loaded artifact metadata is only object-shape normalized; `getRunArtifacts` returns its live internal array, so future callers must not mutate it.

Plan 01 Task 2: complete (commits 915e6149..748eb27e, spec compliant, quality approved after two fix reviews; 23 focused tests pass).
Minor review notes for final triage: sync-mode test does not explicitly assert `r+`; best-effort fsync open itself can still fail; helper probe reads whole capped MP4; directory rename is not fsynced; cleanup leaves non-regular/empty entries; PNG validation intentionally stops after IHDR.

Plan 01 Task 3: complete (commits 2cfec671..54b382a3, spec compliant, quality approved after one fix review; 44 artifact/shared Web tests pass with repository TypeScript flags).
Minor review notes for final triage: add an outer Web handler catch for malformed injected metadata/synchronous stream creation; a non-fs injected stream can leave the readiness promise pending; test seam is part of startWebServer options.

Plan 01 Task 4: complete (commit a98e8752, spec compliant, quality approved; 89 renderer tests and typecheck pass).
Minor review notes for final triage: null-run sentinel collides only with a hypothetical literal runId `manual`; artifact group minimum timestamp is redundantly recomputed.

Plan 01 Task 5: complete (commits 9fc4fd54..5bb0adaf, spec compliant, quality approved after one durability fix review; 118 focused tests and typecheck pass).

Plan 01 complete. Known full-suite baseline remains: MCP import failures plus one unrelated Cursor integration contention failure in the full Electron run.

Plan 02 Task 1: complete (commits 1a5e28db..d36b8def, spec compliant, quality approved after one contract fix review; 26 focused tests pass).

Plan 02 Task 2: complete (commits 25f039d7..e579191b, spec compliant, quality approved after two trust-boundary fix reviews; 32 focused tests and typecheck pass).
Minor review notes for final triage: restore a dedicated prefs-symlink regression test; consider graceful handling of future beta-form Xcode version strings; consolidate repeated adapter-classification wrappers when later calls are added.

Plan 02 Task 3: complete (commits 8bb7a2b1..84beccdf, spec compliant, quality approved after one containment fix review; 59 focused tests and typecheck pass).
Minor review notes for final triage: canonical `.app` suffix is case-sensitive; contained directory symlinks are intentionally rejected to close transitive escapes; post-materialization store refresh can still leak a thrown store error. Task 4 public install must sanitize prepareThreadWorktree/git errors and revalidate as close as possible to simctl.

Plan 02 Task 4: complete (commits 93da2448..15129de6, spec compliant, quality approved after two lease-concurrency fix reviews; 119 focused tests and typecheck pass).
Minor review notes for final triage: remove vestigial bootStatus rethrow; recovery must tolerate shutdown failure when takeover inherits a boot intent whose boot later fails.

Plan 02 Task 5: complete (commits 102011fc..75963bcd, spec compliant, quality approved after one staging-error fix review; 129 focused tests and typecheck pass).
Minor review note for final triage: takeover during artifact commit can persist an already-authorized image for the old owner; there is no safe post-commit undo.

Plan 02 Task 6: complete (commits 6cc6ee86..e3bcc1d1, spec compliant, quality approved after two recording/recovery fix reviews; 213 service tests, 23 adapter tests, and typecheck pass).
Minor review notes for Task 7/final triage: recovery can take about four seconds for an unkillable recorder; recovery must finish before exposing attach; shutdown-failure retries can retain a stale recording PID; recorder executable trust is shape-based; transient video stat failure is treated as empty output.

Plan 02 Task 7: complete (commits de9c77bd..c4d71bc8, spec compliant, quality approved after one durable-path fix review; 47 lifecycle+shutdown, 8 thread_archive, 13 services-pattern tests pass).
Minor review notes for final triage: scheduleSimulatorRelease logs method without id; getIosSimulator() is invoked outside the catch (a throwing resolver would fail archive/delete); no closed-state guard against attach racing quit; crew-sweep release is helper-unit-tested, not an end-to-end sweepCrew fixture.

Plan 02 complete.

Plan 03 controller note: Task 3/5 native compile and Xcode 26/27 acceptance cannot run on this checkout (no full Xcode/simctl). Local completion means source + Node/renderer tests; do not claim Swift tests or real-simulator acceptance; do not close #248. Task 8's local criterion governs: cross-platform tests PASS; helper compile explicitly unverified.

Plan 03 Task 1: complete (commits f67cb231..0e999d01, spec compliant, quality approved after one dimension-overflow fix review; 20 Node + 10 TS protocol tests pass).
Minor review notes for final triage: overflow reuses error code `zero_dimensions`; height overflow shares the branch and is untested separately.

Plan 03 Task 2: complete (commits b9d856c4..790a5aeb, spec compliant, quality approved after one error-typing/concurrency fix review; 12 toolchain + 213 service tests pass).
Minor review notes for final triage: remapToolchainError maps untyped failures to xcode_missing; timeout test does not lock 120_000 ms; SDK-path-only digest mutation is untested; staging copy is not fsynced; digest walks every regular file except .build; findBuiltHelper has a depth-6 name search; handshake-on-cache-hit is deferred to Task 3.

Plan 03 Task 3: complete (commit 5394c35d, spec compliant, quality approved; DONE_WITH_CONCERNS — CLT-only host, `swift test` fails with no XCTest, official verify script exits unverified). Informal CLT sandbox/framing smoke is not the completion gate. #248 stays open.
Minor review notes for final triage: ProtocolLimits hardcoded instead of protocol.json; SessionHarness.readObject uses one availableData; verify compile failures still print “full Xcode unavailable”; non-loopback self-test treats EINPROGRESS as not-denied.

Plan 03 Task 4: complete (commit 83315a7f, spec compliant, quality approved; 10 stream broker tests pass).
Minor review notes for final triage: deltas resume before IDR after backpressure recovery; recovery on an already-keyframe still requests IDR; concurrent listen before first listening event; HEADER_SIZE duplicated; first-message JSON size unbounded; wrong-generation test uses unknown generation.

Plan 03 Task 5: complete (commits 74f34639..6234fd95, spec compliant, quality approved after video-WS + AX-retain + timeout fixes; DONE_WITH_CONCERNS — no booted Xcode 26/27 acceptance). 7-arg MouseNSEvent only; shake fail-closed; video on loopback WS after text auth; AX completions copied.
Minor review notes for final triage: late AX callback after 5s wait still theoretically UAF; captureQueue not drained before free; startStream may leave WS up when capture is unavailable; H264Session avcC blob test is synthetic; SHMethodShapeMatches unused. #248 stays open.

Plan 03 Task 6: complete (commits ffc2e80f..e9967edb, spec compliant, quality approved after helper generation-fence / in-flight RPC / recover-PID fixes; 225 service tests pass). Desktop-only simulator IPC; Web denylist before handler lookup; viewer-token-only streamInfo.
Minor review notes for final triage: protocol token is journalled but matching is command/path only.

Concern fix (turn 74+): native helper now implements `text` — `SHSendText` maps printable ASCII to HID usages and replays key down/up via `SHSendKey` (`SimulatorInputBridge.m`), `HelperSession.swift` dispatches `case "text"` with capability-then-payload guards, tests added in `BridgeCapabilityTests.swift`. `swift build` clean; XCTest still unrun (CLT-only host). VideoFrame-close concern verified already covered in `simulatorStream.ts` + `test/simulatorStream.test.ts`. `scrollTo` remains unimplemented in the helper. #248 stays open.

Concern fix (fork thread 78776b8d): native helper now implements `scrollTo` — `SHSendScrollTo` replays a scroll as a bounded drag (touch down, ≤24 interpolated moves at 8 ms, touch up, best-effort up on mid-gesture failure) through the existing `SHSendTouch`/Indigo mouse path (`SimulatorInputBridge.m`, declared in `SimulatorPrivateBridge.h`); `HelperSession.swift` dispatches `case "scrollTo"` with the same capability(touch)-then-payload guard order as `sendTouch`, payload `{x, y, dx, dy}` matching `electron/ios-simulator.js` scrollTo(). Fail-closed coverage in `BridgeCapabilityTests.swift` (bridge-level and session-level capability_unavailable) plus an RPC-shape assertion in `electron/test/ios-simulator.test.js`. Fork worktree first merged `coder/ios-simulator-integration-macos-agent-dr-06a6a6` (45 commits, 6 additive IPC-surface conflicts, both sides kept). `swift build` clean (one pre-existing sandbox_free_error deprecation warning); `swift test` still unrunnable — no XCTest module on this CLT-only host; 225 service tests pass; `npm run typecheck` passes. #248 stays open.

# Stats dashboard expand SDD (#757)
Plan: docs/superpowers/plans/2026-08-28-stats-dashboard-expand.md
Branch: coder/expand-site-stats-dashboard
Task 1 base: b1447f03

Task 1: complete (commits b1447f03..db122a20, review clean)
Minor for final triage: ingest HTTP test does not lock pathname-only path; no 81-char UTM case.
Task 2: complete (commits db122a20..b5303f55, review clean)
Minor for final triage: inRange is lower-bound only; hourly test does not lock daySeen vs two-hour visitor.
