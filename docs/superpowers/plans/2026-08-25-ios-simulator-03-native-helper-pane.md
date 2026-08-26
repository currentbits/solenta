# iOS Simulator Native Helper and Live Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the source-shipped, fail-closed native helper and a desktop-only Simulator pane with live H.264, direct input, hardware controls, accessibility, and user capture controls.

**Architecture:** A cached Swift Package executable applies Seatbelt, then communicates with Electron main over bounded inherited control pipes and a tokened loopback video WebSocket. The helper dynamically loads Xcode private frameworks for framebuffer capture, IndigoHID input, and AXP accessibility. Electron brokers the stream and exposes typed desktop IPC; the renderer decodes AVCC with WebCodecs into a canvas.

**Tech Stack:** Swift 6, Objective-C runtime bridges, Swift Package Manager, VideoToolbox, CoreMedia, CoreVideo, Seatbelt, `ws`, Electron IPC, React 19, TypeScript, WebCodecs, `node:test`.

## Global Constraints

- Complete plans 01 and 02 first.
- Design spec: `docs/superpowers/specs/2026-08-25-ios-simulator-integration-design.md`. Tracking issue: #248.
- Ship source, sandbox profile, protocol, licenses, and tests. Do not ship a precompiled helper.
- Build with the selected `DEVELOPER_DIR`; cache by all source/profile/protocol bytes, Xcode build, SDK, compiler versions, and host architecture.
- The helper must apply a deny-by-default sandbox before reading the first control request. Sandbox failure is fatal; no JXA, CGEvent, unsandboxed, or desktop-capture fallback.
- Video is H.264/AVCC, at most 30 fps and 4 MiB/message. Control frames are at most 64 KiB.
- Drop delta frames above 8 MiB viewer backpressure; request an IDR after recovery below 2 MiB.
- Private framework capability probes are independent. An unavailable input/accessibility ABI degrades that capability rather than enabling guessed calls.
- Simulator invoke/push channels are desktop-only and must be denied by the Web bridge, not merely hidden.
- This checkout has no full Xcode or `simctl`. Do not claim helper compilation or real Simulator acceptance from local mocked tests.
- Upstream provenance:
  - Apache-2.0 Baguette revision `fb7cc51aec69e3fbb5a71f31b4fb1cc1191d7a2c`
  - MIT ios-mcp-server revision `bd5aca70704fe0fb5e974abaed205f54469799b0`
- Use TDD and commit after each task.

---

## File Structure

**Create**
- `native/ios-simulator-helper/Package.swift`
- `native/ios-simulator-helper/protocol.json`
- `native/ios-simulator-helper/NOTICE.md`
- `native/ios-simulator-helper/LICENSES/Baguette-APACHE-2.0.txt`
- `native/ios-simulator-helper/LICENSES/ios-mcp-server-MIT.txt`
- `native/ios-simulator-helper/Resources/helper.sb`
- `native/ios-simulator-helper/Sources/SimulatorPrivateBridge/include/SimulatorPrivateBridge.h`
- `native/ios-simulator-helper/Sources/SimulatorPrivateBridge/PrivateFrameworkLoader.m`
- `native/ios-simulator-helper/Sources/SimulatorPrivateBridge/SimulatorCaptureBridge.m`
- `native/ios-simulator-helper/Sources/SimulatorPrivateBridge/SimulatorInputBridge.m`
- `native/ios-simulator-helper/Sources/SimulatorPrivateBridge/SimulatorAccessibilityBridge.m`
- `native/ios-simulator-helper/Sources/SimulatorPrivateBridge/SandboxBridge.m`
- `native/ios-simulator-helper/Sources/SolentaSimulatorHelper/main.swift`
- `native/ios-simulator-helper/Sources/SolentaSimulatorHelper/FramedIO.swift`
- `native/ios-simulator-helper/Sources/SolentaSimulatorHelper/ControlProtocol.swift`
- `native/ios-simulator-helper/Sources/SolentaSimulatorHelper/VideoEncoder.swift`
- `native/ios-simulator-helper/Sources/SolentaSimulatorHelper/HelperSession.swift`
- `native/ios-simulator-helper/Tests/SolentaSimulatorHelperTests/ProtocolTests.swift`
- `native/ios-simulator-helper/Tests/SolentaSimulatorHelperTests/VideoEnvelopeTests.swift`
- `electron/ios-simulator-protocol.js`
- `electron/ios-simulator-toolchain.js`
- `electron/ios-simulator-stream.js`
- `electron/test/ios-simulator-protocol.test.js`
- `electron/test/ios-simulator-toolchain.test.js`
- `electron/test/ios-simulator-stream.test.js`
- `src/simulatorProtocol.ts`
- `src/simulatorGeometry.ts`
- `src/simulatorStream.ts`
- `src/components/SimulatorCanvas.tsx`
- `src/components/SimulatorControls.tsx`
- `src/components/SimulatorPane.tsx`
- `src/components/SimulatorPane.module.css`
- `test/simulatorProtocol.test.ts`
- `test/simulatorGeometry.test.ts`
- `test/simulatorStream.test.ts`
- `test/simulatorPane.test.tsx`
- `scripts/verify-ios-simulator-helper.js`

