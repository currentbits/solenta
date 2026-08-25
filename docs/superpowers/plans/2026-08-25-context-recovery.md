# Context Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/compact` create a fresh-context fork, classify context overflow semantically, and expose one-click fork recovery before and after exhaustion.

**Architecture:** Keep the existing `failed` thread status and add `lastErrorKind` as semantic metadata for the current failure. A narrow classifier beside quota handling normalizes overflow copy, while the runner's shared provider-failure helper records one consistent event. All three renderer recovery surfaces call the existing `onFork()` path backed by `services.forkThread` and `buildHandoffPrefix`.

**Tech Stack:** Electron/Node CommonJS backend, TypeScript, React 19, CSS Modules, Node test runner, JSDOM renderer tests.

## Global Constraints

- Scope is limited to the three highest-value findings in issue #709.
- Keep the thread status `failed`; do not add a `context-full` status.
- Use exactly `lastErrorKind: "context-overflow" | null`.
- Use exactly `Context window is full. Fork to fresh context or rewind the last turn.` as the normalized leading copy.
- Describe `/compact` as a fresh-context fork with recent history; `buildHandoffPrefix` is a bounded tail digest, not a generated summary.
- Keep `CONTEXT_WARN_FRACTION` at `0.85`.
- Overflow must never enter quota parking or automatic retry.
- Generic failures must keep `Retry turn`; overflow failures must offer `Fork to fresh context`.
- Do not add dependencies.
- Do not create git commits unless the user explicitly authorizes commits during execution.

---

## File Structure

- `electron/quotaWait.js`: own high-confidence overflow recognition and normalized overflow copy beside quota classification.
- `electron/runner.js`: own the shared provider-failure recording path and attach semantic metadata.
- `electron/store.js`: migrate, validate, and clear `lastErrorKind` with `lastError`.
- `electron/services.js`: initialize new threads with both last-error fields.
- `src/shared/ipc.ts`: expose the semantic failure kind to the renderer.
- `src/devCoder.ts`: keep browser-development `ThreadInfo` fixtures type-correct.
- `test/support/fakeCoder.ts`: give renderer fixtures a stable `lastErrorKind` default.
- `src/slashCommands.ts`: make `/compact` palette copy honest.
- `src/components/ThreadView.tsx`: route `/compact`, warning, and overflow recovery through `onFork`.
- `src/components/ThreadView.module.css`: style the warning-popover action.
- `electron/test/quota-wait.test.js`: prove classifier precision and quota separation.
- `electron/test/store.test.js`: prove migration and clearing semantics.
- `electron/test/runner.test.js`: prove normalized event/metadata behavior at the provider boundary.
- `test/composerSlashActions.test.tsx`: prove `/compact` and warning-ring behavior.
- `test/retryTurnWiring.test.tsx`: prove overflow replaces retry with a real App-level fork.

### Task 1: Classify Overflow and Persist Its Semantic Kind

**Files:**
- Modify: `electron/quotaWait.js:30-45, 347-354`
- Modify: `electron/test/quota-wait.test.js:5-39`
- Modify: `src/shared/ipc.ts:361-377`
- Modify: `electron/store.js:906-926, 2803-2811`
- Modify: `electron/services.js:515-553`
- Modify: `src/devCoder.ts:614-626, 1892-1903`
- Modify: `test/support/fakeCoder.ts:130-168`
- Modify: `electron/test/store.test.js:22-105`

**Interfaces:**
- Produces: `isContextOverflow(text: unknown): boolean`
- Produces: `classifyContextOverflow(text: unknown): { kind: "context-overflow"; text: string } | null`
- Produces: `ThreadInfo.lastErrorKind: "context-overflow" | null`
- Consumes: existing quota parsing remains unchanged.

- [ ] **Step 1: Add failing classifier tests**

Extend the `quotaWait.js` import and add these cases to
`electron/test/quota-wait.test.js`:

