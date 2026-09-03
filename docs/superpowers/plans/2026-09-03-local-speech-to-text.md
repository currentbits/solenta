# Local Speech-to-Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local Parakeet speech-to-text to the desktop composer without adding a JavaScript dependency or sending audio off-device.

**Architecture:** Chromium records and converts one utterance to float32 WAV. The main process validates it and runs NVIDIA's installed `nemo-speech` CLI against a Solenta-managed model directory. The returned text is inserted into the current draft and never auto-sent.

**Tech Stack:** Electron 35, React 19, TypeScript, Node.js, NVIDIA NeMo-Speech.cpp 0.1.0+, Parakeet TDT 0.6B v3.

**Spec:** `docs/superpowers/specs/2026-09-03-local-speech-to-text-design.md`

## Global Constraints

- Use `nvidia/parakeet-tdt-0.6b-v3` and keep audio local.
- Require `nemo-speech` 0.1.0 or newer on `PATH`; do not add or bundle a runtime in this change.
- Model download must require an explicit click and disclose about 715 MB.
- Insert text into the draft at the current selection; never auto-send.
- Maximum WAV payload is 32 MiB and maximum recording time is two minutes.
- Visible product copy must not contain em dashes.
- Add no npm dependency.

---

### Task 1: Main-process speech service

**Files:**
- Create: `electron/speech.js`
- Create: `electron/test/speech.test.js`

**Interfaces:**
- Produces: `createSpeechService({ userDataPath, which, execFile, fs, randomUUID })`
- Produces: `status(): Promise<{ runtimeAvailable: boolean; modelReady: boolean; modelBytes: number }>`
- Produces: `prepare(): Promise<{ runtimeAvailable: true; modelReady: true; modelBytes: number }>`
- Produces: `transcribe(input: { audio: ArrayBuffer | Uint8Array }): Promise<{ text: string }>`

- [ ] **Step 1: Write failing service tests**

Cover these externally observable breaks with literal expectations:

```js
it("does not claim the model is ready without the successful-pull sentinel", async () => {
  const speech = createSpeechService(fakeDeps({ runtime: "/bin/nemo-speech" }));
  assert.deepEqual(await speech.status(), {
    runtimeAvailable: true,
    modelReady: false,
    modelBytes: 714_000_000,
  });
});

it("pulls the pinned model into Solenta's model directory before marking it ready", async () => {
  const fx = fakeDeps({ runtime: "/bin/nemo-speech" });
  await createSpeechService(fx).prepare();
  assert.deepEqual(fx.calls[0].args, ["pull", "nvidia/parakeet-tdt-0.6b-v3"]);
  assert.equal(fx.calls[0].options.env.NEMO_SPEECH_MODEL_DIR, fx.modelDir);
  assert.equal(fx.files.has(fx.readyFile), true);
});

it("always removes the temporary WAV when transcription fails", async () => {
  const fx = fakeDeps({ runtime: "/bin/nemo-speech", transcribeError: new Error("boom") });
  await assert.rejects(createSpeechService(fx).transcribe({ audio: wavFixture() }), /boom/);
  assert.deepEqual([...fx.files].filter((name) => name.endsWith(".wav")), []);
});
```

Also cover missing runtime, versions older than 0.1.0, failed pull not writing the sentinel, empty/non-WAV/oversize input rejection, exact transcribe arguments, trimmed stdout, empty stdout, and a 120-second child-process timeout.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test electron/test/speech.test.js`

Expected: FAIL because `electron/speech.js` does not exist.

- [ ] **Step 3: Implement the minimum service**

Use the existing `defaultWhich` export from `electron/providers.js`, Node's `execFile`, and a Solenta-owned `speech` directory. Resolve and cache `nemo-speech --version`; accept version 0.1.0 or newer and return the same missing-runtime guidance for an older build. Keep constants private:

```js
const MODEL_ID = "nvidia/parakeet-tdt-0.6b-v3";
const MODEL_BYTES = 714_000_000;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
```

Validate `RIFF` at bytes 0 through 3 and `WAVE` at bytes 8 through 11 before writing. Invoke transcription as:

```js
["transcribe", wavPath, "--model", MODEL_ID, "--quiet"]
```

Set `NEMO_SPEECH_MODEL_DIR` on both pull and transcribe. Use `finally` for temporary-file cleanup. Do not shell-concatenate any path or argument.

- [ ] **Step 4: Run the service tests and verify GREEN**

Run: `node --test electron/test/speech.test.js`

Expected: PASS with no warnings.

- [ ] **Step 5: Commit**

```bash
git add electron/speech.js electron/test/speech.test.js
git commit -m "feat: add local Parakeet speech service"
```

### Task 2: Typed speech IPC

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/ipcChannels.ts`
- Modify: `electron/ipc.js`
- Modify: `electron/preload.js` through `scripts/sync-ipc-preload.js`
- Modify: `src/devCoder.ts`
- Modify: `test/support/fakeCoder.ts`
- Create: `electron/test/speech-ipc.test.js`

