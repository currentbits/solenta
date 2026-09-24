# Thread motion acceptance

Plan: [#1353](https://github.com/currentbits/solenta/issues/1353). Follow-up to the four merged UX phases, tested against `f54bab82`. Grok's branch `coder/fork-this-is-a-persisetent-issue-when-us-6a5e9d` was reviewed at `632c6803`; the production correction is `a759450e` and the follow-up simplifies its regression tests. It was merged with user approval into `codex/thread-worker-ux` as `34ea505a`.

## Reproduced defects

| Sequence | Baseline | With the correction |
| --- | --- | --- |
| Expand 20 workers, close with the pointer, then reopen with Space 35ms later. | 40 worker cards remain after 500ms, including 20 abandoned exit placeholders. They remain through subsequent worker updates. | Exactly 20 worker cards, no abandoned placeholders or absolute-positioned exit rows. |
| Start with reduced motion, expand workers, then turn reduced motion off and close the family. | The preference changes but no list animation can run because AutoAnimate never installed its observer. | No animation while reduced; the next pointer disclosure animates after the preference changes. |

The shared disable path removes abandoned AutoAnimate exit placeholders. Solenta also owns the reduced-motion gate from initialization, allowing the existing observer to respond when the preference changes. No new animation library or visual effect was introduced. The cleanup recognizes AutoAnimate's `__aa_del` marker; the duplicate-row regression is relevant when upgrading that dependency. The installed 0.10.0 module was compared byte for byte with its published package archive.

Pointer-only rapid close/open/close cleared after settling. Temporary exit rows observed earlier in that sequence were not a separate persistent defect. Native Space activation was verified by the browser's synthesized click with `detail: 0`.

## Native fixture observations

The isolated Electron fixture used 20 workers, 180 additional independent tasks, two synthetic projects and a long transcript. It delivered 80 worker/transcript updates at 50ms intervals. With the corrected gate, task order and sidebar/transcript scroll offsets stayed unchanged. Updates created no WAAPI list animations. Adding 60 tasks as one batch also created none. Dark screenshots were inspected; reduced-motion disclosure remained immediate.

For that single patched run, 240 observed frame intervals had a median of 16.7ms, a 95th percentile of 16.8ms and a maximum of 66.7ms; four exceeded 34ms. Five long tasks measured 65–85ms. These development-fixture observations do not establish packaged-app frame time, live provider-stream performance or a performance improvement. They establish stable selection/order/scroll and the absence of repeated list animation under the synthetic updates.

The fixture did not measure initial hydration animation: instrumentation began after mounting. Existing regression coverage checks silent initial transcript rendering, append-only entrances and history reveal. No live project data or installed Solenta window was used.

## Verification status

The production build/typecheck, 297 initial targeted checks and all 2,627 renderer checks passed at `a759450e`. After simplifying the test harness, final typecheck and 299 targeted sidebar, hierarchy, selection, status, resize and transcript checks passed at `632c6803`. Both changed files match the reviewed tip byte for byte; `git diff --check` passes. Production code is unchanged by the test follow-up, so the native before/after evidence applies to the final tip.

The three motion regressions run directly in their own existing Node test process, import Sidebar after installing browser observers, and reuse the shared project/thread fixtures. Local timer cleanup lets the tests exit without a nested runner or forced exit.

After landing, both changed files still match the reviewed tip. The destination production build/typecheck and all 299 targeted checks passed. The worker worktree was cleaned up. No release or installation was performed.