**Modify**
- `electron/ios-simulator.js` — helper/session/input/accessibility integration.
- `electron/main.js` — stream broker and service injection.
- `electron/runner.js` — expose the active run ID for user-originated artifact association.
- `electron/ipc.js` — desktop simulator handlers and transport check.
- `electron/webBridge.js` — explicit simulator invoke/push denial.
- `electron/preload.js` — generated.
- `src/shared/ipc.ts` — simulator types and `CoderApi.simulator`.
- `src/shared/ipcChannels.ts` — invokes and pushes.
- `src/shared/wire.ts` — Web-safe push list.
- `src/paneLayout.ts` — shipped simulator pane.
- `src/components/PaneWorkspace.tsx` — hide simulator view on Web.
- `src/components/ThreadView.tsx` — pane renderer.
- `src/App.tsx`, `src/useCoder.ts`, `src/devCoder.ts`, `test/support/fakeCoder.ts` — API/push plumbing.
- `index.html` — loopback WebSocket CSP.
- `scripts/package-app.sh`, `scripts/verify-package.sh` — source packaging checks.
- `.github/workflows/test.yml` — macOS helper compile job.
- `electron/test/package-deps.test.js` — native source include/executable exclusion assertions.

---

### Task 1: Versioned control and video protocols

**Files:**
- Create: `native/ios-simulator-helper/protocol.json`
- Create: `electron/ios-simulator-protocol.js`
- Create: `src/simulatorProtocol.ts`
- Create: `electron/test/ios-simulator-protocol.test.js`
- Create: `test/simulatorProtocol.test.ts`

**Interfaces:**
- Produces one protocol version/limit source and strict Node/renderer codecs.
- Native code consumes generated constants from `protocol.json` during build.

- [ ] **Step 1: Add the protocol manifest**

```json
{
  "version": 1,
  "maxControlBytes": 65536,
  "maxVideoBytes": 4194304,
  "dropViewerBytes": 8388608,
  "recoverViewerBytes": 2097152,
  "videoMagic": "SLV1"
}
```

- [ ] **Step 2: Write failing Node protocol tests**

Cover fragmented and coalesced four-byte-big-endian JSON frames, exact 64 KiB boundary, over-limit close, invalid JSON, request/response IDs, and video headers:

```js
const record = encodeVideoRecord({
  type: "key",
  generation: 3,
  sequence: 9,
  timestampUs: 42n,
  width: 1179,
  height: 2556,
  payload: Buffer.from([1, 2, 3]),
});
assert.deepEqual(decodeVideoRecord(record), {
  type: "key",
  generation: 3,
  sequence: 9,
  timestampUs: 42n,
  width: 1179,
  height: 2556,
  payload: Buffer.from([1, 2, 3]),
});
```

Reject bad magic, unknown type, reserved bytes, length mismatch, zero dimensions on frame records, and payload over 4 MiB.

- [ ] **Step 3: Run and verify red**

Run:

