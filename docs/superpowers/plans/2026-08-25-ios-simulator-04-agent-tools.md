# iOS Simulator Agent Tools and Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each eligible local macOS agent run a thread-bound `simulator` MCP tool with provider-neutral actions, host-owned approvals, artifact results, and visible pane focus.

**Architecture:** A separate `/simulator-mcp` endpoint accepts only short-lived run-scoped bearer tokens; the app-wide `coder-threads` credential cannot invoke it. Provider adapters receive `coder-simulator` as per-run MCP material, never as a global token. A main-process approval broker blocks mutating actions independently of provider permission mode and revalidates lease/path/run state immediately before execution.

**Tech Stack:** MCP Streamable HTTP, Electron main (CommonJS), provider CLI adapters, React/TypeScript permission UI, `node:test`.

## Global Constraints

- Complete plans 01–03 first.
- Design spec: `docs/superpowers/specs/2026-08-25-ios-simulator-integration-design.md`. Tracking issue: #248.
- The simulator MCP endpoint and token are separate from `coder-threads`; app-wide tokens must receive 401 from `/simulator-mcp`.
- The tool schema accepts no `threadId`, `projectId`, `runId`, provider, host path, arbitrary command, or raw helper request.
- Run identity is derived exclusively from an in-memory bearer-token record. Tokens are never persisted, placed in argv/query strings, logged, telemetered, or returned.
- Provider bypass/force/always-approve modes do not bypass Solenta simulator approvals.
- Lifecycle and input may be allowed once or for the current run. URL and recording start are per invocation. Takeover remains user-only.
- Read actions still require the run's owning lease. Stop-recording must remain available without a new prompt.
- Canonicalize/freeze operation and lease generation before prompting; revalidate run, owner, generation, and app path after approval.
- Never log typed text or accessibility secure values. Prompt summaries show lengths/targets, not secret payloads.
- Use TDD and commit after every task.

---

## File Structure

**Create**
- `electron/simulator/runIdentity.js`
- `electron/simulator/approvalBroker.js`
- `electron/simulator/actions.js`
- `electron/test/simulator-run-identity.test.js`
- `electron/test/simulator-approval.test.js`

**Modify**
- `electron/orchServer.js` — `/simulator-mcp`, one-tool server, scoped context.
- `electron/runner.js` — issue/inject/revoke identity; merge host permissions.
- `electron/memory-sup.js` — per-run extra MCP servers for each provider.
- `electron/main.js` — construct brokers and inject dependencies.
- `electron/providers.js` where provider launch options are declared.
- `electron/ipc.js` — route permission response and desktop focus push context.
- `electron/webBridge.js` — retain simulator push/invoke denial from plan 03.
- `src/shared/ipc.ts` — host permission metadata and focus payload.
- `src/shared/ipcChannels.ts`, `electron/preload.js` — focus push if not already added.
- `src/useCoder.ts` — subscribe to simulator focus.
- `src/components/ThreadView.tsx` — host prompt copy and pane auto-open/focus.
- `src/components/ThreadView.module.css` only if existing permission styles cannot express the host prompt.
- Provider and orchestrator tests listed below.

---

### Task 1: Run-scoped simulator identity broker

**Files:**
- Create: `electron/simulator/runIdentity.js`
- Create: `electron/test/simulator-run-identity.test.js`

**Interfaces:**
- Produces opaque per-run MCP material and trusted `{ runId, threadId, projectId, providerId }` context.
- Stores only SHA-256 token digests as Map keys.

- [ ] **Step 1: Write failing identity tests**

Cover:

- issue/authenticate success;
- wrong token and query-token absence;
- different runs receive unrelated tokens;
- expiry at exactly 12 hours with fake clock;
- `isRunActive` false rejects even before expiry;
- revoke one run leaves another valid;
- revoke-all clears every token;
- endpoint can be set only to loopback HTTP;
- returned context does not contain raw token.

Representative test:

