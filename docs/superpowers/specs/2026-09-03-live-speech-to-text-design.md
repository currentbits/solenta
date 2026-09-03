# Live Speech-to-Text Design

**Status:** Approved in conversation on 2026-09-03

## Goal

Add private, English-only live microphone dictation to Solenta's message
composer on macOS arm64, Windows x64, and Linux x64. Partial words appear in
the draft while the user speaks; stopping commits the final transcript for
normal editing or sending.

## Decisions

- Use NVIDIA NeMo-Speech.cpp v0.1.0 as a bundled native sidecar.
- Use `nvidia/nemotron-speech-streaming-en-0.6b` Q8 GGUF, not Parakeet TDT.
  It is a cache-aware streaming English model supported by the native runtime.
- Capture audio with Chromium's `getUserMedia` and an `AudioWorklet`; send
  little-endian 16 kHz mono PCM16 to the main process.
- Keep the renderer sandboxed. The main process owns model files, child
  processes, loopback authentication, downloads, and shutdown.
- Download the roughly 700 MB model after explicit user confirmation. Do not
  include it in application archives.
- Bundle only the runtime needed by each existing release target: Metal on
  macOS arm64 and CPU on Windows/Linux x64. Accelerator variants are added
  only if the feasibility gate proves CPU cannot sustain real-time inference.
- Permit one app-wide transcription session. Keep the composer textarea
  read-only while recording so provisional updates cannot conflict with
  concurrent typing.
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

## Architecture

### Renderer

`Composer` owns the microphone control and provisional draft range. It reuses
the existing uncontrolled textarea helpers (`readDraft`, `writeDraft`, and
`rememberDraft`) so live updates do not turn typing into a React render loop.

On start, the composer records the current draft, cursor position, and thread
id. The textarea becomes read-only. Each partial result replaces only the
provisional range at that cursor. A final result commits that range and makes
the textarea editable. Cancel restores the exact original draft and cursor.
Changing thread, archiving, unmounting, or pressing Escape cancels.

An `AudioWorklet` downsamples the microphone stream to 16 kHz mono and batches
PCM16 into approximately 100 ms chunks before invoking the typed speech IPC.
The worklet contains no model or network logic. Tracks, nodes, and the audio
context are always closed on stop, cancel, failure, and unmount.

### IPC boundary

Extend the existing `CoderApi` and generated preload channel table with a
small `speech` namespace:

- `status()` returns runtime/model availability and the current lifecycle
  state.
- `download()` starts the user-approved model download and returns progress
  through a `speech:changed` push event.
- `start()` starts one authenticated realtime session.
- `write(pcm)` accepts a bounded PCM16 chunk for the active session.
- `stop()` requests a final transcript.
- `cancel()` discards the active transcript.

`speech:changed` carries state, download progress, partial/final text, and one
user-facing error string. Every operation validates the sender, lifecycle
state, payload type, and payload size. Unknown or stale session operations are
rejected rather than applied to a later recording.

### Main-process speech manager

Add one focused module, `electron/speech.js`, created once during boot and
injected into `registerIpc`. It owns:

- the single lifecycle state;
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
2. A click while `missing` shows an inline confirmation containing the exact
   download size. Confirmation calls `download()`; it does not open the mic.
3. Download writes only to a `.partial` file, streams progress, verifies the
   pinned byte length and SHA-256, then atomically renames it. Cancelled,
   truncated, or mismatched files are deleted.
4. A later click while `ready` calls `getUserMedia({ audio: true })`. The OS
   permission prompt therefore follows a direct user gesture.
5. After capture succeeds, `start()` launches or reuses the sidecar, waits for
   readiness, and opens its authenticated `/v1/realtime` socket.
6. The renderer sends bounded PCM chunks. The main process forwards them and
   emits partial text. The composer replaces its one provisional range.
7. Stop flushes the worklet, closes capture, asks the socket to finalize, and
   commits the final text. Empty final text restores the original draft.
8. Cancel or any error closes capture/socket and restores the original draft.

Audio is never written to disk. Once the model exists, the speech manager
makes no outbound request.

## Permissions and security

Install Electron permission request and permission check handlers after
`app.whenReady()`. Grant `media` only when the request comes from Solenta's
main frame, `details.mediaType` is `audio`, and recording was initiated by the
composer. Deny video, guest webview, subframe, and unrelated media requests.
Keep the renderer's existing sandbox and context isolation enabled.

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
restore the original draft and release all audio resources. A sidecar crash
returns the manager to `ready` so the next explicit click may restart it; it
does not retry a recording automatically.

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

- Renderer tests mock media capture and speech IPC, covering download
  confirmation, partial replacement, final commit, Escape cancellation,
  thread switching, cleanup, and accessible labels/states.
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

## Sources

- [NeMo-Speech.cpp runtime](https://github.com/NVIDIA/NeMo-Speech.cpp)
- [NeMo-Speech.cpp v0.1.0 release](https://github.com/NVIDIA/NeMo-Speech.cpp/releases/tag/v0.1.0)
- [Realtime server protocol](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/server.md)
- [English streaming model](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b)
- [Electron session permissions](https://www.electronjs.org/docs/latest/api/session)
