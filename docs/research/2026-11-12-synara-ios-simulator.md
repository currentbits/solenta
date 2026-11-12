# Synara iOS simulator adoption

Implemented 2026-11-12. Tracking: [Solenta #2000](https://github.com/currentbits/solenta/issues/2000).
This follows the [feature and merged-PR research](2026-11-12-synara.md).

## Source and decision

Use Synara's modern input transport and display discovery inside Solenta's
existing native helper. The source is pinned to merged [PR #2108](https://github.com/Emanuele-web04/synara/pull/2108),
commit `c96b82879b4fe4b110133dac06ba6138a9d9761f`.
Upstream access remained read-only. The [MIT license](../../native/ios-simulator-helper/LICENSES/Synara-MIT.txt)
preserves both copyright notices; the [helper notices](../../native/ios-simulator-helper/NOTICE.md)
map every adapted file to its source. Packaging already includes this directory.

Synara's implementation addresses a concrete compatibility gap: newer
CoreSimulator routes input through the guest `dtuhidd` XPC service rather than
the legacy Indigo HID client. Its display code also supports the current
forwarded display descriptors and separate damage/surface callbacks.

## What was adopted

| Upstream source | Solenta implementation |
| --- | --- |
| [DTUHIDTransport.h/.m](https://github.com/Emanuele-web04/synara/blob/c96b82879b4fe4b110133dac06ba6138a9d9761f/apps/server/native/device-helper/Sources/DTUHIDTransport.m) | Copied transport with per-device XPC connection, numeric touch/key/button messages, daemon liveness probe, cancellable warm-up and flush barrier. |
| [HIDBridge.m](https://github.com/Emanuele-web04/synara/blob/c96b82879b4fe4b110133dac06ba6138a9d9761f/apps/server/native/device-helper/Sources/HIDBridge.m) | Adapted readiness, dispatch, key-release cleanup, typing cadence and home/lock/volume usages into the existing C bridge. Device-point coordinates normalize at this boundary. |
| [CoreSimulatorBridge.swift](https://github.com/Emanuele-web04/synara/blob/c96b82879b4fe4b110133dac06ba6138a9d9761f/apps/server/native/device-helper/Sources/CoreSimulatorBridge.swift) | Discover SimulatorKit in both developer-directory and sibling SharedFrameworks locations; select the largest valid framebuffer from `ioPorts`. |
| [FrameStream.swift](https://github.com/Emanuele-web04/synara/blob/c96b82879b4fe4b110133dac06ba6138a9d9761f/apps/server/native/device-helper/Sources/FrameStream.swift) | Register damage and IOSurface-change callbacks, and seed the idle screen immediately. Validate runtime method signatures on forwarded ROCK objects. Revoke callback context before unregistering to make late callbacks inert. |
| [main.swift](https://github.com/Emanuele-web04/synara/blob/c96b82879b4fe4b110133dac06ba6138a9d9761f/apps/server/native/device-helper/Sources/main.swift) | Close the just-opened video connection if capture cannot start. |
| [useDeviceVideoStream.ts](https://github.com/Emanuele-web04/synara/blob/c96b82879b4fe4b110133dac06ba6138a9d9761f/apps/web/src/components/device/useDeviceVideoStream.ts) | Paint only the newest decoded frame per animation frame; close superseded buffers; retain identical codec configuration. Also fence delayed JPEG seeds and callbacks from a replaced decoder. |

CoreSimulator 1155.4+ takes DTUHID only when required symbols and the guest-service
lookup method pass probes. It never silently falls back to Indigo on that path.
Older CoreSimulator retains Solenta's existing probed Indigo implementation.
Input gets an eight-second native budget plus at most one second for key-release
cleanup, inside the ten-second control timeout. Errors distinguish refusal before
dispatch from uncertain partial delivery. The parent never automatically replays either.

Solenta keeps its existing owner lease, control protocol, authenticated loopback
broker, SLV1/AVCC encoding, and pane interface. This is an adaptation into those
boundaries, rather than a second device manager.

## Live acceptance and tests

Host: macOS arm64, Xcode **27.2 (27B52)**, CoreSimulator **1174.21**.
Guest: an isolated **iOS 26.5** simulator running a small UIKit fixture.
The helper ran under the production Seatbelt profile, through its actual control
pipes and the production WebSocket stream broker.

- Tap at the fixture button changed accessibility label `Count 0` to `Count 1`;
  before/after simulator screenshots also confirmed that change.
- Tapping the text field and sending `Ab` produced the exact field value `Ab`.
- Home returned success through DTUHID.
- Stream startup succeeded. The viewer received JPEG, a 26-byte avcC record,
  H.264 keyframes, and subsequent delta frames. Capture then stopped normally.
- The disposable QA simulator was shut down and deleted after verification.

Live capture found two missing sandbox permissions: IOSurface import failed in
ROCK deserialization, and VideoToolbox could not look up its encoder service.
Added only `IOSurfaceRootUserClient` and `com.apple.coremedia.videoencoder` grants.
The profile still denies child processes, home content access, listening sockets
and non-loopback connections. It allows reading the exact selected sibling
SimulatorKit framework. All nine sandbox self-checks pass, including the new
IOSurface/encoder creation checks.

Validation:

- **329 Electron simulator tests** pass across manager, stream, protocol, process,
  toolchain and lifecycle suites, with inherited `CODER_*` settings removed.
- **42 renderer simulator tests** pass across stream, pane, geometry and protocol.
- **28 Swift helper tests** pass. Failed-capture cleanup now verifies socket closure;
  a reserved-header fixture was corrected so the intended length check is reached.
- The standalone native adapter harness passes: coordinate normalization, mixed-case
  key ordering, partial-send release, dead-service/expired-budget refusal, uncertain
  flush, supported buttons, forwarded display callbacks, initial frame and late-callback teardown.
  Its compile/run command is in the helper notices.
- TypeScript/IPC typecheck and `git diff --check` pass.

## Limits

No guest iOS 27 runtime was installed, so the acceptance result is specifically
Xcode 27.2 with iOS 26.5. The older Indigo route was retained but not exercised
against an older installed Xcode. No signed/released application upgrade or
full desktop-pane visual test was run.

Text retains the existing ASCII HID mapping. Synara's separate accessibility-based
Unicode replacement, edge gestures and per-device manager were not ported.
Action/shake are unavailable on DTUHID because this source provides no supported
mapping. Apple private APIs remain a compatibility risk after toolchain updates;
the probes, explicit delivery errors and sandbox self-checks fail visibly.