```sh
node --test electron/test/ios-simulator-protocol.test.js
node --import=./test/support/render.mjs --experimental-strip-types --test test/simulatorProtocol.test.ts
```

Expected: FAIL because protocol modules are absent.

- [ ] **Step 4: Implement the Node control codec**

Export:

```js
function protocolError(code) {
  const error = new Error(code);
  error.name = "IOSSimulatorProtocolError";
  error.code = code;
  return error;
}

function encodeControl(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > limits.maxControlBytes) throw protocolError("control_too_large");
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function createControlDecoder(onValue) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (length > limits.maxControlBytes) throw protocolError("control_too_large");
      if (buffered.length < length + 4) return;
      const body = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      onValue(JSON.parse(body.toString("utf8")));
    }
  };
}
```

- [ ] **Step 5: Implement the 32-byte video envelope**

Use:

```text
0..3 magic "SLV1"
4 type: 1=avcC, 2=keyframe, 3=delta, 4=JPEG seed
5 flags
6..7 reserved zero
8..11 generation uint32 BE
12..15 sequence uint32 BE
16..23 timestampUs uint64 BE
24..25 width uint16 BE
26..27 height uint16 BE
28..31 payloadLength uint32 BE
32.. payload
```

Mirror the decoder in TypeScript using `DataView`. Return `description` payload for `avcC` and AVCC samples unchanged for WebCodecs.

- [ ] **Step 6: Run tests and commit**

Run:

```sh
node --test electron/test/ios-simulator-protocol.test.js
node --import=./test/support/render.mjs --experimental-strip-types --test test/simulatorProtocol.test.ts
```

Expected: PASS.

Commit:

```sh
git add native/ios-simulator-helper/protocol.json electron/ios-simulator-protocol.js src/simulatorProtocol.ts electron/test/ios-simulator-protocol.test.js test/simulatorProtocol.test.ts
git commit -m "feat: define bounded simulator helper protocol"
```

---

### Task 2: Toolchain discovery, source digest, and atomic helper cache

**Files:**
- Create: `electron/ios-simulator-toolchain.js`
- Create: `electron/test/ios-simulator-toolchain.test.js`
- Modify: `electron/ios-simulator.js`

**Interfaces:**
- Produces `discoverToolchains`, `fingerprintToolchain`, and `ensureHelper`.
- Consumes selected developer directory from plan 02.

- [ ] **Step 1: Write failing toolchain tests**

Assert:

- zero subprocesses off macOS/remote;
- exact `xcodebuild -version`, SDK, `swift`, and `clang` probe argv/environment;
- source/profile/protocol/Xcode/compiler/architecture changes alter digest;
- path ordering does not alter digest;
- concurrent callers share one build promise;
- failed build removes temp output and leaves no cache hit;
- compiler timeout kills process group;
- cache hit still launches the normal sandboxed helper and performs the control-pipe capability handshake later.

- [ ] **Step 2: Run and verify red**

Run: `node --test electron/test/ios-simulator-toolchain.test.js`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement fingerprinting**

Hash a stable sequence:

```js
hash.update("solenta-ios-helper\0");
for (const file of sourceFiles.sort()) {
  hash.update(file.relativePath);
  hash.update("\0");
  hash.update(await fs.promises.readFile(file.absolutePath));
  hash.update("\0");
}
for (const value of [
  protocolVersion,
  xcodeVersion,
  xcodeBuild,
  sdkPath,
  process.arch,
  swiftVersion,
  clangVersion,
]) {
  hash.update(String(value));
  hash.update("\0");
}
```

- [ ] **Step 4: Implement the source build**

Build under `userData/native-cache/ios-simulator-helper/.build-<uuid>`:

```sh
/usr/bin/xcrun swift build \
  --package-path <sourceRoot> \
  --configuration release \
  --scratch-path <temp/scratch>
```

Use explicit `DEVELOPER_DIR`, `shell:false`, 120-second timeout, 1 MiB output cap, and detached process group. Copy only the executable to the final digest directory after checking it is a regular executable file. Rename the directory atomically.