```js
const broker = createSimulatorRunIdentityBroker({
  now: () => now,
  randomBytes: () => Buffer.alloc(32, 7),
  isRunActive: (runId) => active.has(runId),
});
broker.setEndpoint("http://127.0.0.1:4321/simulator-mcp");
active.add("r1");

const material = broker.issue({
  runId: "r1",
  threadId: "t1",
  projectId: "p1",
  providerId: "claude",
});
assert.equal(material.serverName, "coder-simulator");
assert.equal(material.url, "http://127.0.0.1:4321/simulator-mcp");
assert.deepEqual(broker.authenticateBearer(material.bearerToken), {
  runId: "r1",
  threadId: "t1",
  projectId: "p1",
  providerId: "claude",
});
```

- [ ] **Step 2: Run and verify red**

Run:

```sh
NODE_ENV=test node --import=./test/support/disable-grok-mcp.mjs --test electron/test/simulator-run-identity.test.js
```

Expected: FAIL with missing module.

- [ ] **Step 3: Implement broker**

```js
function createSimulatorRunIdentityBroker({
  now = Date.now,
  randomBytes = crypto.randomBytes,
  isRunActive = () => true,
}) {
  const byDigest = new Map();
  const digestByRun = new Map();
  let endpoint = null;

  function issue(context) {
    if (!endpoint) throw new Error("Simulator MCP endpoint is not ready");
    revokeRun(context.runId, "replaced");
    const token = randomBytes(32).toString("base64url");
    const digest = sha256(token);
    byDigest.set(digest, {
      ...context,
      issuedAt: now(),
      expiresAt: now() + 12 * 60 * 60 * 1000,
    });
    digestByRun.set(context.runId, digest);
    return {
      serverName: "coder-simulator",
      url: endpoint,
      bearerToken: token,
      tokenEnvVar: "CODER_MCP_TOKEN_CODER_SIMULATOR",
    };
  }
```

`authenticateBearer` hashes the supplied token, uses timing-safe digest equality where comparison is needed, checks expiry/activity, and returns a frozen copy without token/digest.

- [ ] **Step 4: Run tests and commit**

Run: same command as Step 2.

Expected: PASS.

Commit:

```sh
git add electron/simulator/runIdentity.js electron/test/simulator-run-identity.test.js
git commit -m "feat: bind simulator MCP identity to one run"
```

---

### Task 2: Per-run provider MCP materialization

**Files:**
- Modify: `electron/memory-sup.js`
- Modify: `electron/runner.js`
- Modify provider tests:
  - `electron/test/mcp-inject.test.js`
  - `electron/test/claude.test.js`
  - `electron/test/codex.test.js`
  - `electron/test/kimi-home.test.js`
  - `electron/test/grok.test.js`
  - `electron/test/cursor.test.js`
  - `electron/test/opencode.test.js`

**Interfaces:**
- Consumes identity material from Task 1.
- Produces one `coder-simulator` MCP entry per eligible run without entering process-global `activeServers()`.

- [ ] **Step 1: Add failing provider tests**

For each provider, assert:

- `coder-simulator` URL appears in run-specific config;
- bearer token is supplied only through child environment;
- raw token is absent from argv, global files, logs, and returned diagnostics;
- concurrent runs do not overwrite each other's config;
- terminal/replacement revokes identity;
- local non-macOS and remote runs receive no simulator server.

Also assert Claude does not reuse a persistent process after a simulator-enabled run terminal.

- [ ] **Step 2: Run and verify red**

Run:

```sh
NODE_ENV=test node --import=./test/support/disable-grok-mcp.mjs --test \
  electron/test/mcp-inject.test.js \
  electron/test/claude.test.js \
  electron/test/codex.test.js \
  electron/test/kimi-home.test.js \
  electron/test/grok.test.js \
  electron/test/cursor.test.js \
  electron/test/opencode.test.js
```

Expected: FAIL because no provider includes `coder-simulator`.

- [ ] **Step 3: Define a common extra-server shape**

```js
function simulatorExtraServer(material) {
  return {
    name: material.serverName,
    transport: "http",
    url: material.url,
    tokenEnvVar: material.tokenEnvVar,
    token: material.bearerToken,
  };
}
```

Widen provider helpers to accept `{ extraServers = [] }`. Extra servers participate in generated run config/env but never in `registerMcpServer`, `extraServers`, or user-global settings.

- [ ] **Step 4: Implement provider-specific materialization**