**Interfaces:**
- Consumes: Task 1's `createSpeechService`
- Produces: `SpeechStatus`
- Produces: `CoderApi.speech.status()`, `.prepare()`, and `.transcribe({ audio })`

- [ ] **Step 1: Write a failing IPC handler test**

Drive the real handler table with an injected speech service and assert returned values, not handler registration details:

```js
it("routes transcription through the main-process speech service", async () => {
  const speech = { transcribe: async ({ audio }) => ({ text: `bytes:${audio.byteLength}` }) };
  const out = await IPC_HANDLERS["speech:transcribe"]({ speech }, { audio: new ArrayBuffer(12) });
  assert.deepEqual(out, { text: "bytes:12" });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test electron/test/speech-ipc.test.js`

Expected: FAIL because `speech:transcribe` is absent.

- [ ] **Step 3: Add the typed bridge**

Add:

```ts
export interface SpeechStatus {
  runtimeAvailable: boolean;
  modelReady: boolean;
  modelBytes: number;
}

speech: {
  status(): Promise<SpeechStatus>;
  prepare(): Promise<SpeechStatus>;
  transcribe(input: { audio: ArrayBuffer }): Promise<{ text: string }>;
};
```

Add the three names to `IPC_CHANNELS`. Construct one speech service inside `makeCtx` and route handlers directly to it. Browser development and fake APIs should report unavailable status and reject prepare/transcribe with `Speech-to-text requires the desktop app.`

- [ ] **Step 4: Sync preload and verify**

Run: `node --experimental-strip-types scripts/sync-ipc-preload.js`

Run: `node --test electron/test/speech-ipc.test.js && npm run typecheck`

Expected: both commands PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/shared/ipcChannels.ts electron/ipc.js electron/preload.js src/devCoder.ts test/support/fakeCoder.ts electron/test/speech-ipc.test.js
git commit -m "feat: expose speech transcription over IPC"
```

### Task 3: Browser recording and WAV conversion

**Files:**
- Create: `src/speechCapture.ts`
- Create: `test/speechCapture.test.ts`

**Interfaces:**
- Produces: `audioBufferToMonoFloat32Wav(buffer: AudioBuffer): ArrayBuffer`
- Produces: `createSpeechRecorder(deps?): { start(): Promise<void>; stop(): Promise<ArrayBuffer>; cancel(): void }`

- [ ] **Step 1: Write failing pure conversion tests**

Use a hand-built two-channel, two-frame fake `AudioBuffer`. Assert the literal RIFF/WAVE bytes, format code 3, channel count 1, sample rate, data length, and averaged float samples. Add one test proving `stop()` stops every media track and returns WAV bytes.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --import=./test/support/render.mjs --experimental-strip-types --test test/speechCapture.test.ts`

Expected: FAIL because `src/speechCapture.ts` does not exist.

- [ ] **Step 3: Implement recording with platform APIs**

Use `navigator.mediaDevices.getUserMedia({ audio: true })`, `MediaRecorder`, and `AudioContext.decodeAudioData`. Let Chromium choose the recording MIME type. Convert the decoded buffer to mono float32 WAV at its native sample rate. Stop all stream tracks and close the audio context on success and failure.

The recorder must reject duplicate `start()` and `stop()` calls and expose `cancel()` for unmount/thread-switch cleanup. Do not add a library.

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `node --import=./test/support/render.mjs --experimental-strip-types --test test/speechCapture.test.ts`

Expected: PASS with no leaked handles.

- [ ] **Step 5: Commit**

```bash
git add src/speechCapture.ts test/speechCapture.test.ts
git commit -m "feat: record composer speech as WAV"
```

### Task 4: Composer microphone flow

