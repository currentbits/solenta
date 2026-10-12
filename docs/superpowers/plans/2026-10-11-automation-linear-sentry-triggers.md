# Linear and Sentry automation triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automations can fire on Linear issue created/status changed and on a new Sentry grouped issue, using the existing 60s poller.

**Architecture:** Extend `electron/automation-triggers.js` with two more `fetchSource`/`matchRows` branches. Linear reuses `electron/linear.js` GraphQL. Sentry is one GET in a new `electron/sentry.js`. Cursor, baseline, batching, and the failure breaker stay as GitHub left them. No relay, no tunnel.

**Tech Stack:** Electron main (CommonJS, `node:test`), React renderer (TypeScript, `node:test` + `test/support/dom.ts`). Linear GraphQL. Sentry REST. No new npm dependencies.

Spec: `docs/superpowers/specs/2026-10-11-automation-linear-sentry-triggers-design.md` (issue #1588).

## Global Constraints

- Poll, do not relay. No Girder app, no tunnel, no public URL.
- Sentry means a new grouped issue keyed on `firstSeen`, not a numeric spike.
- Generic inbound webhooks are out of scope.
- Host is `sentry.io` only. No `sentryHost` setting.
- Do not paginate. First page of 50, same ceiling as GitHub.
- Poll errors use `Linear trigger: ` / `Sentry trigger: ` and never increment `consecutiveFailures`.
- Creating a Linear issue must not fire `linear_status_changed` (skip the birth span).
- `type` is derived from `event`. Do not trust `raw.type`.
- No new npm dependencies.
- Run electron tests with inherited env removed: `env -u CODER_GUARDRAILS_PATH`.
- Do not change the GitHub poller, cursor rules, or the 60s tick except to share the cursor/fire tail and to generalize `formatTriggerNote`'s title string.

## File map

| File | Responsibility |
| --- | --- |
| `src/shared/ipc.ts` | Trigger event union, trigger fields, `sentryAuthToken` on settings |
| `src/automations.ts` | When-picker labels, `triggerLabel`, `createFormError` Sentry checks |
| `electron/automation-triggers.js` | normalize/parse, matchRows, formatTriggerNote, pollTriggers branches |
| `electron/linear.js` | Shared `postGraphql`, created/status list queries |
| `electron/sentry.js` | Token resolve + one issues GET |
| `electron/secrets.js` | Seal/reveal `sentryAuthToken` |
| `electron/store-normalize.js` | Default and load `sentryAuthToken` |
| `electron/store-settings-methods.js` | get/set `sentryAuthToken` |
| `src/components/settings/GitPane.tsx` | Sentry key field |
| `src/components/SettingsModal.tsx` | Draft/save for the Sentry key |
| `src/components/AutomationsView.tsx` | When optgroups and filter fields |

---

### Task 1: Types, normalize/parse, labels

**Files:**
- Modify: `src/shared/ipc.ts` (`AutomationTriggerEvent`, `AutomationTrigger` around 2883–2902; `AppSettings` after `linearApiKey` around 3190)
- Modify: `electron/automation-triggers.js` (`TRIGGER_EVENTS`, `normalizeTrigger`, `parseTriggerInput`)
- Modify: `src/automations.ts` (`TRIGGER_EVENT_LABELS`, `triggerLabel`, `createFormError`)
- Test: `electron/test/automation-triggers.test.js`
- Test: `test/automations.test.ts`

**Interfaces:**
- Consumes: existing GitHub trigger shape
- Produces: `normalizeTrigger(raw) → AutomationTrigger | null` with `type` derived from `event` and unused filters nulled. `parseTriggerInput(raw)` throws `Sentry trigger requires org and project` when `sentry_issue` is missing either. `triggerLabel` strings exactly as in the spec. `createFormError` accepts optional `event`, `org`, `project`.

- [ ] **Step 1: Write the failing tests.** In `electron/test/automation-triggers.test.js`, extend the existing `normalizeTrigger / matchRows` describe. Import `parseTriggerInput` next to `normalizeTrigger`.

```js
const { matchRows, normalizeTrigger, parseTriggerInput } = require("../automation-triggers.js");

it("normalizes Linear and Sentry events and drops filters that do not apply", () => {
  assert.deepEqual(
    normalizeTrigger({
      event: "linear_issue_created",
      team: "eng",
      status: "Done",
      org: "acme",
      branch: "main",
    }),
    {
      type: "linear",
      event: "linear_issue_created",
      branch: null,
      label: null,
      conclusion: null,
      team: "eng",
      status: null,
      org: null,
      project: null,
      environment: null,
    },
  );
  assert.deepEqual(
    normalizeTrigger({
      event: "linear_status_changed",
      team: "ENG",
      status: "Done",
    }),
    {
      type: "linear",
      event: "linear_status_changed",
      branch: null,
      label: null,
      conclusion: null,
      team: "ENG",
      status: "Done",
      org: null,
      project: null,
      environment: null,
    },
  );
  assert.deepEqual(
    normalizeTrigger({
      event: "sentry_issue",
      org: "acme",
      project: "pump",
      environment: "prod",
      team: "ENG",
    }),
    {
      type: "sentry",
      event: "sentry_issue",
      branch: null,
      label: null,
      conclusion: null,
      team: null,
      status: null,
      org: "acme",
      project: "pump",
      environment: "prod",
    },
  );
  assert.equal(normalizeTrigger({ event: "pr_opened" }).type, "github");
  assert.equal(normalizeTrigger({ event: "nope" }), null);
});

it("parseTriggerInput rejects sentry_issue without org or project", () => {
  assert.throws(
    () => parseTriggerInput({ event: "sentry_issue", org: "acme" }),
    /Sentry trigger requires org and project/,
  );
  assert.throws(
    () => parseTriggerInput({ event: "sentry_issue", project: "pump" }),
    /Sentry trigger requires org and project/,
  );
  assert.deepEqual(
    parseTriggerInput({ event: "sentry_issue", org: "acme", project: "pump" }).event,
    "sentry_issue",
  );
});
```

In `test/automations.test.ts`, add imports and a describe:

```ts
import {
  automationRunDisplayStatus,
  automationRunStatusLabel,
  createFormError,
  triggerLabel,
} from "../src/automations";

describe("triggerLabel / createFormError (#1588)", () => {
  it("labels Linear and Sentry triggers", () => {
    assert.equal(
      triggerLabel({ type: "linear", event: "linear_issue_created" }),
      "on Linear issue created",
    );
    assert.equal(
      triggerLabel({ type: "linear", event: "linear_issue_created", team: "ENG" }),
      "on Linear issue created in ENG",
    );
    assert.equal(
      triggerLabel({ type: "linear", event: "linear_status_changed" }),
      "on Linear status changed",
    );
    assert.equal(
      triggerLabel({
        type: "linear",
        event: "linear_status_changed",
        status: "Done",
        team: "ENG",
      }),
      "on Linear status changed to Done in ENG",
    );
    assert.equal(
      triggerLabel({ type: "sentry", event: "sentry_issue", org: "acme", project: "pump" }),
      "on Sentry issue acme/pump",
    );
    assert.equal(
      triggerLabel({
        type: "sentry",
        event: "sentry_issue",
        org: "acme",
        project: "pump",
        environment: "prod",
      }),
      "on Sentry issue acme/pump (prod)",
    );
  });

  it("requires Sentry org and project", () => {
    const base = {
      name: "n",
      projectId: "p",
      prompt: "go",
      provider: "claude",
      preset: "hourly" as const,
      hour: "",
    };
    assert.equal(createFormError({ ...base, event: "sentry_issue", org: "", project: "pump" }), "Sentry org is required");
    assert.equal(createFormError({ ...base, event: "sentry_issue", org: "acme", project: "" }), "Sentry project is required");
    assert.equal(createFormError({ ...base, event: "sentry_issue", org: "acme", project: "pump" }), null);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

```bash
env -u CODER_GUARDRAILS_PATH node --test electron/test/automation-triggers.test.js
```

Expected: FAIL (`parseTriggerInput` not exported and/or Linear events normalize to `null`).

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/automations.test.ts
```

Expected: FAIL (`linear_issue_created` is not a `TRIGGER_EVENT_LABELS` key).

- [ ] **Step 3: Implement types.** In `src/shared/ipc.ts`, replace the trigger types:

```ts
export type AutomationTriggerEvent =
  | "pr_opened"
  | "pr_merged"
  | "pr_labeled"
  | "review_submitted"
  | "push"
  | "ci_completed"
  | "linear_issue_created"
  | "linear_status_changed"
  | "sentry_issue";

export interface AutomationTrigger {
  type: "github" | "linear" | "sentry";
  event: AutomationTriggerEvent;
  branch?: string | null;
  label?: string | null;
  conclusion?: "success" | "failure" | "cancelled" | "timed_out" | null;
  team?: string | null;
  status?: string | null;
  org?: string | null;
  project?: string | null;
  environment?: string | null;
}
```

On `AppSettings`, after `linearApiKey`:

```ts
  sentryAuthToken?: string | null;
```

- [ ] **Step 4: Implement normalize/parse.** In `electron/automation-triggers.js`, replace the event set and the two functions:

```js
const GITHUB_EVENTS = new Set([
  "pr_opened",
  "pr_merged",
  "pr_labeled",
  "review_submitted",
  "push",
  "ci_completed",
]);
const LINEAR_EVENTS = new Set(["linear_issue_created", "linear_status_changed"]);
const SENTRY_EVENTS = new Set(["sentry_issue"]);
const TRIGGER_EVENTS = new Set([...GITHUB_EVENTS, ...LINEAR_EVENTS, ...SENTRY_EVENTS]);

function typeForEvent(event) {
  if (LINEAR_EVENTS.has(event)) return "linear";
  if (SENTRY_EVENTS.has(event)) return "sentry";
  return "github";
}

function normalizeTrigger(raw) {
  if (!raw || typeof raw !== "object") return null;
  const t = /** @type {Record<string, unknown>} */ (raw);
  const event = String(t.event || "");
  if (!TRIGGER_EVENTS.has(event)) return null;
  const type = typeForEvent(event);
  const str = (v) => {
    const s = v == null ? "" : String(v).trim();
    return s || null;
  };
  const conclusion = str(t.conclusion);
  return {
    type,
    event,
    branch: type === "github" && (event === "push" || event === "ci_completed") ? str(t.branch) : null,
    label: type === "github" && event === "pr_labeled" ? str(t.label) : null,
    conclusion:
      type === "github" && event === "ci_completed" && conclusion && CI_CONCLUSIONS.has(conclusion)
        ? conclusion
        : null,
    team: type === "linear" ? str(t.team) : null,
    status: event === "linear_status_changed" ? str(t.status) : null,
    org: type === "sentry" ? str(t.org) : null,
    project: type === "sentry" ? str(t.project) : null,
    environment: type === "sentry" ? str(t.environment) : null,
  };
}

function parseTriggerInput(raw) {
  if (raw == null) return null;
  const t = normalizeTrigger(raw);
  if (!t) {
    const ev = raw && typeof raw !== "object" ? raw : /** @type {any} */ (raw).event;
    throw new Error(`Unknown trigger event: ${ev || "(empty)"}`);
  }
  if (t.event === "sentry_issue" && (!t.org || !t.project)) {
    throw new Error("Sentry trigger requires org and project");
  }
  return t;
}
```

Export `TRIGGER_EVENTS` as today (now the union). Existing GitHub `normalizeTrigger` tests still pass: they assert a github object **without** the new null fields. Update those two existing asserts to include `team: null, status: null, org: null, project: null, environment: null` so `deepEqual` matches.

- [ ] **Step 5: Implement labels.** In `src/automations.ts`:

```ts
export const TRIGGER_EVENT_LABELS: Record<AutomationTriggerEvent, string> = {
  pr_opened: "PR opened",
  pr_merged: "PR merged",
  pr_labeled: "Label added",
  review_submitted: "Review submitted",
  push: "Push",
  ci_completed: "CI completed",
  linear_issue_created: "Linear issue created",
  linear_status_changed: "Linear status changed",
  sentry_issue: "Sentry issue",
};

export function triggerLabel(trigger: AutomationTrigger): string {
  let label = `on ${TRIGGER_EVENT_LABELS[trigger.event]}`;
  if (trigger.event === "linear_issue_created" && trigger.team) {
    return `${label} in ${trigger.team}`;
  }
  if (trigger.event === "linear_status_changed") {
    if (trigger.status) label += ` to ${trigger.status}`;
    if (trigger.team) label += ` in ${trigger.team}`;
    return label;
  }
  if (trigger.event === "sentry_issue" && trigger.org && trigger.project) {
    label += ` ${trigger.org}/${trigger.project}`;
    if (trigger.environment) label += ` (${trigger.environment})`;
    return label;
  }
  if (trigger.label) label += ` "${trigger.label}"`;
  if (trigger.conclusion) label += ` (${trigger.conclusion})`;
  if (trigger.branch) label += ` on ${trigger.branch}`;
  return label;
}

export function createFormError(input: {
  name: string;
  projectId: string;
  prompt: string;
  provider: string;
  preset: AutomationPreset;
  hour: string;
  event?: string;
  org?: string;
  project?: string;
}): string | null {
  if (!input.name.trim()) return "Name is required";
  if (!input.projectId) return "Project is required";
  if (!input.prompt.trim()) return "Prompt is required";
  if (!input.provider) return "Provider is required";
  if (input.event === "sentry_issue") {
    if (!String(input.org || "").trim()) return "Sentry org is required";
    if (!String(input.project || "").trim()) return "Sentry project is required";
  }
  if (input.preset === "daily" || input.preset === "weekly") {
    if (input.hour === "") return "Hour is required";
    const n = Number(input.hour);
    if (!Number.isInteger(n) || n < 0 || n > 23) {
      return "Hour must be an integer from 0 to 23";
    }
  }
  return null;
}
```

- [ ] **Step 6: Re-run the Task 1 tests.** Same two commands as Step 2. Expected: PASS. Existing GitHub normalize tests pass with the extra null fields.

- [ ] **Step 7: Commit.**

```bash
git add src/shared/ipc.ts src/automations.ts electron/automation-triggers.js electron/test/automation-triggers.test.js test/automations.test.ts
git commit -m "$(cat <<'EOF'
Add Linear and Sentry trigger types and labels (#1588).

EOF
)"
```

---

### Task 2: Linear GraphQL helper and list queries

**Files:**
- Modify: `electron/linear.js`
- Test: `electron/test/issues.test.js` (must stay green)
- Test: `electron/test/linear-triggers.test.js` (create)

**Interfaces:**
- Consumes: existing `postIssueQuery` auth/timeout/error behavior
- Produces: `postGraphql(apiKey, query, variables, opts) → Promise<unknown>`. `fetchTriggerIssues(source, opts)` where `source` is `"created" | "status"`. Returns `nodes` array. `opts.linearGraphql` short-circuits and must receive `{ apiKey, source, query, variables }`. Throws `no api key (Settings → Git)` when the key is missing. Exports `ISSUES_CREATED_QUERY`, `ISSUES_STATUS_QUERY`, `fetchTriggerIssues`, `postGraphql`.

- [ ] **Step 1: Write the failing test file** `electron/test/linear-triggers.test.js`:

```js
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  fetchTriggerIssues,
  ISSUES_CREATED_QUERY,
  ISSUES_STATUS_QUERY,
} = require("../linear.js");

describe("fetchTriggerIssues", () => {
  it("throws when the api key is missing", async () => {
    await assert.rejects(
      () => fetchTriggerIssues("created", { linearApiKey: "" }),
      /no api key \(Settings → Git\)/,
    );
  });

  it("posts the created query and returns nodes", async () => {
    const nodes = [{ identifier: "ENG-1", createdAt: "2026-10-11T00:00:00Z" }];
    const seen = [];
    const out = await fetchTriggerIssues("created", {
      linearApiKey: "k",
      linearGraphql: async (args) => {
        seen.push(args);
        return nodes;
      },
    });
    assert.deepEqual(out, nodes);
    assert.equal(seen[0].source, "created");
    assert.equal(seen[0].apiKey, "k");
    assert.match(seen[0].query, /TriggerIssuesCreated/);
    assert.deepEqual(seen[0].variables, { first: 50 });
  });

  it("posts the status query", async () => {
    const out = await fetchTriggerIssues("status", {
      linearApiKey: "k",
      linearGraphql: async ({ query }) => {
        assert.match(query, /TriggerIssuesStatus/);
        assert.match(query, /stateHistory/);
        return [];
      },
    });
    assert.deepEqual(out, []);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

```bash
env -u CODER_GUARDRAILS_PATH node --test electron/test/linear-triggers.test.js
```

Expected: FAIL (`fetchTriggerIssues` is not exported).

- [ ] **Step 3: Implement.** In `electron/linear.js`, rename the body of `postIssueQuery` into `postGraphql`. `postIssueQuery` becomes a one-line wrapper. Add the two queries and `fetchTriggerIssues`.

```js
const ISSUES_CREATED_QUERY = `query TriggerIssuesCreated($first: Int!) {
  issues(first: $first, orderBy: createdAt) {
    nodes {
      identifier
      title
      url
      createdAt
      team { key }
    }
  }
}`;

const ISSUES_STATUS_QUERY = `query TriggerIssuesStatus($first: Int!) {
  issues(first: $first, orderBy: updatedAt) {
    nodes {
      identifier
      title
      url
      createdAt
      team { key }
      stateHistory(last: 5) {
        nodes {
          startedAt
          state { name }
        }
      }
    }
  }
}`;

async function postGraphql(apiKey, query, variables, opts) {
  if (opts && typeof opts.linearGraphql === "function") {
    return opts.linearGraphql({ apiKey, query, variables });
  }
  const fetchFn = (opts && opts.fetch) || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("fetch is not available");
  }
  const timeoutMs =
    opts && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : LINEAR_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw === "" ? "{}" : raw);
    } catch {
      throw new Error("linear returned unparseable issue JSON");
    }
    if (res.status === 401 || res.status === 403) {
      const err = new Error("auth");
      err.code = "auth";
      throw err;
    }
    if (!res.ok) {
      throw new Error(
        linearErr(
          (json && json.errors && json.errors[0] && json.errors[0].message) || raw,
          `linear HTTP ${res.status}`,
        ),
      );
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function postIssueQuery(apiKey, identifier, opts) {
  if (opts && typeof opts.linearGraphql === "function") {
    return opts.linearGraphql({ apiKey, identifier });
  }
  return postGraphql(apiKey, ISSUE_QUERY, { id: identifier }, opts);
}

async function fetchTriggerIssues(source, opts) {
  const apiKey = resolveLinearApiKey(opts);
  if (!apiKey) throw new Error("no api key (Settings → Git)");
  const query = source === "status" ? ISSUES_STATUS_QUERY : ISSUES_CREATED_QUERY;
  const variables = { first: 50 };
  if (opts && typeof opts.linearGraphql === "function") {
    const out = await opts.linearGraphql({ apiKey, source, query, variables });
    return Array.isArray(out) ? out : [];
  }
  const payload = await postGraphql(apiKey, query, variables, opts);
  const errors = payload && Array.isArray(payload.errors) ? payload.errors : [];
  if (errors.length > 0) {
    throw new Error(
      linearErr(
        errors.map((e) => (e && e.message != null ? String(e.message) : "")).filter(Boolean).join("; "),
        "linear request failed",
      ),
    );
  }
  const nodes = payload && payload.data && payload.data.issues && payload.data.issues.nodes;
  return Array.isArray(nodes) ? nodes : [];
}
```

Keep `postIssueQuery`'s `linearGraphql({ apiKey, identifier })` contract so `electron/test/issues.test.js` stays green. Export the new symbols.

- [ ] **Step 4: Run Linear tests.**

```bash
env -u CODER_GUARDRAILS_PATH node --test electron/test/linear-triggers.test.js electron/test/issues.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add electron/linear.js electron/test/linear-triggers.test.js
git commit -m "$(cat <<'EOF'
Add Linear trigger issue list queries (#1588).

EOF
)"
```

---

### Task 3: matchRows and formatTriggerNote for Linear and Sentry

**Files:**
- Modify: `electron/automation-triggers.js` (`matchRows`, `formatTriggerNote`)
- Test: `electron/test/automation-triggers.test.js`

**Interfaces:**
- Consumes: Task 1 trigger shape. Linear created rows `{ identifier, title, url, createdAt, team?: { key } }`. Linear status rows add `stateHistory: { nodes: Array<{ startedAt, state?: { name } }> }`. Sentry rows `{ firstSeen, shortId, title, permalink }`.
- Produces: `matchRows(trigger, rows, remote?)` — `remote` is required only for GitHub. Linear/Sentry ignore it. `formatTriggerNote(title, items)` where `title` is the string after `[Trigger] ` and before ` (N new event…`.

- [ ] **Step 1: Write the failing tests.** Append to `electron/test/automation-triggers.test.js`:

```js
describe("Linear and Sentry matchRows (#1588)", () => {
  it("linear_issue_created keys on createdAt and filters team case-insensitively", () => {
    const rows = [
      { identifier: "ENG-3", title: "c", url: "u3", createdAt: "2026-10-11T03:00:00Z", team: { key: "ENG" } },
      { identifier: "DOC-1", title: "d", url: "u1", createdAt: "2026-10-11T02:00:00Z", team: { key: "DOC" } },
      { identifier: "eng-2", title: "b", url: "u2", createdAt: "2026-10-11T01:00:00Z", team: { key: "eng" } },
    ];
    const { all, matched } = matchRows(
      { event: "linear_issue_created", team: "eng" },
      rows,
    );
    assert.deepEqual(all, [
      "2026-10-11T03:00:00Z",
      "2026-10-11T02:00:00Z",
      "2026-10-11T01:00:00Z",
    ]);
    assert.deepEqual(matched.map((m) => m.key), ["2026-10-11T03:00:00Z", "2026-10-11T01:00:00Z"]);
    assert.match(matched[0].text, /^ENG-3 created: c \(u3\)$/);
  });

  it("linear_status_changed skips the birth span and filters status + team", () => {
    const rows = [
      {
        identifier: "ENG-9",
        title: "Fix login",
        url: "u9",
        createdAt: "2026-10-11T00:00:00Z",
        team: { key: "ENG" },
        stateHistory: {
          nodes: [
            { startedAt: "2026-10-11T00:00:00Z", state: { name: "Todo" } },
            { startedAt: "2026-10-11T04:00:00Z", state: { name: "Done" } },
          ],
        },
      },
      {
        identifier: "DOC-1",
        title: "docs",
        url: "ud",
        createdAt: "2026-10-11T00:00:00Z",
        team: { key: "DOC" },
        stateHistory: { nodes: [{ startedAt: "2026-10-11T05:00:00Z", state: { name: "Done" } }] },
      },
    ];
    const { all, matched } = matchRows(
      { event: "linear_status_changed", team: "eng", status: "done" },
      rows,
    );
    assert.ok(all.includes("2026-10-11T00:00:00Z"));
    assert.ok(all.includes("2026-10-11T04:00:00Z"));
    assert.deepEqual(matched.map((m) => m.key), ["2026-10-11T04:00:00Z"]);
    assert.equal(matched[0].text, "ENG-9 moved to Done: Fix login (u9)");
  });

  it("sentry_issue keys on firstSeen and skips rows without it", () => {
    const rows = [
      { firstSeen: "2026-10-11T06:00:00Z", shortId: "PUMP-1", title: "boom", permalink: "p1" },
      { title: "no date" },
    ];
    const { all, matched } = matchRows({ event: "sentry_issue" }, rows);
    assert.deepEqual(all, ["2026-10-11T06:00:00Z"]);
    assert.equal(matched[0].text, "PUMP-1 first seen: boom (p1)");
  });
});

describe("formatTriggerNote (#1588)", () => {
  const { formatTriggerNote } = require("../automation-triggers.js");
  it("uses the title string and the same 20-event cap", () => {
    const items = [{ text: "a" }, { text: "b" }];
    assert.equal(
      formatTriggerNote("Linear issue created", items),
      "[Trigger] Linear issue created (2 new events):\n- a\n- b",
    );
  });
});
```

- [ ] **Step 2: Run and confirm fail.**

```bash
env -u CODER_GUARDRAILS_PATH node --test electron/test/automation-triggers.test.js
```

Expected: FAIL (Linear events fall through the GitHub switch / `formatTriggerNote` still wants `(event, remote, items)`).

- [ ] **Step 3: Implement matchRows cases and formatTriggerNote.** In `matchRows`, after the GitHub switch cases (or as new cases in the same switch), handle the three events. GitHub `default` currently handles push/review — keep that as `default` and add explicit `case`s for Linear/Sentry **before** `default`.

```js
      case "linear_issue_created": {
        const key = typeof r.createdAt === "string" ? r.createdAt : "";
        if (!key) continue;
        all.push(key);
        const teamKey = r.team && r.team.key != null ? String(r.team.key) : "";
        if (trigger.team && teamKey.toLowerCase() !== trigger.team.toLowerCase()) continue;
        const id = r.identifier || "?";
        matched.push({
          key,
          text: `${id} created: ${r.title || ""} (${r.url || ""})`,
        });
        break;
      }
      case "linear_status_changed": {
        const createdAt = typeof r.createdAt === "string" ? r.createdAt : "";
        const spans = (r.stateHistory && Array.isArray(r.stateHistory.nodes)
          ? r.stateHistory.nodes
          : []);
        if (spans.length === 0) {
          if (createdAt) all.push(createdAt);
          break;
        }
        const teamKey = r.team && r.team.key != null ? String(r.team.key) : "";
        for (const span of spans) {
          const key = span && typeof span.startedAt === "string" ? span.startedAt : "";
          if (!key) continue;
          all.push(key);
          if (createdAt && !(key > createdAt)) continue;
          const name = span.state && span.state.name != null ? String(span.state.name) : "";
          if (trigger.status && name.toLowerCase() !== trigger.status.toLowerCase()) continue;
          if (trigger.team && teamKey.toLowerCase() !== trigger.team.toLowerCase()) continue;
          const id = r.identifier || "?";
          matched.push({
            key,
            text: `${id} moved to ${name || "?"}: ${r.title || ""} (${r.url || ""})`,
          });
        }
        break;
      }
      case "sentry_issue": {
        const key = typeof r.firstSeen === "string" ? r.firstSeen : "";
        if (!key) continue;
        all.push(key);
        matched.push({
          key,
          text: `${r.shortId || r.id || "?"} first seen: ${r.title || ""} (${r.permalink || ""})`,
        });
        break;
      }
```

Replace `formatTriggerNote`:

```js
function formatTriggerNote(title, items) {
  const shown = items.slice(-MAX_EVENTS_IN_PROMPT);
  const lines = [
    `[Trigger] ${title} (${items.length} new event${items.length === 1 ? "" : "s"}):`,
    ...shown.map((i) => `- ${i.text}`),
  ];
  if (items.length > shown.length) {
    lines.push(`(${items.length - shown.length} older events omitted)`);
  }
  return lines.join("\n");
}
```

Update the GitHub `pollTriggers` call site from `formatTriggerNote(trigger.event, remote, fresh)` to `formatTriggerNote(\`GitHub ${trigger.event} on ${remote.owner}/${remote.repo}\`, fresh)` so existing poller tests keep matching `\[Trigger\] GitHub pr_opened on acme/app`.

- [ ] **Step 4: Re-run** `env -u CODER_GUARDRAILS_PATH node --test electron/test/automation-triggers.test.js`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add electron/automation-triggers.js electron/test/automation-triggers.test.js
git commit -m "$(cat <<'EOF'
Match Linear and Sentry automation trigger rows (#1588).

EOF
)"
```

---

### Task 4: Sentry client

**Files:**
- Create: `electron/sentry.js`
- Test: `electron/test/sentry.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks except the URL/query rules in the spec
- Produces: `resolveSentryAuthToken(opts) → string` (settings `sentryAuthToken`, then `SENTRY_AUTH_TOKEN`). `fetchProjectIssues({ org, project, environment, token, fetch, sentryIssues }) → Promise<any[]>`. Throws `no auth token (Settings → Git)` when token is empty. Throws `auth` (Error with `code: "auth"`) on 401/403.

- [ ] **Step 1: Write** `electron/test/sentry.test.js`:

```js
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolveSentryAuthToken, fetchProjectIssues } = require("../sentry.js");

describe("resolveSentryAuthToken", () => {
  it("prefers opts, then SENTRY_AUTH_TOKEN", () => {
    const prev = process.env.SENTRY_AUTH_TOKEN;
    process.env.SENTRY_AUTH_TOKEN = "env_tok";
    try {
      assert.equal(resolveSentryAuthToken({ sentryAuthToken: " set " }), "set");
      assert.equal(resolveSentryAuthToken({}), "env_tok");
    } finally {
      if (prev == null) delete process.env.SENTRY_AUTH_TOKEN;
      else process.env.SENTRY_AUTH_TOKEN = prev;
    }
  });
});

describe("fetchProjectIssues", () => {
  it("throws when the token is missing", async () => {
    await assert.rejects(
      () => fetchProjectIssues({ org: "acme", project: "pump", token: "" }),
      /no auth token \(Settings → Git\)/,
    );
  });

  it("GETs sentry.io with sort=new and optional environment", async () => {
    const seen = [];
    const rows = [{ firstSeen: "2026-10-11T00:00:00Z", shortId: "P-1" }];
    const out = await fetchProjectIssues({
      org: "acme",
      project: "pump",
      environment: "prod",
      token: "tok",
      fetch: async (url, init) => {
        seen.push({ url: String(url), init });
        return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
      },
    });
    assert.deepEqual(out, rows);
    assert.match(seen[0].url, /^https:\/\/sentry\.io\/api\/0\/projects\/acme\/pump\/issues\/\?/);
    assert.match(seen[0].url, /sort=new/);
    assert.match(seen[0].url, /limit=50/);
    assert.match(seen[0].url, /statsPeriod=/);
    assert.match(decodeURIComponent(seen[0].url), /is:unresolved environment:prod/);
    assert.equal(seen[0].init.headers.Authorization, "Bearer tok");
  });

  it("maps 401 to auth", async () => {
    await assert.rejects(
      () =>
        fetchProjectIssues({
          org: "a",
          project: "b",
          token: "t",
          fetch: async () => ({ ok: false, status: 401, text: async () => "" }),
        }),
      (err) => err && err.code === "auth",
    );
  });
});
```

- [ ] **Step 2: Run and confirm fail.**

```bash
env -u CODER_GUARDRAILS_PATH node --test electron/test/sentry.test.js
```

Expected: FAIL (cannot find module `../sentry.js`).

- [ ] **Step 3: Implement** `electron/sentry.js`:

```js
"use strict";

const SENTRY_TIMEOUT_MS = 30_000;

function resolveSentryAuthToken(opts) {
  const fromOpts =
    opts && opts.sentryAuthToken != null ? String(opts.sentryAuthToken).trim() : "";
  if (fromOpts) return fromOpts;
  const fromEnv =
    process.env.SENTRY_AUTH_TOKEN != null ? String(process.env.SENTRY_AUTH_TOKEN).trim() : "";
  return fromEnv;
}

async function fetchProjectIssues(input) {
  const org = String((input && input.org) || "").trim();
  const project = String((input && input.project) || "").trim();
  const environment = input && input.environment != null ? String(input.environment).trim() : "";
  const token = String((input && input.token) || "").trim();
  if (!token) throw new Error("no auth token (Settings → Git)");
  if (input && typeof input.sentryIssues === "function") {
    return input.sentryIssues({ org, project, environment, token });
  }
  const fetchFn = (input && input.fetch) || globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("fetch is not available");
  const query = environment ? `is:unresolved environment:${environment}` : "is:unresolved";
  const params = new URLSearchParams({
    sort: "new",
    limit: "50",
    statsPeriod: "",
    query,
  });
  const url = `https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?${params}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SENTRY_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (res.status === 401 || res.status === 403) {
      const err = new Error("auth");
      err.code = "auth";
      throw err;
    }
    if (!res.ok) throw new Error(`sentry HTTP ${res.status}`);
    let json;
    try {
      json = JSON.parse(raw === "" ? "[]" : raw);
    } catch {
      throw new Error("sentry returned unparseable issues JSON");
    }
    return Array.isArray(json) ? json : [];
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  resolveSentryAuthToken,
  fetchProjectIssues,
  SENTRY_TIMEOUT_MS,
};
```

- [ ] **Step 4: Re-run** `env -u CODER_GUARDRAILS_PATH node --test electron/test/sentry.test.js`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add electron/sentry.js electron/test/sentry.test.js
git commit -m "$(cat <<'EOF'
Add a Sentry issues poll client for automation triggers (#1588).

EOF
)"
```

---

### Task 5: pollTriggers Linear and Sentry branches

**Files:**
- Modify: `electron/automation-triggers.js` (`pollTriggers`, error prefixes)
- Test: `electron/test/automation-triggers.test.js`

**Interfaces:**
- Consumes: `fetchTriggerIssues` (Task 2), `fetchProjectIssues` / `resolveSentryAuthToken` (Task 4), `matchRows` / `formatTriggerNote` (Task 3)
- Produces: `triggerDeps.linearGraphql` and `triggerDeps.sentryIssues` short-circuit the network. Linear missing key → `Linear trigger: no api key (Settings → Git)`. Sentry missing token → `Sentry trigger: no auth token (Settings → Git)`. Successful poll clears only its own prefix. GitHub path unchanged besides the `formatTriggerNote` title from Task 3.

- [ ] **Step 1: Write the failing poller tests.** In `electron/test/automation-triggers.test.js`, add a describe that uses `startScheduler` like the GitHub tests. Store settings must include the keys when the happy path runs.

```js
describe("Linear and Sentry pollTriggers (#1588)", () => {
  it("baselines Linear created, then batches, and records a missing-key error without the breaker", async () => {
    const auto = services.addAutomation(store, {
      projectId: "p1",
      name: "Lin",
      prompt: "triage",
      provider: "claude",
      preset: "hourly",
      trigger: { event: "linear_issue_created" },
    });
    let nodes = [{ identifier: "ENG-1", title: "old", url: "u1", createdAt: "2026-10-11T01:00:00Z", team: { key: "ENG" } }];
    const started = [];
    const sched = startScheduler({
      store,
      runner: { startRun: async (input) => { started.push(input); return { runId: "r" }; } },
      intervalMs: 60 * 60 * 1000,
      triggerDeps: {
        linearGraphql: async () => nodes,
      },
    });
    store.setSettings({ linearApiKey: "k" });
    try {
      await sched.tick();
      assert.equal(started.length, 0);
      assert.equal(store.getAutomation(auto.id).triggerCursor, "2026-10-11T01:00:00Z");
      nodes = [
        { identifier: "ENG-3", title: "c", url: "u3", createdAt: "2026-10-11T03:00:00Z", team: { key: "ENG" } },
        { identifier: "ENG-2", title: "b", url: "u2", createdAt: "2026-10-11T02:00:00Z", team: { key: "ENG" } },
        nodes[0],
      ];
      await sched.tick();
      assert.equal(started.length, 1);
      assert.match(started[0].prompt, /\[Trigger\] Linear issue created \(2 new events\)/);
      assert.ok(started[0].prompt.indexOf("ENG-2") < started[0].prompt.indexOf("ENG-3"));
      assert.equal(store.getAutomation(auto.id).triggerCursor, "2026-10-11T03:00:00Z");
    } finally {
      sched.stop();
    }

    const missing = services.addAutomation(store, {
      projectId: "p1",
      name: "Lin2",
      prompt: "x",
      provider: "claude",
      preset: "hourly",
      trigger: { event: "linear_issue_created" },
    });
    store.setSettings({ linearApiKey: null });
    const prev = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    const errSched = startScheduler({
      store,
      runner: { startRun: async () => ({}) },
      intervalMs: 60 * 60 * 1000,
      triggerDeps: { linearGraphql: async () => { throw new Error("should not fetch"); } },
    });
    try {
      await errSched.tick();
    } finally {
      errSched.stop();
      if (prev != null) process.env.LINEAR_API_KEY = prev;
    }
    const after = store.getAutomation(missing.id);
    assert.match(after.lastError, /^Linear trigger: no api key/);
    assert.equal(after.consecutiveFailures, 0);
    assert.equal(after.enabled, true);
  });

  it("Sentry missing token is a poll error; happy path notes org/project", async () => {
    const auto = services.addAutomation(store, {
      projectId: "p1",
      name: "Sen",
      prompt: "fix",
      provider: "claude",
      preset: "hourly",
      trigger: { event: "sentry_issue", org: "acme", project: "pump" },
    });
    const errSched = startScheduler({
      store,
      runner: { startRun: async () => ({}) },
      intervalMs: 60 * 60 * 1000,
      triggerDeps: { sentryIssues: async () => [] },
    });
    try {
      await errSched.tick();
    } finally {
      errSched.stop();
    }
    assert.match(store.getAutomation(auto.id).lastError, /^Sentry trigger: no auth token/);
    assert.equal(store.getAutomation(auto.id).enabled, true);

    const prevSentry = process.env.SENTRY_AUTH_TOKEN;
    process.env.SENTRY_AUTH_TOKEN = "st";
    let rows = [{ firstSeen: "2026-10-11T01:00:00Z", shortId: "P-1", title: "old", permalink: "p" }];
    const started = [];
    const ok = startScheduler({
      store,
      runner: { startRun: async (input) => { started.push(input); return { runId: "r" }; } },
      intervalMs: 60 * 60 * 1000,
      triggerDeps: { sentryIssues: async () => rows },
    });
    try {
      await ok.tick();
      assert.equal(started.length, 0);
      rows = [
        { firstSeen: "2026-10-11T02:00:00Z", shortId: "P-2", title: "new", permalink: "p2" },
        rows[0],
      ];
      await ok.tick();
      assert.equal(started.length, 1);
      assert.match(started[0].prompt, /\[Trigger\] Sentry issue on acme\/pump \(1 new event\)/);
    } finally {
      ok.stop();
      if (prevSentry == null) delete process.env.SENTRY_AUTH_TOKEN;
      else process.env.SENTRY_AUTH_TOKEN = prevSentry;
    }
  });
});
```

Use `SENTRY_AUTH_TOKEN` for the happy path so this task does not depend on the settings field from Task 6. Restore the env var in `finally`. The successful poll must clear a `Sentry trigger: ` lastError left by the missing-token tick.

- [ ] **Step 2: Run and confirm fail.**

```bash
env -u CODER_GUARDRAILS_PATH node --test electron/test/automation-triggers.test.js
```

Expected: FAIL (Linear automations still go through `projectRemote` / GitHub fetch).

- [ ] **Step 3: Implement poller branches.** In `pollTriggers`:

```js
function pollErrorPrefix(type) {
  if (type === "linear") return "Linear trigger: ";
  if (type === "sentry") return "Sentry trigger: ";
  return POLL_ERROR;
}

async function loadRows(trigger, deps, store, cache) {
  if (trigger.type === "linear") {
    const linear = require("./linear.js");
    const settings = store.getSettings();
    const source = trigger.event === "linear_status_changed" ? "status" : "created";
    const cacheKey = `linear|${source}`;
    if (!cache.has(cacheKey)) {
      cache.set(
        cacheKey,
        linear.fetchTriggerIssues(source, {
          linearApiKey: settings && settings.linearApiKey,
          linearGraphql: deps.linearGraphql,
        }),
      );
    }
    return cache.get(cacheKey);
  }
  if (trigger.type === "sentry") {
    const sentry = require("./sentry.js");
    const settings = store.getSettings();
    const token = sentry.resolveSentryAuthToken({
      sentryAuthToken: settings && settings.sentryAuthToken,
    });
    const env = trigger.environment || "";
    const cacheKey = `sentry|${trigger.org}|${trigger.project}|${env}`;
    if (!cache.has(cacheKey)) {
      cache.set(
        cacheKey,
        sentry.fetchProjectIssues({
          org: trigger.org,
          project: trigger.project,
          environment: env,
          token,
          sentryIssues: deps.sentryIssues,
        }),
      );
    }
    return cache.get(cacheKey);
  }
  // existing GitHub fetch (unchanged), return rows
}
```

Keep the GitHub fetch inline or extract it into the `else` of `loadRows` using the existing `remoteFor` / `tokenFor` / `rest` / `sourceFor` / `fetchSource` / `cacheKey`. After rows:

```js
      const { all, matched } = matchRows(trigger, rows, remote || { host: "", owner: "", repo: "" });
      const prefix = pollErrorPrefix(trigger.type);
      if (auto.lastError && auto.lastError.startsWith(prefix)) {
        patchAutomation(ctx.store, auto.id, { lastError: null });
        ctx.store.save();
      }
```

For Linear/Sentry, `remote` is unused by `matchRows`. GitHub still computes `remote` first and throws `project origin is not a GitHub repo` as today.

`formatTriggerNote` titles:

- Linear created: `Linear issue created`
- Linear status: `Linear status changed`
- Sentry: `Sentry issue on ${trigger.org}/${trigger.project}`
- GitHub: `GitHub ${trigger.event} on ${remote.owner}/${remote.repo}`

Catch block uses `pollErrorPrefix(trigger.type)` instead of always `POLL_ERROR`.

Linear/Sentry still require `project.path` (same continue as today). They must **not** call `projectRemote`.

- [ ] **Step 4: Re-run** `env -u CODER_GUARDRAILS_PATH node --test electron/test/automation-triggers.test.js`. Expected: PASS, including the existing GitHub poller tests.

- [ ] **Step 5: Commit.**

```bash
git add electron/automation-triggers.js electron/test/automation-triggers.test.js
git commit -m "$(cat <<'EOF'
Poll Linear and Sentry automation triggers on the existing tick (#1588).

EOF
)"
```

---

### Task 6: Seal and store sentryAuthToken

**Files:**
- Modify: `electron/store-normalize.js` (default around 418; load next to `linearApiKey` around 580)
- Modify: `electron/store-settings-methods.js` (`getSettings` around 101; `setSettings` next to `linearApiKey` around 406)
- Modify: `electron/secrets.js` (conceal and reveal, copy the Linear key block)
- Test: `electron/test/secrets.test.js`
- Test: `electron/test/budget-spend.test.js` and `electron/test/auto-settle-settings.test.js` (exact settings objects)

**Interfaces:**
- Produces: `settings.sentryAuthToken` default `null`. Empty string on write clears. Conceal/reveal uses key `"sentryAuthToken"`.

- [ ] **Step 1: Write the failing secrets test** next to the Linear one in `electron/test/secrets.test.js`:

```js
  it("seals and reveals a Sentry auth token (#1588)", () => {
    const s = createSecrets({ safeStorage: fakeSafeStorage() });
    const sealed = s.concealSettings({ sentryAuthToken: "sntrys_secret" });
    assert.notEqual(sealed.sentryAuthToken, "sntrys_secret");
    assert.ok(s.isSealed(sealed.sentryAuthToken));
    const revealed = s.revealSettings(sealed);
    assert.equal(revealed.settings.sentryAuthToken, "sntrys_secret");
  });
```

- [ ] **Step 2: Run and confirm fail.**

```bash
env -u CODER_GUARDRAILS_PATH node --test electron/test/secrets.test.js
```

Expected: FAIL (`sealed.sentryAuthToken` still plaintext because conceal ignores it).

- [ ] **Step 3: Implement store + secrets.** Default in `store-normalize.js`: `sentryAuthToken: null` next to `linearApiKey: null`. Load:

```js
  const sentryTok = /** @type {{ sentryAuthToken?: unknown }} */ (obj).sentryAuthToken;
  if (typeof sentryTok === "string" && sentryTok.trim()) {
    settings.sentryAuthToken = sentryTok.trim();
  } else {
    settings.sentryAuthToken = null;
  }
```

`getSettings` returns `sentryAuthToken: n.sentryAuthToken`. `setSettings` copies the `linearApiKey` block, same validation, field name `sentryAuthToken`.

In `concealSettings`, after the Linear block, the same pattern for `sentryAuthToken`. Include `sentryAuthToken: nextSentryTok` in the returned object. Same in `revealSettings` with `open(..., { key: "sentryAuthToken" })`.

In `budget-spend.test.js` and `auto-settle-settings.test.js`, replace `linearApiKey: null` with `linearApiKey: null, sentryAuthToken: null` **only where that substring is part of a full settings snapshot**. If a line already gained `sentryAuthToken` from a previous replace, do not double it. Grep the two files for `linearApiKey` and fix each snapshot.

- [ ] **Step 4: Re-run.**

```bash
env -u CODER_GUARDRAILS_PATH node --test electron/test/secrets.test.js electron/test/budget-spend.test.js electron/test/auto-settle-settings.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add electron/store-normalize.js electron/store-settings-methods.js electron/secrets.js electron/test/secrets.test.js electron/test/budget-spend.test.js electron/test/auto-settle-settings.test.js
git commit -m "$(cat <<'EOF'
Store and seal the Sentry auth token next to Linear (#1588).

EOF
)"
```

---

### Task 7: Settings Git pane Sentry key

**Files:**
- Modify: `src/components/SettingsModal.tsx` (`SettingsDraftKey`, snapshot, dirty skip, `saveSentryKey`, Git pane props)
- Modify: `src/components/settings/GitPane.tsx`
- Test: `test/settingsModal.test.tsx`

**Interfaces:**
- Consumes: Task 6 `sentryAuthToken` on `AppSettings`
- Produces: Git pane field `data-sentry-auth-token` and button `data-sentry-auth-token-save`. Save patch is `{ sentryAuthToken }` only. Empty + Save clears.

- [ ] **Step 1: Write the failing test** after the Linear describe in `test/settingsModal.test.tsx`:

```ts
describe("SettingsModal Sentry auth token (issue #1588)", () => {
  it("saves the key from the Git pane without sending budget fields", async () => {
    const patches: Partial<AppSettings>[] = [];
    const m = await mount(
      modal({
        initialPane: "git",
        settings: {
          dailyBudgetUsd: null,
          autoSettleAfterDays: 3,
          sentryAuthToken: null,
        } as AppSettings,
        onSaveSettings: async (patch) => {
          patches.push(patch);
          return {
            dailyBudgetUsd: null,
            autoSettleAfterDays: 3,
            sentryAuthToken: patch.sentryAuthToken ?? null,
          } as AppSettings;
        },
      }),
    );
    const input = m.query("[data-sentry-auth-token]") as HTMLInputElement | null;
    assert.ok(input, "Sentry auth token field on Git pane");
    await m.type(input!, "sntrys_test");
    const save = m.query("[data-sentry-auth-token-save]");
    assert.ok(save, "Sentry save button");
    await m.click(save!);
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0], { sentryAuthToken: "sntrys_test" });
    m.unmount();
  });
});
```

- [ ] **Step 2: Run and confirm fail.**

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/settingsModal.test.tsx
```

Expected: FAIL (no `data-sentry-auth-token`). If the whole file is too slow, that command still works; do not skip.

- [ ] **Step 3: Implement UI.** Add `"sentry"` to `SettingsDraftKey`. Snapshot `sentry: settings?.sentryAuthToken ?? ""`. State `sentryKeyText` / `setSentryKeyText` next to Linear. Skip `"sentry"` in the same dirty-draft effect. `saveSentryKey` is a copy of `saveLinearKey` that writes `{ sentryAuthToken: sentryKeyText.trim() || null }`. Pass the new props into `GitPane`. Add `sentry` to the Git pane search keywords string next to `linear ticket api key`.

In `GitPane.tsx`, immediately under the Linear `</section>`, copy that section:

- heading `Sentry`
- `id="sentry-auth-token"`
- `data-sentry-auth-token=""` / `data-sentry-auth-token-save=""`
- placeholder `sntrys_…`
- note: `Used for Sentry automation triggers. Needs event:read. SENTRY_AUTH_TOKEN in the environment also works. Empty and Save key clears a stored key.`
- `dirtyDrafts.current.add("sentry")`
- Save calls `saveSentryKey`

- [ ] **Step 4: Re-run the settings modal test file.** Expected: PASS, including the Linear test.

- [ ] **Step 5: Commit.**

```bash
git add src/components/SettingsModal.tsx src/components/settings/GitPane.tsx test/settingsModal.test.tsx
git commit -m "$(cat <<'EOF'
Add a Sentry auth token field on the Git settings pane (#1588).

EOF
)"
```

---

### Task 8: Automations When picker

**Files:**
- Modify: `src/components/AutomationsView.tsx`
- Test: `test/automationsView.test.tsx`

**Interfaces:**
- Consumes: Task 1 labels and `createFormError`; Task 1 trigger shape
- Produces: When optgroups “Linear event (polled every minute)” and “Sentry event (polled every minute)”. Fields: `name="team"`, `name="status"`, `name="org"`, `name="project"`, `name="environment"` with the placeholders in the spec. Submit sends those on the trigger. Blank Sentry org/project shows the `createFormError` string and does not call `onCreate`.

- [ ] **Step 1: Write the failing tests** in `test/automationsView.test.tsx` after the GitHub event test:

```ts
  it("event triggers: Linear and Sentry fields (#1588)", async () => {
    const created: Array<Record<string, unknown>> = [];
    const m = await mount(
      <AutomationsView
        automations={[]}
        projects={[p1]}
        providers={providers}
        onCreate={(input) => {
          created.push(input as unknown as Record<string, unknown>);
        }}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    await m.change(m.query('[data-automation-create] [name="preset"]'), "linear_status_changed");
    await m.type(m.query('[data-automation-create] [name="name"]'), "Lin");
    await m.type(m.query('[data-automation-create] [name="prompt"]'), "triage");
    await m.type(m.query('[data-automation-create] [name="team"]'), "ENG");
    await m.type(m.query('[data-automation-create] [name="status"]'), "Done");
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].trigger, {
      type: "linear",
      event: "linear_status_changed",
      branch: null,
      label: null,
      conclusion: null,
      team: "ENG",
      status: "Done",
      org: null,
      project: null,
      environment: null,
    });

    await m.change(m.query('[data-automation-create] [name="preset"]'), "sentry_issue");
    await m.type(m.query('[data-automation-create] [name="name"]'), "Sen");
    await m.type(m.query('[data-automation-create] [name="prompt"]'), "fix");
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(created.length, 1, "blank Sentry org/project must not create");
    assert.match(m.text(), /Sentry org is required/);
    await m.type(m.query('[data-automation-create] [name="org"]'), "acme");
    await m.type(m.query('[data-automation-create] [name="project"]'), "pump");
    await m.type(m.query('[data-automation-create] [name="environment"]'), "prod");
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(created.length, 2);
    assert.deepEqual(created[1].trigger, {
      type: "sentry",
      event: "sentry_issue",
      branch: null,
      label: null,
      conclusion: null,
      team: null,
      status: null,
      org: "acme",
      project: "pump",
      environment: "prod",
    });
    m.unmount();
  });
```

Use the same `auto` / `p1` / `providers` / `mount` helpers the GitHub test uses. If `m.change` / `m.type` need the name field re-typed after the second event switch, type name/prompt again before the Sentry submit (the form may have kept “Lin”). The assertion that blank Sentry does not create is the important one.

- [ ] **Step 2: Run and confirm fail.**

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/automationsView.test.tsx
```

Expected: FAIL (`linear_status_changed` is not a When option, or the team field is missing).

- [ ] **Step 3: Implement the form.** In `AutomationsView.tsx`:

State: `team`, `status`, `org`, `project`, `environment` strings, filled from `auto.trigger` in `fillFrom`, cleared in `clearEdit`.

`trigger` object when `event` is set:

```ts
  const triggerType = isTriggerEvent(event)
    ? event.startsWith("linear_")
      ? "linear"
      : event === "sentry_issue"
        ? "sentry"
        : "github"
    : "github";
  const trigger: AutomationTrigger | null = event
    ? {
        type: triggerType,
        event,
        branch: branch.trim() || null,
        label: label.trim() || null,
        conclusion: (conclusion || null) as AutomationTrigger["conclusion"],
        team: team.trim() || null,
        status: status.trim() || null,
        org: org.trim() || null,
        project: project.trim() || null,
        environment: environment.trim() || null,
      }
    : null;
```

`createFormError({ ..., event, org, project })`.

When `<select>` optgroups, after GitHub:

```tsx
              <optgroup label="Linear event (polled every minute)">
                <option value="linear_issue_created">{TRIGGER_EVENT_LABELS.linear_issue_created}</option>
                <option value="linear_status_changed">{TRIGGER_EVENT_LABELS.linear_status_changed}</option>
              </optgroup>
              <optgroup label="Sentry event (polled every minute)">
                <option value="sentry_issue">{TRIGGER_EVENT_LABELS.sentry_issue}</option>
              </optgroup>
```

Conditional fields next to the existing Label/Branch/Result block:

- `event === "linear_issue_created" || event === "linear_status_changed"` → Team input `name="team"` placeholder `Any team`
- `event === "linear_status_changed"` → Status input `name="status"` placeholder `Any status`
- `event === "sentry_issue"` → Org `name="org"`, Project `name="project"`, Environment `name="environment"` placeholder `Any environment`

Existing GitHub event test must still pass (`created[0].trigger` now includes the extra nulls). Update that `deepEqual` to include `team: null, status: null, org: null, project: null, environment: null`.

- [ ] **Step 4: Re-run the AutomationsView test file.** Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/components/AutomationsView.tsx test/automationsView.test.tsx
git commit -m "$(cat <<'EOF'
Add Linear and Sentry choices to the automation When picker (#1588).

EOF
)"
```

---

## Self-review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| Decisions (poll, grouped issue, no relay, one PR) | Constraints + Tasks 4–5 |
| Data model / normalize / parse / sentryAuthToken | Tasks 1, 6 |
| Linear queries + birth-span skip | Tasks 2, 3 |
| Sentry GET + token | Tasks 4, 6, 7 |
| pollTriggers / prefixes / formatTriggerNote | Tasks 3, 5 |
| Settings UI | Task 7 |
| Automations UI / createFormError / triggerLabel | Tasks 1, 8 |
| Tests listed in the spec | Each task |
| Out of scope | Constraints; no task adds a relay, spike, or host field |

**Placeholders:** none.

**Type consistency:** `sentryAuthToken`, `fetchTriggerIssues(source, opts)`, `fetchProjectIssues({ org, project, environment, token, ... })`, `triggerDeps.linearGraphql` / `sentryIssues`, error strings `Linear trigger: ` / `Sentry trigger: `, form errors `Sentry org is required` / `Sentry project is required` are the same in every task.