- [ ] **Step 5: Run tests and commit**

Run: `node --test electron/test/ios-simulator-toolchain.test.js`

Expected: PASS.

Commit:

```sh
git add electron/ios-simulator-toolchain.js electron/test/ios-simulator-toolchain.test.js electron/ios-simulator.js
git commit -m "feat: compile and cache simulator helper source"
```

---

### Task 3: Fail-closed helper shell, framing, and sandbox self-test

**Files:**
- Create: Swift Package, sandbox, framing/session files, protocol tests, notices/licenses listed above.
- Create: `scripts/verify-ios-simulator-helper.js`

**Interfaces:**
- Produces an executable that applies Seatbelt, emits `ready`, accepts bounded requests on inherited FD 3, writes responses on FD 4, and exits cleanly.
- Private capture/input/accessibility capabilities remain false in this task.

- [ ] **Step 1: Add package and license files**

Use two targets because SwiftPM does not permit mixed Swift/Objective-C in one target:

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "SolentaSimulatorHelper",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "SolentaSimulatorHelper", targets: ["SolentaSimulatorHelper"])
  ],
  targets: [
    .target(
      name: "SimulatorPrivateBridge",
      publicHeadersPath: "include",
      linkerSettings: [
        .linkedFramework("Foundation"),
        .linkedFramework("CoreMedia"),
        .linkedFramework("CoreVideo"),
        .linkedFramework("VideoToolbox"),
        .linkedLibrary("sandbox")
      ]
    ),
    .executableTarget(
      name: "SolentaSimulatorHelper",
      dependencies: ["SimulatorPrivateBridge"]
    ),
    .testTarget(
      name: "SolentaSimulatorHelperTests",
      dependencies: ["SolentaSimulatorHelper"]
    )
  ]
)
```

Copy license texts from the pinned revisions and record exact files/revisions used in `NOTICE.md`.

- [ ] **Step 2: Write Swift framing tests**

Test fragmented/coalesced frames, 64 KiB rejection, request decoding, response correlation, generation/token checks, and clean EOF. Run:

```sh
swift test --package-path native/ios-simulator-helper
```

Expected on a full-Xcode host: FAIL until framing code exists. On this checkout, record `BLOCKED: full Xcode unavailable`; do not mark the step passed.

- [ ] **Step 3: Implement sandbox-before-request startup**

`main.swift` accepts only:

```text
--sandbox-profile <absolute packaged source path>
--developer-dir <selected developer dir>
--control-in-fd 3
--control-out-fd 4
[--sandbox-self-test]
```

Startup order:

```swift
let options = try Options.parse(CommandLine.arguments)
try Sandbox.enter(
  profile: options.sandboxProfile,
  parameters: ["DEVELOPER_DIR": options.developerDir]
)
let input = FileHandle(fileDescriptor: options.controlInFD, closeOnDealloc: false)
let output = FileHandle(fileDescriptor: options.controlOutFD, closeOnDealloc: false)
try output.write(contentsOf: FramedIO.encode(["kind": "ready", "v": 1]))
try HelperSession(input: input, output: output).run()
```

The helper reads no control bytes before `Sandbox.enter` succeeds.

- [ ] **Step 4: Add a deny-by-default profile and self-test**

The profile allows selected Xcode/framework reads, required CoreSimulator mach services, inherited pipes, loopback client networking, and app-owned cache/temp paths supplied as parameters. It denies arbitrary home reads/writes, child process spawn, listening sockets, and non-loopback network.

`--sandbox-self-test` runs assertions inside the applied profile and exits nonzero if any denied operation succeeds. `verify-ios-simulator-helper.js` compiles, runs the self-test, and reports each denial independently.

- [ ] **Step 5: Run full-Xcode checks and commit**

On Xcode-equipped macOS:

```sh
swift test --package-path native/ios-simulator-helper
node scripts/verify-ios-simulator-helper.js \
  --developer-dir /Applications/Xcode.app/Contents/Developer \
  --compile \
  --sandbox-self-test
