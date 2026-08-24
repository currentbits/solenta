# Light-mode Website Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all four tracked product screenshots with repeatable 1680 by 1050 light-mode captures, regenerate the two social cards, publish cache-busted references, and deploy the result.

**Architecture:** A dedicated Electron capture script drives the existing `VITE_TRAILER=1` browser fixture, forces the persisted light theme, navigates to four named scenes, and writes normalized PNGs. A plain Node test locks screenshot dimensions and public cache-busting references. The existing Firefox renderer derives both social cards from the new main screenshot.

**Tech Stack:** Electron `BrowserWindow.capturePage`, Vite browser fixtures, Node `node:test`, static HTML, Firefox headless rendering, Girder git deployment.

## Global Constraints

- Capture all four tracked `screen-*.png` assets from the existing `acme/nebula` fixture.
- Every product screenshot must be exactly 1680 by 1050 pixels.
- Persist `solenta-theme=light`, reload, and require `data-theme="light"` before capture.
- Keep the existing fixture content, website layout, screenshot frames, social-card layout, and social-card copy.
- Regenerate both `site/assets/og.png` and `site/assets/card.png`.
- Use `?v=2` for public `screen-main.png`, `screen-agents.png`, and `card.png` references.
- Do not use live or private project data.
- Do not change application theme tokens or add new screenshot sections.
- Visible website copy must not introduce em dashes.

---

### Task 1: Deterministic light-mode capture pipeline

**Files:**
- Create: `scripts/capture-site-screenshots.js`
- Create: `electron/test/site-screenshots.test.js`
- Replace: `site/assets/screen-main.png`
- Replace: `site/assets/screen-agents.png`
- Replace: `site/assets/screen-automations.png`
- Replace: `site/assets/screen-kanban.png`

**Interfaces:**
- Consumes: browser fixture at `SITE_SCREENSHOT_URL` or `http://localhost:5173`, `data-thread-card`, `data-panel-tab`, `data-view-nav`, `data-automations`, and `data-kanban`.
- Produces: four deterministic 1680 by 1050 PNG files in `site/assets/`.

- [ ] **Step 1: Write the failing screenshot-dimension test**

Create `electron/test/site-screenshots.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const ASSETS = path.join(ROOT, "site", "assets");
const SCREENSHOTS = [
  "screen-main.png",
  "screen-agents.png",
  "screen-automations.png",
  "screen-kanban.png",
];

function pngSize(file) {
  const data = fs.readFileSync(file);
  assert.equal(
    data.subarray(1, 4).toString("ascii"),
    "PNG",
    `${path.basename(file)} must be a PNG`,
  );
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

test("site product screenshots use the canonical 1680x1050 canvas", () => {
  for (const name of SCREENSHOTS) {
    assert.deepEqual(
      pngSize(path.join(ASSETS, name)),
      { width: 1680, height: 1050 },
      name,
    );
  }
});
```

- [ ] **Step 2: Run the test and verify the existing mixed dimensions fail**

Run:

```bash
node --test electron/test/site-screenshots.test.js
```

Expected: FAIL for `screen-agents.png`, `screen-automations.png`, and `screen-kanban.png`. The existing `screen-main.png` may already pass.

- [ ] **Step 3: Add the deterministic capture script**

Create `scripts/capture-site-screenshots.js`:

```js
// Capture the four public website screenshots from deterministic browser fixtures.
// Usage:
//   VITE_TRAILER=1 npm run dev:browser
//   npx electron scripts/capture-site-screenshots.js
"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const URL = process.env.SITE_SCREENSHOT_URL || "http://localhost:5173";
const OUT = path.join(__dirname, "..", "site", "assets");
const WIDTH = 1680;
const HEIGHT = 1050;
const THREAD_ID = "thread-1";

app.commandLine.appendSwitch("force-device-scale-factor", "1");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(win, source) {
  return win.webContents.executeJavaScript(source);
}

async function waitFor(win, expression, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await run(win, `Boolean(${expression})`)) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function click(win, selector, label) {
  const clicked = await run(
    win,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`could not click ${label}`);
  await sleep(250);
}

async function clickTab(win, label) {
  const clicked = await run(
    win,
    `(() => {
      const button = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent.trim() === ${JSON.stringify(label)}
      );
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`could not click ${label} tab`);
  await sleep(250);
}

