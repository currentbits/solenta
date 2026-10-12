# Typed context chips — implementation plan

> Execute inline. TDD. Reuse review-comment persistence and chip UI.

**Goal:** Composer can attach Threads, PRs, Skills, terminal excerpts, and several quotes as persisted chips that expand at send.

**Architecture:** One `ContextChip` union in `src/contextChips.ts`. Persist next to review comments. Mixed `@` list. Expand in `composeOutgoing`.

## Tasks

1. Chip model + formatters (`src/contextChips.ts`, `test/contextChips.test.ts`)
2. Persist in `composerSession` (hydrate / prune / cap)
3. `ContextChips` UI + Composer send/clear
4. Mixed `@` menu (threads / PRs / skills)
5. Quotes: append + optional note; drop `replyByThread`
6. `skills.read` IPC + send-time expanders
7. Terminal **Add to prompt**
