# iOS Simulator Run Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic, durable image/video run-artifact store and transcript surface that later simulator work can use without reusing outbound attachments or provider-specific tool images.

**Architecture:** Artifact bytes live in an app-owned, opaque-ID store while metadata is persisted with the thread. Producers receive temporary staging paths from the store, then atomically commit validated PNG/MP4 batches. Electron and Solenta Web serve bytes through range-capable endpoints; normal thread JSON carries metadata only.

**Tech Stack:** Electron main (CommonJS), Node filesystem/streams, React 19 + TypeScript, custom Electron protocol, HTTP byte ranges, `node:test`.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-08-25-ios-simulator-integration-design.md`. Tracking issue: #248.
- This plan implements only PNG and H.264 MP4 artifacts. Existing `AttachmentInfo`, `ToolCallInfo.images`, `electron/tool-images.js`, and `electron/image-store.js` remain unchanged.
- Limits are exactly 20 MiB/image, 250 MiB and five minutes/video, 500 MiB/thread, and 1 GiB/global.
- Archive retains artifacts. Thread deletion removes them. Rewind makes artifacts from removed runs orphan-cleanup candidates; manual artifacts survive.
- Referenced artifacts are never pruned to make space. Reject new commits with `artifact_limit` after orphan cleanup cannot satisfy a cap.
- Artifact bytes never cross renderer IPC or WebSocket JSON. Web playback uses the existing web token plus thread authorization.
- Use TDD. End every task with its focused tests and a commit.

---

## File Structure

**Create**
- `electron/run-artifact-media.js` — PNG/MP4 magic, dimensions, duration, and supported MIME validation.
- `electron/run-artifact-store.js` — staging, batch commit, metadata persistence, secure lookup, caps, cleanup.
- `electron/artifact-range.js` — pure single-byte-range parsing.
- `electron/test/run-artifact-media.test.js`
- `electron/test/run-artifact-store.test.js`
- `electron/test/artifact-range.test.js`
- `electron/test/web-run-artifacts.test.js`
- `src/runArtifacts.ts` — media URL and display-format helpers.
- `src/components/RunArtifacts.tsx`
- `src/components/RunArtifacts.module.css`
- `test/runArtifacts.test.tsx`

**Modify**
- `src/shared/ipc.ts` — `RunArtifactInfo`, `ThreadDetail.artifacts`, `VerifyResult.artifactIds`.
- `electron/store.js` — `runArtifactsByThread` persistence and methods.
- `electron/services.js` — include artifact metadata in thread detail and schedule cleanup after destructive changes.
- `electron/main.js` — construct the artifact store and inject it into media/Web services.
- `electron/media-protocol.js` — opaque artifact URLs plus `HEAD`/range responses.
- `electron/webServer.js` — authenticated artifact route before SPA fallback.
- `src/threadPatch.ts` — preserve unchanged artifact-array identity.
- `src/timeline.ts` — artifact groups.
- `src/components/ThreadView.tsx` — render artifact timeline entries.
- `electron/test/store.test.js`
- `electron/test/rewind.test.js`
- `electron/test/media-protocol.test.js`
- `test/threadPatch.test.ts`
- `test/timeline.test.ts`
- `test/threadView.test.tsx`

---

### Task 1: Metadata contract and persistence lifecycle

**Files:**
- Modify: `src/shared/ipc.ts:948-1001`, `:1421-1441`, `:1538-1555`
- Modify: `electron/store.js` defaults/load methods and thread removal/truncation paths
- Modify: `electron/services.js:3641-3661`
- Modify: `src/threadPatch.ts:126-168`
- Test: `electron/test/store.test.js`
- Test: `electron/test/rewind.test.js`
- Test: `test/threadPatch.test.ts`

**Interfaces:**
- Produces `RunArtifactInfo`, `Store#getRunArtifacts`, `Store#setRunArtifacts`, and `Store#findRunArtifact`.
- Later tasks consume `ThreadDetail.artifacts ?? []`; the field remains optional for old fixtures and wire clients.

- [ ] **Step 1: Write failing Store and patch tests**

Add a Store test that persists, reloads, finds, archives, and removes metadata:

