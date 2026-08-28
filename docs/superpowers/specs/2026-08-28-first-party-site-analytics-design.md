# First-party site analytics

Approved 2026-08-28. Replaces the unfinished Plausible setup on solenta.app
(issue #683) with a collector and private dashboard we run ourselves
(issue #747).

## Goal

See launch traffic without a third-party analytics product: pageviews,
unique visitors, top pages, referrers, and the tagged events already on
the homepage (Download by platform, Docs, Changelog, GitHub Repo, GitHub
Star, All downloads).

The public site stays on the contract already in `site/index.html`: no
cookies, no personal data, no consent banner.

## Non-goals (v1)

- Countries, devices, browsers, realtime, funnels, session recording
- UTMs or any other query string
- Tagging nav on docs.html / changelog.html (those pages send pageviews
  only, matching today)
- Public stats
- Mixing this into `feedback-api/` or the static site container
- Self-hosting Plausible, Umami, or GoatCounter

## Architecture

Same shape as `feedback-api/`. Not mixed into the nginx site image.

| Piece | Where |
|---|---|
| Collector + dashboard | `stats-api/` in this repo |
| Girder app | `solenta-stats`, stack `solenta` |
| Domain | `stats.solenta.app` |
| Store | its own Postgres (Girder backs it up) |
| Secret | `ADMIN_TOKEN` (same idea as feedback) |
| Tracker | `site/stats.js`, served from solenta.app |

```text
browser (solenta.app)
  site/stats.js  --sendBeacon text/plain-->  POST /e   stats.solenta.app
                                                     |
you (browser or curl)  --cookie or Bearer-->  GET /   dashboard
                                              GET /api/stats
                                                     |
                                              Postgres events + salts
```

The marketing page never waits on stats. A down collector drops the
event. It does not break a download.

Deploy the stats app by grafting `stats-api/` onto
`ssh://git@100.112.17.24:2222/solenta-stats.git`, the same commit-tree
pattern used for `site/` onto `solenta.git`.

## Privacy

**Never written to Postgres:** IP, User-Agent, cookies, full URL, query
string, or anything that can be tied to a person across days.

**Written:** `ts`, event `name`, `path`, referrer hostname, a 16-hex-char
`visitor` hash, and optional `platform` in `{mac, win, linux}`.

**Uniques.** At ingest:

```
visitor = HMAC-SHA256(salt_for_utc_today, ip + "\n" + user-agent)
          .hex.slice(0, 16)
```

The salt is 32 random bytes, stored as hex, keyed by UTC date, persisted
in `salts` so a restart does not split the day. HMAC key is
`Buffer.from(salt, "hex")`. A person who visits Monday and Tuesday is
two visitors. That is the privacy model. Calendar days on the dashboard
are UTC, same as the salt.

The dashboard "Visitors" total for a range is the **sum of per-day
distinct visitor hashes**, not `COUNT(DISTINCT visitor)` over the whole
range. Label it "Visitors". Do not claim a 30-day unique person count.

**Drops (still HTTP 204):** foreign origin, bot UA, `DNT: 1`, `Sec-GPC:
1`, over 60 events per IP per minute, body over 2 KB, unknown event
name, collector or database error.

**Public-site cookies:** none. The stats host may set an HttpOnly auth
cookie for the operator after login. Visitors never see it.

## Data model

```sql
CREATE TABLE IF NOT EXISTS salts (
  day DATE PRIMARY KEY,
  salt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  name TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  visitor TEXT NOT NULL DEFAULT '',
  props JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS events_name_ts ON events (name, ts);
```

No IP column. Ever.

## Collector

`POST /e` is unauthenticated. It always returns **204**, including on
every drop listed above, so the browser never surfaces an error. Drops
are one log line (`drop: bot`, `drop: origin`, `drop: dnt`,
`drop: ratelimit`, `drop: db`, ...). A successful insert is also one
log line (`event pageview /`).

`GET /health` returns 200 `{ok:true}` for Girder probes, with or without
a database.

### Body

Text/plain JSON (no CORS preflight). Also accept `application/json`.
Cap 2 KB; over cap still 204.

```json
{ "n": "pageview", "u": "https://solenta.app/docs.html", "r": "https://www.producthunt.com/", "p": { "platform": "mac" } }
```

| Field | Rule |
|---|---|
| `n` | Allowlist only: `pageview`, `Download`, `Docs`, `Changelog`, `GitHub Repo`, `GitHub Star`, `All downloads`. Anything else is dropped. Max 40 chars. |
| `u` | Must parse as `https://solenta.app` or `https://www.solenta.app`. Pathname only is stored. `/index.html` becomes `/`. Strip query and hash. Max 200 chars. |
| `r` | Hostname only, lowercase, no port. Empty if missing, unparsable, or the host is `solenta.app` / `www.solenta.app`. Max 200 chars. |
| `p.platform` | Only on named events (not `pageview`). Only `mac`, `win`, or `linux`. Any other key or value is discarded. `props` is `{}` when platform is absent. |

IP is the first `X-Forwarded-For` hop, same as `feedback-api`. It is used
in memory for the visitor hash and the rate limiter, then discarded.

User-Agent is used in the hash, then discarded. Treat as a bot and drop
when the lowercase UA matches
`bot|crawler|spider|preview|slurp|facebookexternalhit|embedly`.

Rate limit: 60 events per IP per rolling minute, in-memory Map, same
single-instance caveat as feedback (a restart forgives everyone).

CORS: if `Origin` is `https://solenta.app` or `https://www.solenta.app`,
echo it on `Access-Control-Allow-Origin` plus
`Access-Control-Allow-Methods: POST`. `OPTIONS /e` returns 204 with
those headers. Missing Origin is fine (sendBeacon still sends one).

## Tracker (`site/stats.js`)

Strip every Plausible `<script>` and every `plausible-event-*` class from
`site/index.html`, `site/docs.html`, and `site/changelog.html`. Add
`<script src="stats.js" defer></script>` on all three.

`stats.js` only sends when `location.hostname` is `solenta.app` or
`www.solenta.app`. Local servers, Girder preview hosts, and `file:` do
nothing.

On load: one `pageview` with `u = location.href` and
`r = document.referrer`.

On click of `[data-event]`: `sendBeacon` `{n, u, r, p}` where `n` is
`data-event`, `p.platform` is `data-platform` when present. Do not call
`preventDefault`. `sendBeacon` is the leaving-page path.

Endpoint is hardcoded: `https://stats.solenta.app/e`. Content-Type
`text/plain;charset=UTF-8`.

Homepage markup becomes real attributes. `site/main.js` already rewrites
the hero button's platform; it sets `data-platform` instead of a
Plausible class.

```html
<a data-event="Download" data-platform="mac" href="...">
<a data-event="GitHub Star" href="...">
```

Exact `data-event` values match the collector allowlist. Spaces are
fine (`GitHub Repo`, `GitHub Star`, `All downloads`). Tagged events stay
on the homepage CTAs only.

## Dashboard

Paper-and-ink, same tokens as the site (`--paper #f5f5f2`, `--ink
#191918`, `--accent #f2e51f`). Not the dark product UI. Server-rendered
HTML, no React, no Chart.js, no webfont files (system stack). Zero JS
on the dashboard: range is `/?days=1|7|30` links.

### Auth

`ADMIN_TOKEN` unset denies everything, including login.

Two ways in, both compared with `timingSafeEqual` against `ADMIN_TOKEN`:

1. Cookie `solenta_stats` (HttpOnly, Secure, SameSite=Strict, Path=/,
   Max-Age=30 days) set by `POST /login` (`application/x-www-form-urlencoded`,
   field `password`).
2. `Authorization: Bearer <token>` for curl, same as feedback.

Logged out `GET /` is a password form. Wrong password re-renders the
form, no redirect loop. `POST /logout` clears the cookie.

### Logged-in `GET /`

Default range is 30 days. Invalid `days` falls back to 30.

- Four totals: Visitors (sum of daily uniques), Pageviews, Downloads,
  GitHub stars
- Per-day CSS bars: one column per calendar day in the range, including
  zeros. Bar height is visitors. Caption under each bar is the pageview
  count.
- Two lists, top 20: pages by pageview count, referrers by pageview
  count (empty referrer omitted)
- Events: every allowlisted name except `pageview`, with Download split
  by `mac` / `win` / `linux` / (no platform)
- Empty range: the sentence "No events in this range."
- DB down: HTTP 503, one sentence. No stack traces.

### `GET /api/stats?days=1|7|30`

Same auth. JSON the HTML is built from:

```json
{
  "days": 30,
  "visitors": 12,
  "pageviews": 40,
  "downloads": 5,
  "githubStars": 2,
  "series": [{ "day": "2026-08-01", "visitors": 3, "pageviews": 8 }],
  "pages": [{ "path": "/", "count": 20 }],
  "referrers": [{ "host": "producthunt.com", "count": 4 }],
  "events": [{ "name": "Download", "platform": "mac", "count": 3 }]
}
```

`series` includes every calendar day in the range, zeros allowed, oldest
first. `events[].platform` is `null` when the event has no platform.

## Tests

### `stats-api/test.js`

`node:test`, fake db, same style as `feedback-api/test.js`.

Must fail if any of these break:

- `POST /e` is 204 for a valid pageview, for junk, for a foreign origin,
  for a bot UA, for `DNT: 1`, for `Sec-GPC: 1`, for an over-cap body,
  and when the db throws
- the insert params contain no IP and no User-Agent
- the same IP+UA on the same UTC day produces the same `visitor`; a new
  salt produces a different one
- referrer is stored as a hostname; a solenta.app referrer is stored as `""`
- `/index.html` is stored as `/`
- unknown `n` and unknown `p.platform` never reach the db
- rate limit lets 60 through then drops
- bearer and cookie auth accept the token and reject near-misses
  (shorter, longer, missing prefix)
- unset `ADMIN_TOKEN` denies the dashboard
- `/api/stats` visitors equal the sum of per-day distinct hashes, not a
  range-wide distinct
- `GET /health` is 200 without a db

### Site tests

New `electron/test/site-stats.test.js` (picked up by `npm run test:electron`):

- `index.html`, `docs.html`, `changelog.html` contain no `plausible.io`
  and no `plausible-event-`
- all three include `stats.js`
- homepage CTAs that today carry Plausible classes carry `data-event`
  (and Download carries `data-platform`)
- `stats.js` evaluated against `https://solenta.app/` beacons a pageview
  and a `data-event` click
- the same script against `http://127.0.0.1/` or a Girder preview host
  beacons nothing

`electron/test/site-downloads.test.js` asserts `data-platform="mac"`
instead of `plausible-event-platform=mac`.

### `npm test`

Add `"test:stats": "node --test stats-api/test.js"` and append it to the
root `"test"` script. A silent collector is the bug #683 already hit;
unlike `feedback-api`, this suite is on the CI gate.

## Deploy

Order matters. Set the token before the first boot sees an empty one.

1. `create_app` `{name: "solenta-stats", stack: "solenta"}`
2. `services_add` `{app: "solenta-stats", type: "postgres"}`
3. `app_env_set` `ADMIN_TOKEN` to a 32-byte hex secret. Do not commit it.
4. `domains_add` `{app: "solenta-stats", host: "stats.solenta.app"}`
5. Graft `stats-api/` to `ssh://git@100.112.17.24:2222/solenta-stats.git`
6. `app_config` healthPath `/health` if Girder does not already probe it
7. Graft the site (Plausible gone, `stats.js` on) to `solenta.git`
8. Prove it: open solenta.app, click Download, open
   `https://stats.solenta.app` with the token, see the event. Also:

```
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://stats.solenta.app/api/stats?days=1"
```

Dockerfile copies `feedback-api/Dockerfile`: two-stage, npm stripped from
the final image, `USER node`, `PORT=3000`. Dependency: `pg` only.

`docs/ARCHITECTURE.md` gets a Stats section next to Feedback.

#747 stays `plan:doing` until the live probe works, then closes. #683's
analytics checkbox is done at the same time; the download flow in #683
stays done.

## Key decisions

- **Own collector, not Plausible CE / Umami / GoatCounter.** Those are
  the same class of third-party #683 already failed to finish.
- **Sibling Girder app, not feedback-api and not the site container.**
  Pageview volume must not share rate limits or failure modes with bug
  reports, and the static nginx image stays static.
- **Daily-rotating visitor hash, IP never stored.** Matches the current
  site comment. Range "Visitors" is the sum of daily uniques.
- **Honor DNT and GPC.** Drop those events. Slightly lower counts, the
  privacy comment stays true.
- **No query strings.** Referrer host is enough to see Product Hunt vs
  Twitter vs GitHub.
- **Always 204 on POST /e.** The marketing page cannot break because
  analytics broke.
- **Dashboard is server-rendered HTML with CSS bars.** No chart library,
  no JS, paper-and-ink tokens.
- **stats-api tests run in `npm test`.** feedback-api's suite is
  manual; this one is the launch gate.

## Files

| Path | Change |
|---|---|
| `stats-api/server.js` | collector, dashboard, `/api/stats`, auth |
| `stats-api/test.js` | node:test, fake db |
| `stats-api/package.json` | `pg`, `node --test test.js` |
| `stats-api/package-lock.json` | lockfile so the Docker `npm install` is reproducible |
| `stats-api/Dockerfile` | copy of feedback-api's two-stage image |
| `site/stats.js` | tracker |
| `site/index.html` | drop Plausible, add stats.js and `data-event` |
| `site/docs.html` | drop Plausible, add stats.js |
| `site/changelog.html` | drop Plausible, add stats.js |
| `site/main.js` | write `data-platform` on the hero button |
| `electron/test/site-stats.test.js` | HTML + tracker contract |
| `electron/test/site-downloads.test.js` | `data-platform` assertion |
| `package.json` | `test:stats` on the `test` script |
| `docs/ARCHITECTURE.md` | Stats section |

## Open questions

None. Dashboard visibility, hosting split, privacy (DNT, no UTMs),
tracker markup, dashboard layout, tests-in-CI, and live Girder setup
were all decided in the design thread.