- Claude: write `userData/mcp-runs/<runId>/claude.json` mode `0600`; add `mcp__coder-simulator__simulator` to exact allowed tools; delete directory and dispose persistent Claude session at terminal.
- Codex: add URL via `-c`; use `bearer_token_env_var="CODER_MCP_TOKEN_CODER_SIMULATOR"` and child env token.
- Kimi: write per-run `KIMI_CODE_HOME` entry using bearer-token environment reference; do not write literal token.
- Grok: persist only the environment-header reference once; supply current token in each child env and remove the reference on app stop.
- Cursor: include per-run `mcp.json` in a `runId`-scoped plugin directory and use an environment reference.
- OpenCode: merge `coder-simulator` into `OPENCODE_CONFIG_CONTENT` with environment header and `oauth:false`.

- [ ] **Step 5: Issue and revoke around runner spawn**

Immediately before eligible provider spawn:

```js
const material =
  process.platform === "darwin" && !project.remoteHost
    ? simulatorRunIdentities.issue({
        runId,
        threadId,
        projectId: thread.projectId,
        providerId: provider,
      })
    : null;
```

On spawn/setup failure, revoke in `catch`. In the single terminal notification choke point, revoke synchronously before transcript/status push. `stopRun`, replacement, and `stopAll` also revoke before killing provider processes.

- [ ] **Step 6: Run tests and commit**

Run the Step 2 command.

Expected: PASS.

Commit:

```sh
git add electron/memory-sup.js electron/runner.js electron/test/mcp-inject.test.js electron/test/claude.test.js electron/test/codex.test.js electron/test/kimi-home.test.js electron/test/grok.test.js electron/test/cursor.test.js electron/test/opencode.test.js
git commit -m "feat: inject simulator MCP per agent run"
```

---

### Task 3: Host-owned approval broker and permission card

**Files:**
- Create: `electron/simulator/approvalBroker.js`
- Create: `electron/test/simulator-approval.test.js`
- Modify: `electron/runner.js`
- Modify: `src/shared/ipc.ts`
- Modify: `src/components/ThreadView.tsx`
- Extend: `test/permissionPrompt.test.tsx`

**Interfaces:**
- Produces `authorize`, `respond`, `getPending`, `revokeRun`.
- Integrates with existing `PermissionDecision`: `"allow"` means exact operation once, `"allowAlways"` means category for this run, `"deny"` rejects.

- [ ] **Step 1: Write failing broker tests**

Cover:

- exact-operation allow once;
- category allow-for-run;
- URL/recording reject `"allowAlways"` and remain one-shot;
- ten-minute expiry;
- identical request coalescing;
- different canonical operation does not coalesce;
- run revoke rejects waiters;
- lease generation change rejects before resolve;
- typed text absent from summary/log-safe object;
- provider permission mode never changes result.

- [ ] **Step 2: Run and verify red**

Run:

```sh
NODE_ENV=test node --import=./test/support/disable-grok-mcp.mjs --test electron/test/simulator-approval.test.js
```

Expected: FAIL with missing module.

- [ ] **Step 3: Implement canonical approval records**

```js
const CATEGORY_BY_ACTION = Object.freeze({
  attach: "lifecycle",
  detach: "lifecycle",
  boot: "lifecycle",
  install: "lifecycle",
  launch: "lifecycle",
  tap: "input",
  swipe: "input",
  type: "input",
  press: "input",
  scroll_to: "input",
  open_url: "url",
  record_start: "recording",
});
```

Canonical operation fingerprints use SHA-256 over stable JSON including action, device/attachment generation, coordinates/path/URL, and a hash of typed text. The display summary for text is `"Type <N> characters"` and never includes text.

Broker request:

```js
await approvals.authorize({
  runContext,
  category,
  operation: Object.freeze(canonicalOperation),
  summary,
  generation,
});
```

- [ ] **Step 4: Merge host and provider pending permissions**

Extend `PendingPermissionInfo`:

```ts
  source?: "provider" | "host";
  category?: "lifecycle" | "input" | "url" | "recording";
  operation?: string;
  allowScope?: "once" | "run";
```

Runner returns the oldest host request before provider requests. `respondPermission` routes a known host request ID to the broker; otherwise it preserves the existing provider flow.

- [ ] **Step 5: Add host prompt rendering tests and UI**

For `source === "host"` render:

- “Agent wants to control iOS Simulator”
- category + sanitized operation
- Allow once
- Allow for this run only when `allowScope === "run"`
- Deny

