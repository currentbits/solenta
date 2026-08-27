# Flatten daily-driver UI (cards and borders)

User feedback: the app is functionally great, but the UI is a dashboard of
cards and borders. It does not feel like t3code: a continuous page of type
and space.

**Decision (2026-08-27):** Flatten, first pass on the daily driver only.
Identity stays (Inter, dark/light tokens, blue accent, three-column shell).
Functionality stays. Tracking: GitHub #727.

## Job

Someone sits in a thread for hours. The centre pane is reading and writing.
The right pane is environment actions. Chrome should recede. The transcript
should read as a document, not a stack of tiles.

Visitor mode: **Operate**. Quiet means less noise, not a new brand.

## Problem

The default widget is a boxed card:

```css
background: var(--card);
border: 1px solid var(--border);
border-radius: var(--radius);
```

That pattern is used on the order of 90 times. Light mode is worse: white
tiles on `#f3f5f8` with `#cfd6e1` outlines.

Loudest surfaces in `assets/screenshot.png` / `site/assets/screen-main.png`:

1. **Environment column** — 8 to 15 independent `.gitCard` tiles (Repository,
   PRs, Recap, Fork, Changes, Display, Worktree, Pull, Dev server, …).
2. **Transcript events** — one-line statuses (`Kicked off 5 subagents`,
   `Run complete`) wrapped in `ThreadView` `.card`.
3. **Tool calls and Work Log** — same bordered + shadowed `.card`.
4. **Plan / suggested-work / time-saved** — more bordered cards above the
   composer.
5. **Chrome** — icon buttons, Views segmented control, composer pills, all
   with a 1px border.
6. **Composer** — card plus drop shadow. This is the one object that should
   stay physical.

The **sidebar thread list** is already close to the target (rows, hover,
inset active). Do not card-ify it.

## Rule

**In-page grouping uses type, space, and hover. `background: var(--card)` plus
a 1px `--border` is reserved for floating surfaces and the composer.**

Keep a box when the thing must float or must be answered:

- Popovers, menus, modals, dialogs
- The composer (the one physical object in the thread column)
- Blocking prompts the user must answer (permission, Ask, Teach, Spec).
  Those keep a **wash**, not a 1px tile. Amber/blue/violet fill is the
  signal; the outline goes.

Drop the box everywhere else in scope.

## Scope (in)

Daily driver:

- Thread transcript (`src/components/ThreadView.module.css`, a little
  `ThreadView.tsx` if a class rename is cleaner than restyling `.card`)
- Environment + Agents tabs of the right pane (`AgentsPanel.module.css`
  `.gitCard`, `.sessionCard`, `.teamSection`, `.workflow`)
- Composer (`Composer.module.css`)
- Ghost chrome: `.iconBtn`, `.menuBtn`, `.btn` (non-primary), `.paneTabs`,
  `.agentsToggle`, `.collapseBtn`, composer `.pill`

## Scope (out)

Same rule, later pass (do not do in this work):

- Memory tab, Skills tab, Settings, Kanban, Fleet, Digest, Planboard view,
  Insights, Usage, Automations, onboarding
- Marketing screenshots (`site/assets/screen-*.png`) — recapture after this
  ships; issue #690 is the existing screenshot pipeline
- Layout rewrite, rebrand, new tokens beyond comments, animation redesign

## Visual contract

### Chrome

- Default icon/text buttons: transparent fill, **transparent** border.
  Hover: `var(--overlay-hover)`. Active/selected: `var(--blue-soft)` fill,
  no outline.
- Views segmented control (`.paneTabs`): no outer 1px box. Active tab is a
  fill. Inactive tabs are type only.
- Column seams stay (sidebar `border-right`, agents `border-left`) but both
  use `--border-soft`. One seam per panel, not a box per widget.
- Focus-visible rings stay. Do not replace them with borders.

### Environment / Agents

`.gitCard`, `.sessionCard`, `.teamSection`, `.workflow` become sections:

- No fill, no 1px border, no `box-shadow`, no radius.
- Keep the existing label (`.gitCardLabel` / `.sessionLabel` / `.workflowLabel`).
- Separate with the existing `.scroll { gap: 14px }`. No hairline between
  sections (labels already group).
- `data-*-card` attributes stay. Tests query those, not the box.
- Phase chips / role chips: fill when meaningful, no 1px outline.

### Transcript

`ThreadView` `.card` (events, tool calls, Work Log) loses fill, border,
shadow, and heavy radius. It becomes a block of type:

- Event lines (`Kicked off 5 subagents`, `Run complete`): a text row,
  weight 600, no tile.
- Tool calls: header row (dot + name + summary). Expanded body is inset
  type / mono, optional top hairline on the **body** only.
- Work Log: same as tools (chevron + title, then a list).
- Plan overview (`[data-plan-card]`): typed list, no tile.
- Suggested-work row: no 1px box. Actions stay as ghost buttons.
- Status strip / queued strip: wash, no outline. Running still reads as
  running.
- User bubble: keep `var(--blue-soft)` fill so user vs assistant is
  obvious; **drop** `border: 1px solid var(--blue-border)`.
- Empty-state glyph: drop the boxed+shadowed tile; a quiet glyph is enough.

Assistant markdown stays unboxed (already is).

### Composer

The one object:

- Keep fill + radius + a hairline so it is a place to type.
- Drop `box-shadow: 0 8px 24px var(--shadow-color)`.
- Pills: ghost (transparent border). Accent pill: fill, no outline.
- Focus-within may tint the hairline to `--blue-border` (already does).

### Blocking prompts

`.permissionCard`, `.specCard`, Ask/Teach/Felt: keep the tinted wash so
they interrupt. Drop the 1px border. Primary/deny actions stay solid
buttons (those are actions, not chrome).

## Tests

This repo already locks CSS by reading the module file (see
`test/threadView.test.tsx` `ruleBody`, `test/sidebar.test.tsx`). Add
`test/flattenDailyDriver.test.ts` that parses the four CSS modules and
asserts the contract above. Existing `data-*-card` / "Work Log" tests must
keep passing.

Do not add screenshot tests in this pass.

## Key decisions

1. **Flatten, do not soften.** Keeping card shapes with fainter borders
   still reads as a dashboard. Approved 2026-08-27.
2. **Daily driver first.** Memory/Skills/Settings/Kanban follow later so
   the screenshot the feedback is about actually changes.
3. **Composer stays an object.** t3code still has a composer shell. The
   shadow is what makes it float off the page; the hairline is enough.
4. **User bubble keeps a wash.** Flattening it to plain type would mix
   user and assistant. The border goes; the fill stays.
5. **No markup rewrite unless a class rename is cleaner.** Environment
   sections keep `data-repo-card` etc. Event/tool/work-log can keep
   `.card` if `.card` itself is flattened.
6. **No new color tokens.** Use `--overlay-hover`, `--border-soft`,
   `--blue-soft` that already exist.

## Anti-goals

- Do not remove Plan, Work Log, Recap, Fork, Worktree, or any control.
- Do not change the three-column grid.
- Do not restyle the sidebar thread rows.
- Do not introduce a new font or accent.
- Do not nest a card inside a card.
- Do not gray out hierarchy. Selected, running, and danger still need
  color.

## Open questions

None. Approach and scope were chosen explicitly.
