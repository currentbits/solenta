# Requirements: file the two product bugs

This thread's spec slug (`cut-a-nightly-build`) is leftover from an earlier
prompt. The current user request is to open GitHub issues for two defects,
not to cut another nightly and not to implement the fixes in this thread.

## Acceptance criteria

1. WHEN the user reports that a thread cannot leave spec mode THE SYSTEM SHALL
   have an open GitHub issue describing that there is `startSpec` but no
   `stopSpec` / Exit control, so `[Spec mode]` keeps wrapping every follow-up.
   Issue: https://github.com/currentbits/solenta/issues/500

2. WHEN the user reports that the composer `/` menu does not scroll under
   arrow keys THE SYSTEM SHALL have an open GitHub issue describing that
   `commandIndex` moves while the highlighted row is never
   `scrollIntoView`'d inside `.mentionList` (`max-height: 240px`).
   Issue: https://github.com/currentbits/solenta/issues/501

3. WHEN those issues are filed THE SYSTEM SHALL label them `bug` and
   `plan:todo` so they appear on the planboard.

## Out of scope

- Implementing exit-spec-mode or slash-list scrolling in this thread.
- Cutting or republishing a nightly.
- Changing any file other than this requirements artifact in this spec stage.