```js
const {
  isQuotaLike,
  isContextOverflow,
  classifyContextOverflow,
  parseQuotaError,
  quotaWaitEnabled,
  decideQuotaWait,
  formatQuotaWaitClock,
  MAX_WAIT_MS,
} = require("../quotaWait.js");

describe("isContextOverflow", () => {
  it("matches structured and provider overflow language", () => {
    const positives = [
      "context_length_exceeded",
      "Prompt is too long",
      "maximum context length exceeded",
      "This model's maximum context length is 128000 tokens",
      "Your input exceeds the context window of this model",
      "request is too long for the model context window",
    ];
    for (const text of positives) {
      assert.equal(isContextOverflow(text), true, text);
    }
  });

  it("rejects quota, output-token, budget, and generic size errors", () => {
    const negatives = [
      "You've hit your session limit · resets 3pm",
      "rate_limit_error: 429 Too Many Requests",
      "Daily budget of $1.00 reached",
      "max_tokens must be less than 4096",
      "output token limit reached",
      "Request entity too large",
      "Run error (exit 1): spawn claude ENOENT",
      "",
      null,
    ];
    for (const text of negatives) {
      assert.equal(isContextOverflow(text), false, String(text));
    }
  });

  it("normalizes overflow while retaining short provider detail", () => {
    const parsed = classifyContextOverflow(
      "Run error: context_length_exceeded\nrequest had 250000 tokens\nignored tail",
    );
    assert.deepEqual(parsed, {
      kind: "context-overflow",
      text:
        "Context window is full. Fork to fresh context or rewind the last turn.\n" +
        "Provider error: Run error: context_length_exceeded\nrequest had 250000 tokens",
    });
    assert.equal(classifyContextOverflow("Run error: connection refused"), null);
  });
});
```

- [ ] **Step 2: Run the classifier test and confirm it fails**

Run:

```bash
node --test electron/test/quota-wait.test.js
```

Expected: FAIL because `isContextOverflow` and `classifyContextOverflow` are
not exported.

- [ ] **Step 3: Implement the narrow classifier and normalizer**

Add this beside `QUOTA_RE` in `electron/quotaWait.js`:

```js
const CONTEXT_OVERFLOW_COPY =
  "Context window is full. Fork to fresh context or rewind the last turn.";

const CONTEXT_OVERFLOW_RE =
  /context[_\s-]?length[_\s-]?exceeded|prompt is too long|maximum context (?:length|window)|context window.{0,80}(?:exceed|full|too (?:long|large))|exceeds?.{0,40}(?:the |this model'?s )?context window|(?:input|prompt|request).{0,80}too (?:long|large).{0,80}(?:model'?s? )?context window/i;

/**
 * High-confidence provider context overflow; deliberately excludes generic
 * "limit reached", quota, and output-token wording.
 * @param {unknown} text
 */
function isContextOverflow(text) {
  const s = String(text ?? "").trim();
  return Boolean(s && CONTEXT_OVERFLOW_RE.test(s));
}

/**
 * Targeted recovery copy plus at most two provider-detail lines.
 * @param {unknown} text
 * @returns {{ kind: "context-overflow", text: string } | null}
 */
function classifyContextOverflow(text) {
  const raw = String(text ?? "").trim();
  if (!isContextOverflow(raw)) return null;
  const detail = raw
    .split(/\r?\n/)
    .slice(0, 2)
    .join("\n")
    .slice(0, 500);
  return {
    kind: "context-overflow",
    text: `${CONTEXT_OVERFLOW_COPY}\nProvider error: ${detail}`,
  };
}
```

Export both functions from `module.exports`:

```js
module.exports = {
  isQuotaLike,
  isContextOverflow,
  classifyContextOverflow,
  parseQuotaError,
  quotaWaitEnabled,
  decideQuotaWait,
  formatQuotaWaitClock,
  MAX_WAIT_MS,
};
```

- [ ] **Step 4: Run the classifier tests and confirm they pass**

Run:

```bash
node --test electron/test/quota-wait.test.js
```

Expected: PASS, including existing quota-clock cases.

- [ ] **Step 5: Add failing store tests for migration and clearing**

Add these cases to `electron/test/store.test.js`:

```js
it("normalizes lastErrorKind and rejects unknown persisted kinds", () => {
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      projects: [],
      threads: [
        { id: "missing", lastError: null },
        { id: "overflow", lastErrorKind: "context-overflow" },
        { id: "unknown", lastErrorKind: "network-error" },
      ],
      messagesByThread: {},
      workLogByThread: {},
      usageByThread: {},
    }),
    "utf8",
  );
  const store = new Store(filePath);
  assert.equal(store.getThread("missing").lastErrorKind, null);
  assert.equal(store.getThread("overflow").lastErrorKind, "context-overflow");
  assert.equal(store.getThread("unknown").lastErrorKind, null);
});

it("clears lastErrorKind whenever a non-failed status clears lastError", () => {
  const store = new Store(filePath);
  store.setThreads([
    {
      id: "t1",
      status: "failed",
      lastError: "Context window is full",
      lastErrorKind: "context-overflow",
    },
  ]);
  store.updateThread("t1", { status: "working" });
  assert.equal(store.getThread("t1").lastError, null);
  assert.equal(store.getThread("t1").lastErrorKind, null);
});
```

- [ ] **Step 6: Run the store tests and confirm they fail**

Run:

```bash
node --test electron/test/store.test.js
```

Expected: FAIL because migration and status clearing do not populate
`lastErrorKind`.

- [ ] **Step 7: Add metadata to the IPC type and every thread constructor**

Add this directly after `lastError` in `ThreadInfo`:

```ts
/** Semantic kind for the current lastError; null for ordinary failures. */
lastErrorKind: "context-overflow" | null;
```

In `migrateThread` in `electron/store.js`, add:

```js
lastErrorKind:
  t.lastErrorKind === "context-overflow" ? "context-overflow" : null,
```

Change the non-failed-status clearing patch to:

```js
p = { ...p, lastError: null, lastErrorKind: null };
```

Initialize both fields in `electron/services.js`'s `createThread`:

```js
status: "idle",
lastError: null,
lastErrorKind: null,
createdAt: now,
```

Add `lastErrorKind: null` directly after thread `lastError` fields in both
`ThreadInfo` constructors in `src/devCoder.ts`, and in the `thread()` fixture
in `test/support/fakeCoder.ts`:

```ts
status: "idle",
lastError: null,
lastErrorKind: null,
```

Update the round-trip thread fixture in `electron/test/store.test.js` with:

```js
lastError: null,
lastErrorKind: null,
```

- [ ] **Step 8: Run store tests and TypeScript checking**

Run:

```bash
node --test electron/test/store.test.js && npm run typecheck
```

Expected: PASS with no missing `ThreadInfo.lastErrorKind` errors.

- [ ] **Step 9: Commit the classifier and metadata foundation if authorized**

If commits were explicitly authorized:

```bash
git add electron/quotaWait.js electron/test/quota-wait.test.js electron/store.js electron/services.js electron/test/store.test.js src/shared/ipc.ts src/devCoder.ts test/support/fakeCoder.ts
git commit -m "feat: classify context overflow failures"
```

Otherwise leave the tested changes uncommitted.

### Task 2: Normalize Every Provider Failure Through the Shared Runner Path

**Files:**
- Modify: `electron/runner.js:74-78, 2373-2418, 2661-2666, 2852-2878, 3013-3016, 3488-3495, 3558-3585, 4070-4096, 4469-4498, 4860-4889, 5269-5299, 5719-5722`
- Modify: `electron/test/runner.test.js:63-72, 1123-1162`

**Interfaces:**
- Consumes: `classifyContextOverflow(text)` from Task 1.
- Produces: private
  `markRunFailed(threadId, errText, runId, extraPatch?) -> { parked, until?, text, kind }`.
- Produces: provider events and `ThreadInfo.lastError` with identical normalized
  text for overflow.

- [ ] **Step 1: Add a fake overflow process and failing runner test**

Add beside the existing fake agent scripts:

```js
function fakeAgentContextOverflowScript() {
  return "process.stderr.write('context_length_exceeded\\nrequest had 250000 tokens');process.exit(1)";
}
```