```

Expected: PASS. If unavailable, do not claim this task complete.

Commit:

```sh
git add native/ios-simulator-helper scripts/verify-ios-simulator-helper.js
git commit -m "feat: add sandboxed simulator helper shell"
```

---

### Task 4: Loopback stream broker and backpressure

**Files:**
- Create: `electron/ios-simulator-stream.js`
- Create: `electron/test/ios-simulator-stream.test.js`
- Modify: `electron/main.js`

**Interfaces:**
- Produces helper/viewer WebSocket sessions bound to lease generation.
- Calls injected `requestKeyframe()` and `setBitrate(bps)` callbacks; it does not know private helper details.

- [ ] **Step 1: Write failing broker tests**

Cover loopback-only bind, separate helper/viewer tokens, first-message authentication, generation mismatch, 4 MiB rejection, config/key/JPEG forwarding, delta dropping over 8 MiB, one IDR request after recovery below 2 MiB, bitrate floor 500 Kbps, and clean close.

- [ ] **Step 2: Run and verify red**

Run: `node --test electron/test/ios-simulator-stream.test.js`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement broker**

Export:

```js
function createIOSSimulatorStreamBroker({
  WebSocketServer = require("ws").WebSocketServer,
  randomBytes = crypto.randomBytes,
  decodeRecord = protocol.decodeVideoRecord,
  log = () => {},
}) {
  return {
    listen,
    createSession,
    closeSession,
    close,
  };
}
```

Bind `127.0.0.1` port 0. A session gets random helper/viewer tokens and generation. The first text message is `{ token, generation }`; reject later text messages. Never forward tokens in pushes/status.

- [ ] **Step 4: Run tests and commit**

Run: `node --test electron/test/ios-simulator-stream.test.js`

Expected: PASS.

Commit:

```sh
git add electron/ios-simulator-stream.js electron/test/ios-simulator-stream.test.js electron/main.js
git commit -m "feat: broker bounded simulator video streams"
```

---

### Task 5: Private capture, H.264, HID, and accessibility evidence gate

**Files:**
- Create/modify: native bridge and encoder/session files listed in File Structure.
- Extend: native tests.
- Modify: `native/ios-simulator-helper/NOTICE.md`

**Interfaces:**
- Produces independently probed `stream`, `touch`, `keyboard`, `hardwareButtons`, and `accessibility` capabilities.
- Uses no guessed private selector or ABI.

- [ ] **Step 1: Audit pinned upstream source**

Record, in `NOTICE.md`, the exact adapted file and revision before copying code:

```text
Baguette fb7cc51aec69e3fbb5a71f31b4fb1cc1191d7a2c:
- Infrastructure/Stream/AVCCStream.swift
- Infrastructure/Stream/H264Encoder.swift
- Infrastructure/Input/IndigoHIDInput.swift
- Infrastructure/Accessibility/AXPTranslatorAccessibility.swift

ios-mcp-server bd5aca70704fe0fb5e974abaed205f54469799b0:
- native/simtouch.m
- native/simtree.m
```

Compare framework paths, symbol lookup, signatures, memory ownership, coordinate transforms, and runtime guards on Xcode 26 and Xcode 27. When sources disagree, keep the capability disabled until a real-host probe resolves it.

- [ ] **Step 2: Define the stable C boundary**

```c
typedef struct SHCapabilityReport {
  bool stream;
  bool touch;
  bool keyboard;
  bool hardwareButtons;
  bool accessibility;
} SHCapabilityReport;

