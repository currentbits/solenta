# Onboarding: reach the first useful conversation

Status: implemented with three Grok workers, reviewed, awaiting integration.
Planboard: [#1250](https://github.com/currentbits/solenta/issues/1250), plan:doing.

## Goal and evidence

Help a new user connect one installed agent, add a project, and open a thread
where they can write and send their first task. A completed useful response is
the activation goal; dismissing onboarding is only setup completion. This is a
code-based assessment, not a measured conversion or retention claim.

The current four-screen flow starts with an introduction, presents every CLI,
asks for worktree/delegation/budget defaults, then ends with seven feature cards
and a generic Finish button. It never creates a first thread. CLI detection
checks installation, not authentication. Provider refresh errors are swallowed.
The onboarding and add-project dialogs both listen for Escape.

## Implementation plan

1. Replace welcome → CLI → setup → tour with Agent → Project → First thread.
   Put a short product explanation on the first step and expose textual progress.
   Preserve an explicit skip and Settings relaunch. Backdrop clicks should not
   accidentally mark onboarding complete. Reuse the modal focus hook, suspending
   onboarding while the existing project dialog is open, and return to the same
   step on cancel or success.
2. Say that only one agent is needed. Distinguish Installed from signed in;
   explain terminal sign-in without claiming authentication was verified. Show
   installed agents prominently and retain installation instructions for others.
   Make Recheck pending/success/failure visible, including an empty provider list.
   Preserve best-effort refresh behavior for existing background callers.
3. Make project setup the clear action. Keep non-repository initialization
   disclosure. Place existing worktree, delegation, and budget controls in a
   native optional disclosure; do not silently change defaults. Explain each
   choice plainly and retain pending/error handling and budget validation.
4. Replace the feature wall with a concrete first-task handoff. Show/select the
   project and an installed real provider, then create an empty thread using the
   existing createThread/setProvider flow. Start only on explicit click; never
   send a prompt or start a paid run automatically. Missing prerequisites point
   back to their setup step. Keep errors visible and prevent duplicate creation
   while pending. Offer a short example task and a docs link for later learning.
5. Review all Grok diffs, assemble them in an isolated review checkout, run
   targeted onboarding/adjacent renderer checks and typecheck/build, and inspect
   the browser at desktop and narrow sizes. Record evidence before integration.

## Ownership

- Grok flow worker: App.tsx, OnboardingModal.tsx, TourStep.tsx, shared onboarding
  CSS, onboarding.test.tsx, onboardingTour.test.tsx, and the opt-out from
  selected-thread provider inheritance in useCoder.ts createThread.
- Grok agent worker: CliStep.tsx, useCoder.ts refreshProviders only,
  onboardingCli.test.tsx. Coordinate the refresh function type if it changes.
- Grok project worker: SetupStep.tsx and onboardingSetup.test.tsx only.
- Lead: this plan, Planboard coordination, combined review and validation.

Workers must preserve others' edits, keep changes on their assigned paths, use
existing helpers/dependencies, and commit their changes for review.

## Acceptance and verification

- Three understandable steps; skip/relaunch and keyboard navigation work.
- Only actual available providers can be selected for the first thread;
  simulate is excluded, installation is not represented as authentication.
- Failed recheck is actionable and retryable without dropping the previous list.
- Add-project success and cancellation resume Project; Escape in that dialog
  does not finish onboarding. Only the active dialog owns keyboard focus.
- Optional settings keep saved choices and report validation/persistence errors.
- First-thread action targets the selected project/provider, selects the new
  thread, and leaves the composer ready without calling runs.start.
- Empty/missing prerequisites, async failure, rapid duplicate clicks, and
  Settings relaunch do not start unintended work or lose existing drafts.
- Use the existing Node renderer test runner. No new packages or analytics.

After shipping, evaluate time from first setup to first completed response and
the share of new users reaching it if suitable opt-in data becomes available.
No baseline numbers, tracking infrastructure, email campaigns, or guided tours
are invented for this change.

## Implementation and review evidence

| Area | Grok worker revision |
| --- | --- |
| Three-step flow and first-thread handoff | `778482f9` |
| Agent detection feedback and retry | `161c9c47` |
| Optional project defaults and budget validation | `c3e38193` |

The reviewed implementation creates a thread only on explicit action. Failed
agent selection retries the same thread; changing projects targets the newly
selected project. A failed onboarding completion save retains the created
thread for retry. The existing thread's provider is not inherited during this
handoff. No provider run starts automatically.

Final focused verification: **40 onboarding tests passed**, and `npm run build`
passed (including TypeScript and generated preload checks). The duplicate
tabIndex in the existing onboarding modal was removed during the rewrite.

```sh
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/onboarding.test.tsx test/onboardingCli.test.tsx test/onboardingSetup.test.tsx test/onboardingTour.test.tsx
npm run build
```

The full renderer run before the final two retry regressions passed 2,396 of
2,397 tests. Its sole failure, the Composer model-picker Tab-cycle test, also
failed independently on unchanged base `5355d91c`. The final retry changes
were then covered by the 40 passing focused tests and another successful build.
The existing focus regression was suggested as follow-up to the ongoing #920
work, rather than changing unrelated Composer behavior here.

Browser checks used an isolated Electron window with the existing devCoder
fixture as a desktop bridge. All three screens fit at 1120×820 and 390×720.
Native disclosure keyboard activation and modal focus containment passed.
Entering an incomplete number did not clear a saved daily budget. The explicit
first-thread action created exactly one thread in the selected project with
the selected installed provider, focused the composer, and started zero runs.
No live account, authentication, provider execution, or user repository was
used by these browser checks.

A separate pre-existing Vite-development issue was suggested: App renders a
web-token dialog alongside onboarding despite the DEV exemption at boot,
causing competing focus traps. Desktop-style fixture checks avoid that extra
development-only dialog; this change does not alter web authentication.