Add this test after the generic nonzero-exit test:

```js
it("classifies context overflow and records one targeted recovery event", async () => {
  process.env.CODER_AGENT_CMD =
    `${process.execPath} -e ${fakeAgentContextOverflowScript()}`;
  const thread = store.getThreads()[0];
  const { runId } = await runner.startRun({
    threadId: thread.id,
    prompt: "overflow please",
  });

  await waitFor(() => store.getThread(thread.id).status === "failed");
  const failed = store.getThread(thread.id);
  assert.equal(failed.lastErrorKind, "context-overflow");
  assert.match(failed.lastError, /^Context window is full\./);

  const events = store
    .getMessages(thread.id)
    .filter((m) => m.role === "event" && m.runId === runId);
  assert.equal(events.length, 1);
  assert.match(events[0].text, /^Context window is full\./);
  assert.match(events[0].text, /context_length_exceeded/);
});
```

Extend the existing generic nonzero-exit test with:

```js
assert.equal(detail.thread.lastErrorKind, null);
```

- [ ] **Step 2: Run the focused runner tests and confirm failure**

Run:

```bash
node --test electron/test/runner.test.js
```

Expected: the overflow assertion fails because the runner still stores a
generic `Run error` with no semantic kind.

- [ ] **Step 3: Import classification and centralize event recording**

Extend the quota import in `electron/runner.js`:

```js
const {
  classifyContextOverflow,
  decideQuotaWait,
  formatQuotaWaitClock,
  quotaWaitEnabled,
} = require("./quotaWait.js");
```

Replace `markRunFailed` with:

```js
/**
 * Record one provider failure event, then park quota failures or mark failed.
 * @param {string} threadId
 * @param {string} errText
 * @param {string | null | undefined} runId
 * @param {object} [extraPatch]
 * @returns {{
 *   parked: boolean,
 *   until?: number,
 *   text: string,
 *   kind: "context-overflow" | null
 * }}
 */
function markRunFailed(threadId, errText, runId, extraPatch) {
  const overflow = classifyContextOverflow(errText);
  const text = overflow ? overflow.text : errText;
  const kind = overflow ? overflow.kind : null;
  const park = overflow
    ? null
    : decideQuotaWait({
        text: errText,
        thread: store.getThread(threadId),
        settings: store.getSettings(),
      });

  if (park) {
    store.updateThread(
      threadId,
      {
        ...(extraPatch || {}),
        status: "quota-wait",
        runStartedAt: null,
        lastError: shortError(text),
        lastErrorKind: null,
        quotaWaitUntil: park.until,
      },
      { touch: true },
    );
    appendMessage(threadId, "event", text, runId);
    appendMessage(
      threadId,
      "event",
      `Quota wait: usage limit reached. Resuming at ${formatQuotaWaitClock(park.until)}.`,
    );
    scheduleQuotaWake(threadId, park.until);
    return { parked: true, until: park.until, text, kind: null };
  }

  store.updateThread(
    threadId,
    {
      ...(extraPatch || {}),
      status: "failed",
      runStartedAt: null,
      lastError: shortError(text),
      lastErrorKind: kind,
    },
    { touch: true },
  );
  appendMessage(threadId, "event", text, runId);
  return { parked: false, text, kind };
}
```

- [ ] **Step 4: Move all provider event writes into `markRunFailed`**

At every listed call site, remove the adjacent provider-error
`appendMessage(threadId, "event", ..., runId)` and pass `runId` as the third
argument. Use the returned normalized text wherever the terminal notification
or local terminal variable exposes the failure.

The no-extra-patch shape is:

```js
const failure = markRunFailed(threadId, errText, runId);
appendDoneWorkLog(threadId, runId, "Run error");
// Existing save/push calls remain in their current order.
notifyRunTerminal(threadId, "failed", failure.text, {
  tokensIn: runUsage.tokensIn,
  tokensOut: runUsage.tokensOut,
  costUsd: runUsage.costUsd,
});
```

The Claude session-capture shape is:

```js
const failure = markRunFailed(threadId, failText, runId, {
  sessionId: classified.sessionLost ? null : capturedSessionId,
});
terminalStatus = "failed";
terminalText = failure.text;
```

The empty-phantom shape is:

```js
markRunFailed(threadId, failText, runId, {
  sessionId: capturedSessionId,
});
```

Apply those exact shapes to these existing failure branches:

- simulator tick exception
- generic agent exit and `onError`
- empty Claude phantom
- Claude result error, process exit, and `onError`
- Codex process exit and `onError`
- Kimi process exit and `onError`
- OpenCode process exit and `onError`
- Cursor process exit and `onError`
- Ask-mode rejection

Do not move work-log completion, save, push, OTel, or terminal-notification
calls across their existing branch boundaries.

- [ ] **Step 5: Run backend failure and quota regressions**

Run:

```bash
node --test electron/test/quota-wait.test.js electron/test/store.test.js electron/test/runner.test.js electron/test/claude-result-error.test.js
```

Expected: PASS. The new overflow case has one normalized run event; existing
generic errors and quota parking still pass.

- [ ] **Step 6: Run the complete Electron suite**

Run:

```bash
npm run test:electron
```

Expected: PASS with no provider adapter regression.

- [ ] **Step 7: Commit shared runner normalization if authorized**

If commits were explicitly authorized:

```bash
git add electron/runner.js electron/test/runner.test.js
git commit -m "fix: surface context overflow recovery"
```

Otherwise leave the tested changes uncommitted.

### Task 3: Wire Fresh-Context Recovery into `/compact`, the Ring, and Failed Events

**Files:**
- Modify: `src/slashCommands.ts:40-46`
- Modify: `src/components/ThreadView.tsx:208-301, 1117-1209, 4287-4351, 4437-4471, 5152-5159, 5674-5712`
- Modify: `src/components/ThreadView.module.css:1562-1584, 2008-2063`
- Modify: `test/composerSlashActions.test.tsx:79-124, 146-173`
- Modify: `test/retryTurnWiring.test.tsx:60-99, 193-252`

**Interfaces:**
- Consumes: `ThreadInfo.lastErrorKind` from Task 1.
- Consumes: existing `ThreadViewProps.onFork()`.
- Produces: one `handleForkFresh()` callback shared by `/compact`, `/fork`,
  warning recovery, and overflow recovery.
- Produces: `ContextRingBadge.onFork?: () => void`.

- [ ] **Step 1: Replace the placebo `/compact` test with a failing fork test**

Replace the old `/compact` case in `test/composerSlashActions.test.tsx`:

```tsx
it("/compact forks to fresh context instead of opening usage", async () => {
  const forks: number[] = [];
  const m = await mountView({ onFork: () => forks.push(1) });
  await acceptSlash(m, "/compact");
  assert.deepEqual(forks, [1]);
  assert.equal(m.query("[data-context-popover]"), null);
  assert.equal(textarea(m).value, "");
});
```

Add warning-action coverage:

```tsx
it("warn context offers a one-click fresh-context fork", async () => {
  const forks: number[] = [];
  const warned = detail({
    usage: { ...USAGE, contextTokens: 180_000 },
  });
  const m = await mountView({
    detail: warned,
    onFork: () => forks.push(1),
  });
  await acceptSlash(m, "/usage");
  const action = m.query("[data-context-fork]");
  assert.ok(action);
  await m.click(action as HTMLElement);
  assert.deepEqual(forks, [1]);
  assert.equal(m.query("[data-context-popover]"), null);
});

it("does not offer context fork below warn or while working", async () => {
  const below = await mountView({
    detail: detail({ usage: USAGE }),
    onFork: () => {},
  });
  await acceptSlash(below, "/usage");
  assert.equal(below.query("[data-context-fork]"), null);
  below.unmount();

  const noFork = await mountView({
    detail: detail({
      usage: { ...USAGE, contextTokens: 180_000 },
    }),
  });
  await acceptSlash(noFork, "/usage");
  assert.equal(noFork.query("[data-context-fork]"), null);
  noFork.unmount();

  const working = await mountView({
    detail: detail({
      thread: thread({ status: "working" }),
      usage: { ...USAGE, contextTokens: 180_000 },
    }),
    onFork: () => {},
  });
  await acceptSlash(working, "/usage");
  assert.equal(working.query("[data-context-fork]"), null);
});

it("/compact is inert while the thread is working", async () => {
  const forks: number[] = [];
  const m = await mountView({
    detail: detail({ thread: thread({ status: "working" }) }),
    onFork: () => forks.push(1),
  });
  await acceptSlash(m, "/compact");
  assert.deepEqual(forks, []);
});
```

