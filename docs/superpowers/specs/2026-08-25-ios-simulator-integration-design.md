# iOS Simulator integration

## Goal

On macOS, give one Solenta thread and its agent a shared iOS Simulator surface. The user can watch and control the same device the agent controls, while Solenta can collect screenshots and recordings as durable evidence attached to the originating run.

The complete interaction supports:

- discovering and booting available simulators;
- installing a validated `.app` produced beneath the thread worktree;
- launching an installed bundle or opening a URL;
- a live H.264 device stream in a Solenta pane;
- mouse, keyboard, swipe, and hardware-button input;
- native iOS accessibility-tree inspection and bounded semantic scrolling;
- PNG screenshots and H.264 MP4 recordings;
- agent-visible screenshots and transcript-visible run artifacts; and
- explicit approval boundaries for agent-driven mutation and input.

This is the expanded scope recorded on GitHub issue #248, not only the original screenshot-and-recording slice.

## Boundaries

### In scope

- Local macOS projects and worktrees
- One shared simulator control lease at a time
- Existing available Simulator devices
- Active-Xcode discovery and helper compilation
- A source-shipped native helper
- Simulator lifecycle, app lifecycle, direct input, and accessibility
- A generic image/video run-artifact foundation sufficient for this feature
- Native Electron and authenticated Solenta Web artifact playback

### Out of scope

- A custom `xcodebuild` wrapper or scheme/build-configuration UI
- Installing or configuring Xcode MCP or XcodeBuildMCP; that remains issue #488
- Android emulator support
- Physical iOS devices
- Multi-device farms or concurrent simulator panes
- PR artifact upload and artifact comments; those remain broader issue #244 work
- Screenshot markup or element-to-source mapping
- Shipping precompiled native binaries

Agents build with their normal shell tools or an external Xcode MCP server. The simulator integration only installs a relative `.app` path that resolves beneath the owning thread's worktree. Builds that normally use Xcode's global DerivedData must select a worktree-local output path before installation. This keeps arbitrary build commands and Xcode project selection outside a privileged main-process service.

## System architecture

The feature has five independently testable units:

1. `IOSSimulatorService` in Electron main owns device state, process lifecycle, leases, approvals, and the narrow native-helper protocol.
2. `SolentaSimulatorHelper` is compiled from source with the user's selected Xcode and owns private-framework access for capture, HID, and accessibility.
3. `SimulatorPane` decodes the live stream and turns user gestures into typed IPC actions.
4. The `simulator` MCP tool exposes a bounded action enum to the current thread's agent.
5. `RunArtifactStore` persists image/video evidence by opaque identifier and serves it to transcript clients.

The main process is the policy boundary. Neither the renderer nor an MCP caller receives a filesystem path, arbitrary subprocess command, CoreSimulator object, or unrestricted helper connection.

```text
thread agent -- run-scoped MCP --> orchestrator ----+
                                                    |
SimulatorPane -------- typed Electron IPC ----------+--> IOSSimulatorService
                                                               |
                                      +------------------------+------------------+
                                      |                        |                  |
                               fixed argv simctl      sandboxed helper     RunArtifactStore
                                      |                        |                  |
                                 CoreSimulator        H.264 / HID / AX     transcript evidence
```

## Platform and Xcode discovery

The service reports a typed capability snapshot before any attachment:

- host platform;
- local versus remote project;
- active developer directory;
- Xcode version and build number;
- accepted license status;
- available simulator runtimes and devices;
- helper cache/build state; and
- individual stream, touch, keyboard, hardware-button, and accessibility capabilities.

The default developer directory comes from `/usr/bin/xcode-select -p`. When multiple Xcode applications are detected, the pane lets the user choose one; the selected developer directory is stored as a user-level preference because the simulator is shared across projects. Every `xcrun`, compiler, and helper process receives the same explicit `DEVELOPER_DIR`.

The service rejects:

- non-macOS hosts;
- remote or WSL projects;
- Command Line Tools without full Simulator frameworks;
- unaccepted Xcode licenses;
- unavailable runtimes or stale device identifiers; and
- helper execution when its sandbox cannot be applied.

The pane shows these as an actionable checklist. Missing accessibility or an unsupported private ABI is a degraded capability, while missing Xcode, CoreSimulator, the sandbox, or live capture prevents attachment.

## Worktree and app-path safety

Every action starts from a thread identity supplied by trusted host context, not an agent-provided project identity.

