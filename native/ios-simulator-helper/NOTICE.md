# Solenta iOS Simulator helper — third-party notices

This package ships original Solenta source plus adaptations of two
independently licensed upstream projects. License texts are stored
verbatim under `LICENSES/`. Solenta does not execute or download either
project at runtime.

Adapted files were audited at the pinned revisions **before** any
implementation was copied. Private-framework calls are loaded with
`dlopen`/`dlsym` and Objective-C `method_getTypeEncoding` probes. A
capability is reported true only when its probes pass. No private
selector or C ABI is invented.

## Apache-2.0 — Baguette

- Project: https://github.com/tddworks/baguette
- Revision: `fb7cc51aec69e3fbb5a71f31b4fb1cc1191d7a2c`
- License copy: `LICENSES/Baguette-APACHE-2.0.txt`

Files adapted (paths relative to `Sources/Baguette/`):

- `Infrastructure/Stream/AVCCStream.swift`
  — JPEG-seed-then-AVCC cadence, force-IDR flag, bitrate apply.
- `Infrastructure/Stream/H264Encoder.swift`
  — VideoToolbox realtime session, no frame reordering, avcC blob
  from `CMVideoFormatDescriptionGetH264ParameterSetAtIndex`, one
  AVCC sample per output. Solenta uses keyframe interval 30, 30 fps,
  and initial 1.5 Mbps (not Baguette's 5 s interval / 2 Mbps default).
- `Infrastructure/Input/IndigoHIDInput.swift`
  — SimulatorKit symbol names, `SimDeviceLegacyHIDClient`,
  `sendWithMessage:freeWhenDone:completionQueue:completion:`,
  `IndigoHIDMessageForButton` (home/lock),
  `IndigoHIDMessageForHIDArbitrary` (keyboard + volume/action),
  pointer/mouse service warm-up. Touch uses the 7-arg
  `IndigoHIDMessageForMouseNSEvent` shape documented in this file as
  the real ABI (see disagreements below). Solenta does **not** adapt
  `IOHIDDigitizerDispatch` byte-offset patching.
- `Infrastructure/Accessibility/AXPTranslatorAccessibility.swift`
  — AXPTranslator shared instance, bridge-token delegate,
  `frontmostApplicationWithDisplayId:bridgeDelegateToken:`,
  `macPlatformElementFromTranslation:`, SimDevice
  `sendAccessibilityRequestAsync:completionQueue:completionHandler:`,
  token stamping, host-frame → device-point transform via
  `deviceType.mainScreenSize` / `mainScreenScale`.

Additional Baguette files consulted so capture has a probed source
(not in the original Task 3 list; recorded here before adapting):

- `Infrastructure/Screen/SimulatorKitScreen.swift`
  — `SimDevice.io`, `updateIOPorts`, `deviceIOPorts`,
  `portIdentifier == com.apple.framebuffer.display`,
  `registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:`,
  `unregisterScreenCallbacksWithUUID:`, `framebufferSurface`.
- `Infrastructure/Simulator/CoreSimulators.swift`
  — `SimServiceContext.sharedServiceContextForDeveloperDir:error:`,
  `defaultDeviceSetWithError:`, device UDID/state lookup.
  Solenta does **not** scan `/Applications` for Xcode; it uses only
  the caller-supplied `developerDir`.
- `Domain/Accessibility/AXElementReader.swift` and
  `Domain/Accessibility/AXFrameTransform.swift`
  — `accessibilityFrame` IMP, attribute reads, width-uniform scale.

## MIT — ios-mcp-server

- Project: https://github.com/martingeidobler/ios-mcp-server
- Revision: `bd5aca70704fe0fb5e974abaed205f54469799b0`
- License copy: `LICENSES/ios-mcp-server-MIT.txt`

Files adapted:

- `native/simtouch.m`
  — `IndigoHIDMessageForMouseNSEvent` target `0x32`, nsEventType
  1/2/6 (down/up/dragged), `SimDeviceLegacyHIDClient`,
  `sendWithMessage:freeWhenDone:completionQueue:completion:`,
  normalized 0–1 coordinates. The 5-arg C typedef plus ARM64 `d0–d3=1.0`
  assembly is **not** used (see disagreements).
- `native/simtree.m`
  — AccessibilityPlatformTranslation path, AXPTranslator enable +
  bridge delegate, `frontmostApplicationWithDisplayId:bridgeDelegateToken:`,
  `macPlatformElementFromTranslation:`,
  `accessibilityAttributeValue:` / `accessibilityFrame` /
  `AXChildren` walk, JSON emission. Output is bounded to role, label,
  identifier, value, enabled, selected, and frame (no hint/center/index).

## Audit: agreements, disagreements, probes

Framework paths that both sources (or the single source, for capture)
use and that this helper probes:

| Framework | Path |
| --- | --- |
| CoreSimulator | `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator` |
| SimulatorKit | `$DEVELOPER_DIR/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit` |
| CoreSimDeviceIO | `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Frameworks/CoreSimDeviceIO.framework/CoreSimDeviceIO` |
| AccessibilityPlatformTranslation | `/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation` |
| SimRenderingServices (bundle) | CoreSimulator `Resources/SimRenderingServices.simdeviceio` |

Xcode 26.6 (17F113) SimulatorKit on this host was inspected with
`dlopen` + `method_getTypeEncoding` and `otool` of C prologues. That
is a binary/signature audit, **not** a booted-simulator acceptance
run. Xcode 27 was not present.

### Capture / stream

Only Baguette implements framebuffer capture among the pinned files.
Selectors and encodings confirmed on this host for the IO client path:

- `SimDevice.io` `@16@0:8`
- `SimDeviceIOClient.updateIOPorts` `v16@0:8`
- `SimDeviceIOClient.deviceIOPorts` `@16@0:8`
- `SimDeviceIOPort.portIdentifier` `@16@0:8`
- `SimDeviceIOPort.descriptor` `@16@0:8`

`registerScreenCallbacksWithUUID:…` and `framebufferSurface` exist as
ObjC selector strings inside SimulatorKit and as Swift methods on
`SimRenderServer.FramebufferDisplayDescriptor`. The live descriptor
class is not instantiated without a booted device, so the callback
encoding is probed on the concrete descriptor at `SHStartCapture`.
Handshake `stream` is true only when SimulatorKit + the IO client
encodings above resolve under the supplied `developerDir`.

### Touch (`IndigoHIDMessageForMouseNSEvent`) — disagreement

| Source | Claimed C shape |
| --- | --- |
| ios-mcp-server `simtouch.m` | 5 integer args `(CGPoint*, void*, int target, int nsEventType, int direction)` plus ARM64 asm setting `d0–d3 = 1.0`. Direction 1/2/0. |
| Baguette `IndigoHIDInput.swift` | 9-arg `(CGPoint*, CGPoint?, target, eventType, direction, 1.0, 1.0, width, height)` for taps **and** 7-arg `(CGPoint*, CGPoint?, target, eventType, edge, width, height)` for edge gestures, both `dlsym`'d from the same symbol. Production taps were moved to `IOHIDDigitizerDispatch` (byte patches at 0x6c / 0x3a). |

SimulatorKit 17F113 prologue at `_IndigoHIDMessageForMouseNSEvent`
(`0x11270`) saves `x0…x4` and `q0/q1` (`d0/d1`) and `cmp x24, #0x4`
(edge max). That matches Baguette's documented **7-arg** shape, not
the 5-arg or 9-arg typedefs.

Solenta therefore:

- Does **not** call the 5-arg or 9-arg typedefs.
- Does **not** adapt `IOHIDDigitizerDispatch` offset patching.
- Calls the 7-arg form with `edge = 0` (none), nsEventType 1/2/6,
  normalized device-point ratios, and `NSSize(1,1)`.
- Enables `touch` only after SimulatorKit, the mouse symbol, and
  `SimDeviceLegacyHIDClient` init/send encodings probe true.

Xcode 27 may change this C shape; the capability must fail closed
there until encodings/symbols are re-confirmed.

### Keyboard / hardware buttons

ios-mcp-server does not implement keyboard or hardware buttons.
Baguette's symbols were confirmed in SimulatorKit 17F113:

- `IndigoHIDMessageForButton` uses `x0,x1,x2` (3 ints) — home arg0=0,
  lock arg0=1, direction 1/2, target `0x33`.
- `IndigoHIDMessageForHIDArbitrary` uses `x0…x3` (4 ints) —
  `(target=0x32, page, usage, operation 1/2)`.

HID usages for volume/action/keyboard page 7 come from Baguette
`Domain/Common/CoordinateTypes.swift` / `Domain/Input/Keyboard.swift`
(consumer page 12 usages 233/234, telephony page 11 usage 45). Those
are public HID table values, not private ABI.

`hardwareButtons` does not include shake: neither pinned file
documents a shake ABI (`IndigoHIDMessageForDeviceMotionLiteEvent`
takes a buffer whose layout we will not guess). Shake requests fail
closed.

### Accessibility — partial disagreement

Agreed and encoding-confirmed:

- AXP path `/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/…`
- `+AXPTranslator.sharedInstance` `@16@0:8`
- `-setAccessibilityEnabled:` `v20@0:8B16`
- `-setBridgeTokenDelegate:` `v24@0:8@16`
- `-frontmostApplicationWithDisplayId:bridgeDelegateToken:` `@28@0:8I16@20`
  (`displayId` is `uint32_t`, **not** `NSInteger`)
- `-macPlatformElementFromTranslation:` `@24@0:8@16`
- `AXPMacPlatformElement.accessibilityFrame` `{CGRect=…}16@0:8`
- `accessibilityAttributeValue:` `@24@0:8@16`
- `SimDevice.sendAccessibilityRequestAsync:completionQueue:completionHandler:` `v40@0:8@16@24@?32`
- Bridge protocol methods:
  - `accessibilityTranslationDelegateBridgeCallbackWithToken:` `@?24@0:8@16`
  - `accessibilityTranslationConvertPlatformFrameToSystem:withToken:` `{CGRect=…}56@0:8{CGRect=…}16@48`
  - `accessibilityTranslationRootParentWithToken:` `@24@0:8@16`

Disagreement: ios-mcp-server passes `NSInteger displayId` (8 bytes on
LP64) into a 4-byte `I` slot and emits host-window frames (plus extra
JSON fields). Baguette passes `UInt32` and projects frames to device
points. Solenta uses the encoding-confirmed `uint32_t` slot and the
Baguette device-point transform so frames can match screenshot
coordinates. JSON is bounded to role, label, identifier, value,
enabled, selected, frame; depth and node count are capped in native
code.

### Memory / coordinates

- HID messages are allocated by SimulatorKit and freed when
  `freeWhenDone` is true (both sources).
- Framebuffers: SimulatorKit reuses IOSurface in place; Solenta copies
  into a new `CVPixelBuffer` before the capture callback returns.
- Touch coordinates are device points, divided by
  `mainScreenSize/mainScreenScale` to unit space.
- Accessibility frames are mapped with Baguette's width-uniform scale
  + vertical letterbox offset.

## Capability matrix (this helper)

| Capability | Shipped behind probes | Left false for ABI disagreement |
| --- | --- | --- |
| `stream` | Yes (SimulatorKit + IO client encodings; callback encoding at start) | No |
| `touch` | Yes (7-arg MouseNSEvent after binary audit) | 5-arg and 9-arg paths not shipped |
| `keyboard` | Yes (HIDArbitrary 4-arg) | No (ios-mcp has no keyboard) |
| `hardwareButtons` | Yes (Button 3-arg + HIDArbitrary volume/action) | Shake left unavailable (no pinned ABI) |
| `accessibility` | Yes (encoding-confirmed AXP selectors) | ios-mcp `NSInteger` displayId / extra JSON fields not used |