SHPrivateContextRef SHCreatePrivateContext(
  const char *developerDir,
  const char *udid,
  SHCapabilityReport *report,
  char **errorOut
);
bool SHStartCapture(SHPrivateContextRef, SHFrameCallback, void *, char **);
bool SHSendTouch(SHPrivateContextRef, SHTouchPhase, double, double, char **);
bool SHSendKey(SHPrivateContextRef, SHKeyEvent, char **);
bool SHPressButton(SHPrivateContextRef, SHHardwareButton, char **);
char *SHCopyAccessibilityJSON(SHPrivateContextRef, uint32_t maxDepth, char **);
void SHDestroyPrivateContext(SHPrivateContextRef);
```

The Objective-C implementation owns all `dlopen`, `dlsym`, Objective-C runtime, CoreFoundation ownership, and private selector details.

- [ ] **Step 3: Port H.264 AVCC encoding**

Use VideoToolbox with realtime, no frame reordering, keyframe interval 30, 30 fps, and initial 1.5 Mbps. Convert format description extensions to `avcC`; send one whole AVCC sample per video message. Implement explicit force-IDR and bitrate update requests.

- [ ] **Step 4: Port input and accessibility behind probes**

Use the pinned IndigoHID and AXP implementations only after their framework/symbol/signature probes pass. Normalize touch coordinates in device points. Accessibility output is bounded to roles, labels, identifiers, values, enabled/selected state, and frames; cap depth and node count in native code.

- [ ] **Step 5: Prove Xcode 26/27 behavior**

On each toolchain/runtime:

1. handshake and capability report;
2. first JPEG seed + `avcC` + IDR + deltas;
3. forced IDR and rotation;
4. background tap/swipe and keyboard;
5. Home/lock/volume/shake where supported;
6. accessibility frames matching screenshot coordinates;
7. sandbox self-test.

If either environment is unavailable, retain the specific capability as unverified and do not close #248.

- [ ] **Step 6: Commit verified native capabilities**

```sh
git add native/ios-simulator-helper
git commit -m "feat: stream and control iOS Simulator from native helper"
```

---

### Task 6: Service helper session and typed desktop IPC

**Files:**
- Modify: `electron/ios-simulator.js`
- Modify: `electron/runner.js`
- Modify: `electron/ipc.js`
- Modify: `electron/webBridge.js`
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/ipcChannels.ts`
- Modify: `src/shared/wire.ts`
- Regenerate: `electron/preload.js`
- Extend: `electron/test/ios-simulator.test.js`, `electron/test/ipc-seam.test.js`, `electron/test/web.test.js`

**Interfaces:**
- Produces desktop `CoderApi.simulator`; Web calls are denied before handler dispatch.
- Extends service with `streamInfo`, `retryStream`, `sendInput`, `tap`, `swipe`, `typeText`, `pressButton`, `accessibility`, and `scrollTo`.

- [ ] **Step 1: Write failing IPC/Web tests**

Assert:

- all desktop channels reach a fake service with `transport:"desktop"`;
- Web invocation of every `simulator:*` channel returns forbidden and never calls service;
- `simulator:changed` and `simulator:focus` never broadcast over Web;
- preload/channel table/handler lockstep remains exact;
- user screenshot/recording handlers pass the active run ID when one exists and `null` otherwise;
- payloads contain no helper/viewer token except direct `streamInfo` response.

- [ ] **Step 2: Run and verify red**

Run:

```sh
node --test electron/test/ipc-seam.test.js electron/test/web.test.js electron/test/ios-simulator.test.js
```

Expected: FAIL because channels/types/handlers are absent.

- [ ] **Step 3: Add shared types**

Add:

```ts
export type SimulatorInput =
  | { kind: "touch"; phase: "down" | "move" | "up"; pointerId: number; x: number; y: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: SimulatorKey; phase: "down" | "up" }
  | { kind: "button"; button: SimulatorHardwareButton };

export interface SimulatorStreamInfo {
  url: string;
  token: string;
  generation: number;
  protocolVersion: 1;
  maxMessageBytes: 4194304;
}
```

Add `CoderApi.simulator` methods for capabilities, selectDeveloperDir, listDevices, status, attach, detach, takeControl, streamInfo, retryStream, sendInput, accessibility, scrollTo, install, launch, openUrl, screenshot, startRecording, and stopRecording. `sendInput` is the direct-user low-level path. Service-only `tap`, `swipe`, `typeText`, and `pressButton` wrap bounded helper requests for the later MCP handler; they are not separate renderer IPC methods.

- [ ] **Step 4: Add desktop handlers and Web denylist**

Every handler begins:

```js
function requireDesktop(ctx) {
  if (!ctx || ctx.transport !== "desktop") {
    const err = new Error("iOS Simulator controls require the desktop app");
    err.code = "unsupported_platform";
    throw err;
  }
}
```