The service:

1. loads the thread and its project;
2. rejects remote projects;
3. materializes a pending worktree when the action permits it;
4. reloads the thread;
5. resolves `thread.worktreePath || project.path`;
6. rejects a missing worktree instead of falling back to the main checkout;
7. canonicalizes the root with `realpath`; and
8. retains the thread and project IDs in the lease.

`install` accepts a relative path ending in `.app`. The service canonicalizes the bundle and requires the entire bundle to remain beneath the canonical worktree root, including symlink resolution. It reads the bundle identifier from `Info.plist` with fixed-argument platform tooling, validates the result, and passes the canonical path to `simctl install`.

All platform commands use absolute binaries, argument arrays, `shell: false`, bounded output, explicit timeouts, and injected process functions for tests. No simulator action accepts shell text or arbitrary `xcodebuild` flags.

## Device lease and ownership

The simulator is a host-global resource, while Solenta threads are isolated. A single lease prevents two threads from silently replacing each other's app or input.

The lease records:

- owner thread and project IDs;
- selected device UDID;
- generation token;
- whether Solenta booted the device;
- helper PID and protocol token;
- active recording PID and temporary path; and
- timestamps for acquisition and last activity.

Opening another thread's Simulator pane shows the current owner and a read-only busy state. “Take control” requires explicit user confirmation, stops the previous stream and recording cleanly, increments the generation, and transfers the lease. Stale async results carrying an old generation are ignored.

The lease journal is atomically persisted beneath `userData`. On startup, Solenta recovers a stale journal by terminating only matching helper/recording processes it started and by shutting down only a device it booted. It never erases a device and never shuts down a device that was already booted when attached.

Thread deletion, project removal, takeover, app quit, and explicit detach all stop recording, stop the helper, release the lease, and perform ownership-aware device cleanup. Archive detaches the live lease but retains artifacts.

## Native helper

### Source and compilation

Helper source lives under `native/ios-simulator-helper/` and has no network-fetched build dependency. The main process compiles it on first attachment with the selected Xcode toolchain.

The cache key includes:

- every helper source and sandbox-profile byte;
- helper protocol version;
- Xcode version and build number;
- SDK path;
- host architecture; and
- compiler version.

Compiled output is written to a temporary directory, validated, then atomically moved under an app-owned cache. A cache hit still runs the helper capability handshake because private-framework availability can change after an Xcode update.

The local checkout currently has Command Line Tools but no `simctl`. Unit tests can run here, but native compile and real-simulator acceptance require an Xcode-equipped macOS environment.

### Sandbox

The helper applies a deny-by-default Seatbelt profile before accepting commands. The profile permits only:

- reading its executable and selected Xcode/Simulator frameworks;
- the narrowly required CoreSimulator mach/XPC services;
- connecting to the loopback endpoint and token supplied by the parent;
- bounded temporary/cache paths explicitly supplied by the parent; and
- process operations needed for its own threads and codecs.

The helper cannot invoke a shell, spawn children, inspect arbitrary user files, listen on a public socket, or make non-loopback network connections. Sandbox initialization failure is fatal; there is no unsandboxed fallback.

### Private-framework compatibility

Capture, HID input, and native accessibility require SimulatorKit, CoreSimulator, and AccessibilityPlatformTranslation private interfaces. The helper loads symbols dynamically and validates the expected ABI before enabling each feature.

Framework discovery covers the Xcode 26 and Xcode 27 layouts. Each capability has a separate handshake result so an Xcode update can disable accessibility while leaving capture and input usable. Calls validate coordinate ranges, payload sizes, device identity, and lease generation before entering private APIs.

If code is adapted from Apache-2.0 Baguette or MIT ios-mcp-server, the implementation must retain the applicable license notice and record the source revision. Solenta does not execute or download either project at runtime.

## Live stream

The helper captures the simulator framebuffer without recording the user's desktop or Simulator window chrome. VideoToolbox encodes H.264 at up to 30 frames per second. The default target is 1.5 Mbps, dynamically reducible when the pane reports sustained backpressure.

The main process hosts a loopback-only WebSocket endpoint with random helper and viewer tokens bound to the current lease generation. The helper sends video over this endpoint. Helper handshake and control requests use a separate bounded, length-prefixed pipe inherited from the parent process; renderer control never travels over the video socket.

Each binary message contains one bounded record:

- codec configuration (`avcC`);
- keyframe;
- delta frame; or
- JPEG seed frame for immediate first paint.

The maximum video message size is 4 MiB. Helper pipe requests and responses are capped at 64 KiB. A viewer whose buffered amount exceeds 8 MiB drops delta frames instead of blocking helper RPC or device input. When it recovers, the service requests a new keyframe through the helper pipe.

`SimulatorPane` uses `VideoDecoder` and draws `VideoFrame` output to a canvas. It closes decoded frames immediately, recreates the decoder after a configuration change, and displays a reconnecting state after helper or socket interruption. A helper crash does not transfer or release the device lease automatically; the user can retry attachment without losing ownership.

## User interaction

The pane supplies:

- device selector and attach/detach;
- visible lease owner and takeover;
- pointer-to-device coordinate mapping;
- tap, press-and-hold, drag/swipe, and keyboard input;
- Home, lock, volume, shake, and supported hardware controls;
- install/launch controls for a validated worktree app;
- screenshot capture;
- recording start/stop and elapsed time; and
- capability and error details.

Pointer coordinates are normalized against the current encoded device dimensions, not the CSS canvas size. Input carries the lease generation and is discarded after resize, reconnect, or takeover until fresh dimensions are known.

User-originated pane actions do not require an agent permission prompt. They still pass through the same validation and lease checks as agent actions.

Launching an app from an agent action emits a main-process push that opens or focuses the Simulator pane for that thread. The pane is not required to be open before the agent lists devices or requests attachment, but the user must be able to see the resulting live surface before input approval is granted.

## Agent tools and thread identity

The built-in `coder-threads` MCP endpoint currently authenticates the app instance and can bind a project, but it does not cryptographically identify the originating thread. A simulator tool cannot trust a `threadId` argument because another same-project agent could claim the lease owner's ID.

Provider launch integration therefore issues a random run-scoped capability token bound in main-process memory to:

- run ID;
- thread ID;
- project ID;
- provider process lifetime; and
- expiry time.

The token is injected only into that run's MCP configuration. Simulator handlers require the scoped token and derive thread identity from it. The existing app-wide token remains valid for existing orchestration tools but cannot invoke simulator actions. Ending the run revokes the capability.

One `simulator` MCP tool uses a closed action enum:

- `status`, `list`, `attach`, `detach`, and `boot`;
- `install`, `launch`, and `open_url`;
- `tap`, `swipe`, `type`, and `press`;
- `screenshot`, `record_start`, and `record_stop`;
- `accessibility`; and
- `scroll_to`.

Schemas bound text length, coordinates, gesture duration, URL length/scheme, accessibility depth/count, and scroll attempts. There is no arbitrary command, environment, path outside the relative app bundle, or raw helper request.

`accessibility` strips unsupported/private fields and returns bounded roles, labels, identifiers, values, enabled/selected state, and device-point frames. `scroll_to` finds a named accessible element and performs at most eight bounded scroll attempts before returning a structured not-found result.

## Agent approval policy

Built-in MCP tools can bypass provider-native permission cards, so simulator authorization is enforced by Solenta main rather than a provider mode.

Approval categories are:

- device lifecycle: attach, detach, boot, install, and launch;
- input: tap, swipe, type, press, and semantic scroll;
- URL: every `open_url`, displaying the complete target;
- recording: every recording start; and
- takeover: always user-only.

Device lifecycle and input prompts offer allow once, allow for this run, or deny. URL and recording prompts are per invocation and do not offer a run-wide grant. Status and device listing require scoped thread identity but work before lease acquisition so the agent can choose a device. Screenshot and accessibility require the owning lease and scoped thread identity. None of these read actions prompts.

Approval requests appear in the owning thread and block the MCP response until answered, cancelled, expired, or the run exits. Multiple identical pending requests coalesce. Revocation occurs on run end, lease transfer, thread stop, or device change.

## Run artifact model

User composer attachments and agent-produced evidence remain separate concepts. `AttachmentInfo` continues to represent outbound user inputs. A new `RunArtifactInfo` represents app-owned evidence:

```ts
interface RunArtifactInfo {
  id: string;
  threadId: string;
  runId: string | null;
  toolCallId?: string;
  source: "simulator" | "verification" | "browser" | "manual";
  kind: "image" | "video";
  mimeType: string;
  name: string;
  size: number;
  createdAt: string;
  width?: number;
  height?: number;
  durationMs?: number;
  posterArtifactId?: string;
}
```