- [ ] **Step 2: Add a failing App-level overflow recovery test**

Add this fixture to `test/retryTurnWiring.test.tsx`:

```tsx
function overflowTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-context-overflow",
    title: "context overflow target",
    status: "failed",
    lastError: "Context window is full.",
    lastErrorKind: "context-overflow",
    updatedAt: NOW + 2500,
  });
  return {
    row,
    d: detail({
      thread: row,
      messages: [
        msg({ id: "m-ou", role: "user", text: "large prompt" }),
        msg({
          id: "m-oe",
          role: "event",
          text: "Context window is full. Fork to fresh context or rewind the last turn.",
        }),
      ],
    }),
  };
}
```

Add this test:

```tsx
it("context overflow offers Fork to fresh context instead of retry", async () => {
  const decoyRow = decoy();
  const { row, d } = overflowTarget();
  const fake = createFakeCoder({
    projects: [project()],
    threads: [decoyRow, row],
    details: {
      "t-decoy": detail({ thread: decoyRow }),
      "t-context-overflow": d,
    },
  });
  const m = await boot(fake);
  await selectThread(m, "context overflow target");

  assert.equal(retryButtons(m).length, 0);
  const fork = m
    .queryAll("button")
    .find((button) => button.textContent?.trim() === "Fork to fresh context");
  assert.ok(fork);

  const runsBefore = fake.of("runs.start").length;
  await m.click(fork);
  await m.flush();
  assert.equal(fake.of("runs.start").length, runsBefore);
  const forks = fake.of("threads.fork");
  assert.equal(forks.length, 1);
  assert.deepEqual(forks[0].args[0], { threadId: "t-context-overflow" });
  m.unmount();
});
```

- [ ] **Step 3: Run the focused renderer tests and confirm they fail**

Run:

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/composerSlashActions.test.tsx test/retryTurnWiring.test.tsx
```

Expected: `/compact` opens usage, the warn action is absent, and overflow still
renders `Retry turn`.

- [ ] **Step 4: Make `/compact` copy honest**

Change the command hint in `src/slashCommands.ts`:

```ts
{
  name: "/compact",
  hint: "Fork to fresh context with recent history",
  kind: "run",
  action: "compact",
},
```

- [ ] **Step 5: Add the warning-popover fork action**

Extend `ContextRingBadge` with:

```ts
onFork?: () => void;
```

Replace the warning paragraph with:

```tsx
{ring.warn && (
  <div className={styles.contextWarn}>
    <p className={styles.contextWarnNote}>Compaction is close</p>
    {onFork && (
      <button
        type="button"
        className={styles.contextForkBtn}
        data-context-fork=""
        onClick={() => {
          onOpenChange(false);
          onFork();
        }}
      >
        Fork to fresh context
      </button>
    )}
  </div>
)}
```

Add these styles after `.contextWarnNote`:

```css
.contextWarn {
  display: grid;
  gap: 8px;
}