Do not render editable command/input fields or “accept all providers”.

- [ ] **Step 6: Run tests and commit**

Run:

```sh
NODE_ENV=test node --import=./test/support/disable-grok-mcp.mjs --test electron/test/simulator-approval.test.js
node --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/permissionPrompt.test.tsx
```

Expected: PASS.

Commit:

```sh
git add electron/simulator/approvalBroker.js electron/test/simulator-approval.test.js electron/runner.js src/shared/ipc.ts src/components/ThreadView.tsx test/permissionPrompt.test.tsx
git commit -m "feat: approve simulator actions in Solenta"
```

---

### Task 4: Strict simulator action parser

**Files:**
- Create: `electron/simulator/actions.js`
- Extend: `electron/test/orch-server.test.js`

**Interfaces:**
- Produces strict normalized actions; MCP schema optional fields are never passed directly to the service.

- [ ] **Step 1: Add failing action-validation tests**

Cover every action:

```text
status, list, attach, detach, boot, install, launch, open_url,
tap, swipe, type, press, screenshot, record_start, record_stop,
accessibility, scroll_to
```

Reject identity fields, unknown fields/actions, NaN/infinite/negative coordinates, text over 4 KiB, URL over 2,048, swipe duration outside 50–5,000 ms, accessibility depth outside 1–12, node count outside 1–2,000, and scroll attempts outside 1–8.

- [ ] **Step 2: Run and verify red**

Run:

```sh
NODE_ENV=test node --import=./test/support/disable-grok-mcp.mjs --test --test-name-pattern="simulator action" electron/test/orch-server.test.js
```

Expected: FAIL because the parser/tool does not exist.

- [ ] **Step 3: Implement closed parser**

Export:

```js
function actionError(code, message) {
  const error = new Error(message);
  error.name = "SimulatorActionError";
  error.code = code;
  return error;
}

function assertKeys(raw, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw actionError("invalid_action", `Unexpected field: ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw actionError("invalid_action", `Missing field: ${key}`);
    }
  }
}

function boundedNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw actionError("invalid_action", "Numeric field is out of range");
  }
  return number;
}

function boundedInt(value, min, max) {
  const number = boundedNumber(value, min, max);
  if (!Number.isInteger(number)) {
    throw actionError("invalid_action", "Integer field is required");
  }
  return number;
}

function boundedString(value, max, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw actionError("invalid_action", `${field} is invalid`);
  }
  return value;
}