```js
it("persists run artifacts, retains archive evidence, and removes deleted threads", () => {
  const artifact = {
    id: "a1",
    threadId: thread.id,
    runId: "r1",
    source: "simulator",
    kind: "image",
    mimeType: "image/png",
    name: "screen.png",
    size: 12,
    createdAt: "2026-08-25T12:00:00.000Z",
  };
  store.setRunArtifacts(thread.id, [artifact]);
  store.saveNow();

  const reopened = new Store(store.file);
  assert.deepEqual(reopened.getRunArtifacts(thread.id), [artifact]);
  assert.deepEqual(reopened.findRunArtifact("a1"), {
    threadId: thread.id,
    artifact,
  });

  services.setArchived(reopened, { threadId: thread.id, archived: true });
  assert.equal(reopened.getRunArtifacts(thread.id).length, 1);
  services.deleteThread(reopened, { threadId: thread.id });
  assert.deepEqual(reopened.getRunArtifacts(thread.id), []);
});
```

Add a rewind test with artifacts for retained run `r1`, removed run `r2`, and `runId: null`; assert `r1` and manual remain while `r2` metadata is removed.

Add a `mergeThreadPatch` test:

```ts
it("preserves artifact identity when metadata is unchanged", () => {
  const artifacts: RunArtifactInfo[] = [artifact];
  const prev = { ...detail(), artifacts };
  const next = mergeThreadPatch(prev, { ...patch(), artifacts: [{ ...artifact }] });
  assert.equal(next?.artifacts, artifacts);
});
```

- [ ] **Step 2: Run tests and verify red**

Run:

```sh
node --test electron/test/store.test.js electron/test/rewind.test.js
node --import=./test/support/render.mjs --experimental-strip-types --test test/threadPatch.test.ts
```

Expected: FAIL because `setRunArtifacts` does not exist and `ThreadDetail` has no `artifacts`.

- [ ] **Step 3: Add the shared contracts**

Add beside `ToolCallInfo`:

```ts
export interface RunArtifactInfo {
  id: string;
  threadId: string;
  runId: string | null;
  toolCallId?: string;
  source: "simulator" | "verification" | "browser" | "manual";
  kind: "image" | "video";
  mimeType: "image/png" | "video/mp4";
  name: string;
  size: number;
  createdAt: string;
  width?: number;
  height?: number;
  durationMs?: number;
  posterArtifactId?: string;
}
```

Add to `ThreadDetail` and `VerifyResult`:

```ts
  artifacts?: RunArtifactInfo[];
```

```ts
  artifactIds?: string[];
```

- [ ] **Step 4: Persist metadata in Store**

Add `runArtifactsByThread: {}` to every empty/default data shape. Normalize loaded values to arrays of plain objects. Add these methods near the message/work-log methods:

```js
  getRunArtifacts(threadId) {
    const value = this.data.runArtifactsByThread[String(threadId)];
    return Array.isArray(value) ? value : [];
  }

  setRunArtifacts(threadId, artifacts) {
    const id = String(threadId);
    this.data.runArtifactsByThread[id] = Array.isArray(artifacts)
      ? artifacts.map((artifact) => ({ ...artifact, threadId: id }))
      : [];
    this.markDirty();
  }

  findRunArtifact(id) {
    const wanted = String(id || "");
    for (const [threadId, artifacts] of Object.entries(
      this.data.runArtifactsByThread,
    )) {
      if (!Array.isArray(artifacts)) continue;
      const artifact = artifacts.find((item) => item && item.id === wanted);
      if (artifact) return { threadId, artifact };
    }
    return null;
  }
```

In thread deletion, delete `runArtifactsByThread[threadId]`. In transcript truncation, compute retained non-null run IDs from retained messages/work log and filter only non-null artifact run IDs that no longer exist.

- [ ] **Step 5: Expose metadata and merge patches**

Add to `getThreadDetail`:

```js
    artifacts: store.getRunArtifacts(threadId).slice(),
```

In `mergeThreadPatch`, compare `prev.artifacts` and `rest.artifacts` with `sameJson`, include the identity in the unchanged guard, and return it explicitly:

```ts
  const artifacts = sameJson(prev.artifacts, rest.artifacts)
    ? prev.artifacts
    : rest.artifacts;
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```sh
node --test electron/test/store.test.js electron/test/rewind.test.js
node --import=./test/support/render.mjs --experimental-strip-types --test test/threadPatch.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```sh
git add src/shared/ipc.ts electron/store.js electron/services.js src/threadPatch.ts electron/test/store.test.js electron/test/rewind.test.js test/threadPatch.test.ts
git commit -m "feat: persist run artifact metadata"
```