Artifacts are stored beneath:

```text
userData/run-artifacts/<threadId>/<runId-or-manual>/<opaque-id>.<validated-extension>
```

The metadata store never accepts a caller-supplied absolute path. Writes use an app-owned temporary file, content sniffing, size validation, `fsync`, and atomic rename. Reads resolve an opaque ID, verify thread authorization, reject symlinks/non-regular files, and return the stored MIME type.

Initial fixed limits are:

- 20 MiB per image;
- 250 MiB and five minutes per video;
- 500 MiB per thread; and
- 1 GiB globally.

Retention first removes temporary/orphaned files and artifacts no longer referenced by a thread/run. It does not silently remove referenced artifacts from live or archived transcripts. When referenced content fills the cap, new capture fails with a storage-full result and directs the user to cleanup.

Thread deletion removes its artifacts. Archive retains them. Rewind/truncation removes metadata references and makes the files eligible for orphan cleanup. A user capture made during an active run is linked to that run; otherwise it uses the `manual` artifact directory and a null run ID.

## Screenshot and recording flow

For an agent screenshot:

1. the scoped tool and lease are validated;
2. `simctl io <udid> screenshot` writes to an app-owned temporary PNG;
3. the artifact store validates and registers it against the active run/tool call;
4. the MCP result returns the artifact ID plus an image content block resized to at most 1,600 pixels wide and 4 MiB; and
5. the transcript renders the durable artifact independently of provider stream parsing.

This avoids the current Claude-only durability path for MCP image blocks.

For a recording:

1. approval is granted;
2. `simctl io <udid> recordVideo --codec=h264 --force <temp.mp4>` starts in its own process group;
3. the service enforces duration and size limits;
4. stop, timeout, run stop, takeover, or shutdown sends `SIGINT`;
5. the service waits a bounded interval for MP4 finalization;
6. a screenshot is captured as the poster;
7. validated MP4 and poster files are atomically registered; and
8. the MCP/pane result returns artifact metadata, never base64 video.

`SIGKILL` is only a final fallback, and an unfinalized temporary recording is never registered as an artifact.

## Artifact delivery and rendering

Electron uses an opaque `solenta-media://artifact/<id>` URL. The media protocol supports `HEAD` and byte-range reads so Chromium video controls can seek without loading the full MP4.

Solenta Web gets a separate authenticated, thread-authorized range endpoint. The JSON wire protocol carries metadata only; video bytes never pass through WebSocket RPC or a data URL. Simulator control invoke channels remain desktop-only and are explicitly refused by the web bridge.

The thread transcript groups artifacts by run and optional tool call. It renders:

- image thumbnail and existing lightbox behavior;
- MP4 poster, native playback controls, duration, and download;
- missing/corrupt media state; and
- source, timestamp, and run association.

`VerifyResult` gains optional artifact IDs so later verification work can identify which evidence supported the gate. PR publishing remains out of scope.

## IPC and pane integration

`CoderApi` gains a desktop simulator namespace for:

- capability/status;
- device list;
- attach/detach/takeover;
- install/launch/open URL;
- input and hardware actions;
- screenshot and recording;
- accessibility; and
- stream connection details.

Simulator invoke channels are declared in the shared IPC table and preload bridge but placed on an explicit desktop-only denylist in the web bridge. Push channels report status changes, ownership changes, recording state, and pane-focus requests.

`simulator` is added to the pane registry. Existing Browser pane behavior is the model for opening, focus, persistence, and thread-scoped rendering, but the Simulator pane does not require a renderer WebView.

## Error model

Every operation returns or throws a typed code from these groups:

- `unsupported_platform` and `remote_project`;
- `xcode_missing`, `license_required`, and `runtime_missing`;
- `helper_compile_failed`, `sandbox_failed`, and `capability_unavailable`;
- `device_missing`, `device_busy`, `lease_stale`, and `takeover_required`;
- `worktree_missing`, `invalid_app_path`, and `invalid_bundle`;
- `approval_denied`, `approval_expired`, and `run_ended`;
- `stream_disconnected` and `decoder_failed`;
- `recording_failed`, `recording_finalize_failed`, and `artifact_limit`;
- `timeout`, `cancelled`, and `unexpected`.

Errors shown in the pane include a recovery action when one is safe. Logs are bounded and redact tokens, full environment dumps, and private app content. MCP errors include enough structured context for the agent to recover but never helper internals, host paths outside the worktree, or approval tokens.

