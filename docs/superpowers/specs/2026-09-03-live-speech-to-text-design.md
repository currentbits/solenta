# Live Speech-to-Text Design

**Status:** Approved in conversation on 2026-09-03. SpeechSink erratum
applied 2026-09-03 (issues #168 / #855).

## Goal

Add private, English-only live microphone dictation to Solenta's message
composer on macOS arm64, Windows x64, and Linux x64. Partial words appear in
the draft while the user speaks; stopping commits the final transcript for
normal editing or sending. Capture is one app-wide renderer `SpeechSink`
(`dictation` XOR `intermediary` XOR `none`). Composer is the dictation
consumer of `speech:changed`, not the owner of `getUserMedia`.

## Decisions

- Use NVIDIA NeMo-Speech.cpp v0.1.0 as a bundled native sidecar.
- Use `nvidia/nemotron-speech-streaming-en-0.6b` Q8 GGUF, not Parakeet TDT.
  It is a cache-aware streaming English model supported by the native runtime.
- Capture audio with Chromium's `getUserMedia` and an `AudioWorklet` inside
  `SpeechSink`; send little-endian 16 kHz mono PCM16 to the main process.
- Keep the renderer sandboxed. The main process owns model files, child
  processes, loopback authentication, downloads, and shutdown.
- Download the roughly 700 MB model after explicit user confirmation. Do not
  include it in application archives.
- Bundle only the runtime needed by each existing release target: Metal on
  macOS arm64 and CPU on Windows/Linux x64. Accelerator variants are added
  only if the feasibility gate proves CPU cannot sustain real-time inference.
- Permit one app-wide transcription session. A renderer module singleton
  `SpeechSink` (`src/speechSink.ts`) is the only `getUserMedia` and
  `speech.start` caller. `kind` is `dictation` | `intermediary` | `none`
  (exactly one). Composer is the `dictation` consumer of `speech:changed`.
  The Talk through it sheet (#168) is the `intermediary` consumer and is
  not implemented here. Composer textarea is read-only while
  `SpeechSink.kind === "dictation"` so provisional updates cannot conflict
  with concurrent typing. It stays editable while `kind === "intermediary"`
  or `none`.
- Electron `media` permission keys off `speech.start` from the main frame
  (session initiated / in flight), not a renderer `SpeechSink` object.
- SpeechSink + the Dictate consumer ship in this issue's renderer PR.
  Do not change the NeMo sidecar or `electron/speech.js` protocol to add
  a second session.
- All implementation work must be performed by workers forked with
  `pool="grok"`. The orchestrator may plan, inspect, review, and request the
  user's permission to land completed worker branches, but must not implement
  product code itself.

## Non-goals

- Languages other than English
- File transcription, transcript history, or retained audio
- Cloud transcription or cloud fallback
- Microphone/device selection
- Speaker diarization, word boosting, translation, or voice commands
- A general model manager or settings screen
- Windows/Linux GPU backends unless the CPU feasibility gate fails
- Voice intermediary / Talk through it (#168). This spec only reserves
  `SpeechSink.kind === "intermediary"` so dictation and intermediary can
  share one session. Do not add VoicePanel, `voiceByThread`, Distill, or
  Dispatch here.

## Architecture

### Renderer

A renderer module singleton `SpeechSink` (`src/speechSink.ts`) owns capture
(`getUserMedia`, AudioWorklet, `speech.start` / `write` / `stop` /
`cancel`) and consumes `speech:changed`. `kind` is `dictation` |
`intermediary` | `none` (one at a time). Composer owns the **Dictate**
control and the provisional draft range as the `dictation` consumer: it
still uses `readDraft` / `writeDraft` / `rememberDraft` so live updates do
not turn typing into a React render loop. The Talk through it sheet (#168)
is the `intermediary` consumer and must not write the composer draft.
`SpeechSink.start()` is the only `getUserMedia` caller.

SpeechSink + Dictate ship in this issue's renderer PR. #168's later mic PR
only subscribes VoicePanel as `intermediary`. Do not implement Talk through
it here. Do not change the NeMo sidecar or `electron/speech.js` protocol.

```ts
export type SpeechSinkKind = "none" | "dictation" | "intermediary";

export interface SpeechSink {
  kind: SpeechSinkKind;
  /** Current live line from speech:changed partial. Replace, not concat. */
  partial: string;
  setKind(next: SpeechSinkKind): Promise<void>; // cancels the other consumer
  start(): Promise<void>;  // getUserMedia + speech.start + worklet
  stop(): Promise<void>;   // finalize; deliver completed text to the consumer
  cancel(): Promise<void>; // discard partial; restore draft if dictation
  subscribe(fn: () => void): () => void;
}
```

`useSpeechSink()` subscribes on mount and unsubscribes on unmount. Composer
imports `{ speechSink, useSpeechSink }` from `../speechSink`. Do not
construct a second instance. Importing the module from `App.tsx` is enough
to create the singleton at renderer boot.

Dictate lives in Composer's left `pills` row (attach / model), labeled
**Dictate**, not next to Send. Hide it on web.

On Dictate start, SpeechSink sets `kind` to `dictation` and the composer
records the current draft, cursor position, and thread id. The textarea
becomes read-only. Each `speech:changed` **partial** is the current live
line: replace the provisional range at that cursor; do not concatenate
renderer-side. A **final** / completed result commits that range and makes
the textarea editable. Cancel restores the exact original draft and cursor.
Empty final text restores the original draft. Changing thread, archiving,
unmounting, or pressing Escape cancels. Starting `intermediary` while
`dictation` is active cancels dictation (restore draft and cursor).
Starting `dictation` while `intermediary` is active cancels intermediary
capture (discard the live partial; do not clear the #168 session).

An `AudioWorklet` downsamples the microphone stream to 16 kHz mono and batches
PCM16 into approximately 100 ms chunks before invoking the typed speech IPC.
The worklet contains no model or network logic. Tracks, nodes, and the audio
context are always closed on stop, cancel, failure, and unmount. SpeechSink
owns that teardown; Composer does not open or close the mic.

### IPC boundary

Extend the existing `CoderApi` and generated preload channel table with a
small `speech` namespace:

- `status()` returns runtime/model availability and the current lifecycle
  state.
- `download()` starts the user-approved model download and returns progress
  through a `speech:changed` push event.
- `start()` starts one authenticated realtime session. Invoking it from
  the main frame is what the `media` permission handler keys off.
- `write(pcm)` accepts a bounded PCM16 chunk for the active session.
- `stop()` requests a final transcript.
- `cancel()` discards the active transcript.

`speech:changed` carries state, download progress, partial/final text, and one
user-facing error string. `partial` is the **current live line**: the
dictation consumer replaces the provisional range; it does not concatenate.
Final / completed text commits. Snapshot assembly of websocket frames, if
needed, belongs in `electron/speech.js`. Every operation validates the
sender, lifecycle state, payload type, and payload size. Unknown or stale
session operations are rejected rather than applied to a later recording.

### Main-process speech manager

Add one focused module, `electron/speech.js`, created once during boot and
injected into `registerIpc`. It owns:

- the single lifecycle state. `start()` from the main frame must mark the
  session initiated **before** awaiting sidecar readiness, so the `media`
  permission handler can grant `getUserMedia` in the same click turn. That
  is a flag on the existing session, not a new IPC method.
- the bundled runtime path for the current platform and architecture;
- the model path below `app.getPath("userData")/speech`;
- model download, streaming SHA-256 verification, `.partial` cleanup, and
  atomic rename;
- one NeMo-Speech.cpp child process;
- a random loopback port and per-process bearer token;
- readiness polling and one realtime WebSocket;
- bounded PCM writes and parsed partial/final events;
- cancellation, crash recovery, and teardown.

Start the sidecar lazily on the first recording and retain it for later
recordings. Bind only to `127.0.0.1`, disable its playground, require a random
token, and never expose the token or port to the renderer. Use the already
installed `ws` dependency from the main process. Register speech teardown in
the existing application cleanup phase so normal quit, SIGINT, and SIGTERM
all terminate it.

## Lifecycle and data flow

1. The initial status is `missing`, `ready`, or `error` after checking the
   bundled runtime and verified model path.
2. A Dictate click while `missing` shows an inline confirmation containing
   the exact download size. Confirmation calls `download()`; it does not
   open the mic.
3. Download writes only to a `.partial` file, streams progress, verifies the
   pinned byte length and SHA-256, then atomically renames it. Cancelled,
   truncated, or mismatched files are deleted.
4. A later Dictate click while `ready` calls `SpeechSink.start()`. In the
   same user-gesture turn it invokes `speech.start` (main process marks the
   session initiated) and `getUserMedia({ audio: true })`. Do not await
   sidecar readiness before `getUserMedia` or Chromium drops the gesture.
   The OS permission prompt therefore follows the click.
5. After capture succeeds, the in-flight `speech.start` launches or reuses
   the sidecar, waits for readiness, and opens its authenticated
   `/v1/realtime` socket.
6. SpeechSink sends bounded PCM chunks. The main process forwards them and
   emits partial text. Composer, as the dictation consumer, replaces its
   one provisional range. Snapshot assembly of streaming frames, if needed,
   belongs in `electron/speech.js`, not in the renderer.
7. Stop flushes the worklet, closes capture, asks the socket to finalize,
   and commits the final text into the provisional range. Empty final text
   restores the original draft.
8. Cancel or any error closes capture/socket, sets `kind` to `none`, and
   restores the original draft.

Audio is never written to disk. Once the model exists, the speech manager
makes no outbound request.

## Permissions and security

Install Electron permission request and permission check handlers after
`app.whenReady()`. Grant `media` only when the request comes from Solenta's
main frame, `details.mediaType` is `audio`, and recording was initiated by
`speech.start` (the main-process session is live or the `start` IPC is in
flight). Deny video, guest webview, subframe, and unrelated media requests.
The renderer `SpeechSink` object is not visible to the permission handler;
do not key the grant off a renderer-only flag. Keep the renderer's existing
sandbox and context isolation enabled.

The main process accepts audio only for the active opaque session id. It caps
each chunk and rejects malformed, oversized, stale, or out-of-order writes.
The sidecar binds to loopback, requires its random bearer token, and exposes
neither its address nor credentials through preload. Model and runtime paths
are fixed below trusted application/user-data roots; user input never selects
an executable.

## Errors

User-visible errors distinguish:

- microphone permission denied;
- no input device;
- model download/network failure;
- model digest mismatch;
- bundled runtime missing or unsupported;
- sidecar readiness timeout;
- model load or out-of-memory failure;
- unexpected sidecar/socket exit.

Download errors leave the prior verified model untouched. Recording errors
while `kind === "dictation"` restore the original draft, set `kind` to
`none`, and release all audio resources. A sidecar crash returns the
manager to `ready` so the next explicit click may restart it; it does not
retry a recording automatically.

## Platform packaging

- macOS arm64: package the Metal runtime inside the app bundle, add
  `NSMicrophoneUsageDescription`, sign the runtime with the rest of the nested
  bundle, and include it in notarization verification.
- Windows x64: package the CPU runtime and adjacent DLLs inside
  `resources/app/runtime/speech`; keep the portable archive layout unchanged.
- Linux x64: package the CPU runtime and adjacent shared libraries at the same
  relative location and preserve executable bits in the tarball.

The packaging scripts download pinned NeMo-Speech.cpp release assets during a
release build, verify their published SHA-256 values, and copy only the target
runtime. Development may use an explicitly passed runtime path in tests, but
production does not search `PATH` or execute an arbitrary user-installed
binary.

## Feasibility gate

Before product integration, a Grok worker must prove the pinned runtime/model
pair on all three release targets. The spike may be throwaway and must not be
merged as product code. It passes only when:

- live partial and final text are produced on macOS arm64/Metal, Windows
  x64/CPU, and Linux x64/CPU;
- first partial text appears within 1.5 seconds;
- final text settles within 1.5 seconds after stop;
- real-time factor remains at or below 1.0 for five minutes;
- sidecar resident memory remains below 2.5 GB;
- warm-cache transcription succeeds with outbound networking blocked;
- runtime and model licenses permit Solenta's distribution model.

If Windows or Linux CPU misses the latency or throughput gate, stop and amend
this design with the measured backend choice before implementing a GPU path.
If the native runtime cannot satisfy the protocol or stability gates, do not
silently fall back to Python/NeMo or Parakeet TDT.

## Verification

- Renderer tests mock media capture and speech IPC. They cover SpeechSink
  XOR (`dictation` vs `none`; switching `kind` cancels the other consumer
  and does not start a second session), download confirmation, partial
  replacement of the live line, final commit into the provisional range,
  Escape cancellation, thread switching, cleanup, and accessible
  labels/states. Composer tests treat it as the dictation consumer, not
  the `getUserMedia` / `speech.start` caller.
- Electron tests inject fake fetch, child-process, readiness, and WebSocket
  dependencies into the speech manager. They cover digest verification,
  atomic install, lifecycle guards, payload bounds, partial/final parsing,
  crash recovery, and idempotent teardown.
- IPC lock tests ensure `CoderApi`, channel declarations, generated preload,
  desktop wiring, and browser/dev fakes remain aligned.
- Packaging tests assert the correct runtime tree, executable permissions,
  required licenses, and macOS microphone plist entry.
- A release-gate job on each supported OS runs `nemo-speech doctor` and a
  deterministic checked-in WAV transcription against the cached pinned model.
- Manual release acceptance records from a real microphone on all three OSes;
  CI cannot validate physical microphone permission dialogs.

## Product PRs (after the gate)

1. `speech` IPC namespace + `speech:changed` push (`CoderApi`,
   ipcChannels, preload, fakeCoder, devCoder). Unchanged by this erratum.
2. `electron/speech.js` manager, download/verify, sidecar, tests.
   Unchanged by this erratum. Do not add a second session or change the
   NeMo websocket protocol.
3. **Renderer:** `src/speechSink.ts` singleton, Dictate control as the
   `dictation` consumer, AudioWorklet, Composer provisional range, tests.
   This is where SpeechSink lands. Do not implement #168 here.
4. Packaging, `NSMicrophoneUsageDescription`, licenses, CI
   `nemo-speech doctor` + checked-in WAV gate.

## Related

- Issue #845: live composer dictation (this spec).
- Issue #168: Talk through it / voice intermediary. Reserves
  `SpeechSink.kind === "intermediary"`. Product PRs for #168 stay blocked
  on an explicit implement ask.
- Issue #855: this SpeechSink erratum.

## Sources

- [NeMo-Speech.cpp runtime](https://github.com/NVIDIA/NeMo-Speech.cpp)
- [NeMo-Speech.cpp v0.1.0 release](https://github.com/NVIDIA/NeMo-Speech.cpp/releases/tag/v0.1.0)
- [Realtime server protocol](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/server.md)
- [English streaming model](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b)
- [Electron session permissions](https://www.electronjs.org/docs/latest/api/session)
