---
target: thread/projects sidebar
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
timestamp: 2026-08-19T13-35-09Z
slug: src-components-sidebar-tsx
---
Method: dual-agent (A: design review · B: detector/evidence)
Evidence caveat: live-app screenshot blocked by macOS Screen Recording TCC in a non-interactive session; visual claims rest on source. Detector scan of Sidebar.tsx: clean (0 findings) — its rule set targets slop patterns, not general design quality, and single-file mode never scanned Sidebar.module.css.

# Design Health Score — Solenta sidebar (src/components/Sidebar.tsx)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Excellent — arguably over-visible |
| 2 | Match System / Real World | 2 | Invented vocabulary: settled, spaces, woke, wt, ask |
| 3 | User Control and Freedom | 3 | Bulk "Settle all"/"Clear" are hover-hidden one-clicks |
| 4 | Consistency and Standards | 2 | 4 row templates, 3 identical header styles for 3 hierarchy levels, tokens bypassed by hardcoded hex |
| 5 | Error Prevention | 3 | Good remove-project dialog; "Clear" archives everything in one hover click |
| 6 | Recognition Rather Than Recall | 2 | Shelf precedence (snoozed>pinned>settled) and tag abbreviations must be memorized |
| 7 | Flexibility and Efficiency | 4 | ⌘J/K, ⌘1-9, multi-select, batch bar — better than t3 |
| 8 | Aesthetic and Minimalist Design | 1 | 19-element rows, ~15 pill styles, 10-12 font sizes, 4 row templates |
| 9 | Error Recovery | 3 | Search errors render as "No threads match" — a wrong answer shown as true (Sidebar.tsx:1564) |
| 10 | Help and Documentation | 3 | `?` keyboard sheet; everything else tooltip-only |
| **Total** | | **27/40** | **Acceptable — functionally strong, aesthetically failing** |

# Design Specificity Verdict

Accreted, not authored. Comments cite "round 40…49" and a dozen issue numbers; each feature locally well-reasoned, but no pass ever asked what comes OUT. Tell: ~10-12 font sizes (incl. 10.5px/12.5px) and hardcoded hex (#93c5fd, #c4b5fd, #fca5a5, #fbbf24) alongside a token system. Comments repeatedly cite "t3-style" for individual mechanics while the whole no longer resembles t3.

Deterministic scan: 0 findings on Sidebar.tsx (slop-pattern rule set; Sidebar.module.css unscanned in single-file mode). No false positives. No overlay possible (Electron).

# Why t3 reads clean (concretely)

- 1 datum per row (title, one line, ~32px); Solenta worst case: 19 visible elements across 4-5 lines + 5 hover buttons + 2 submenus.
- t3: ~2 font sizes, 1 accent + 2 neutrals, 0 badges, 1 row template, 1 nesting level, passive recency grouping. Solenta: 10-12 sizes, ~14 colors, ~15 pill styles, 4 row templates, 4 nesting levels crossed with 4 status shelves.
- t3's list answers one question: "which conversation do I want?" Solenta's row also answers provider, git state, cost, status, risk — all at rest, in 300px.

# What's Working (keep)

1. Keyboard model — ⌘J/K, ⌘1-9 with held-⌘ hints, multi-select, `?` sheet; keyboard order provably matches render order (sidebarSelection.ts:41-99).
2. A11y diligence — sr-only unread, no nested interactive controls (cardSelect overlay), focus-visible, reduced-motion.
3. Stability rules — activity never reorders rows; active thread never vanishes.

# Priority Issues

1. [P0] Row is a dashboard, not a list item (Sidebar.tsx:640-771). Fix: rest state = status dot + title + age (≤3 elements); metadata to hover/selected/thread header.
2. [P0] ~15 pill styles / 6 badge hues in a 300px column (Sidebar.module.css:1013-1270). Fix: status = dot color (blue running / amber needs-you / red failed / nothing idle); delete badgeDone.
3. [P1] Three near-identical 11px uppercase header styles for space/project/shelf (Sidebar.module.css:188, 282, 777). Fix: differentiate levels; drop groupHeaderSummary duplication.
4. [P1] Per-project creation cluster ×N (Sidebar.tsx:2092-2238). Fix: one global New Thread with project/type picker.
5. [P1] No type scale: 10-12 sizes, ~9 weights, hardcoded hex. Fix: 3 sizes, 3 weights, tokens only.
6. [P2] Four "not now" zones with hidden precedence (sidebarGroups.ts:103-117). Fix: Active and Later.
7. [P2] Hover pill: 5 actions + 2 submenus; hover hides the age (Sidebar.module.css:587-590). Fix: pin + one … overflow menu.
8. [P3] Destructive bulk actions hover-hidden with no confirm (Sidebar.tsx:3180-3205). Fix: overflow menu with count in label.

# Persona Red Flags

Alex (power user): broken scan column; 5s ticks + auto-animate + 3 pulse animations while scanning; ⌘1-9 indexes mutate with collapse state; "needs me" scattered across 4 encodings; no `/`/⌘F for search.
Sam (SR/keyboard): ~150+ tab stops to the settled tail; no list semantics or aria-current; status absent from accessible names — cannot triage; no live region for status flips; role="menu" without arrow keys.

# Minor Observations

Raw rgba where --blue-soft exists (Sidebar.module.css:461); "wake" lone text button among icons; three state-toggle icon languages; ~215px chrome before first thread (t3 ~120px); money in a nav column; sticky project headers but non-sticky space/shelf headers; 300px width for ~380px rows.

# Questions to Consider

1. Do Spaces deserve to exist (~400 lines to group 2-6 projects)?
2. Should the sidebar stop being the dashboard (Activity/Kanban/Planboard are one click away)?
3. Would you ship this sidebar as the landing-page screenshot with 30 real threads?
