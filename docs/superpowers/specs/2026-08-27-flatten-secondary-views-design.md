# Flatten secondary views (same contract as #727)

Follow-up to GitHub #727 / `2026-08-27-flatten-daily-driver-ui-design.md`.
Tracking: GitHub #728.

The daily driver (transcript, Environment/Agents, composer, chrome) is
flatten-or-in-flight on its own branch. This pass applies **the same rule**
to the views that were out of scope there.

**Decision:** Flatten. Identity stays. Functionality stays. Do not recard-ify
the daily driver.

## Rule

In-page grouping uses type, space, and hover. `background: var(--card)` plus
a 1px `--border` is reserved for floating surfaces and the composer.

Keep a box when the thing must float or is a place to type:

- Popovers, menus, modals, dialogs (Settings window frame stays)
- Form inputs and selects (search, textarea, `<select>`)
- Blocking/warning washes (Fleet notes keep amber fill; drop the 1px outline)

Drop the box everywhere else in these views.

## Scope (in)

- Memory tab: `.card`, `.doctor`; ghost `.retryBtn`. Inputs stay.
- Skills tab: `.row`, boxed `.form` / `.preview` / `.instructionCode`; ghost
  `.ghostBtn` and `.chip`. Inputs stay.
- Settings modal: inner rows (`.memoryRow`, `.gcCandidate`), ghost `.btn`.
  `.modal` / `.settingsModal` stay framed.
- Kanban: flatten `.column`. Stop recardifying sidebar `data-thread-card`
  rows (`data-kanban-column` stays).
- Fleet / Usage: ghost `.segment` and `.refresh`.
- Digest: flatten `.row`; ghost `.refresh` and chrome pills.
- Planboard: flatten `.column`, `.card`, `.planCard`; ghost refresh/start.
  Selects stay.
- Insights: flatten `.mode` and `.row`; ghost `.refresh`.
- Automations: flatten `.row`; ghost `.action`. Inputs stay.

## Scope (out)

- ThreadView, AgentsPanel, Composer, App chrome of the daily driver
- Onboarding, Activity, PR list, Workflows inner cards
- Marketing screenshots (`site/assets/screen-*.png`) — recapture via #690

## Tests

`test/flattenSecondaryViews.test.ts` parses the CSS modules (same pattern as
`test/threadView.test.tsx`). Existing `data-*` tests must keep passing.
Do not add screenshot tests.

## Anti-goals

- Do not change layout or remove controls.
- Do not restyle sidebar thread rows except to stop Kanban recardifying them.
- Do not introduce new tokens.
- Do not gray out hierarchy. Selected, running, and danger still need color.
