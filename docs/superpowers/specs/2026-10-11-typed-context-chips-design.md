# Typed context chips (#1526)

Approved 2026-10-11. Mixed `@` list. One `ContextChip` bag persisted next to review comments. Expand at send.

## Problem

`@` inserts a plain `@path ` string. ⌘⇧C makes a single reply chip that does not survive restart. The terminal has no send-to-composer action.

## Decision

- Files and folders stay `@path ` text (`applyMention`).
- Prompt snippets stay text-insert (#189).
- Threads, PRs, Skills, terminal excerpts, and quotes are `ContextChip`s.
- Review comments stay their own list and formatter.
- No `@thread` / `@pr` / `@skill` prefix grammar.
- Terminal gets **Add to prompt** only. Find / Clear stay on #1185. Quick-action output retention stays on #1216.

## Data

`src/contextChips.ts`. Discriminated union persisted as `SavedDraft.chips`.

| kind | Stored | Chip label | Send expansion |
|---|---|---|---|
| `thread` | `threadId`, `title` | Thread title | `formatThreadDigest` of `threads.get` messages (last 12 user/assistant turns, 1200 chars each — same as `electron/ask.js`) |
| `pr` | `number`, `title` | `#N title` | `git.prDetail` title, body (cap 8k), `+additions/−deletions` |
| `skill` | `name`, `description` | Skill name | `skills.read` SKILL.md body (cap 8k). New IPC. |
| `terminal` | `text`, optional `command`, `startLine`, `endLine` | `term · cmd · L12-40` | excerpt + command + range |
| `quote` | ReplyTarget fields + `comment: string` | Cite / Reply + excerpt | existing `<reply-context>` plus the optional note |

Failed expand appends a one-line `Could not load <label>: <reason>` and does not block send.

Ids: `crypto.randomUUID()`.

## Persistence

`keptContextChips` in `src/composerSession.ts`, same debounce/cap as review comments. Hydrate ignores unknown kinds and missing required fields. Prune with the other draft maps. Cleared on send.

Quotes move out of `ThreadView` `replyByThread` React state so they survive restart.

## `@` menu

One mixed list. Row order: snippets, threads, PRs, skills, files, Browse folder.

Empty query: up to 8 threads (newest), 8 open PRs, 8 skills, plus files as today.

Non-empty query: case-insensitive substring on snippet name, thread title, `PR#` / title, skill name / description, file path.

Accept: snippet → text; file → `@path `; thread/PR/skill → append a chip and remove the `@token`.

Sources are props on Composer (`mentionThreads`, `mentionPrs`, `mentionSkills`) so tests stay fake-free of IPC.

## Quotes

⌘⇧C **appends** a quote chip. Several per draft. Optional note, same edit-in-place as `ReviewCommentChips`. Click jumps to the source (`onRevealChip`). × removes. Unavailable source greys out like today’s reply chip.

## Terminal

**Add to prompt** on the pane bar. Disabled with no selection (`hasSelection`). Never auto-sends. Uses xterm `getSelection`. Line range when `getSelectionPosition` exists; otherwise omit lines and label `term · cmd · N lines`. Last command from `TerminalState` when present.

## Send

`composeOutgoing` becomes async. Order: review comments, context chips, paste cards + draft. Quote chips replace `wrapReplyContext(replyTo)`. A draft that is only chips (no typed text) is sendable, same as review comments today.

## Out of scope

- File mentions as chips
- Prefix tokens / two-step category picker
- Terminal Find / Clear / Copy toolbar (#1185 remainder)
- Persisting quick-action command output (#1216 remainder)
- Snapshotting skill/PR/thread bodies at pick time