function parseSimulatorAction(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw actionError("invalid_action", "Action must be an object");
  }
  const action = String(raw.action || "");
  switch (action) {
    case "status":
    case "list":
      assertKeys(raw, ["action"]);
      return Object.freeze({ action });
    case "attach":
      assertKeys(raw, ["action", "udid"]);
      return Object.freeze({
        action,
        udid: boundedString(raw.udid, 64, "udid"),
      });
    case "detach":
    case "boot":
    case "screenshot":
    case "record_start":
    case "record_stop":
      assertKeys(raw, ["action", "generation"]);
      return Object.freeze({
        action,
        generation: boundedInt(raw.generation, 1, 0xffffffff),
      });
    case "install":
      assertKeys(raw, ["action", "generation", "appPath"]);
      return Object.freeze({
        action,
        generation: boundedInt(raw.generation, 1, 0xffffffff),
        appPath: boundedString(raw.appPath, 4096, "appPath"),
      });
    case "launch":
      assertKeys(raw, ["action", "generation", "bundleId"]);
      return Object.freeze({
        action,
        generation: boundedInt(raw.generation, 1, 0xffffffff),
        bundleId: boundedString(raw.bundleId, 255, "bundleId"),
      });
    case "open_url":
      assertKeys(raw, ["action", "generation", "url"]);
      return Object.freeze({
        action,
        generation: boundedInt(raw.generation, 1, 0xffffffff),
        url: boundedString(raw.url, 2048, "url"),
      });
    case "tap":
      assertKeys(raw, ["action", "generation", "x", "y"]);
      return Object.freeze({
        action,
        generation: boundedInt(raw.generation, 1, 0xffffffff),
        x: boundedNumber(raw.x, 0, 100_000),
        y: boundedNumber(raw.y, 0, 100_000),
      });
    case "swipe":
      assertKeys(
        raw,
        ["action", "generation", "fromX", "fromY", "toX", "toY"],
        ["durationMs"],
      );
      return Object.freeze({
        action,
        generation: boundedInt(raw.generation, 1, 0xffffffff),
        fromX: boundedNumber(raw.fromX, 0, 100_000),
        fromY: boundedNumber(raw.fromY, 0, 100_000),
        toX: boundedNumber(raw.toX, 0, 100_000),
        toY: boundedNumber(raw.toY, 0, 100_000),
        durationMs:
          raw.durationMs == null
            ? 300
            : boundedInt(raw.durationMs, 50, 5_000),
      });
    case "type":
      assertKeys(raw, ["action", "generation", "text"]);
      return Object.freeze({
        action,
        generation: boundedInt(raw.generation, 1, 0xffffffff),
        text: boundedString(raw.text, 4096, "text"),
      });
    case "press": {
      assertKeys(raw, ["action", "generation", "button"]);
      const button = boundedString(raw.button, 32, "button");
      if (!["home", "lock", "volumeUp", "volumeDown", "shake"].includes(button)) {
        throw actionError("invalid_action", "Unknown hardware button");
      }
      return Object.freeze({
        action,
        generation: boundedInt(raw.generation, 1, 0xffffffff),
        button,
      });
    }
    case "accessibility":
      assertKeys(raw, ["action", "generation"], ["maxDepth", "maxNodes"]);
      return Object.freeze({
        action,
        generation: boundedInt(raw.generation, 1, 0xffffffff),
        maxDepth:
          raw.maxDepth == null ? 8 : boundedInt(raw.maxDepth, 1, 12),
        maxNodes:
          raw.maxNodes == null ? 500 : boundedInt(raw.maxNodes, 1, 2_000),
      });
    case "scroll_to":
      assertKeys(
        raw,
        ["action", "generation", "label"],
        ["maxAttempts"],
      );
      return Object.freeze({
        action,
        generation: boundedInt(raw.generation, 1, 0xffffffff),
        label: boundedString(raw.label, 512, "label"),
        maxAttempts:
          raw.maxAttempts == null
            ? 8
            : boundedInt(raw.maxAttempts, 1, 8),
      });
    default:
      throw actionError("invalid_action", `Unknown simulator action: ${action}`);
  }
}
```

No default spread of caller fields is allowed.

- [ ] **Step 4: Run tests and commit**

Run the Step 2 command.

Expected: PASS.

Commit:

```sh
git add electron/simulator/actions.js electron/test/orch-server.test.js
git commit -m "feat: validate bounded simulator tool actions"
```

---

### Task 5: Separate simulator MCP endpoint and service dispatch

**Files:**
- Modify: `electron/orchServer.js`
- Modify: `electron/main.js`
- Extend: `electron/test/orch-server.test.js`

**Interfaces:**
- Produces `/simulator-mcp`, which exposes only one `simulator` tool.
- Consumes identity broker, approval broker, action parser, simulator service, and artifact store.

- [ ] **Step 1: Add failing endpoint/auth tests**

Assert:

- `/simulator-mcp` with app token -> 401;
- `/mcp` with run token -> 401;
- no/query token -> 401;
- valid bearer token -> `tools/list` contains only `simulator`;
- forged identity fields fail parser and cannot change context;
- expired/revoked token -> 401;
- action routes to service with trusted thread/run IDs;
- approval occurs before mutation and state revalidates after approval;
- screenshot result includes artifact metadata plus bounded image block;
- recording result contains metadata only.

- [ ] **Step 2: Run and verify red**

Run:

```sh
NODE_ENV=test node --import=./test/support/disable-grok-mcp.mjs --test electron/test/orch-server.test.js
```

Expected: FAIL because `/simulator-mcp` returns 404.

- [ ] **Step 3: Add bearer-only route**

```js
if (url.pathname === "/simulator-mcp") {
  const token = extractBearer(req);
  const runContext = runIdentities.authenticateBearer(token);
  if (!runContext) {
    res.writeHead(401).end();
    return;
  }
  const handler = createSimulatorToolHandler(handlerDeps, runContext);
  const mcp = buildSimulatorMcpServer(sdk, handler);
  await handleMcpRequest(req, res, mcp, body);
  return;
}
```

Do not accept `?token=` and do not register the tool in the existing `buildMcpServer`.

- [ ] **Step 4: Register one MCP tool**

The SDK input schema has `action` enum plus optional action fields; `parseSimulatorAction` enforces action-specific required/extra fields.

Handler flow:

1. authenticate run context;
2. parse action;
3. for `status`/`list`, resolve only trusted thread context so discovery works before attachment; for every other action, resolve and validate the current owning lease;
4. canonicalize and authorize if category requires it;
5. revalidate run active, owner, generation, and app path;
6. dispatch with trusted `{ threadId, runId }`;
7. format bounded result.

Dispatch with an explicit switch:

```js
async function dispatchSimulatorAction(service, runContext, action) {
  const trusted = {
    threadId: runContext.threadId,
    runId: runContext.runId,
  };
  switch (action.action) {
    case "status":
      return service.getStatus({ threadId: trusted.threadId });
    case "list":
      return service.listDevices({ threadId: trusted.threadId });
    case "attach":
      return service.attach({
        threadId: trusted.threadId,
        deviceUdid: action.udid,
      });
    case "detach":
      return service.detach({ threadId: trusted.threadId, generation: action.generation });
    case "boot":
      return service.boot({ threadId: trusted.threadId, generation: action.generation });
    case "install":
      return service.install({
        threadId: trusted.threadId,
        generation: action.generation,
        relativeAppPath: action.appPath,
      });
    case "launch":
      return service.launch({ ...trusted, ...action });
    case "open_url":
      return service.openUrl({
        threadId: trusted.threadId,
        generation: action.generation,
        url: action.url,
      });
    case "tap":
      return service.tap({ ...trusted, ...action });
    case "swipe":
      return service.swipe({ ...trusted, ...action });
    case "type":
      return service.typeText({ ...trusted, ...action });
    case "press":
      return service.pressButton({ ...trusted, ...action });
    case "screenshot":
      return service.captureScreenshot({ ...trusted, ...action });
    case "record_start":
      return service.startRecording({ ...trusted, ...action });
    case "record_stop":
      return service.stopRecording({ ...trusted, ...action });
    case "accessibility":
      return service.accessibility({ ...trusted, ...action });
    case "scroll_to":
      return service.scrollTo({ ...trusted, ...action });
  }
  throw actionError("invalid_action", "Unsupported simulator action");
}
```

Screenshot formatting resizes the PNG to at most 1,600 px wide/4 MiB before returning:

```js
{
  content: [
    { type: "text", text: JSON.stringify({ artifact }) },
    { type: "image", mimeType: "image/png", data: base64 },
  ],
}
```

- [ ] **Step 5: Run tests and commit**

Run the Step 2 command.

Expected: PASS.

Commit:

```sh
git add electron/orchServer.js electron/main.js electron/test/orch-server.test.js
git commit -m "feat: add run-scoped simulator MCP endpoint"
```

---

### Task 6: Pane focus, approval visibility, and reload reconciliation

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/ipcChannels.ts`
- Regenerate: `electron/preload.js`
- Modify: `electron/main.js`
- Modify: `src/useCoder.ts`
- Modify: `src/components/ThreadView.tsx`
- Create/extend: `test/threadView.simulator.test.tsx`
- Extend: `electron/test/web.test.js`

