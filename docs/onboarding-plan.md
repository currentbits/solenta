# Onboarding: reach the first useful conversation

Status: implementation in progress with Grok workers.

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
  CSS, onboarding.test.tsx, onboardingTour.test.tsx.
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