---

### Task 2: Validated atomic artifact storage

**Files:**
- Create: `electron/run-artifact-media.js`
- Create: `electron/run-artifact-store.js`
- Create: `electron/test/run-artifact-media.test.js`
- Create: `electron/test/run-artifact-store.test.js`

**Interfaces:**
- Consumes Store methods from Task 1.
- Produces `createRunArtifactStore(options)` with `stage`, `commitBatch`, `discard`, `open`, and `cleanup`.

- [ ] **Step 1: Write media-probe tests**

Create fixtures in each test temp directory. Assert:

```js
assert.deepEqual(await probeRunArtifact(pngPath, {
  kind: "image",
  mimeType: "image/png",
}), { mimeType: "image/png", size: png.length, width: 2, height: 3 });

await assert.rejects(
  probeRunArtifact(fakePngPath, { kind: "image", mimeType: "image/png" }),
  (err) => err.code === "invalid_artifact",
);

const mp4 = await probeRunArtifact(mp4Path, {
  kind: "video",
  mimeType: "video/mp4",
});
assert.equal(mp4.durationMs, 2_000);
```

Use a minimal checked-in test builder that writes a PNG signature + IHDR and an ISO-BMFF `ftyp` + `moov/mvhd` fixture; no external codec tool is required.

- [ ] **Step 2: Run probe tests and verify red**

Run: `node --test electron/test/run-artifact-media.test.js`

Expected: FAIL with `Cannot find module '../run-artifact-media.js'`.

- [ ] **Step 3: Implement bounded PNG/MP4 probing**

Export:

```js
function artifactError(code, message) {
  const error = new Error(message);
  error.name = "RunArtifactError";
  error.code = code;
  return error;
}

async function probeRunArtifact(file, expected, limits = DEFAULT_LIMITS) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw artifactError("invalid_artifact", "Artifact must be a regular file");
  }
  const max =
    expected.kind === "image" ? limits.maxImageBytes : limits.maxVideoBytes;
  if (stat.size <= 0 || stat.size > max) {
    throw artifactError("artifact_limit", "Artifact exceeds its size limit");
  }
  return expected.kind === "image"
    ? probePng(file, stat.size)
    : probeMp4(file, stat.size, limits.maxVideoDurationMs);
}
```

`probePng` validates the 8-byte signature and reads width/height from IHDR offsets 16/20. `probeMp4` walks bounded top-level boxes, requires `ftyp`, descends into `moov`, reads `mvhd` version 0 or 1 timescale/duration, and rejects zero/over-limit duration. Reject boxes whose declared end exceeds file size.

- [ ] **Step 4: Write artifact-store tests**

Cover:

- stage path lives under `run-artifacts/.staging`;
- tokens and final IDs are opaque UUIDs;
- caller never supplies an absolute path;
- `commitBatch` validates every item before metadata changes;
- a two-item video/poster batch appears together;
- wrong thread lookup returns null;
- symlink stage/final files are rejected;
- injected tiny thread/global caps reject without deleting referenced metadata;
- cleanup removes stale staging and unreferenced final files only.

The happy-path assertion:

```js
const staged = await artifacts.stage({
  kind: "image",
  mimeType: "image/png",
});
await fs.promises.writeFile(staged.path, pngFixture(2, 3));
const [info] = await artifacts.commitBatch({
  threadId: thread.id,
  runId: "r1",
  source: "simulator",
  items: [{
    key: "screen",
    stagingToken: staged.token,
    kind: "image",
    mimeType: "image/png",
    name: "Simulator screenshot.png",
  }],
});
assert.equal(info.path, undefined);
assert.deepEqual(await artifacts.open({ id: info.id, threadId: thread.id }), {
  info,
  path: path.join(root, thread.id, "r1", `${info.id}.png`),
  size: info.size,
});
```

- [ ] **Step 5: Run store tests and verify red**

Run: `node --test electron/test/run-artifact-store.test.js`

Expected: FAIL with `Cannot find module '../run-artifact-store.js'`.

- [ ] **Step 6: Implement the store**

Export:

```js
function createRunArtifactStore({
  userDataPath,
  store,
  now = Date.now,
  randomUUID = crypto.randomUUID,
  probeFile = probeRunArtifact,
  limits = {},
}) {
  const root = path.join(userDataPath, "run-artifacts");
  const staged = new Map();

  return {
    stage,
    commitBatch,
    discard,
    open,
    cleanup,
  };
}
```