Set desktop transport in `registerIpc`. In `webBridge.js`, reject channel names beginning `simulator:` before `handlers[channel]` lookup and suppress simulator pushes. Define Web-safe pushes explicitly in `src/shared/wire.ts` rather than aliasing every push.

Add to the runner return surface:

```js
function activeRunId(threadId) {
  const entry = active.get(String(threadId));
  return entry && typeof entry.runId === "string" ? entry.runId : null;
}
```

User screenshot/recording handlers derive `runId` from `ctx.runner.activeRunId(threadId)`; the renderer never supplies it.

- [ ] **Step 5: Spawn/control helper from service**

Use inherited FD 3/4, send handshake after `ready`, then create stream session. Every input/helper request includes lease generation and validates current owner again after response. A helper crash marks helper capabilities disconnected but retains lease. Implement `tap` as touch down plus up with the native minimum hold, `swipe` as a bounded helper gesture, `typeText` as a text request capped at 4 KiB, and `pressButton` with the closed hardware-button enum.

- [ ] **Step 6: Regenerate preload and run tests**

Run:

```sh
node --experimental-strip-types scripts/sync-ipc-preload.js
node --test electron/test/ipc-seam.test.js electron/test/web.test.js electron/test/ios-simulator.test.js
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add electron/ios-simulator.js electron/runner.js electron/ipc.js electron/webBridge.js electron/preload.js src/shared/ipc.ts src/shared/ipcChannels.ts src/shared/wire.ts electron/test/ios-simulator.test.js electron/test/ipc-seam.test.js electron/test/web.test.js
git commit -m "feat: expose desktop-only simulator sessions"
```

---

### Task 7: WebCodecs canvas, pane, and direct user controls

**Files:**
- Create: renderer files/tests listed in File Structure.
- Modify: pane/app/hook/fake files listed in File Structure.
- Modify: `index.html`

**Interfaces:**
- Consumes `CoderApi.simulator` and `SimulatorStreamInfo`.
- Produces shipped desktop `simulator` pane and direct controls; Web hides/refuses stale pane state.

- [ ] **Step 1: Write geometry and stream tests**

Geometry:

```ts
assert.deepEqual(
  canvasPointToDevice(
    { clientX: 60, clientY: 120 },
    { left: 10, top: 20, width: 100, height: 200 },
    { width: 1179, height: 2556 },
  ),
  { x: 589.5, y: 1278 },
);
```

Test clamping, rotation, zero dimensions, pointer-capture loss, stale generation, and input refusal before fresh dimensions.

Stream tests fake `VideoDecoder`, `EncodedVideoChunk`, `createImageBitmap`, and canvas context. Assert configure on `avcC`, key/delta types, timestamps, frame `close()` in `finally`, decoder recreation, JPEG seed, and disconnect reset.

- [ ] **Step 2: Run and verify red**

Run:

```sh
node --import=./test/support/render.mjs --experimental-strip-types --test test/simulatorGeometry.test.ts test/simulatorStream.test.ts
```

Expected: FAIL because renderer modules are absent.

- [ ] **Step 3: Implement canvas decoder/input**

`SimulatorCanvas` is focusable, captures pointer on down, sends bounded down/move/up device-point events, maps printable keyboard input to `text`, and maps only the closed special-key enum to key events.

Decoder output:

```ts
output: (frame) => {
  try {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
    context.drawImage(frame, 0, 0);
    onDimensions({ width: frame.displayWidth, height: frame.displayHeight });
  } finally {
    frame.close();
  }
}
```

- [ ] **Step 4: Write pane tests**

Cover unsupported platform, Xcode/license/runtime checklist, device selection, attach/detach, owner busy state, explicit takeover confirmation, stream reconnect, hardware buttons, install/launch/URL, screenshot, recording timer, accessibility output, and hidden Web view.

- [ ] **Step 5: Add pane registry and UI**

Add `"simulator"` to `PANE_TYPES` and:

```ts
simulator: { title: "iOS Simulator", shipped: true, split: "horizontal" },
```

`PaneWorkspace` excludes it in Web mode. `ThreadView` renders `SimulatorPane` with selected thread ID and API. `useCoder` subscribes to `simulator:changed`; fake APIs return deterministic unsupported/attached states.

- [ ] **Step 6: Update CSP**

Add only loopback WebSocket:

```html
connect-src 'self' ws://127.0.0.1:*;
```

Do not allow arbitrary `ws:` origins.

- [ ] **Step 7: Run renderer verification and commit**

Run:

```sh
node --import=./test/support/render.mjs --experimental-strip-types --test test/simulatorGeometry.test.ts test/simulatorStream.test.ts test/simulatorPane.test.tsx test/paneLayout.test.ts test/paneWorkspace.test.tsx
npm run typecheck
npm run build
```

Expected: PASS.

Commit:

```sh
git add src/simulatorProtocol.ts src/simulatorGeometry.ts src/simulatorStream.ts src/components/SimulatorCanvas.tsx src/components/SimulatorControls.tsx src/components/SimulatorPane.tsx src/components/SimulatorPane.module.css src/paneLayout.ts src/components/PaneWorkspace.tsx src/components/ThreadView.tsx src/App.tsx src/useCoder.ts src/devCoder.ts test/support/fakeCoder.ts index.html test/simulatorGeometry.test.ts test/simulatorStream.test.ts test/simulatorPane.test.tsx test/paneLayout.test.ts test/paneWorkspace.test.tsx
git commit -m "feat: add live shared iOS Simulator pane"
```

---

### Task 8: Package source and compile-check on macOS CI

**Files:**
- Modify: `scripts/package-app.sh`
- Modify: `scripts/verify-package.sh`
- Modify: `.github/workflows/test.yml`
- Modify: `electron/test/package-deps.test.js`

**Interfaces:**
- Produces an app bundle containing helper source/profile/licenses but no helper executable.

- [ ] **Step 1: Write failing package verification**

Extend `electron/test/package-deps.test.js` to assert the package copy manifest and verification script require:

```text
native/ios-simulator-helper/Package.swift
native/ios-simulator-helper/protocol.json
native/ios-simulator-helper/Resources/helper.sb
native/ios-simulator-helper/NOTICE.md
native/ios-simulator-helper/LICENSES/*
native/ios-simulator-helper/Sources/*
```

Assert no file named `SolentaSimulatorHelper` without a source extension exists in packaged resources.

- [ ] **Step 2: Run package check and verify red**

Run:

```sh
node --test electron/test/package-deps.test.js
```

Expected: FAIL because native source is not copied.

- [ ] **Step 3: Package source and add CI compile job**

Copy the exact source tree while excluding `.build`, `.swiftpm`, and test build outputs. Add macOS CI:

```yaml
  ios-helper:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: swift test --package-path native/ios-simulator-helper
      - run: node scripts/verify-ios-simulator-helper.js --compile --sandbox-self-test
```

- [ ] **Step 4: Run full available verification**

Run:

```sh
npm run typecheck
npm run build
npm test
```

Expected locally: cross-platform tests PASS; helper compile is explicitly unverified without full Xcode.

- [ ] **Step 5: Commit**

```sh
git add scripts/package-app.sh scripts/verify-package.sh .github/workflows/test.yml electron/test/package-deps.test.js
git commit -m "package: ship and compile-check simulator helper source"
```

## Self-Review Coverage

- Source-shipped digest cache and selected Xcode: Tasks 2–3
- Deny-by-default fail-closed Seatbelt: Task 3
- H.264 AVCC stream, frame bounds, backpressure: Tasks 1, 4, 5, 7
- IndigoHID input/hardware buttons: Task 5
- Native accessibility tree: Task 5
- Independent degraded capabilities: Tasks 3, 5, 6
- Shared pane/direct user control: Tasks 6–7
- Desktop-only IPC and explicit Web denial: Task 6
- Packaging and macOS compile evidence: Task 8
- Agent MCP identity, approvals, and auto-open are intentionally deferred to plan 04.
