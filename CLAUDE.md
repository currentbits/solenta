# solenta

Standing instructions generated from Solenta shared memory — conventions, strategies, and verified decisions. Prefer these over restating the tree.

<!-- generated-by: solenta-config-doctor -->

## Conventions

### Solenta release tweets: 0.4.0 shape, never a changelog dump

Willem posts Solenta updates as himself (@currentbitsNET), not as a product blog. The tweet that matches his voice is the 0.4.0 one (2026-08-16): one casual first-person line, then New/Perf/Fixed bullets, then a short closer. The 0.6.0 draft was a press release plus a WHAT WE SHIPPED appendix; he pasted that whole thing and later called the same shape for 0.7.0 a terrible tweet.

Do:
- casual opener, lowercase ok
- 5–8 short bullets of things you feel
- one 'also:' leftover line
- changelog URL, no appendix, no ALL CAPS section headers, no MIT/local-first closer, no '29 PRs'

Do not recreate the 0.6.0 press-release shape.

### Solenta release checklist: worktree build, curated notes, girder graft

Full "cut a release" sequence, run end to end for v0.6.0 (2026-08-17, 60 commits since v0.5.0):

1. `git pull --ff-only origin main` FIRST. The main checkout often carries uncommitted WIP; stash it by path (`git stash push -m ... <file>`) rather than committing it into the release, and `git stash pop` after. publish-release.sh refuses a dirty tree anyway.
2. Build the change list from `gh pr list --state merged --json number,title,mergedAt` filtered on mergedAt > the previous tag's date, NOT from merge-commit subjects — worktree merges have useless subjects. Verify the boundary: PRs merged just before the tag still show up in that window, so check `git merge-base --is-ancestor <mergeCommit> <prev-tag>` for the borderline ones (three of them were already in v0.5.0).
3. Bump `package.json` v
…

### Skill dirs are symlink farms: scan with isSymbolicLink, copy with dereference

Willem's real setup already fans skills out by hand: ~/.claude/skills holds 28 SYMLINKS into ~/.agents/skills (only 3 real dirs). Any scanner using readdirSync(..., {withFileTypes:true}) + d.isDirectory() sees ZERO of them — dirent.isDirectory() is false for a symlink, it does not follow. The skill manager (#343, electron/skills.js scanSkillDir) shipped that bug past a fully green suite; only running listSkills against the real HOME caught it. Not cosmetic: all 31 skills read as missing from claude, so Sync would have cpSync'd ~130k of content over the symlink farm.