async function selectThread(win) {
  await click(
    win,
    `[data-thread-card="${THREAD_ID}"] button`,
    `thread ${THREAD_ID}`,
  );
  await waitFor(
    win,
    `document.body.textContent.includes("Modernize Per-Device Provider Settings")`,
    "selected seeded thread",
  );
}

async function capture(win, name, expectedSelector) {
  await waitFor(win, `document.querySelector(${JSON.stringify(expectedSelector)})`, name);
  await run(win, `document.fonts && document.fonts.ready`);
  await sleep(400);
  let image = await win.webContents.capturePage();
  const size = image.getSize();
  if (size.width !== WIDTH || size.height !== HEIGHT) {
    image = image.resize({ width: WIDTH, height: HEIGHT, quality: "best" });
  }
  const target = path.join(OUT, name);
  fs.writeFileSync(target, image.toPNG());
  const written = image.getSize();
  if (written.width !== WIDTH || written.height !== HEIGHT) {
    throw new Error(`${name}: wrote ${written.width}x${written.height}`);
  }
  console.log(`wrote ${target}`);
}

async function prepare(win) {
  await win.loadURL(URL);
  await run(
    win,
    `localStorage.setItem("solenta-theme", "light"); location.reload(); "reloading"`,
  );
  await waitFor(
    win,
    `document.documentElement.getAttribute("data-theme") === "light"`,
    "light theme",
  );
  await run(win, `document.querySelector("[data-web-token-gate]")?.remove(); "ok"`);
  await waitFor(win, `document.querySelector("[data-thread-card]")`, "fixture threads");
  await selectThread(win);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    backgroundColor: "#f3f5f8",
    webPreferences: {
      offscreen: true,
      partition: `site-shots-${Date.now()}`,
    },
  });

  try {
    await prepare(win);

    await clickTab(win, "Environment");
    await capture(win, "screen-main.png", `[data-thread-card="${THREAD_ID}"]`);

    await clickTab(win, "Agents");
    await capture(win, "screen-agents.png", `[data-thread-card="${THREAD_ID}"]`);

    await click(win, "[data-panel-tab='pulse']", "Pulse tab");
    await click(win, "[data-view-nav='automations']", "Automations");
    await clickTab(win, "Environment");
    await capture(win, "screen-automations.png", "[data-automations]");

    await click(win, "[data-view-nav='kanban']", "Kanban");
    await clickTab(win, "Environment");
    await capture(win, "screen-kanban.png", "[data-kanban]");
  } catch (error) {
    console.error("site screenshot capture failed:", error?.stack || error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
```

- [ ] **Step 4: Start the deterministic fixture server**

Before starting another server, inspect existing terminals for an active `npm run dev:browser`. If none is running, start:

```bash
VITE_TRAILER=1 npm run dev:browser
```

Expected: Vite reports a local URL, normally `http://localhost:5173`.

- [ ] **Step 5: Capture all four screenshots**

Run:

```bash
npx electron scripts/capture-site-screenshots.js
```

If Vite selected another port, run:

```bash
SITE_SCREENSHOT_URL=http://localhost:<port> npx electron scripts/capture-site-screenshots.js
```

Expected: four `wrote .../site/assets/screen-*.png` lines and exit code 0.

- [ ] **Step 6: Run the dimension test and verify it passes**

Run:

```bash
node --test electron/test/site-screenshots.test.js
```

Expected: 1 test passed, 0 failed.

- [ ] **Step 7: Inspect all four PNGs**

Open each PNG and verify:

- the app background and panels use the light theme;
- `screen-main.png` shows the seeded thread and Environment;
- `screen-agents.png` shows the same thread and Agents;
- `screen-automations.png` shows Automations and Environment;
- `screen-kanban.png` shows Kanban and Environment;
- no token gate, modal, tooltip, private data, or clipped content is visible.

- [ ] **Step 8: Commit the capture pipeline and screenshots**

```bash
git add scripts/capture-site-screenshots.js \
  electron/test/site-screenshots.test.js \
  site/assets/screen-main.png \
  site/assets/screen-agents.png \
  site/assets/screen-automations.png \
  site/assets/screen-kanban.png
git commit -m "site: recapture product screenshots in light mode"
```

### Task 2: Social previews and cache-busted public references

**Files:**
- Modify: `electron/test/site-screenshots.test.js`
- Modify: `site/index.html`
- Modify: `site/docs.html`
- Modify: `site/changelog.html`
- Replace: `site/assets/og.png`
- Replace: `site/assets/card.png`

**Interfaces:**
- Consumes: `site/assets/screen-main.png`, `site/og-card.html`, and `scripts/render-og.sh`.
- Produces: 1200 by 630 `og.png` and `card.png`, plus `?v=2` public URLs.

- [ ] **Step 1: Extend the test with social-card and URL contracts**

Append to `electron/test/site-screenshots.test.js`:

```js
const SITE = path.join(ROOT, "site");
const PAGE_FILES = ["index.html", "docs.html", "changelog.html"];
const CARD_URL = "https://solenta.app/assets/card.png?v=2";

test("social preview images use the canonical 1200x630 canvas", () => {
  for (const name of ["og.png", "card.png"]) {
    assert.deepEqual(
      pngSize(path.join(ASSETS, name)),
      { width: 1200, height: 630 },
      name,
    );
  }
});

test("public screenshot and social-card URLs carry the light capture version", () => {
  const index = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  assert.match(index, /src="assets\/screen-main\.png\?v=2"/);
  assert.match(index, /src="assets\/screen-agents\.png\?v=2"/);

  for (const page of PAGE_FILES) {
    const html = fs.readFileSync(path.join(SITE, page), "utf8");
    assert.ok(html.includes(CARD_URL), `${page} must reference ${CARD_URL}`);
    assert.doesNotMatch(
      html,
      /https:\/\/solenta\.app\/assets\/card\.png"/,
      `${page} must not retain an unversioned card URL`,
    );
  }
});
```

- [ ] **Step 2: Run the test and verify the unversioned HTML fails**

Run:

```bash
node --test electron/test/site-screenshots.test.js
```

Expected: the screenshot-dimension and social-card-dimension tests pass; the public URL test fails because HTML still uses unversioned image URLs.

- [ ] **Step 3: Add query version 2 to visible screenshots**

In `site/index.html`, change only these two image URLs:

```html
<img src="assets/screen-main.png?v=2" alt="Solenta running a thread: work log, agent messages, and the environment panel with PR checks" />
```

```html
<img src="assets/screen-agents.png?v=2" alt="The Agents panel showing a workflow with phases Seed, Analyze, Verify, Judge and Synthesize" />
```

- [ ] **Step 4: Version every public social-card URL**

In `site/index.html`, `site/docs.html`, and `site/changelog.html`, replace every:

```text
https://solenta.app/assets/card.png
```

with:

```text
https://solenta.app/assets/card.png?v=2
```

This applies to `link rel="image_src"`, `og:image`, `og:image:secure_url`, and `twitter:image`.

- [ ] **Step 5: Render both social-preview images**

Run:

```bash
bash scripts/render-og.sh
```

Expected:

- Firefox exits 0;
- `sips` reports 1200 by 630;
- the script reports both `og.png` and `card.png` written.

- [ ] **Step 6: Run all site asset tests**

Run:

```bash
node --test electron/test/site-screenshots.test.js \
  electron/test/site-downloads.test.js
```

Expected: all tests pass with 0 failures.

- [ ] **Step 7: Inspect both social cards**

Open `site/assets/og.png` and `site/assets/card.png`. Verify they are visually identical, retain the existing card background/layout/copy, and embed the new light-mode main screenshot without clipping.

- [ ] **Step 8: Commit social previews and public references**

```bash
git add electron/test/site-screenshots.test.js \
  site/index.html site/docs.html site/changelog.html \
  site/assets/og.png site/assets/card.png
git commit -m "site: refresh social previews for light screenshots"
```

### Task 3: Verify and deploy the light screenshot set

**Files:**
- Verify: `scripts/capture-site-screenshots.js`
- Verify: `electron/test/site-screenshots.test.js`
- Verify: `site/assets/screen-*.png`
- Verify: `site/assets/og.png`
- Verify: `site/assets/card.png`
- Update externally: GitHub issue `#690`

**Interfaces:**
- Consumes: committed `site/` tree and Girder remote `ssh://git@100.112.17.24:2222/solenta.git`.
- Produces: a fast-forward Girder site graft and verified public image URLs.

- [ ] **Step 1: Run the final local verification**

Run:

```bash
node --test electron/test/site-screenshots.test.js \
  electron/test/site-downloads.test.js
git status --short --branch
```

Expected: all tests pass; the working tree is clean.

- [ ] **Step 2: Review the complete implementation diff**

Run:

```bash
git diff origin/main...HEAD -- \
  scripts/capture-site-screenshots.js \
  electron/test/site-screenshots.test.js \
  site/
```

Confirm the diff contains only capture tooling, the six intended PNG replacements, and cache-busted image references.

- [ ] **Step 3: Build a fast-forward Girder graft**

Run:

```bash
git fetch girder main
GRAFT_TREE=$(git rev-parse HEAD:site)
GRAFT_PARENT=$(git rev-parse girder/main)
GRAFT_SHA=$(git commit-tree "$GRAFT_TREE" -p "$GRAFT_PARENT" -F - <<'EOF'
site: publish light-mode product screenshots

Replace the public product captures and social cards with deterministic
light-mode renders, with versioned URLs that bypass stale edge caches.
EOF
)
git merge-base --is-ancestor "$GRAFT_PARENT" "$GRAFT_SHA"
git diff --stat "$GRAFT_PARENT".."$GRAFT_SHA"
```

Expected: the ancestry check exits 0 and the stat lists the intended HTML and image changes.

- [ ] **Step 4: Deploy through Girder**

Run:

```bash
git push girder "$GRAFT_SHA":main
```

Expected: Docker build succeeds, image scan reports 0 HIGH/CRITICAL vulnerabilities, and the push fast-forwards `main`.

- [ ] **Step 5: Verify public screenshot URLs**

Run:

```bash
for asset in \
  'screen-main.png?v=2' \
  'screen-agents.png?v=2' \
  'screen-automations.png' \
  'screen-kanban.png' \
  'og.png' \
  'card.png?v=2'
do
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    "https://solenta.app/assets/$asset")
  printf '%s %s\n' "$asset" "$code"
  test "$code" = "200"
done
```

Expected: every asset prints `200`.

- [ ] **Step 6: Verify the live HTML references the new assets**

Run:

```bash
html=$(curl -fsS 'https://solenta.app/')
case "$html" in
  *'screen-main.png?v=2'*'screen-agents.png?v=2'*'card.png?v=2'*) ;;
  *) echo "live HTML does not reference all light screenshot assets" >&2; exit 1 ;;
esac
```

Expected: exit code 0.

- [ ] **Step 7: Inspect the live site**

Open `https://solenta.app/` at desktop and mobile widths. Verify the hero and Agents screenshots are light, correctly framed, and do not overflow. Open `https://solenta.app/assets/card.png?v=2` and verify the regenerated social card.

- [ ] **Step 8: Complete the Planboard issue**

Run:

```bash
gh issue edit 690 --remove-label plan:doing --add-label plan:done
gh issue comment 690 --body "Light-mode product screenshots and social previews are deployed and verified live. All site asset tests pass."
gh issue close 690 --reason completed
```

Expected: issue `#690` is closed with label `plan:done`.
