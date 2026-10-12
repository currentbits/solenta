# Automation triggers: Linear and Sentry (polled)

**Status:** Approved in conversation on 2026-10-11 (issue #1588).
**Scope:** add Linear and Sentry event sources to the existing automation poller. Generic inbound webhooks are out of scope.

## Decisions

1. **Poll, do not relay.** A desktop app has no public URL. GitHub triggers already poll every 60s (`electron/automation-triggers.js`). Linear and Sentry both have pollable APIs. A Girder relay or a tunnel is not part of this slice.
2. **Sentry means a new grouped issue**, not a numeric event-count spike. Key on `firstSeen`.
3. **Generic inbound webhooks stay deferred.** They are the only source that needs a public URL. Follow-up, not this spec.
4. **One PR.** Linear and Sentry ship together. Linear already has a GraphQL client and a sealed settings key. Sentry adds a sealed token and a tiny REST client.

## What already exists

- Scheduler tick is 60s (`electron/automations.js` `startScheduler`). After due scheduled runs, it calls `pollTriggers`.
- Each source returns items with a monotonic `key`. The automation stores `triggerCursor`. The first poll only sets the baseline so history never fires. New matches batch into one run. The cursor advances only when that run starts. A still-working run is skipped so events pile into the next one.
- Poll errors write `lastError` with a source prefix (`GitHub trigger: `) and never increment `consecutiveFailures`.
- `AutomationTrigger` is `{ type: "github", event, branch, label, conclusion }`. The When picker is a single `<select>`: schedule presets or a GitHub event string.
- Linear ticket fetch lives in `electron/linear.js`. Auth is `settings.linearApiKey` (sealed) or `LINEAR_API_KEY`.
- Outbound webhooks (Solenta → user URL, issue #167) are unrelated.

## Architecture

`pollTriggers` grows two more branches next to GitHub. No plugin registry, no new process, no hosted service.

```
scheduler tick (60s)
  → pollTriggers
       github  → project origin + github.rest
       linear  → settings.linearApiKey + GraphQL
       sentry  → settings.sentryAuthToken + REST
  → matchRows (filters) → fresh keys > cursor → one fireRun
```

The Solenta project on the automation is only where the agent runs. Linear team and Sentry org/project are trigger filters, not inferred from git origin.

Fetch cache is per tick, same as GitHub:

| Source | Cache key |
| --- | --- |
| GitHub | `{host}/{owner}/{repo}\|{pulls\|issueEvents\|runs\|events}` |
| Linear created | `linear\|created` |
| Linear status | `linear\|status` |
| Sentry | `sentry\|{org}\|{project}\|{environment or ""}` |

Team and status filters are applied in `matchRows`, so one Linear fetch serves every automation of that event. Sentry org/project/environment are in the request URL, so they belong on the cache key.

## Data model

Extend the existing trigger. `type` is derived from `event`. Unknown events still normalize to `null` (schedule mode) on read and throw from `parseTriggerInput` on write.

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
  /** Linear team key, e.g. ENG. Null = any team. */
  team?: string | null;
  /** Linear workflow state name. Null = any transition. */
  status?: string | null;
  /** Sentry org slug. Required for sentry_issue. */
  org?: string | null;
  /** Sentry project slug. Required for sentry_issue. */
  project?: string | null;
  /** Sentry environment. Null = all environments. */
  environment?: string | null;
}
```

`normalizeTrigger` keeps a field only when it applies to that event (same as today's branch/label/conclusion). Empty strings become `null`.

`parseTriggerInput` rejects `sentry_issue` without both `org` and `project` (after trim). Linear `team` and `status` stay optional.

`triggerCursor` stays `number | string | null`. Linear and Sentry keys are ISO-8601 timestamps and compare with `>`.

`AppSettings` gains `sentryAuthToken?: string | null`. Default `null`. Empty string on write clears it. Sealed at rest next to `linearApiKey` in `electron/secrets.js` conceal/reveal. Env fallback: `SENTRY_AUTH_TOKEN`.

Every settings default and fixture that lists `linearApiKey: null` also lists `sentryAuthToken: null` (`electron/store-normalize.js` and the exact-object tests in `budget-spend.test.js` / `auto-settle-settings.test.js`).

## Linear source

Reuse `electron/linear.js`. Extract a shared `postGraphql(apiKey, query, variables, opts)` from `postIssueQuery` so the existing issue fetch and the new list queries share timeout, auth header, and error mapping. Do not change `fetchLinearIssue` behavior.

`resolveLinearApiKey` is unchanged: settings, then `LINEAR_API_KEY`. Missing key → poll error `Linear trigger: no api key (Settings → Git)`.

### Issue created

```graphql
query TriggerIssuesCreated($first: Int!) {
  issues(first: $first, orderBy: createdAt) {
    nodes {
      identifier
      title
      url
      createdAt
      team { key }
    }
  }
}
```

`$first` is 50. The page must be the **newest** 50 issues. Linear's default `createdAt` order is newest-first on `first`; if a stub or live response comes back oldest-first, switch that query to `last: 50`. Key = `createdAt`. Every row with a valid `createdAt` goes into `all`. A row matches when `team` is unset or `team.key` equals the filter case-insensitively.

Prompt line: `ENG-12 created: Fix login (https://linear.app/…/ENG-12)`.

### Status changed

```graphql
query TriggerIssuesStatus($first: Int!) {
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
}
```

`$first` is 50, newest-updated first (same newest-page rule as created). `stateHistory(last: 5)` is the five most recent spans so a long-lived issue still yields the latest transitions.

For each issue:

- `all` keys: every span `startedAt`, or `createdAt` when history is empty (baseline still advances).
- A span **matches** when all of:
  1. `startedAt` is a non-empty string.
  2. `startedAt > issue.createdAt` — the birth span is not a status change.
  3. If the trigger has `status`, `state.name` equals it case-insensitively.
  4. If the trigger has `team`, `team.key` equals it case-insensitively.

Key = `startedAt`. Prompt line: `ENG-12 moved to Done: Fix login (url)`.

Two spans that share a timestamp collide the same way GitHub `ci_completed` already does. Accept that.

## Sentry source

New `electron/sentry.js`. One GET, no SDK.

```
GET https://sentry.io/api/0/projects/{org}/{project}/issues/?sort=new&limit=50&statsPeriod=
```

Query string:

- `sort=new` — first seen, newest first.
- `query` starts as `is:unresolved`. If `environment` is set, append ` environment:{env}`.
- `statsPeriod=` — empty, so the response drops the fat 24h histogram.

Headers: `Authorization: Bearer {token}`. Required scope: `event:read`.

Key = `firstSeen`. `all` and `matched` are the same set (the query already applied environment and unresolved). Skip rows without `firstSeen`.

Prompt line: `PUMP-STATION-1 first seen: title (permalink)`.

Host is `sentry.io` only. A self-hosted `sentryHost` setting is a later addition if someone needs it.

Missing token → `Sentry trigger: no auth token (Settings → Git)`. 401/403 → `Sentry trigger: auth`. Missing org/project is rejected at write time, so the poller does not have to invent a URL.

`resolveSentryAuthToken` mirrors Linear: settings, then `SENTRY_AUTH_TOKEN`.

## Poller

`pollTriggers` keeps the same loop. After `normalizeTrigger` (already on the stored row), branch on `trigger.type`.

GitHub path is unchanged, including `projectRemote` and `GitHub trigger: ` errors.

Linear/Sentry paths do not call `projectRemote`. They still require the automation's Solenta project to exist (same as today) so `fireRun` has a workspace.

`triggerDeps` grows optional `linearGraphql` and `sentryFetch` (or a `sentryIssues` function) so tests never hit the network. Default implementations use the real clients.

Error prefixes:

- `Linear trigger: `
- `Sentry trigger: `

A successful poll clears only its own prefix, same as GitHub.

`formatTriggerNote`:

- Linear created: `[Trigger] Linear issue created (N new event(s)):`
- Linear status: `[Trigger] Linear status changed (N new event(s)):`
- Sentry: `[Trigger] Sentry issue on {org}/{project} (N new event(s)):`

Same 20-event cap and “older events omitted” line.

## Settings UI

`src/components/settings/GitPane.tsx`: a Sentry section immediately under Linear. Password field, Save key, empty+save clears. Note: “Used for Sentry automation triggers. Needs event:read. SENTRY_AUTH_TOKEN in the environment also works.”

`SettingsDraftKey` adds `"sentry"`. `saveSentryKey` copies `saveLinearKey`. The renderer sees the plaintext token the same way it sees the Linear key. Add `sentry` to the Git pane search keywords next to `linear ticket api key`.

## Automations UI

`TRIGGER_EVENT_LABELS`:

- `linear_issue_created`: “Linear issue created”
- `linear_status_changed`: “Linear status changed”
- `sentry_issue`: “Sentry issue”

When picker gets two new optgroups (“Linear event (polled every minute)”, “Sentry event (polled every minute)”) next to GitHub.

Conditional fields (same pattern as Label / Branch / Result):

| Event | Fields |
| --- | --- |
| `linear_issue_created` | Team (placeholder “Any team”) |
| `linear_status_changed` | Team, Status (placeholder “Any status”) |
| `sentry_issue` | Org, Project (required), Environment (placeholder “Any environment”) |

`createFormError` returns “Sentry org is required” / “Sentry project is required” when those are blank. The submit lock (#941) is unchanged.

`triggerLabel` examples:

- `on Linear issue created` / `on Linear issue created in ENG`
- `on Linear status changed` / `on Linear status changed to Done in ENG`
- `on Sentry issue` / `on Sentry issue acme/pump-station` / `on Sentry issue acme/pump-station (prod)`

`devCoder.ts` automations store accepts the new trigger shape the same way it accepts GitHub (passthrough). No extra mock poller.

## Errors and limits

- First page only (50). Same ceiling as GitHub. If more than 50 matching events land inside one minute, the oldest of that burst can be skipped. Do not paginate.
- Linear/Sentry being down is a poll error, not a breaker trip.
- Creating a Linear issue does not fire `linear_status_changed`.
- App off or asleep misses events that fall off the first page before the next successful poll. Same as GitHub.

## Tests

`electron/test/automation-triggers.test.js`:

- `normalizeTrigger` keeps team/status/org/project/environment only on the events that use them; unknown events stay `null`.
- `parseTriggerInput` throws on `sentry_issue` without org or project.
- Linear created: team filter case-insensitive; key is `createdAt`.
- Linear status: birth span (`startedAt === createdAt`) does not match; later span does; status and team filters apply.
- Sentry: key is `firstSeen`; rows without it are skipped.
- `pollTriggers` Linear: baseline then one batched run; missing key writes `Linear trigger:` and leaves `enabled` true.
- `pollTriggers` Sentry: same, via a stubbed issues fetch.

`electron/test/secrets.test.js`: conceal/reveal `sentryAuthToken`.

`electron/test/issues.test.js` / Linear fetch tests stay green after the GraphQL helper extract.

Settings exact-object fixtures gain `sentryAuthToken: null`.

`test/automationsView.test.tsx`: pick Linear and Sentry events, send filters, reject blank Sentry org/project.

`test/settingsModal.test.tsx`: save and clear the Sentry key (mirror the Linear test).

`test/automations.test.ts`: `triggerLabel` for the three new events and their filters.

## Files

- Modify: `electron/automation-triggers.js`, `electron/linear.js`, `electron/automations.js` (only if `triggerDeps` / notes need a hook), `electron/secrets.js`, `electron/store-normalize.js`, `electron/store-settings-methods.js`, `src/shared/ipc.ts`, `src/automations.ts`, `src/components/AutomationsView.tsx`, `src/components/SettingsModal.tsx`, `src/components/settings/GitPane.tsx`
- Create: `electron/sentry.js`
- Tests: the files listed above
- Do not add a relay app, a tunnel, or a Sentry host setting

## Out of scope

- Generic inbound webhooks / Girder relay / ngrok
- Numeric Sentry spike (N events in M minutes)
- Self-hosted Sentry host
- Linear/Sentry inferred from the git remote
- Natural-language authoring (#1589) and permission scopes (#1590)
- Changing the GitHub poller, cursor rules, or the 60s tick
