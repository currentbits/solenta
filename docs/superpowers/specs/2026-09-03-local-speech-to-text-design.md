# Local Speech-to-Text Design

## Goal

Add private, local speech-to-text to Solenta's composer. A user can click a microphone button, speak, stop recording, and review the transcription in the existing draft before sending it.

## Product contract

- Desktop only. Browser mode does not show the microphone control.
- The first release requires `nemo-speech` 0.1.0 or newer on `PATH` and uses `nvidia/parakeet-tdt-0.6b-v3`.
- The model is downloaded only after an explicit user action. The UI states that the download is about 715 MB.
- Audio and transcripts stay on the machine. Solenta does not send audio to a network service.
- One click starts recording. A second click stops it and starts transcription.
- The transcript is inserted at the current composer selection. It is never sent automatically.
- Existing draft text is preserved. When text surrounds the insertion point, the transcript is separated with a single space where needed.
- Recording, model preparation, and transcription have distinct accessible states. Errors keep the current draft intact and can be dismissed through the existing composer error surface.
- Only one recording or transcription may run at a time.

## Architecture

The renderer records with Chromium's `MediaRecorder`, decodes the completed blob with `AudioContext`, and converts it to a mono float32 WAV. This uses the platform APIs already shipped inside Electron and adds no JavaScript dependency.

The WAV crosses the existing typed IPC bridge as an `ArrayBuffer`. A small main-process service validates its size and WAV header, writes a temporary file under Solenta's user-data directory, invokes the official `nemo-speech` CLI, and deletes the temporary file in `finally`. Model files live below `userData/speech/models` through `NEMO_SPEECH_MODEL_DIR`.

Model preparation runs `nemo-speech pull nvidia/parakeet-tdt-0.6b-v3`. A Solenta-owned sentinel is written only after that command exits successfully. Transcription runs the CLI against the temporary WAV with the same model ID and controlled model directory. The service accepts injected process and filesystem seams so tests do not download a model or execute the real binary.

## Error handling and limits

- Reject payloads that are not WAV, are empty, or exceed 32 MiB before writing them.
- Cap recordings at two minutes in the renderer and stop automatically at the limit.
- Missing runtime: explain that `nemo-speech` is required and link to NVIDIA's install documentation.
- Missing model: ask the user to download it before recording.
- Denied microphone permission: report the browser's permission error without changing the draft.
- Empty transcription: leave the draft unchanged and show a short retry message.
- Every temporary recording is removed after success, CLI failure, timeout, or cancellation.

## Testing

- Main-process unit tests cover availability, explicit model preparation, argument/environment construction, validation, timeout, output parsing, and temporary-file cleanup.
- Pure renderer tests cover WAV output and transcript insertion at start, middle, end, and around whitespace.
- Composer tests cover the prepare, record, transcribe, disabled, and error states through injected browser and IPC seams.
- Typecheck's existing IPC lock proves the desktop preload and TypeScript API remain aligned.

## Deliberate first-release limits

- No global hotkey, voice activity detection, partial transcript, microphone picker, or automatic send.
- No bundled native runtime. Users install NVIDIA's CLI once; Solenta manages only the model cache and transcription flow.
- No persistent inference server. Each utterance invokes the CLI. Add a kept-warm local server only if measured startup latency is materially disruptive.

## Upstream basis

- NVIDIA NeMo-Speech.cpp 0.1.0 supports Parakeet TDT, CPU, CUDA, Vulkan, and Metal across Linux, Windows, and Apple Silicon macOS: https://github.com/NVIDIA/NeMo-Speech.cpp
- Parakeet TDT 0.6B v3 supports 25 European languages and is CC BY 4.0: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- NeMo-Speech accepts PCM16 and float32 WAV from 8 to 96 kHz. Parakeet TDT is offline-only, so Solenta records a complete utterance before transcription: https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/cli.md
