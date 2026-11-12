# Saved draft previews

Implemented 2026-11-12. Tracking: [#2005](https://github.com/currentbits/solenta/issues/2005).

Synara [#1579](https://github.com/Emanuele-web04/synara/pull/1579) provides the
interaction: preview the saved unsent prompt, normalize whitespace, hide inline
context placeholders and keep recalled sent history separate. Solenta adapts the
behavior using its existing composer maps and thread cards. No upstream code was
copied and no dependency or persistence format was added.

Sidebar and Kanban thread cards show a small Draft button. Hover or keyboard
focus reveals an excerpt; Escape dismisses it. Clicking the button opens its
owning thread and preserves the normal modifier selection behavior. The excerpt
collapses whitespace, drops object replacement placeholders and caps text at 180
Unicode code points plus an ellipsis, without changing the full draft. Context
chips already live separately from typed text, so their bodies are never expanded
into the preview. Attachment/context-only drafts show counts, without paths,
filenames or context bodies. Sent history alone never creates a marker.

The existing draft-save path notifies subscribers in a coalesced microtask, since
attachment/paste updates can run inside React state updaters. Only the badge
subscribes; thread-card memoization stays intact. Hydration, reset and pruning also
notify. This uses the existing window-local maps and localStorage behavior; it
does not add synchronization between windows or linked computers.

Arrow-key recall starts only from an empty composer in Solenta. It now changes
the displayed textarea without writing the recalled prompt into the draft map.
An edit makes it a normal saved draft; sending or stashing uses the displayed
text as before. Switching threads or restarting discards untouched recalled text;
the sent prompt remains available through recall. This keeps previews and restart
persistence aligned with actual unfinished work.

The initial research also inspected newer main, which already has a generic draft
marker from #1770. This worktree's October 27 baseline lacks it. This branch adds
the missing marker/subscription as well as the excerpt; reconcile that overlapping
marker work when integrating into current main instead of retaining two markers.

Verification passed 288 focused renderer checks across draft previews, composer
durability, general composer behavior, attachments, power-ups, sidebar and Kanban,
plus typecheck/preload synchronization and diff checks. A real sandboxed Electron
fixture used the production Composer, ThreadCard and styles to verify live drafts
in two threads, focus/tooltip dismissal, draft selection, send, transient recall,
thread switching and context-only markers. The inspected screenshot is
`/tmp/solenta-draft-preview.png`.

The later [combined verification](2026-11-12-synara-batch-verification.md) ran the
full renderer/backend suites and corrected the missing static-render snapshot
callback on the badge subscription. No signed package, main-branch integration or
release was performed. Screen-reader behavior was checked through accessible DOM
relationships, not with a real screen reader.