`stage` creates a `0600` file path beneath `.staging`, stores `{ token, path, kind, mimeType, createdAt }` in memory, and returns only token/path to trusted main-process producers.

`commitBatch` must:

1. validate thread existence and every token;
2. probe every staged file;
3. calculate current referenced thread/global bytes plus this batch;
4. call cleanup once if a cap would be crossed, then recalculate;
5. reject with `artifact_limit` if still over;
6. create `threadId/runId-or-manual`;
7. rename every staged file to `<artifactId>.<png|mp4>`;
8. set `posterArtifactId` by resolving `posterKey` inside the same batch;
9. call `store.setRunArtifacts` once and `store.saveNow()`; and
10. roll back renamed files if metadata persistence throws.

`open` uses `findRunArtifact`, enforces optional thread equality, `lstat`s a regular non-symlink file, verifies `realpath` remains under the artifact root, and returns metadata/path/size.

- [ ] **Step 7: Run focused tests and commit**

Run:

```sh
node --test electron/test/run-artifact-media.test.js electron/test/run-artifact-store.test.js
```

Expected: PASS.

Commit:

```sh
git add electron/run-artifact-media.js electron/run-artifact-store.js electron/test/run-artifact-media.test.js electron/test/run-artifact-store.test.js
git commit -m "feat: add atomic image and video artifact store"
```

---

### Task 3: Desktop and Web byte-range delivery

**Files:**
- Create: `electron/artifact-range.js`
- Modify: `electron/media-protocol.js`
- Modify: `electron/webServer.js`
- Modify: `electron/main.js`
- Create: `electron/test/artifact-range.test.js`
- Modify: `electron/test/media-protocol.test.js`
- Create: `electron/test/web-run-artifacts.test.js`

**Interfaces:**
- Consumes `RunArtifactStore#open`.
- Produces `artifactUrl(id)`, Electron `solenta-media://artifact/<id>`, and authenticated `GET|HEAD /api/run-artifacts/:threadId/:id`.

- [ ] **Step 1: Write pure range tests**

Assert full, explicit, open-ended, suffix, malformed, multiple, and unsatisfiable ranges:

```js
assert.deepEqual(resolveByteRange(undefined, 100), {
  status: 200, start: 0, end: 99, length: 100,
});
assert.deepEqual(resolveByteRange("bytes=10-19", 100), {
  status: 206, start: 10, end: 19, length: 10,
});
assert.deepEqual(resolveByteRange("bytes=-5", 100), {
  status: 206, start: 95, end: 99, length: 5,
});
assert.deepEqual(resolveByteRange("bytes=200-300", 100), { status: 416 });
assert.deepEqual(resolveByteRange("bytes=0-1,5-6", 100), { status: 416 });
```

- [ ] **Step 2: Run and verify red**

Run: `node --test electron/test/artifact-range.test.js`

Expected: FAIL because `artifact-range.js` is absent.

- [ ] **Step 3: Implement the range helper**

Export `resolveByteRange(header, size)`. Accept only `bytes=<one-range>`, clamp the end to `size - 1`, and return 416 for invalid/multiple/empty/unsatisfiable input.

- [ ] **Step 4: Extend media protocol tests first**

Add tests for:

```js
assert.equal(artifactUrl("a1"), "solenta-media://artifact/a1");
assert.deepEqual(parseMediaUrl("solenta-media://artifact/a1"), {
  kind: "artifact",
  id: "a1",
});
```

Install a handler with a fake artifact store and assert `GET`, `HEAD`, `bytes=2-5`, 404, and 416 responses include exact `Content-Type`, `Accept-Ranges`, `Content-Length`, and `Content-Range`.

- [ ] **Step 5: Implement Electron delivery**

Add:

```js
function artifactUrl(id) {
  const value = String(id || "");
  return SAFE_ID_RE.test(value)
    ? `${SCHEME}://artifact/${encodeURIComponent(value)}`
    : null;
}
```

Widen `installHandler` options with `getArtifactStore`. For artifacts, open by opaque ID, parse `request.headers.get("range")`, and return a `Response` backed by `Readable.toWeb(fs.createReadStream(path, { start, end }))`. Preserve the current `net.fetch(file:)` path for tool/local images.

- [ ] **Step 6: Write Web route tests**

Start the Web server with `artifactStore` and assert:

- no/wrong token -> 401;
- wrong thread -> 404;
- valid `?token=` -> 200;
- `HEAD` returns no bytes;
- valid range -> 206;
- unsatisfiable -> 416;
- static SPA fallback is not used for `/api/run-artifacts/...`.

- [ ] **Step 7: Implement authenticated Web delivery**

Add `opts.artifactStore`. Before `serveStatic`, parse:

```js
const match = /^\/api\/run-artifacts\/([^/]+)\/([^/?]+)$/.exec(url.pathname);
```

Require `GET`/`HEAD`, compare `url.searchParams.get("token")` with the server token using a helper that first checks equal `Buffer.byteLength` and then calls `crypto.timingSafeEqual`, call `artifactStore.open({ id, threadId })`, and stream the resolved range. Set:

```js
{
  "Content-Type": opened.info.mimeType,
  "Accept-Ranges": "bytes",
  "Content-Length": String(range.length),
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
}
```

Construct one artifact store in `main.js` after Store load, inject a getter into the early media handler, pass the instance to `startWebServer`, and schedule `artifactStore.cleanup()` with boot retention.

- [ ] **Step 8: Run focused tests and commit**

Run:

```sh
node --test electron/test/artifact-range.test.js electron/test/media-protocol.test.js electron/test/web-run-artifacts.test.js
```

Expected: PASS.

Commit:

```sh
git add electron/artifact-range.js electron/media-protocol.js electron/webServer.js electron/main.js electron/test/artifact-range.test.js electron/test/media-protocol.test.js electron/test/web-run-artifacts.test.js
git commit -m "feat: stream run artifacts over desktop and web"
```

---

### Task 4: Transcript artifact groups and media cards

**Files:**
- Create: `src/runArtifacts.ts`
- Create: `src/components/RunArtifacts.tsx`
- Create: `src/components/RunArtifacts.module.css`
- Modify: `src/timeline.ts`
- Modify: `src/components/ThreadView.tsx`
- Create: `test/runArtifacts.test.tsx`
- Modify: `test/timeline.test.ts`
- Modify: `test/threadView.test.tsx`

**Interfaces:**
- Consumes `ThreadDetail.artifacts`.
- Produces artifact timeline groups and image/video cards. Existing image-lightbox delegation remains the zoom implementation.

- [ ] **Step 1: Write timeline tests**

Add:

```ts
const entries = buildTimeline(messages, workLog, [
  { ...image, runId: "r1", toolCallId: "t1", createdAt: "2026-08-25T12:00:00Z" },
  { ...video, runId: "r1", toolCallId: "t1", createdAt: "2026-08-25T12:00:01Z" },
  { ...manual, runId: null, createdAt: "2026-08-25T12:00:02Z" },
]);
const groups = entries.filter((entry) => entry.kind === "artifacts");
assert.equal(groups.length, 2);
assert.deepEqual(groups[0].artifacts.map((a) => a.id), ["image", "video"]);
assert.equal(groups[1].runId, null);
```

- [ ] **Step 2: Run and verify red**

Run: `node --import=./test/support/render.mjs --experimental-strip-types --test test/timeline.test.ts`

Expected: FAIL because `buildTimeline` accepts only two arguments and emits no artifacts.

- [ ] **Step 3: Add timeline artifact groups**

Add:

```ts
export interface ArtifactGroup {
  kind: "artifacts";
  key: string;
  runId: string | null;
  toolCallId?: string;
  artifacts: RunArtifactInfo[];
  timestamp: number;
}
```

Group by `${runId ?? "manual"}\0${toolCallId ?? ""}`, sort each group by parsed `createdAt` then ID, and sort ties after the originating message but before work log. Invalid dates sort at zero without throwing.

- [ ] **Step 4: Write component tests**

Render one image, one video with poster, and one missing URL. Assert image alt/src, `<video controls preload="metadata">`, poster URL, download link, duration label, run/source label, and unavailable state. `ThreadView`'s existing delegated click handler opens every timeline `<img>` and needs no artifact-specific attribute.

- [ ] **Step 5: Add URL helpers and component**

`src/runArtifacts.ts` exports:

```ts
import { resolveWebToken } from "./coderApi";
import { isWebMode } from "./shared/wire";