**Interfaces:**
- Produces desktop-only `simulator:focus` payload `{ threadId, generation, reason }`.
- Agent launch focuses/opens the pane after success; pending input approval opens it before the card.

- [ ] **Step 1: Write failing focus tests**

Prove:

- successful agent launch emits focus after launch succeeds;
- failed launch emits no focus;
- pending input approval emits focus before permission push;
- focus opens/focuses simulator pane only for selected thread;
- it never changes selected thread or activates OS window;
- reload/status reconciliation reopens pane for an active attachment;
- Web receives no focus push.

- [ ] **Step 2: Run and verify red**

Run:

```sh
node --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/threadView.simulator.test.tsx
NODE_ENV=test node --import=./test/support/disable-grok-mcp.mjs --test electron/test/web.test.js
```

Expected: FAIL because focus behavior is absent.

- [ ] **Step 3: Add focus contract and desktop broadcast**

```ts
export interface SimulatorFocusRequest {
  threadId: string;
  generation: number;
  reason: "agent_launch" | "agent_input_approval";
}
```

Use a desktop-only broadcast function; keep the Web push denylist from plan 03.

- [ ] **Step 4: Open/focus pane**

`useCoder` retains the latest focus request by thread. In `ThreadView`, when a new request matches the selected thread:

```ts
setPaneLayout((current) => openPane(current, "simulator", focusedPaneId));
```

