# Stats Dashboard Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend stats.solenta.app with country, browser, UTM sources, live last-30-minutes, fixed funnels, extra totals, and 90-day / hourly Today views, without cookies or a new dependency.

**Architecture:** Same `POST /e` body. Derive `country` (`CF-IPCountry`), `browser` (UA family), and `utm_*` in memory and merge them into existing `events.props` JSONB. `buildStats(rows, days, nowMs)` grows the JSON the HTML already uses. SQL `since` is the earlier of range start and `nowMs - 30min`. No site tracker change. Graft `stats-api/` only.

**Tech Stack:** Node 22 `node:http` / `node:test`, `pg` only, Girder app `solenta-stats`.

**Spec:** `docs/superpowers/specs/2026-08-28-stats-dashboard-expand-design.md` (issue #757).

## Global Constraints

- Public site: no cookies, no personal data, no consent banner.
- Never write IP, raw User-Agent, full URL, or leftover query string to Postgres.
- `POST /e` always returns 204, including on every drop.
- Visitors for a range is the sum of per-day distinct hashes, not range-wide distinct.
- Live visitors are distinct hashes in a single 30-minute window.
- Country: two A-Z letters from `CF-IPCountry`; omit `XX` / empty / missing.
- Browser: `Chrome` | `Safari` | `Firefox` | `Edge` | `Other` (Edge before Chrome).
- UTM keys only: `utm_source`, `utm_medium`, `utm_campaign`. Max 80 chars. `[a-zA-Z0-9._-]`.
- Ranges: `1|7|30|90`. Invalid `days` becomes 30. Today is 24 hourly UTC slots.
- Dashboard: paper-and-ink (`--paper #f5f5f2`, `--ink #191918`, `--accent #f2e51f`), no Chart.js, no dashboard JS, no webfonts. Meta refresh 30s on logged-in `GET /` only.
- Visible copy: no em dashes.
- One dependency: `pg`. Do not touch `site/` or `feedback-api/`.
- No GeoIP file, no custom funnel builder, no cross-day unique people.

## File structure

| File | Responsibility |
|---|---|
| `stats-api/server.js` | Ingest parses, `querySince`, expanded `buildStats`, dashboard HTML |
| `stats-api/test.js` | New ingest + aggregator + HTML cases |
| `docs/ARCHITECTURE.md` | Stats section: props, 90, live, funnels |

---

### Task 1: Ingest country, browser, UTMs

**Files:**
- Modify: `stats-api/server.js`
- Modify: `stats-api/test.js`

**Interfaces:**
- Consumes: existing `handleEvent`, `parsePath`, `HOSTS`.
- Produces: `parseCountry(header)`, `parseBrowser(ua)`, `parseUtms(u)`, `eventProps({ name, platform, country, browser, utms })`. Insert `props` JSON may include those keys and must never include IP or raw UA.

- [ ] **Step 1: Append failing ingest tests to `stats-api/test.js`**

Add to the existing require:

```js
const {
  server,
  setDb,
  setNow,
  resetHits,
  RATE_MAX,
  parseCountry,
  parseBrowser,
  parseUtms,
} = require("./server");
```

Append:

```js
test("parseCountry accepts ISO codes and drops XX", () => {
  assert.equal(parseCountry("NL"), "NL");
  assert.equal(parseCountry("us"), "US");
  assert.equal(parseCountry("XX"), "");
  assert.equal(parseCountry(""), "");
  assert.equal(parseCountry(undefined), "");
});

test("parseBrowser classifies Edge before Chrome", () => {
  assert.equal(parseBrowser("Mozilla/5.0 Edg/120.0"), "Edge");
  assert.equal(parseBrowser("Mozilla/5.0 Chrome/120.0"), "Chrome");
  assert.equal(parseBrowser("Mozilla/5.0 CriOS/120.0"), "Chrome");
  assert.equal(parseBrowser("Mozilla/5.0 Firefox/120.0"), "Firefox");
  assert.equal(parseBrowser("Mozilla/5.0 FxiOS/120.0"), "Firefox");
  assert.equal(
    parseBrowser("Mozilla/5.0 Version/17.0 Safari/605.1.15"),
    "Safari",
  );
  assert.equal(parseBrowser("curl/8.0"), "Other");
  assert.equal(parseBrowser(""), "");
});

test("parseUtms keeps three keys and drops the rest", () => {
  const utm = parseUtms(
    "https://solenta.app/?utm_source=ph&utm_medium=social&utm_campaign=launch&foo=1",
  );
  assert.deepEqual(utm, {
    utm_source: "ph",
    utm_medium: "social",
    utm_campaign: "launch",
  });
  assert.equal(JSON.stringify(utm).includes("foo"), false);
  assert.deepEqual(parseUtms("https://solenta.app/?utm_source=bad value"), {});
});

test("POST /e stores country browser utm and never IP or UA", async (t) => {
  resetHits();
  const port = await listen();
  const db = fakeDb();
  setDb(db);
  t.after(() => {
    server.close();
    setDb(null);
  });
  const res = await post(
    port,
    {
      n: "pageview",
      u: "https://solenta.app/?utm_source=ph&utm_medium=social&foo=1",
      r: "",
    },
    {
      "cf-ipcountry": "NL",
      "user-agent": "Mozilla/5.0 Edg/120.0",
    },
  );
  assert.equal(res.status, 204);
  const insert = db.calls.find((c) => /INSERT INTO events/i.test(c.sql));
  const props = JSON.parse(insert.params[4]);
  assert.equal(props.country, "NL");
  assert.equal(props.browser, "Edge");
  assert.equal(props.utm_source, "ph");
  assert.equal(props.utm_medium, "social");
  assert.equal(props.foo, undefined);
  const blob = JSON.stringify(insert.params);
  assert.equal(blob.includes("203.0.113.10"), false);
  assert.equal(blob.includes("Mozilla/5.0"), false);
  assert.equal(blob.includes("Edg/120"), false);
});

test("POST /e omits XX country and still inserts", async (t) => {
  resetHits();
  const port = await listen();
  const db = fakeDb();
  setDb(db);
  t.after(() => {
    server.close();
    setDb(null);
  });
  assert.equal((await post(port, PAGE, { "cf-ipcountry": "XX" })).status, 204);
  const props = JSON.parse(db.events[0].props);
  assert.equal(props.country, undefined);
});
```

`PAGE` already exists in this file. `post` already merges extra headers.

- [ ] **Step 2: Run and confirm FAIL**

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: FAIL, `parseCountry is not a function` (or similar).

- [ ] **Step 3: Implement parsers and merge into `handleEvent`**

Add next to `parseReferrer` in `stats-api/server.js`:

```js
function parseCountry(header) {
  const raw = String(header || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(raw) || raw === "XX") return "";
  return raw;
}

function parseBrowser(ua) {
  const s = String(ua || "").toLowerCase();
  if (!s) return "";
  if (s.includes("edg/")) return "Edge";
  if (s.includes("firefox/") || s.includes("fxios/")) return "Firefox";
  if (s.includes("chrome/") || s.includes("crios/")) return "Chrome";
  if (s.includes("safari/") && s.includes("version/")) return "Safari";
  return "Other";
}

const UTM_SAFE = /^[a-zA-Z0-9._-]{1,80}$/;

function parseUtms(u) {
  if (typeof u !== "string") return {};
  try {
    const params = new URL(u).searchParams;
    const out = {};
    for (const key of ["utm_source", "utm_medium", "utm_campaign"]) {
      const v = params.get(key) || "";
      if (UTM_SAFE.test(v)) out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
}
```

Replace the props block in `handleEvent` (after `parseReferrer`, before `if (!db)`):

```js
  const referrer = parseReferrer(body.r);
  let props = { ...parseUtms(body.u) };
  const country = parseCountry(req.headers["cf-ipcountry"]);
  if (country) props.country = country;
  const browser = parseBrowser(ua);
  if (browser) props.browser = browser;
  if (name !== "pageview" && body.p && typeof body.p === "object") {
    const platform = body.p.platform;
    if (PLATFORMS.has(platform)) props.platform = platform;
  }
```

Export `parseCountry`, `parseBrowser`, `parseUtms` from `module.exports`.

- [ ] **Step 4: Run tests**

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: PASS (existing tests plus the new ones).

- [ ] **Step 5: Commit**

```bash
git add stats-api/server.js stats-api/test.js
git commit -m "stats-api: store country, browser, and utm keys in event props"
```

---

### Task 2: Expand `buildStats`

**Files:**
- Modify: `stats-api/server.js`
- Modify: `stats-api/test.js`

**Interfaces:**
- Consumes: Task 1 `props` shape `{ country?, browser?, utm_source?, utm_medium?, utm_campaign?, platform? }`.
- Produces: `clampDays` accepts `90`. `querySince(days, nowMs) -> Date`. `buildStats(rows, days, nowMs)` returns `{ days, visitors, pageviews, downloads, githubStars, docs, changelog, githubRepo, live: {visitors, pageviews}, series: [{day, hour, visitors, pageviews}], pages, referrers, countries, browsers, sources, events, funnels }`. Funnels: `Home to Download`, `Home to Docs`, `Home to GitHub Star`. Totals/series/lists/funnels ignore rows outside the selected range. Live ignores rows older than 30 minutes.

- [ ] **Step 1: Append aggregator tests**

```js
const { buildStats, clampDays, querySince } = require("./server");

test("clampDays accepts 90 and rejects 2", () => {
  assert.equal(clampDays("90"), 90);
  assert.equal(clampDays("2"), 30);
  assert.equal(clampDays("1"), 1);
});

test("buildStats hourly today, live, funnels, and extra totals", () => {
  const now = Date.parse("2026-08-28T12:30:00.000Z");
  const rows = [
    {
      ts: "2026-08-28T12:10:00.000Z",
      name: "pageview",
      path: "/",
      referrer: "producthunt.com",
      visitor: "aaa",
      props: {
        country: "NL",
        browser: "Safari",
        utm_source: "ph",
        utm_medium: "social",
        utm_campaign: "launch",
      },
    },
    {
      ts: "2026-08-28T12:11:00.000Z",
      name: "pageview",
      path: "/",
      referrer: "",
      visitor: "aaa",
      props: { country: "NL", browser: "Safari" },
    },
    {
      ts: "2026-08-28T12:12:00.000Z",
      name: "Download",
      path: "/",
      referrer: "",
      visitor: "aaa",
      props: { platform: "mac", country: "NL", browser: "Safari" },
    },
    {
      ts: "2026-08-28T12:13:00.000Z",
      name: "Download",
      path: "/",
      referrer: "",
      visitor: "aaa",
      props: { platform: "mac" },
    },
    {
      ts: "2026-08-28T11:00:00.000Z",
      name: "Docs",
      path: "/",
      referrer: "",
      visitor: "bbb",
      props: { country: "DE", browser: "Chrome" },
    },
    {
      ts: "2026-08-27T23:50:00.000Z",
      name: "pageview",
      path: "/",
      referrer: "",
      visitor: "ccc",
      props: { country: "US", browser: "Firefox" },
    },
  ];
  const stats = buildStats(rows, 1, now);
  assert.equal(stats.days, 1);
  assert.equal(stats.series.length, 24);
  assert.equal(stats.series[0].hour, 0);
  assert.equal(stats.series[12].pageviews, 2);
  assert.equal(stats.series[12].visitors, 1);
  assert.equal(stats.docs, 1);
  assert.equal(stats.downloads, 2);
  assert.equal(stats.visitors, 2, "aaa + bbb on 28th; ccc is yesterday");
  assert.equal(stats.live.pageviews, 2);
  assert.equal(stats.live.visitors, 1);
  assert.equal(stats.countries[0].code, "NL");
  assert.equal(stats.browsers[0].name, "Safari");
  assert.equal(stats.sources[0].label, "ph / social / launch");
  const homeDl = stats.funnels.find((f) => f.name === "Home to Download");
  assert.equal(homeDl.entered, 1);
  assert.equal(homeDl.converted, 1);
  assert.equal(homeDl.rate, 100);
});

test("querySince includes the live window before midnight", () => {
  const now = Date.parse("2026-08-28T00:10:00.000Z");
  const since = querySince(1, now);
  assert.ok(since.getTime() <= now - 30 * 60 * 1000);
  assert.ok(since.getTime() < Date.parse("2026-08-28T00:00:00.000Z"));
});
```

- [ ] **Step 2: Run and confirm FAIL**

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: FAIL, `querySince is not a function` or `stats.series[0].hour` undefined / `stats.docs` undefined.

- [ ] **Step 3: Replace `clampDays` / `buildStats` and add `querySince`**

```js
const LIVE_MS = 30 * 60 * 1000;

function clampDays(raw) {
  const n = Number(raw);
  if (n === 1 || n === 7 || n === 30 || n === 90) return n;
  return 30;
}

function rangeStartMs(days, nowMs) {
  const end = new Date(nowMs);
  return Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - (days - 1));
}

function querySince(days, nowMs) {
  const live = nowMs - LIVE_MS;
  const start = rangeStartMs(days, nowMs);
  return new Date(Math.min(start, live));
}

function inRange(tsMs, days, nowMs) {
  return tsMs >= rangeStartMs(days, nowMs);
}

function hourKey(ms) {
  const d = new Date(ms);
  return `${utcDay(ms)}T${String(d.getUTCHours()).padStart(2, "0")}`;
}

function sourceLabel(props) {
  const parts = [props.utm_source];
  if (props.utm_medium) parts.push(props.utm_medium);
  if (props.utm_campaign) parts.push(props.utm_campaign);
  return parts.join(" / ");
}

function buildStats(rows, days, nowMs) {
  const hourly = days === 1;
  const series = [];
  if (hourly) {
    const day = utcDay(nowMs);
    for (let h = 0; h < 24; h++) {
      series.push({
        day,
        hour: h,
        visitors: 0,
        pageviews: 0,
        seen: new Set(),
      });
    }
  } else {
    const start = new Date(rangeStartMs(days, nowMs));
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime());
      d.setUTCDate(start.getUTCDate() + i);
      series.push({
        day: d.toISOString().slice(0, 10),
        hour: null,
        visitors: 0,
        pageviews: 0,
        seen: new Set(),
      });
    }
  }
  const bySlot = new Map(
    series.map((s) => [hourly ? `${s.day}T${String(s.hour).padStart(2, "0")}` : s.day, s]),
  );
  const pages = new Map();
  const referrers = new Map();
  const countries = new Map();
  const browsers = new Map();
  const sources = new Map();
  const events = new Map();
  const funnelDays = new Map();
  let pageviews = 0;
  let downloads = 0;
  let githubStars = 0;
  let docs = 0;
  let changelog = 0;
  let githubRepo = 0;
  const liveSeen = new Set();
  let livePageviews = 0;
  const daySeen = new Set();

  for (const row of rows) {
    const tsMs = new Date(row.ts).getTime();
    const props = row.props && typeof row.props === "object" ? row.props : {};
    if (nowMs - tsMs <= LIVE_MS && tsMs <= nowMs) {
      if (row.visitor) liveSeen.add(row.visitor);
      if (row.name === "pageview") livePageviews += 1;
    }
    if (!inRange(tsMs, days, nowMs)) continue;
    const day = utcDay(tsMs);
    const slot = bySlot.get(hourly ? hourKey(tsMs) : day);
    const name = row.name;
    if (row.visitor && slot) slot.seen.add(row.visitor);
    if (row.visitor) daySeen.add(`${day}\0${row.visitor}`);
    if (props.country) countries.set(props.country, (countries.get(props.country) || 0) + 1);
    if (props.browser) browsers.set(props.browser, (browsers.get(props.browser) || 0) + 1);
    if (row.visitor) {
      const fk = `${day}\0${row.visitor}`;
      const f = funnelDays.get(fk) || { home: false, download: false, docs: false, star: false };
      if (name === "pageview" && row.path === "/") f.home = true;
      if (name === "Download") f.download = true;
      if (name === "Docs") f.docs = true;
      if (name === "GitHub Star") f.star = true;
      funnelDays.set(fk, f);
    }
    if (name === "pageview") {
      pageviews += 1;
      if (slot) slot.pageviews += 1;
      pages.set(row.path, (pages.get(row.path) || 0) + 1);
      if (row.referrer) referrers.set(row.referrer, (referrers.get(row.referrer) || 0) + 1);
      if (props.utm_source) {
        const label = sourceLabel(props);
        sources.set(label, (sources.get(label) || 0) + 1);
      }
    } else if (NAMES.has(name)) {
      const platform = props.platform || null;
      const key = `${name}\0${platform || ""}`;
      events.set(key, (events.get(key) || 0) + 1);
      if (name === "Download") downloads += 1;
      if (name === "GitHub Star") githubStars += 1;
      if (name === "Docs") docs += 1;
      if (name === "Changelog") changelog += 1;
      if (name === "GitHub Repo") githubRepo += 1;
    }
  }

  for (const s of series) s.visitors = s.seen.size;
  const visitors = hourly
    ? daySeen.size
    : series.reduce((n, s) => n + s.visitors, 0);
  const top = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20);
  let entered = 0;
  let toDl = 0;
  let toDocs = 0;
  let toStar = 0;
  for (const f of funnelDays.values()) {
    if (!f.home) continue;
    entered += 1;
    if (f.download) toDl += 1;
    if (f.docs) toDocs += 1;
    if (f.star) toStar += 1;
  }
  const rate = (n) => (entered === 0 ? 0 : Math.round((n / entered) * 100));

  return {
    days,
    visitors,
    pageviews,
    downloads,
    githubStars,
    docs,
    changelog,
    githubRepo,
    live: { visitors: liveSeen.size, pageviews: livePageviews },
    series: series.map(({ day, hour, visitors: v, pageviews: p }) => ({
      day,
      hour,
      visitors: v,
      pageviews: p,
    })),
    pages: top(pages).map(([path, count]) => ({ path, count })),
    referrers: top(referrers).map(([host, count]) => ({ host, count })),
    countries: top(countries).map(([code, count]) => ({ code, count })),
    browsers: top(browsers).map(([name, count]) => ({ name, count })),
    sources: top(sources).map(([label, count]) => ({ label, count })),
    events: [...events.entries()].map(([key, count]) => {
      const [name, platform] = key.split("\0");
      return { name, platform: platform || null, count };
    }),
    funnels: [
      { name: "Home to Download", entered, converted: toDl, rate: rate(toDl) },
      { name: "Home to Docs", entered, converted: toDocs, rate: rate(toDocs) },
      { name: "Home to GitHub Star", entered, converted: toStar, rate: rate(toStar) },
    ],
  };
}
```

Hourly visitors for `days=1` summed across 24 hours is the same as summing per-hour distinct (a visitor in two hours counts twice). That matches "sum of per-slot distinct" for Today, analogous to daily sums on longer ranges. The existing 7-day visitor test still uses daily slots.

Wire `querySince` into `handleStats` (replace the `since` block):

```js
    const { rows } = await db.query(
      `SELECT ts, name, path, referrer, visitor, props
         FROM events WHERE ts >= $1
         ORDER BY ts ASC`,
      [querySince(days, nowFn()).toISOString()],
    );
```

Export `querySince`. Keep exporting `buildStats` and `clampDays`.

- [ ] **Step 4: Run tests**

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: PASS. If the existing "visitors sum daily distinct" test fails because `series[].hour` is required internally, it should still pass: `days=2` is not used there (`days=2` is passed as 2, not clamped). That test calls `buildStats(rows, 2, now)` directly with `days=2`, which is neither 1 nor hourly. `buildStats` should treat any `days !== 1` as daily slots of length `days` (do not clamp inside `buildStats`). The snippet above does that.

- [ ] **Step 5: Commit**

```bash
git add stats-api/server.js stats-api/test.js
git commit -m "stats-api: hourly series, live window, funnels, and extra totals"
```

---

### Task 3: Dashboard HTML and architecture note

**Files:**
- Modify: `stats-api/server.js`
- Modify: `stats-api/test.js`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: Task 2 `buildStats` payload and `querySince`.
- Produces: Logged-in `GET /` shows Live, extra totals, Countries, Browsers, Sources, Funnels, `?days=90`, hourly bar labels `HH` when `days=1`, `<meta http-equiv="refresh" content="30">`. Login HTML has no refresh. Empty sentence only when `stats.pageviews === 0 && stats.events.length === 0 && stats.docs === 0 && stats.changelog === 0 && stats.githubRepo === 0 && stats.downloads === 0 && stats.githubStars === 0` (equivalently: no rows in range; use `pageviews + downloads + githubStars + docs + changelog + githubRepo === 0`). No `<script`. No em dash.

- [ ] **Step 1: Append dashboard tests**

```js
test("GET / with bearer shows new sections and refresh", async (t) => {
  const port = await listen();
  setNow(() => Date.parse("2026-08-28T12:00:00.000Z"));
  setDb(
    fakeDb({
      rows: [
        {
          ts: "2026-08-28T11:50:00.000Z",
          name: "Docs",
          path: "/",
          referrer: "",
          visitor: "abc",
          props: { country: "NL", browser: "Safari" },
        },
      ],
    }),
  );
  t.after(() => {
    server.close();
    setDb(null);
    setNow(null);
  });
  const res = await fetch(`http://127.0.0.1:${port}/?days=7`, {
    headers: { authorization: "Bearer secret-token" },
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Live:/);
  assert.match(html, /Docs/);
  assert.match(html, /Changelog/);
  assert.match(html, /GitHub Repo/);
  assert.match(html, /Countries/);
  assert.match(html, /Browsers/);
  assert.match(html, /Sources/);
  assert.match(html, /Funnels/);
  assert.match(html, /Home to Download/);
  assert.match(html, /\?days=90/);
  assert.match(html, /http-equiv="refresh"/);
  assert.equal(html.includes("No events in this range."), false);
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("\u2014"), false);
});

