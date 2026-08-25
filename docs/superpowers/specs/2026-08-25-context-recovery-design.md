# Context Recovery Design

Issue: [#709](https://github.com/currentbits/solenta/issues/709)

## Scope

This change addresses the issue's three highest-value gaps:

1. Make `/compact` create a fresh context instead of opening `/usage`.
2. Classify provider context-overflow failures separately from ordinary crashes.
3. Give the 85% context warning a one-click recovery action.

The medium- and low-priority research findings remain outside this change.

## Existing Constraints

`services.forkThread` already creates a same-provider thread with a fresh CLI
session. On its first turn, `buildHandoffPrefix` injects a bounded tail digest
from the source thread. This frees context, but it does not summarize the
thread. User-facing copy must describe it as a fork with recent history rather
than promise a generated summary.

Provider failures already converge on `runner.js`'s shared `markRunFailed`
helper, which also decides whether quota errors should park. The existing
thread status remains `failed`; introducing a new status would unnecessarily
ripple through filters, workflows, sidebars, and store recovery.

## Thread Failure Metadata

Add this field to `ThreadInfo` and persisted thread records:

```ts
lastErrorKind: "context-overflow" | null;
```

Older records normalize the field to `null`. Whenever the store clears
`lastError` because a new run starts or another non-failed status is written,
it also clears `lastErrorKind`. Generic failures explicitly leave the kind
`null`.

The metadata describes only the current `lastError`; it is not a historical
classification for every event message.

## Overflow Classification

Add `isContextOverflow(text)` beside the quota classifiers in
`electron/quotaWait.js`. It accepts unknown input and returns a boolean.

The classifier uses high-confidence structured identifiers and phrases seen
across CLI providers, including:

- `context_length_exceeded`
- `prompt is too long`
- `maximum context length ... exceeded`
- `context window ... exceeded`
- input or request text explicitly saying it is too long for the model's
  context window

It must not match broad wording such as `limit reached`, token budgets, output
token limits, quota errors, rate limits, or generic oversized file/request
errors. Those phrases either belong to existing quota handling or do not prove
that the model context is exhausted.

`markRunFailed` classifies the raw provider text before quota parking. On an
overflow it:

1. Keeps status `failed`.
2. Sets `lastErrorKind` to `context-overflow`.
3. Uses the normalized leading copy:
   `Context window is full. Fork to fresh context or rewind the last turn.`
4. Retains a shortened raw provider message below that copy for diagnosis.
5. Returns the normalized text and kind to the caller so the stored event and
   thread metadata agree.

Overflow never parks or auto-retries. Non-overflow quota and generic failure
behavior stays unchanged.

## Manual Compaction

`/compact` invokes the same plain `onFork()` callback used by `/fork`. The
source thread is not modified, and the newly selected thread keeps the source
provider, model, permission mode, and bounded recent-message handoff.

The command is unavailable while the source thread is running, matching the
existing `/fork` guard. Its palette hint becomes:

`Fork to fresh context with recent history`

This makes the command behavior real while keeping the wording honest about
the tail digest.

## Warning Recovery

`ContextRingBadge` receives an optional fork callback and whether recovery is
currently allowed. When `ring.warn` is true, its popover replaces the passive
warning-only treatment with:

- The existing `Compaction is close` explanation.
- A `Fork to fresh context` button.

The button closes the popover and invokes the same `onFork()` path as
`/compact`. It is not rendered while a run is active or when no fork callback
is available. The warning threshold remains 0.85.

## Overflow Recovery

The latest event on a failed thread already owns the `Retry turn` action.
When `detail.thread.lastErrorKind` is `context-overflow`, that event instead
shows `Fork to fresh context` and calls `onFork()`. Retrying the same oversized
session is intentionally not offered.

Rewind remains available through `/rewind` and editable prior user messages.
Generic failures continue to show `Retry turn`.

If forking fails, the existing run-error banner remains the error surface.

## Testing

### Classifier

Unit tests in `electron/test/quota-wait.test.js` cover:

- Claude/Codex-style overflow phrases and structured error codes.
- Empty and unknown values.
- Generic process failures.
- Output token limits and Solenta budget limits.
- Quota and rate-limit phrases, proving the two classifiers do not overlap.

### Store and Runner

Tests verify:

- Older thread records normalize `lastErrorKind` to `null`.
- Starting another run clears both last-error fields.
- Overflow failures store normalized copy and `context-overflow`.
- Generic failures retain `null`.
- Quota failures preserve current parking behavior.

### Renderer

Tests verify:

- `/compact` calls `onFork` and does not open the context breakdown.
- `/compact` remains inert while the thread is working.
- A ring at or above 85% shows the fork action.
- A ring below 85% does not show it.
- Overflow events offer fork instead of retry.
- Generic failures still offer retry.
- The warning action is absent without an available fork callback.

Existing fork/handoff tests remain the contract for fresh-session creation,
selection, and bounded context transfer.

## Non-Goals

This change does not:

- Add estimated rings for blind providers.
- Add OpenCode catalog windows.
- Change note-block budgeting or context breakdown segments.
- Add a sidebar context indicator.
- Add automatic parking of machine-delivered turns.
- Change the store's message cap or thread payload transport.