**Files:**
- Modify: `src/useCoder.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/ThreadView.tsx`
- Modify: `src/components/Composer.tsx`
- Modify: `src/components/Composer.module.css`
- Modify: `test/composer.test.tsx`

**Interfaces:**
- Consumes: typed IPC from Task 2
- Consumes: `createSpeechRecorder` from Task 3
- Produces: optional Composer callbacks for status, prepare, and transcribe

- [ ] **Step 1: Write failing Composer behavior tests**

Add tests through the real Composer:

```tsx
it("prepares the model explicitly before exposing record", async () => {
  const h = makeHarness({ speechStatus: { runtimeAvailable: true, modelReady: false, modelBytes: 714_000_000 } });
  const m = await mount(composer(h));
  await m.click(m.query('button[aria-label="Download speech model"]'));
  assert.equal(h.speechPrepareCalls, 1);
  assert.equal(m.query('button[aria-label="Record speech"]') !== null, true);
});

it("inserts a transcript at the selection without sending", async () => {
  const h = makeHarness({ transcript: "review this" });
  const m = await mount(composer(h));
  await m.type(m.query("textarea"), "please now");
  m.query("textarea").setSelectionRange(7, 7);
  await m.click(m.query('button[aria-label="Record speech"]'));
  await m.click(m.query('button[aria-label="Stop recording"]'));
  assert.equal(m.query("textarea").value, "please review this now");
  assert.deepEqual(h.sends, []);
});
```

Also cover missing runtime, permission failure, disabled/Ask mode hiding the button, thread switch cancellation, empty transcript, and the two-minute automatic stop using a fake timer.

- [ ] **Step 2: Run the focused Composer tests and verify RED**

Run: `node --import=./test/support/render.mjs --experimental-strip-types --test test/composer.test.tsx`

Expected: new speech tests FAIL because no microphone control exists.

- [ ] **Step 3: Wire the minimal UI**

Follow the existing attachment callback path from `useCoder` through `App` and `ThreadView`; do not import the Electron bridge directly in Composer. Add one compact icon button beside Attach:

- unavailable: hidden in web mode; desktop tooltip points to NVIDIA install docs
- model missing: `Download speech model`, explicit click, about 715 MB in title/help
- downloading: disabled with `Preparing speech model`
- ready: `Record speech`
- recording: accent treatment and `Stop recording`
- transcribing: disabled with `Transcribing speech`

Use Composer's existing uncontrolled `writeDraft` path to insert text at `selectionStart`/`selectionEnd` and restore the caret. Surface failures through `localError`. Cancel recording on unmount or thread change.

- [ ] **Step 4: Run renderer verification**

Run: `node --import=./test/support/render.mjs --experimental-strip-types --test test/composer.test.tsx test/speechCapture.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/useCoder.ts src/App.tsx src/components/ThreadView.tsx src/components/Composer.tsx src/components/Composer.module.css test/composer.test.tsx
git commit -m "feat: add speech input to the composer"
```

### Task 5: Documentation and integrated verification

**Files:**
- Modify: `README.md`
- Modify: `THIRD_PARTY_NOTICES.md` if present, otherwise create `docs/third-party-speech.md`

**Interfaces:**
- Consumes: complete Tasks 1 through 4
- Produces: install and licensing instructions for the shipped feature

- [ ] **Step 1: Document setup and licenses**

Document `nemo-speech` 0.1.0+, NVIDIA's official installation link, the explicit model download, local-only audio handling, supported desktop platforms, and Parakeet's CC BY 4.0 model license. Do not claim browser support or bundled runtime support.

- [ ] **Step 2: Run the focused and full verification surface**

```bash
npm run typecheck
node --test electron/test/speech.test.js electron/test/speech-ipc.test.js
node --import=./test/support/render.mjs --experimental-strip-types --test test/speechCapture.test.ts test/composer.test.tsx
npm run test:renderer
npm run test:electron
```

Expected: every command exits 0.

- [ ] **Step 3: Manual smoke test**

With `nemo-speech` installed, start Solenta, explicitly download the model, record a short sentence, and confirm the text appears in the current draft without sending. Deny microphone permission once and confirm the draft survives unchanged.

- [ ] **Step 4: Commit**

```bash
git add README.md THIRD_PARTY_NOTICES.md docs/third-party-speech.md
git commit -m "docs: explain local speech setup"
```

Only add paths that exist after the documentation choice.