If already open, set its leaf as focused. On mount, call simulator status and reopen when this thread owns an active attachment.

- [ ] **Step 5: Regenerate and run tests**

Run:

```sh
node --experimental-strip-types scripts/sync-ipc-preload.js
node --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/threadView.simulator.test.tsx
NODE_ENV=test node --import=./test/support/disable-grok-mcp.mjs --test electron/test/web.test.js electron/test/ipc-seam.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add src/shared/ipc.ts src/shared/ipcChannels.ts electron/preload.js electron/main.js src/useCoder.ts src/components/ThreadView.tsx test/threadView.simulator.test.tsx electron/test/web.test.js electron/test/ipc-seam.test.js
git commit -m "feat: reveal simulator pane for agent control"
```

---

### Task 7: Security regression matrix and completion evidence

**Files:**
- Extend all tests touched by this plan.
- Create: `docs/IOS_SIMULATOR.md`
- Modify: `README.md` — link the new guide from the feature/documentation list.

**Interfaces:**
- Produces provider-neutral security evidence and final issue acceptance evidence.

- [ ] **Step 1: Add cross-provider security matrix**

For every provider, run the same assertions:

- run A cannot control run B/thread B;
- token revoked before terminal status push;
- bypass mode still blocks at host approval;
- lease takeover invalidates pending/approved old actions;
- app-wide token cannot list simulator tools;
- raw token absent from argv, global config, transcript, logs, and artifacts.

- [ ] **Step 2: Run focused suites**

```sh
NODE_ENV=test node --import=./test/support/disable-grok-mcp.mjs --test \
  electron/test/simulator-run-identity.test.js \
  electron/test/simulator-approval.test.js \
  electron/test/orch-server.test.js \
  electron/test/mcp-inject.test.js \
  electron/test/claude.test.js \
  electron/test/codex.test.js \
  electron/test/kimi-home.test.js \
  electron/test/grok.test.js \
  electron/test/cursor.test.js \
  electron/test/opencode.test.js \
  electron/test/web.test.js

node --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 \
  test/permissionPrompt.test.tsx \
  test/threadView.simulator.test.tsx \
  test/simulatorPane.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run repository verification**

```sh
npm run typecheck
npm run build
npm run test:electron
npm run test:renderer
npm test
```

Expected: PASS.

- [ ] **Step 4: Run native acceptance**

On full-Xcode macOS, execute the plan-03 compile/sandbox check and the design-spec matrix: boot, install/launch, live stream, input, accessibility, screenshot artifact, two-second recording artifact, takeover, and crash recovery on Xcode 26 and 27.

Expected: PASS. If this evidence is unavailable, keep #248 open and report the exact unverified matrix rows.

- [ ] **Step 5: Document and commit**

Create `docs/IOS_SIMULATOR.md` with these exact sections: Requirements, Select Xcode, Build output inside the worktree, Attach and take control, Agent approval categories, Screenshots and recordings, Artifact limits, Degraded capabilities, and Troubleshooting. Link it from `README.md`. Document macOS/full-Xcode requirements, approval behavior, fixed artifact limits, worktree-local app build output, lease/takeover behavior, and the Xcode 26/27 validation boundary.

```sh
git add docs/IOS_SIMULATOR.md README.md
git commit -m "docs: explain shared iOS Simulator verification"
```

## Self-Review Coverage

- Unforgeable run/thread identity and 12-hour expiry: Task 1
- Provider-neutral per-run injection and revocation: Task 2
- Host-owned approvals independent of provider mode: Task 3
- Closed action enum and bounded values: Task 4
- Separate MCP endpoint/app-token refusal: Task 5
- Artifact screenshot/video results: Task 5
- Agent launch/input visibility and pane auto-open: Task 6
- Web denial and cross-provider/cross-thread regression proof: Tasks 5–7
- Real native acceptance and issue-close gate: Task 7