Two rules for anything walking skill dirs:
1. Accept `d.isDirectory() || d.isSymbolicLink()`; the follow-up fs.statSync(<dir>/SKILL.md) follows the link, and a dangling link just throws into the existing catch.
2. fs.cpSync(sr
…

### Memory scoping: always pass the project PATH, never the display slug

The memory server canonicalizes project keys to the basename of the MAIN repo root (memory-server/src/project-key.js): a path like ~/code/coder -> "coder", and worktrees resolve to the same key via git-common-dir. A display slug like "currentbits/solenta" canonicalizes to "solenta" — a scope no agent ever writes to. This is exactly why the solenta project's Memory tab showed empty while other projects (slug == dir basename) worked. Fixed 2026-08-14 (commit 87af397): AgentsPanel now passes project.path to MemoryTab. Rule for any new memory call site in the app: send the raw repo path and let the server canonicalize; never send project.slug or project.name.

### Renderer tests: drainConsoleErrors() for deliberate component crashes

Solenta's test/support/dom.ts fails the whole suite if React logs ANY console.error while a component is mounted (unmountAll gate). Tests that deliberately crash a component (e.g. test/errorBoundary.test.tsx, issue #81) must call drainConsoleErrors(/pattern/) after the crash to acknowledge the expected noise; non-matching errors still fail the gate. The app itself now wraps the three main panes (Sidebar / Thread view slot / AgentsPanel) in src/components/ErrorBoundary.tsx, each with Try again (reset boundary) and Reload app (window.location.reload, injectable via onReload prop for tests).

## Decisions and gotchas

### Sidebar #567: Active + Later shelf contract replaces four-shelf model

Since commit 2ed3091 (branch coder/i-want-you-to-do-a-deep-dive-into-t3-s-t-b36463) partitionSidebar returns { attentionThreads, later: {snoozed, settled, archived} } — no top-level pinned/snoozed/settled arrays. Precedence: archived > snoozed > pinned-stays-active > settled. Pinned threads render in their project group sorted FIRST (data-pinned card attr, data-pin-flag glyph, ", pinned" in aria-label); there is no Pinned shelf. One Later shelf (data-later-shelf, header "Later · N[ · M unread]") holds snoozed (wake-soonest) then settled then archived (data-archived rows, data-unarchive-btn). Retired selectors: data-pinned-section, data-snoozed-shelf, data-snoozed-header, data-settled-tail, data-unpin-btn, per-group archived toggle. Test helpers find the shelf by header text "Later ·". buil
…

### Git is a center-pane tab, not a right-rail card or overlay

Issue #569. The worktree diff is a full-height center pane behind Thread | Git tabs in the thread header (changesOpen in App). Do not put it back in the 520px overlay or as a sixth AgentsPanel tab. Environment “Open Git”, next-git Commit, and /review all call onViewChanges. Spec/Teach/Ask start from the overflow menu. First pane type toward #552; not the docking shell.

### Research round 30 (2026-08-19): live perf profiling — store rename saturation, boot du storm (#563), unwindowed transcripts (#564)

Round 30, performance. Method that worked again: measure the live machine (sample(1) on the running pids, stat-watch the store file, read the live store), then map findings onto the board before filing.

MEASURED:
- `sample 32564 5` (main process): uv worker thread spent 3690/4126 samples (3.7 of 5 s) inside one rename() of the coder-store tmp file. Main thread otherwise idle; the node:sqlite frames in the sample were JIT symbolication noise (codeindex.js is JSON + 60s debounce, not sqlite — don't chase that again).
- Store rewrite cadence near-idle: 2 rewrites in 30 s = 286 MB written = ~9.5 MB/s sustained; ~71 MB/s worst case at the 2 s debounce cap while streaming. Main RSS 1.0 GB.
- ps %CPU is a decaying/lifetime average: renderer showed 37.6% in ps but was fully idle in sample. Always
…

### Research round 29 (2026-08-19): dogfood the live store, not the competitors — 2 issues, 2 comments

Round 29. After 28 competitor rounds the external vein is dry; the empirical vein is not. Method that worked: read-only scan of ~/Library/Application Support/Solenta (coder-store.json + worktrees/) and compare against what shipped.

MEASURED ON THE LIVE MACHINE (2026-08-19, 445 threads, 5 projects):
- worktrees/ = 96.0 GB across 166 dirs, median 709 MB, 161 belong to archived threads, only 4 working, 0 pinned. worktreeRetention is undefined on every project, so enforceRetention (worktrees.js:3789 `if (!(n > 0)) continue`) has never done anything. Default of 10/project reclaims 64.0 GB; the largest project alone held 119 dirs / 57.3 GB.
- coder-store.json = 143.2 MB + a 139.5 MB .bak. messagesByThread is 134.35 MB = 99.5%
…

### Electron suite has 7 pre-existing failures on main (tracked #536)

As of origin/main 9517511 (2026-08-18), npm run test:electron has 7 failures that are NOT merge artifacts — identical counts on pristine origin/main, pre-merge local, and merged tree: verify-gate.test.js 0/4, checkpoints.test.js 1 ("worktreeBase is not configured" — fixture's createRunner lacks userDataPath, #511 fail-closed path requires it), web.test.js 1, store.test.js 1 (reviewAcceptedHunks:[] in fixture mismatch at store.test.js:106). Tracked as issue #536. When verifying merges, compare against these baselines instead of expecting green.

Also: electron tests need node_modules — a plain `git worktree add` + run fails with MODULE_NOT_FOUND (cross-spawn); symlink node_modules (and core/node_modules) from the main checkout to test another ref. Renderer tests are node:test, not vitest —
…

### #511 worktree setup failure never falls back to the checkout

Worktree isolation is fail-closed. A thread with pendingWorktree or a bound worktreePath must not run in the project checkout.

- setupWorktree throws `Failed to create worktree:\n` + verbatim git stderr (gitFailureText prefers err.stderr; never first-line-only).
- prepareThreadWorktree = clearMissingWorktree + ensureWorktree. clearMissingWorktree re-arms pendingWorktree so the next turn rematerializes.
- runner.startRun / startWorkflowRun catch setup failure, record user + event + status failed + lastError (Retry-turn attaches), throw so fork/drainQueued know the agent never started. Zero children spawn.
- workflow.js throws if the folder is gone rather than using project.path.
- Regression: electron/test/worktree-setup-fail.test.js (fake git on PATH fails only `worktree add`).

There is
…

### #490 header next-action button already shipped in #497/#505

Issue #490 (replace always-visible Push + Create PR with the next-action header button) is already on main. Do not re-implement.

- #497 added NextGitActionButton + suggestNextGitAction and wired createPr/prChecks/prMerge from App into ThreadView.
- #505 (issue #503) made Create PR appear on unpublished worktrees and when sync has not loaded; Push is only for an open PR that is ahead.
- Decision table: src/nextGitAction.ts. Click paths: NextGitActionButton in src/components/ThreadView.tsx. App wiring: onCreatePr/onPrChecks/onPrMerge.
- Tests: test/nextGitAction.test.ts + test/nextGitActionButton.test.tsx.
- Closed #490 as plan:done from thread f559dda1 (2026-08-18). Parent #382 may stay open for #361/#363. #489 is the same code; its later draft/CLAUDE.md comment is extra scope.

### #467 worker pool: resolve in forkWorkerThread, menu is a dispatch note

Issue #467 shipped on branch coder/subagent-model-pool-described-candidates-797649 (commit f3c5234). Settings.subagentPool is {defaultAlias, force, entries[{alias,provider,model,description}]}. Resolution lives in electron/subagentPool.js and is applied inside forkWorkerThread, so thread_fork, pendingFork, and /handoff|/advisor|/committee workers share one path. The lead picks with pool=<alias>; omit pool to use defaultAlias; force pins every worker. Empty pool inherits the lead (old behaviour). The live menu is injected by subagentPoolNoteFor on every dispatch (coder-threads gate), not by rebuilding the MCP server. Does not auto-route the user-facing thread (#246) or Best-of-N. Alias is a lowercase slug /^[a-z][a-z0-9-]{0,31}$/. Description is 1-160 chars, one line.

### #444 ⌘N / ⌘⇧N new-thread shortcuts hook into handleBrandCreate

Issue #444 landed on branch coder/new-thread-keyboard-shortcuts-n-n-9d405d.

- Sidebar window keydown (next to ⌘1…9 / ⌘J/K): mod+n → handleBrandCreate, mod+shift+n → createInTargetProject. Both skip via isShortcutBlocked (textarea / composer / dialog).
- handleBrandCreate is shared with the brand-row +. Until #443 it just calls createInTargetProject (open thread's project, else first). After #443, handleBrandCreate should open the picker when projects.length > 1 so ⌘N follows automatically.
- KeyboardSheet APP_SHORTCUTS: '⌘ + N' New thread, '⌘ + ⇧ + N' New thread in current project.
- Tests: test/multiSelect.test.tsx describe 'Sidebar new-thread shortcuts (#444)'.
- No remappable keybindings; no mod+shift+o alias.

### #469 drop host is the thread main, not Composer

Issue #469: OS file drop is bound on ThreadView <main data-thread-drop> via Composer dropHostRef + useFileDrop. Do not put the only onDrop on the composer strip — transcript/empty-state drops would miss. Resolve Files from dataTransfer.items (webkitGetAsEntry + getAsFile), then api.attachments.droppedFilePath → fromPaths → classifyPaths. FileList omits Finder folders. Web/dev without droppedFilePath still uses saveImage (images only). Empty result shows DROP_REJECT_MESSAGE from src/dropFiles.ts. Overlay is pointer-events:none; dragleave uses relatedTarget so child crossings do not flicker.

### electron test fakes: writeFakeBin + win32 list rules (#450)

Shared helper: electron/test/support/fakeBin.js writeFakeBin(filePath, body).

POSIX: writes the same #!/usr/bin/env node file + chmod 0755 as the 32 local helpers used to. Win32: same JS file plus a .cmd wrapper that runs process.execPath on it; returns the .cmd path.

That .cmd is spawnable via cross-spawn (agent CLIs after #442). child_process.execFile cannot run .cmd (Node EINVAL). So:
- CODER_CLAUDE_BIN / CODEX / KIMI / GROK / OPENCODE / AGENT fakes → .cmd works
- CODER_GH_BIN and CODER_FM_BIN still go through execFile (worktrees.js ghTryAsync, fm.js fmRun) → those tests stay POSIX-only until those call sites switch to cross-spawn
- memory-sup fake memory server is spawned as `node [entry]`, so it must return the JS path, not the .cmd
- ipc-seam.test.js and which-cache.test.js write #
…

### Composer / command popup must freeze refresh after accept/Escape

The @-mention popup can close on Escape/Enter and stay closed because mentionOpen requires async mentionFiles; a same-tick onSelect refresh only re-sets the query, not the list. A sync / command menu will immediately reopen if refreshCommand runs from the select event that follows setSelectionRange or a jsdom value write. Use a commandFrozen ref (set on accept and Escape, cleared on the next onChange / thread switch). Also: after accept, insert `name + " "` and treat any whitespace in the composer text as "token complete" so getCommandQuery returns null. assert.equal(domNode, null) hangs in this suite when the node is present (inspects a circular DOM); use assert.ok(!node).

### electron/smoke.js load-time throws do not exit; CI must force process.exit

Electron prints "App threw an error during load" on a top-level throw in the entry script (missing require, etc.) and then stays alive. smoke.js fail() uses app.exit(1) only after app.whenReady(), so a require() failure would hang a CI job until timeout-minutes. smoke.js now installs process.on("uncaughtException") at the very top (before requires) and process.exit(1). Verified: missing dist/index.html → app.exit(1) → exit 1; all five macOS passes → app.exit(0) → exit 0. Windows leg of the new smoke job (#449) is unverified until CI runs it.

### #448 verify/devservers Windows shell: Git Bash, not cmd.exe; WSL only via wrapCommand

Issue #448 (branch coder/fork-windows-support-hardening-wsl-bound-ea7084).

verify.js user command string is POSIX. On win32 spawn `bash -c` (Git Bash; doctor already probes this). Do NOT fall back to cmd.exe/PowerShell — they would silently mis-parse `>&2`, `exit 3`, `&&`. Missing bash is a real spawn error.

WSL-side projects route through ssh.js wrapCommand so the command runs in the distro. Do NOT wrap ssh remotes from verify.js or devservers.js — that would change macOS remote-verify behaviour ("never change non-win32").

wrapCommand(project, bin, argv, platform?) now accepts an injected platform so WSL wrapping is testable on macOS.

devservers.js never used /bin/sh (argv is npm run <script>). Win32 fix is cross-spawn for npm.cmd + WSL wrap. Process-group kill is pid-direct on win32.
…

### Context ring accuracy (#317): Claude cache tokens, codex cumulative totals, missing claude windows

Issue #317 landed on coder/context-visibility-accurate-per-thread-c-a8891f. Three separate defects, all invisible to the existing tests:

1. CLAUDE CACHE TOKENS. `usage.input_tokens` in the CLI's stream-json `result` event counts only UNCACHED input. Verified live: `{input_tokens: 10, cache_creation_input_tokens: 10203, cache_read_input_tokens: 17748, output_tokens: 175}` — the old `input + output` formula read 185 against a true prompt of 28,136 (152x under-read). A mid-session thread showed input_tokens: 2 against cache_read: 154815. contextTokens must sum input + cache_creation + cache_read + output; the billable inputTokens/outputTokens counters and recordUsage must NOT (cache reads bill differently). grok runs the same claude-stream path, so it inherits the fix.

2. CODEX. `token_coun
…