test("login HTML does not auto-refresh", async (t) => {
  const port = await listen();
  t.after(() => server.close());
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.equal(html.includes("http-equiv=\"refresh\""), false);
  assert.match(html, /name="password"/);
});
```

- [ ] **Step 2: Run and confirm FAIL**

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: FAIL on missing `Live:` / `?days=90` / refresh meta.

- [ ] **Step 3: Update `renderDashboard`, `handleHome`, and ARCHITECTURE**

In `renderDashboard`:

- After charset meta, when rendering the logged-in page (this function is only used logged-in): `<meta http-equiv="refresh" content="30">`
- Nav: add `${link(90, "90 days")}`
- Nums grid: add Docs, Changelog, GitHub Repo (seven tiles; CSS `repeat(4, 1fr)` is fine, wraps)
- After nums: `<p class="live">Live: ${stats.live.visitors} visitors, ${stats.live.pageviews} pageviews</p>`
- Bar label: `hourly` when `days === 1` use `String(s.hour).padStart(2, "0")`, else `s.day.slice(5)`
- Empty: `const empty = stats.pageviews + stats.downloads + stats.githubStars + stats.docs + stats.changelog + stats.githubRepo === 0;`
- When not empty, after Events add Countries (`code`), Browsers (`name`), Sources (`label`), Funnels (`<li><span>name</span><b>converted / entered (rate%)</b></li>`)

Use `querySince` in `handleHome` the same way as `handleStats`.

In `docs/ARCHITECTURE.md` replace the Site analytics dashboard row and add one paragraph:

```markdown
`props` may include `platform`, `country` (ISO from `CF-IPCountry`),
`browser` (Chrome / Safari / Firefox / Edge / Other), and
`utm_source` / `utm_medium` / `utm_campaign`. IP and raw User-Agent
are still never stored. Dashboard ranges are 1 / 7 / 30 / 90 days.
`GET /` meta-refreshes every 30 seconds and shows a Live strip
(last 30 minutes) plus three fixed same-day funnels (Home to
Download, Docs, GitHub Star).
```

Change the curl snippet days mention to `1|7|30|90`.

- [ ] **Step 4: Run tests**

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: PASS. Existing empty-range test still matches `No events in this range.` when `rows: []`.

- [ ] **Step 5: Commit**

```bash
git add stats-api/server.js stats-api/test.js docs/ARCHITECTURE.md
git commit -m "stats-api: dashboard live strip, funnels, and 90-day range"
```

---

### Task 4: Graft stats-api to Girder

**Files:**
- None in git beyond what Tasks 1-3 committed.

**Interfaces:**
- Consumes: live `stats-api/` from Tasks 1-3.
- Produces: `girder-stats` main updated. `GET /health` 200. Synthetic `POST /e` with `cf-ipcountry` and a UTM URL is visible on `GET /api/stats?days=1`. Issue #757 comment, then `plan:done` and close.

- [ ] **Step 1: Graft**

```bash
git fetch girder-stats
TREE=$(git rev-parse HEAD:stats-api)
PARENT=$(git rev-parse girder-stats/main)
SHA=$(git commit-tree "$TREE" -p "$PARENT" -F - <<'EOF'
stats-api: countries, browsers, UTMs, live, funnels
EOF
)
git push girder-stats "$SHA":refs/heads/main
```

Expected: Docker build succeeds, deploy line for `solenta-stats`.

- [ ] **Step 2: Health**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://stats.solenta.app/health
```

