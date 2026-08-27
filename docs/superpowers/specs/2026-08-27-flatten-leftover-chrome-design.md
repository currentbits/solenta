# Flatten leftover chrome (same contract as #727 / #728)

Follow-up to GitHub #727 / #728.
Tracking: GitHub #729.

The daily driver and the secondary-view pass (Memory, Skills, Settings,
Kanban, Fleet, Digest, Planboard, Insights, Usage, Automations) are
flatten-or-in-flight on their own branches. This pass applies **the same
rule** to leftover chrome that #728 left out of scope.

**Decision:** Flatten. Identity stays. Functionality stays. Do not recard-ify
the daily driver or the #728 views.

## Rule

In-page grouping uses type, space, and hover. `background: var(--card)` plus
a 1px `--border` is reserved for floating surfaces, the composer, and form
inputs.

Keep a box when the thing must float or is a place to type:

- Popovers, menus, modals, dialogs (Workflows `.modal` and onboarding
  `.sheet` stay framed)
- Form inputs and selects (Workflows `.input` / `.select` / `.textarea`,
  onboarding `.setupInput`)
- Warning washes keep fill; drop the 1px outline

Drop the box everywhere else in these views.

## Scope (in)

- Activity: flatten `.row`; ghost `.refresh`
- PR list: flatten `.row`; ghost `.refresh` / `.retry` / `.checkout`
- Onboarding: flatten inner `.cliRow` / `.tourCard`; ghost `.btn`.
  `.sheet` stays framed. Inputs stay.
- WorkflowsModal: flatten inner `.phaseCard`; ghost chrome buttons
  (`.btn`, `.iconBtn`, `.deleteBtn`, `.newBtn`). `.modal` stays framed.
  Inputs stay.

## Scope (out)

- ThreadView, AgentsPanel, Composer, App chrome of the daily driver
- Memory, Skills, Settings, Kanban, Fleet, Digest, Planboard, Insights,
  Usage, Automations (#728)
- Marketing screenshots (`site/assets/screen-*.png`) — recapture via #690

## Tests

`test/flattenLeftoverChrome.test.ts` parses the CSS modules (same pattern as
`test/flattenSecondaryViews.test.ts`). Existing `data-*` tests must keep
passing. Do not add screenshot tests.

## Anti-goals

- Do not change layout or remove controls.
- Do not recard-ify daily-driver or #728 modules.
- Do not introduce new tokens.
- Do not gray out hierarchy. Selected, running, and danger still need color.