export function runArtifactMediaUrl(
  threadId: string,
  artifactId: string,
): string {
  if (!isWebMode()) {
    return `solenta-media://artifact/${encodeURIComponent(artifactId)}`;
  }
  const token = resolveWebToken() ?? "";
  return `/api/run-artifacts/${encodeURIComponent(threadId)}/${encodeURIComponent(artifactId)}?token=${encodeURIComponent(token)}`;
}

export function artifactDurationLabel(durationMs?: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs! < 0) return null;
  const seconds = Math.round(durationMs! / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
```

`RunArtifacts` resolves posters from the full thread artifact array, renders ordinary `<img>` elements for images and `<video controls>` for videos, and never displays a host path.

- [ ] **Step 6: Integrate ThreadView**

Pass `detail?.artifacts ?? []` to `buildTimeline`. Add an `entry.kind === "artifacts"` branch adjacent to work-log rendering:

```tsx
<RunArtifacts
  threadId={detail.thread.id}
  group={entry}
  allArtifacts={detail.artifacts ?? []}
/>
```

Use group key `artifacts:${entry.key}`. Do not add a second lightbox state; preserve the existing delegated click handler.

- [ ] **Step 7: Run renderer tests and commit**

Run:

```sh
node --import=./test/support/render.mjs --experimental-strip-types --test test/timeline.test.ts test/threadPatch.test.ts test/runArtifacts.test.tsx test/threadView.test.tsx
npm run typecheck
```

Expected: PASS.

Commit:

```sh
git add src/runArtifacts.ts src/components/RunArtifacts.tsx src/components/RunArtifacts.module.css src/timeline.ts src/components/ThreadView.tsx test/runArtifacts.test.tsx test/timeline.test.ts test/threadView.test.tsx
git commit -m "feat: render image and video run artifacts"
```

---

### Task 5: Lifecycle cleanup and complete artifact verification

**Files:**
- Modify: `electron/services.js` rewind/delete hooks
- Modify: `electron/main.js` retention/shutdown hooks
- Extend: artifact Store/service tests

**Interfaces:**
- Consumes `RunArtifactStore#cleanup`.
- Produces best-effort orphan cleanup after durable metadata changes without deleting referenced archived evidence.

- [ ] **Step 1: Add lifecycle tests**

Inject a fake artifact store and prove:

- rewind saves filtered metadata before cleanup starts;
- failed rewind does not clean;
- successful thread deletion schedules cleanup;
- archive does not delete metadata or bytes;
- boot retention invokes cleanup once;
- cleanup failure is logged and never fails thread operations.

- [ ] **Step 2: Run lifecycle tests and verify red**

Run:

```sh
node --test electron/test/rewind.test.js electron/test/store.test.js electron/test/web-run-artifacts.test.js
```

Expected: FAIL because cleanup is not called after metadata removal.

- [ ] **Step 3: Add best-effort cleanup scheduling**

Add one injected callback/service dependency rather than requiring `run-artifact-store.js` from `services.js`. Call it only after the Store mutation is durable:

```js
function scheduleArtifactCleanup(ctx) {
  if (!ctx || typeof ctx.cleanupRunArtifacts !== "function") return;
  Promise.resolve()
    .then(() => ctx.cleanupRunArtifacts())
    .catch((err) => ctx.log?.(`run-artifacts: cleanup failed: ${err.message}`));
}
```

Wire `cleanupRunArtifacts: () => runArtifactStore.cleanup()` from main/IPC contexts.

- [ ] **Step 4: Run full verification**

Run:

```sh
npm run typecheck
npm run build
npm run test:electron
npm run test:renderer
npm test
```

Expected: all suites pass.

- [ ] **Step 5: Commit**

```sh
git add electron/services.js electron/main.js electron/test/rewind.test.js electron/test/store.test.js
git commit -m "fix: clean orphaned run artifacts after durable lifecycle changes"
```

## Self-Review Coverage

- Durable PNG/MP4 model and limits: Tasks 1–2
- Atomic staging and batch registration: Task 2
- Archive/delete/rewind retention: Tasks 1 and 5
- Electron and authenticated Web range delivery: Task 3
- Metadata-only wire behavior: Tasks 1 and 3
- Transcript image/video rendering and posters: Task 4
- `VerifyResult.artifactIds`: Task 1
- Simulator capture production, helper, MCP, PR publishing, and annotations are intentionally deferred to later plans.