## Testing strategy

### Main-process unit tests

`electron/test/ios-simulator.test.js` uses injected platform, filesystem, clock, spawn, and exec functions. It covers:

- zero subprocesses off macOS and for remote projects;
- pending/missing worktree handling without checkout fallback;
- Xcode, runtime, and device JSON parsing;
- exact command paths, argv, environment, cwd, and `shell: false`;
- app traversal and symlink escapes;
- malformed UDIDs, bundle IDs, URLs, text, and coordinates;
- lease contention, takeover, generation races, and recovery;
- compiler/helper timeout, cancellation, output caps, and process-tree kill;
- ownership-aware detach and shutdown;
- recording SIGINT, timeout, finalization, and corrupt temporary files; and
- separate degraded helper capabilities.

### Helper and protocol tests

- Source digest/cache invalidation tests
- Sandbox profile parameter and fail-closed tests
- Handshake and maximum-frame tests
- AVCC configuration/keyframe/delta fixtures
- Backpressure/drop/force-IDR behavior
- Coordinate conversion and payload bounds
- Compile check on Xcode-equipped macOS CI
- A manual acceptance matrix for Xcode 26 and 27 with at least one iOS runtime each

No test may require a booted simulator in the normal cross-platform `npm test` job.

### Agent and security tests

- Run-scoped capability issuance, expiry, revocation, and thread binding for each provider
- App-wide orchestrator token refusal for simulator actions
- Same-project cross-thread spoof refusal
- Approval allow-once, allow-for-run, deny, expiry, coalescing, and run cancellation
- MCP action schema bounds and screenshot image result
- Simulator channels rejected over the web bridge

### Artifact tests

- Opaque ID and thread/run isolation
- Atomic writes and orphan cleanup
- MIME magic, extension, size, duration, traversal, and symlink refusal
- MP4 byte ranges and authenticated Web delivery
- Archive retention, delete cleanup, rewind orphaning, and cap behavior
- Screenshot and recording linkage to run/tool/verification metadata

### Renderer tests

- Pane registry and persistence
- Capability checklist and degraded states
- Device selection, busy owner, takeover, and reconnect
- WebCodecs lifecycle with a fake decoder
- Canvas coordinate mapping
- Auto-open after agent launch
- Permission prompts
- Image/video artifact rendering and missing-media states

### Verification

Run focused tests while implementing, then:

```sh
npm run typecheck
npm run build
npm test
```

Native compile and real Simulator acceptance are separate required evidence because this development host does not have full Xcode installed. Issue #248 must not be closed based only on mocked Node tests.

## Delivery order

1. Land the generic run-artifact model, store, media delivery, and transcript rendering.
2. Land platform discovery, strict worktree/app validation, device commands, leases, and recovery.
3. Land helper compilation, sandbox, protocol, H.264 capture, input, and accessibility.
4. Land the Simulator pane and direct user control.
5. Land run-scoped MCP identity, approval-gated agent actions, and auto-open behavior.
6. Integrate screenshot/recording artifacts and full lifecycle cleanup.
7. Complete cross-platform tests, Xcode CI compile proof, real Simulator acceptance, packaging, notices, and user documentation.

Each stage preserves a passing cross-platform suite. No stage introduces an unsandboxed helper fallback, arbitrary command execution, or provider-specific simulator behavior.

## Acceptance criteria

The issue is complete only when:

1. A macOS user with full Xcode can select and boot an available simulator in a thread pane.
2. A validated `.app` beneath that thread's worktree can be installed and launched.
3. The pane displays a live H.264 stream and supports direct pointer, keyboard, swipe, and hardware input.
4. The owning thread's agent can use the bounded simulator tool while another thread cannot spoof ownership.
5. Agent input, lifecycle mutation, URL opens, and recording obey the specified approvals.
6. Accessibility output identifies visible iOS elements with frames matching device coordinates.
7. Screenshots and finalized MP4s appear as durable run artifacts and survive app restart/archive.
8. Slow viewers do not block RPC or input, and stale lease generations cannot mutate a transferred device.
9. Crash recovery cleans up only Solenta-owned processes/device boots.
10. Simulator controls are unavailable on non-macOS, remote projects, and Solenta Web.
11. Cross-platform tests pass, the helper compiles in Xcode-equipped CI, and the real-device acceptance matrix passes.

