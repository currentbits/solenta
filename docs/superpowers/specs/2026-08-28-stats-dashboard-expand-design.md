# Site analytics dashboard expansion

Approved 2026-08-28. Extends the first-party collector from
`docs/superpowers/specs/2026-08-28-first-party-site-analytics-design.md`
(issue #747). Public site stays cookieless. Daily visitor hashes stay
the unique model. No consent banner.

## Goal

The private dashboard at stats.solenta.app answers launch questions that
v1 left out: where traffic came from (UTM + referrer), which countries
and browsers show up, whether homepage visitors convert to Download /
Docs / GitHub Star, and what happened in the last 30 minutes. Also
expose more of the events we already store (Docs, Changelog, GitHub
Repo) and a 90-day range.

## Non-goals

- Cross-day unique people (cookie or long-lived salt)
- Consent banner, public-site cookies, storing IP or raw User-Agent
- Storing the leftover query string after UTM keys are copied
- GeoIP database or any new npm dependency (still `pg` only)
- Custom funnel builder, session recording, devices beyond browser
  family, Chart.js, dashboard JS
- Tagging nav on docs.html / changelog.html
- Mixing this into `feedback-api/` or the site nginx image

## Architecture

Same process, same Postgres, same `POST /e` body shape `{n,u,r,p?}`.
New dimensions are derived in memory at ingest and written into the
existing `events.props` JSONB next to `platform`. No schema migration.

```text
browser (solenta.app)
  location.href already includes ?utm_*
  sendBeacon {n,u,r,p?}  -->  POST /e
                                 |
                                 parse CF-IPCountry, UA family, utm_*
                                 store props {platform?, country?,
                                              browser?, utm_source?,
                                              utm_medium?, utm_campaign?}
you  -->  GET /?days=1|7|30|90   HTML + meta refresh 30s
     -->  GET /api/stats         same payload as JSON
```

Tracker (`site/stats.js`) does not change. `u` is already
`location.href`.

Deploy by grafting `stats-api/` onto
`ssh://git@100.112.17.24:2222/solenta-stats.git`. Site graft is not
required unless a later change touches `site/`.

## Privacy

**Never written:** IP, raw User-Agent, full URL, leftover query string,
cookies on solenta.app.

**Newly written, in `props` only:**

| Key | Rule |
|---|---|
| `country` | `CF-IPCountry` when it is two A-Z letters. Omit `XX`, empty, missing. |
| `browser` | `Chrome`, `Safari`, `Firefox`, `Edge`, or `Other`. Parsed from UA in memory, then UA is discarded. |
| `utm_source` `utm_medium` `utm_campaign` | From `u` search params before path strip. Each value sliced to 80 chars. Keep only `[a-zA-Z0-9._-]`. Omit if empty after that. |

`platform` stays as v1: only on named events, only `mac` / `win` /
`linux`.

**Visitors** for a range is still the sum of per-day distinct visitor
hashes. The live strip uses the same rule on a 30-minute window (one
bucket, not 30 daily sums). Do not label either number as a unique
person count across days.

DNT, GPC, bots, origin allowlist, 60/min, 2 KB, always-204: unchanged.

Events ingested before this ships have empty new keys. Lists omit
empty keys. Old rows stay valid.

## Collector

`POST /e` gains three in-memory parses after the existing allowlist /
path / referrer checks and before insert. Failures of a parse omit that
key; they do not drop the event.

**Country.** `req.headers["cf-ipcountry"]`. Cloudflare already proxies
stats.solenta.app. No MaxMind file.

**Browser.** Lowercased UA:

- `edg/` -> `Edge`
- `firefox/` or `fxios/` -> `Firefox`
- `chrome/` or `crios/` (and not Edge) -> `Chrome`
- `safari/` and `version/` (and not Chrome/Edge/Firefox) -> `Safari`
- else `Other` when a UA is present

Order matters so Edge is not counted as Chrome.

**UTM.** `new URL(body.u).searchParams` for `utm_source`,
`utm_medium`, `utm_campaign` only. Other params are not copied.

Insert params stay `(name, path, referrer, visitor, propsJson)`. The
JSON blob must still contain no IP and no raw UA.

## Dashboard

Paper-and-ink tokens. Server-rendered HTML. No Chart.js, no webfonts,
no dashboard JS. Logged-in `GET /` includes
`<meta http-equiv="refresh" content="30">`. The login form does not.

### Auth

Unchanged: cookie `solenta_stats` or `Authorization: Bearer`. Unset
`ADMIN_TOKEN` denies.

### Ranges

`/?days=1|7|30|90`. Invalid `days` becomes 30.

- `days=1`: 24 hourly UTC slots, oldest first. Bar height is distinct
  visitor hashes in that hour. Caption is pageviews. Label is `HH`
  (00-23).
- `days=7|30|90`: one bar per UTC day, as today.

### Totals

Visitors, Pageviews, Downloads, GitHub stars, Docs, Changelog, GitHub
Repo. Download-by-platform stays in the Events list, not as extra
hero tiles.

### Live

One sentence: `Live: N visitors, M pageviews`. Window is
`now - 30 minutes` through now. Visitors in that window are
`COUNT` of distinct visitor hashes (single window, not a day sum).

### Lists (top 20, count desc then name asc)

Pages (pageviews by path), Referrers (pageviews by host), Countries
(all stored events with `props.country`), Browsers (all stored events
with `props.browser`), Sources (pageviews that have `utm_source`,
label `source` or `source / medium / campaign` when the later keys
exist).

Empty values omitted. A country list that is empty (no CF header on
older rows) simply renders no rows under the heading.

### Funnels

Fixed, same UTC day, same `visitor` hash. A visitor who fires the
exit event twice still counts once.

| Name | Enter | Convert |
|---|---|---|
| Home to Download | `pageview` path `/` | `Download` |
| Home to Docs | `pageview` path `/` | `Docs` |
| Home to GitHub Star | `pageview` path `/` | `GitHub Star` |

Each row: name, entered, converted, rate as a whole percent
(`converted / entered`, 0 if entered is 0). No custom builder.

### Empty and errors

Empty sentence "No events in this range." only when the selected range
has zero rows of any name. DB throw: HTTP 503, one sentence, no stack
in the HTML. Visible copy: no em dashes.

### `GET /api/stats?days=1|7|30|90`

Same auth. JSON the HTML is built from. Additions:

```json
{
  "days": 30,
  "visitors": 12,
  "pageviews": 40,
  "downloads": 5,
  "githubStars": 2,
  "docs": 3,
  "changelog": 1,
  "githubRepo": 4,
  "live": { "visitors": 2, "pageviews": 5 },
  "series": [{ "day": "2026-08-01", "hour": null, "visitors": 3, "pageviews": 8 }],
  "pages": [{ "path": "/", "count": 20 }],
  "referrers": [{ "host": "producthunt.com", "count": 4 }],
  "countries": [{ "code": "NL", "count": 6 }],
  "browsers": [{ "name": "Safari", "count": 4 }],
  "sources": [{ "label": "producthunt / social / launch", "count": 3 }],
  "events": [{ "name": "Download", "platform": "mac", "count": 3 }],
  "funnels": [
    { "name": "Home to Download", "entered": 10, "converted": 2, "rate": 20 }
  ]
}
```

For `days=1`, `series[].hour` is `0..23` and `day` is that UTC date.
For longer ranges `hour` is `null`.

`buildStats(rows, days, nowMs)` stays the aggregator. Live is computed
from the same `rows` plus `nowMs`. SQL `since` is the earlier of the
range start and `nowMs - 30 minutes`, so a Today view at 00:10 UTC
still sees live events from 23:40 yesterday. Totals, series, lists,
and funnels ignore rows outside the selected range. Live ignores rows
older than 30 minutes.

## Tests

Extend `stats-api/test.js`. Must fail if any of these break:

- insert `props` can include `country`, `browser`, and utm keys, and
  still never includes IP or the raw UA
- `CF-IPCountry: NL` stores `country: "NL"`; `XX` and missing omit it
- UA `Edg/120` stores `browser: "Edge"`, not Chrome
- `u` with `?utm_source=ph&utm_medium=social&foo=1` stores the two
  utm keys and does not store `foo`
- `buildStats` visitors remain the sum of per-day distinct hashes
- `days=1` series has 24 hourly slots
- `days=90` is accepted; `days=2` falls back to 30
- live counts only rows in the last 30 minutes, including rows
  before today's UTC midnight when `days=1`
- funnel: two `/` pageviews and one Download from the same visitor
  on one day -> entered 1, converted 1; a second Download does not
  raise converted
- `GET /` HTML contains Countries, Browsers, Sources, Funnels, Live,
  `?days=90`, and `<meta http-equiv="refresh" content="30">` when
  authorized; login HTML does not refresh
- empty sentence is absent when the only events are Docs
- HTML has no `<script` and no em dash

Site tests do not change unless `stats.js` changes (it should not).

## Deploy

Graft `stats-api/` to `girder-stats` after tests pass. No new Girder
env. No site graft. Existing `ADMIN_TOKEN` stays. Prove with a
synthetic `POST /e` that includes a query string and a
`cf-ipcountry` header, then `GET /api/stats?days=1`.

Update `docs/ARCHITECTURE.md` Stats section: props may include
country, browser, and utm keys; dashboard ranges include 90; live
and funnels exist.

## Key decisions

- **Daily uniques stay.** A 30-day unique person count needs a cookie
  or a long-lived hash. Neither is in scope.
- **CF-IPCountry, not GeoIP.** The beacon already hits a Cloudflare
  host. No database file to refresh.
- **props JSONB, not new columns.** Volume is launch-scale. Avoid a
  migration on the live Girder Postgres.
- **Meta refresh, not dashboard JS.** Keeps the v1 "zero JS" rule.
- **Three fixed funnels.** Enough to see homepage conversion. No
  builder.
- **UTM allowlist of three keys.** Not the rest of the query string.

## Files

| Path | Change |
|---|---|
| `stats-api/server.js` | ingest parses; `buildStats` / dashboard / API |
| `stats-api/test.js` | new cases above |
| `docs/ARCHITECTURE.md` | Stats section |

No `site/` change.

## Open questions

None. Approach A, daily uniques, ingest contract, dashboard layout,
funnels, live window, ranges, and test gates were decided in the
design thread.