.contextForkBtn {
  width: 100%;
  padding: 5px 9px;
  border: 1px solid var(--amber-border);
  border-radius: var(--radius-sm);
  background: var(--amber-soft);
  color: var(--amber);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.contextForkBtn:hover {
  background: var(--card-hover);
}
```

- [ ] **Step 6: Share one guarded fork callback across slash and ring actions**

Add this callback after the context-ring memo in `ThreadView`:

```ts
const handleForkFresh = useCallback(() => {
  if (isWorking || !onFork) return;
  void onFork();
}, [isWorking, onFork]);
```

Split the slash action behavior so `/usage` remains a popover action and
`/compact` becomes a fork:

```ts
if (action === "usage") {
  if (ring) setContextOpen(true);
  return;
}
if (action === "compact" || action === "fork") {
  handleForkFresh();
  return;
}
```

Update the callback dependency list to include `handleForkFresh` and remove
the direct `onFork` dependency if it is no longer read there.

Pass the callback to the ring only when recovery is available:

```tsx
<ContextRingBadge
  ring={ring.view}
  segments={ring.segments}
  used={ring.used}
  open={contextOpen}
  onOpenChange={setContextOpen}
  onFork={onFork && !isWorking ? handleForkFresh : undefined}
/>
```

- [ ] **Step 7: Generalize the event action and select fork for overflow**

Replace the retry-specific `MessageBlock` action props with:

```ts
eventActionLabel?: string;
eventActionTitle?: string;
onEventAction?: () => void;
```

Render them in the event block:

```tsx
{eventActionLabel && onEventAction && (
  <button
    type="button"
    className={styles.retryBtn}
    title={eventActionTitle}
    onClick={onEventAction}
  >
    {eventActionLabel}
  </button>
)}
```

Compute the overflow event independently from retry's last-user requirement:

```ts
const overflowEventId = useMemo(() => {
  if (
    !detail ||
    detail.thread.status !== "failed" ||
    detail.thread.lastErrorKind !== "context-overflow"
  ) {
    return null;
  }
  const last = detail.messages[detail.messages.length - 1];
  return last?.role === "event" ? last.id : null;
}, [detail]);
```

Inside the timeline map, derive mutually exclusive surfaces:

```ts
const isOverflowSurface =
  entry.message.role === "event" &&
  overflowEventId != null &&
  entry.message.id === overflowEventId;
const isRetrySurface =
  !isOverflowSurface &&
  entry.message.role === "event" &&
  retryEventId != null &&
  entry.message.id === retryEventId;
```

Pass the action:

```tsx
eventActionLabel={
  isOverflowSurface
    ? "Fork to fresh context"
    : isRetrySurface
      ? "Retry turn"
      : undefined
}
eventActionTitle={
  isOverflowSurface
    ? "Fork this thread with recent history in a fresh context"
    : isRetrySurface
      ? retryTitle
      : undefined
}
onEventAction={
  isOverflowSurface
    ? handleForkFresh
    : isRetrySurface
      ? handleRetry
      : undefined
}
```

Keep the existing `.retryBtn` class for both compact event-card actions; it is
neutral action chrome despite its historical name.

- [ ] **Step 8: Run focused renderer tests**

Run:

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/composerSlashActions.test.tsx test/retryTurnWiring.test.tsx test/contextRing.test.ts
```

Expected: PASS. `/compact`, warning recovery, and overflow recovery each fork;
ordinary failures still retry.

- [ ] **Step 9: Run complete verification**

Run:

```bash
npm run typecheck && npm run test:renderer && npm run test:electron
```

Expected: all commands PASS.

- [ ] **Step 10: Update the review itinerary**

Rewrite
`.solenta/review-itinerary/e0b22f37-5dad-4cd7-a4b3-472c6c1558d7.json`
with read order `tests`, `critical`, `impl`, `docs`. Annotate:

- classifier precision and overlap risks
- store migration/clearing semantics
- centralized runner event ordering
- the three renderer fork entry points
- the design and implementation-plan documents

- [ ] **Step 11: Commit renderer recovery if authorized**

If commits were explicitly authorized:

```bash
git add src/slashCommands.ts src/components/ThreadView.tsx src/components/ThreadView.module.css test/composerSlashActions.test.tsx test/retryTurnWiring.test.tsx .solenta/review-itinerary/e0b22f37-5dad-4cd7-a4b3-472c6c1558d7.json docs/superpowers/specs/2026-08-25-context-recovery-design.md docs/superpowers/plans/2026-08-25-context-recovery.md
git commit -m "feat: add fresh-context recovery actions"
```

Otherwise leave the verified implementation and documentation uncommitted.