Expected: `200`.

- [ ] **Step 3: Synthetic event**

Do not print `ADMIN_TOKEN`. Read it from the environment if set, otherwise skip the authenticated assert and only confirm `/health`.

```bash
curl -sS -o /dev/null -w "%{http_code}\n" -X POST https://stats.solenta.app/e \
  -H "content-type: text/plain;charset=UTF-8" \
  -H "origin: https://solenta.app" \
  -H "cf-ipcountry: NL" \
  -H "user-agent: Mozilla/5.0 Edg/120.0" \
  --data '{"n":"pageview","u":"https://solenta.app/?utm_source=ph&utm_medium=social","r":""}'
```

Expected: `204`.

If `ADMIN_TOKEN` is in the environment:

```bash
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://stats.solenta.app/api/stats?days=1" | head -c 400
```

Expected: JSON includes `"countries"` and `"live"`.

- [ ] **Step 4: Close the planboard issue**

```bash
gh issue comment 757 --body "Live: dashboard has countries, browsers, sources, live, funnels, and 90-day range."
gh issue close 757 --reason completed
gh issue edit 757 --remove-label plan:doing --add-label plan:done
```

- [ ] **Step 5: Commit** (none if only remote graft). If Step 4 is the last git-side work, skip.

---

## Self-review

**Spec coverage**

| Spec section | Task |
|---|---|
| Country / browser / UTM ingest, no IP/UA | 1 |
| Visitors daily sum; live 30-min distinct | 2 |
| Hourly Today, 90-day clamp | 2 |
| Extra totals, lists, funnels | 2, 3 |
| Meta refresh, empty sentence, no script | 3 |
| `querySince` includes pre-midnight live | 2 |
| ARCHITECTURE | 3 |
| Girder graft, #757 | 4 |
| No site/ change | not implemented |

**Placeholders:** none.

**Names:** `parseCountry`, `parseBrowser`, `parseUtms`, `querySince`, `LIVE_MS`, `buildStats` return keys match the spec JSON.
