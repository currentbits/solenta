# Combined Synara adoption verification

Verified 2026-11-12. Tracking: [#2007](https://github.com/currentbits/solenta/issues/2007).
This covers the [adoption batch](2026-11-12-synara.md): iOS simulator transport,
continuous annotations, external CLI usage, WebMCP, MCP connector proposals and
saved draft previews. Changes remain on this worktree branch.

## Corrections found

- The new Draft badge used `useSyncExternalStore` without a server snapshot.
  Client interaction tests passed, but five existing static thread-card rendering
  tests failed. Both render paths now read the same saved-draft snapshot. A new
  regression verifies that static cards include their saved excerpt.
- `verify-ios-simulator-helper.js` rejected this installed Xcode because it lacked
  `Developer/Applications/Simulator.app`, despite working `simctl` and Swift tools.
  The headless helper does not require the GUI bundle. The probe retains the
  selected developer directory and Command Line Tools rejection, then requires a
  successful `xcrun simctl help`; compile verification still requires a real build.
- The script previously checked only the original loopback permission result.
  It now also requires explicit successful IOSurface and H.264 encoder results.
  The helper itself already ran those checks and returned failure if they failed.
  Three script tests cover toolchain acceptance/refusal, missing or denied capture
  permissions, and unsuccessful helper exit status.

## Results

| Check | Result |
| --- | --- |
| Full renderer suite | 3,208 passed; no failures or skips after the snapshot fix. |
| Full Electron/backend suite | 5,055 passed, seven failures, three skipped. Every failure reproduced on untouched baseline; details below. |
| New native-verifier regressions | Three passed separately; the full backend run had already selected its file list before this test file was added. |
| Production renderer build | `npm run build` passed, including typecheck and generated preload checks. Vite retains its existing large-chunk warning. |
| Native release helper | Compile and all nine production Seatbelt self-checks passed through the verification script. |
| Native Swift tests | 28 passed. |
| Native input/capture adapter harness | Passed using the production adapters with a fake daemon/display. |
| Real Electron WebMCP verification | Passed initial registration, read/mutation callbacks, cancellation, limits, reload fencing, response policy and guest isolation. Inspected `/tmp/solenta-webmcp.png` shows Count: 2. |
| Diff validation | `git diff --check` passed. |

Node was 22.23.2. Broad renderer/backend test children had inherited `CODER_*`
variables removed, provider executables excluded from PATH, Grok/Cursor MCP writes
disabled, and Kimi output redirected to a private temporary path. Fake provider
executables created by tests still ran normally. No live provider was invoked.

The full renderer suite runs as Node's test runner with the existing render hooks,
all `test/*.test.ts` and `test/*.test.tsx`, four concurrent files and a 60-second
file timeout. Backend uses the same hooks, concurrency and timeout over all
`electron/test/*.test.js`. Native commands remain documented in the helper notices
and `scripts/verify-ios-simulator-helper.js --compile --sandbox-self-test`.

## Baseline failures and limits

An isolated temporary extraction of commit `a7e52e3c`, sharing only installed
dependencies, reproduced all seven failing backend cases:

- Five `budget-spend.test.js` fixtures use August 6 timestamps that have passed
  the 90-day retention boundary. This was already recorded as separate suggested
  work during CLI-usage implementation; no spend/accounting code was changed here.
- `site-llms.test.js` finds generated `site/llms-full.txt` out of sync with
  `site/docs.html`. The generator and these files are unchanged by this batch.
  A separate suggested-work chip records the fix.
- `web.test.js` assumes default port 4620 is free. The running Solenta app already
  owns that listener, confirmed with `lsof`. The application was left running.

Full logs: `/tmp/solenta-synara-renderer.log`, `/tmp/solenta-synara-backend.log`,
`/tmp/solenta-synara-baseline.log`, `/tmp/solenta-synara-build.log`,
`/tmp/solenta-synara-native-sandbox.log`, `/tmp/solenta-synara-swift.log`,
`/tmp/solenta-synara-native-adapter.log` and `/tmp/solenta-synara-webmcp.log`.

## Local package

`bash scripts/package-app.sh` built and Developer ID-signed `out/Solenta.app`
(unnotarized local build) and its boot probe passed: memory server `/health`,
isolated userData and a live embed. The packaged helper tree is 240 KiB with no
`.build` or `.swiftpm` cache, and includes `LICENSES/` and `NOTICE.md`. The new
modules `cli-session-usage.js`, `mcpProposals.js` and
`preview-webmcp-preload.js` are in the bundle. A copy of the packaged helper
sources compiled with Xcode and passed all nine sandbox checks, including
IOSurface and the H.264 encoder. Log: `/tmp/pkg-05039948.log`.

Core, memory-server and stats suites were not rerun in this pass. There was no
notarized package, installed-app upgrade, main-branch integration, live-provider
handshake or release. This pass did not boot or send input to a simulator; the
earlier real-device acceptance remains in the simulator adoption report. Browser
screenshot/Inspect capture investigation [#2006](https://github.com/currentbits/solenta/issues/2006)
is independent work and was not taken over. Current main's existing draft marker
still needs reconciliation when integrating this older-baseline branch.

## Replayed onto origin/main

The batch was cherry-picked onto `origin/main` (`c8c8581b`) as branch
`coder/synara-adoption`. The old branch was cut from a local main whose ACP and
budget merges reached origin as squash PRs, so merging it produced 51 duplicate
conflicts. Replaying only the Synara commits left additive conflicts with
main's tab audio mute, bug reports, mentions and fusion work, all kept on both
sides.

Draft previews now reuse main's pencil marker (#1770) instead of adding a
second "Draft" badge: the marker became a button with the preview tooltip, and
also shows for attachment- or context-only drafts. Main's rules stay: compact
cards have no marker and static renders show no drafts. Preview text refreshes
through a microtask-coalesced notification, because draft lists mutate inside
React updaters.

After replay: typecheck and IPC preload sync pass, 3,989/3,989 renderer tests
pass and the production build succeeds. 6,274 Electron tests ran with a
CI-like environment. The 19 Cloud Connect failures came from this worktree's
`node_modules` missing main's new `jose` dependency. With `jose@6.2.16`
installed, and its integrity matching the lockfile, both cloud test files pass
17/17.
