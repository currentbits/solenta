# Live speech-to-text feasibility (NeMo-Speech.cpp v0.1.0)

**Tracking:** currentbits/solenta#845
**Spike date:** 2026-09-03
**Worker branch:** `coder/fork-execute-this-live-speech-to-text-de-3b4108`
**Verdict:** **PASS**

macOS arm64 / Metal passed locally. Linux x64 CPU and Windows x64 CPU passed on native GitHub Actions (`ubuntu-latest` / `windows-latest`) in [run 33743047536](https://github.com/currentbits/solenta/actions/runs/33743047536). Product PRs may start for all three release targets. Do not ship the throwaway `speech-spike.yml` as a permanent product gate.

Throwaway helpers: `spike/speech/` (not product code). Bulky downloads stayed in `$HOME/Library/Caches/solenta-speech-spike/` and are not committed.

## Environment

| | |
|---|---|
| OS | macOS 26.6.2 (Build 25G83), Darwin 25.6.0 |
| Arch | arm64 (`RELEASE_ARM64_T6050`) |
| CPU | Apple M5 Pro, 15 logical CPUs |
| Memory | 24 GiB (`hw.memsize` 25769803776) |
| GPU (doctor) | Apple M5 Pro, 17.8 GiB Metal |
| Disk free | 368 GiB |
| Docker | 29.6.1 at `/opt/homebrew/bin/docker`, engine `linux/aarch64` |
| Node | v22.23.2 (built-in `WebSocket`) |
| Host tools | `say`, `afconvert`, `sandbox-exec`, `gh` |

`nemo-speech doctor` on the pinned macOS Metal archive:

```
NeMo-Speech.cpp 0.1.0
Features: asr backend_metal diarization http integrated_vad model_pull punctuation realtime_websocket speech_translation translation tts
Devices:
  [0] gpu            Apple M5 Pro (17.8 GiB)
  [1] accelerator    Accelerate
  [2] cpu            Apple M5 Pro (24.0 GiB)
```

## Pins actually measured

GitHub release `v0.1.0` asset digests (API `digest` field) matched the published `.sha256` files and the bytes on disk.

| Artifact | Bytes | sha256 (GitHub digest, `.sha256` file, and `shasum -a 256`) |
|---|---|---|
| `nemo-speech-0.1.0-macos-aarch64-metal.tar.gz` | 3,465,028 | `f1dff4f9dd9c96214f8cb78b982812459132df8a4ad1a42409fd94de4a366244` |
| `nemo-speech-0.1.0-linux-x86_64-cpu.tar.gz` | 4,583,913 | `0f74131d631ad2c694cf0ec53490866bb6461147959589a69fb6fc231944065b` |
| `nemo-speech-0.1.0-windows-x86_64-cpu.zip` | 4,730,421 | `5e4ea81046012edcd77fd8848de8eefb5a4ba38cc26f52eb544ab184695a75d6` |

Model (Hugging Face `nvidia/nemotron-speech-streaming-en-0.6b`, file `nemotron-speech-streaming-en-0.6b.q8_0.gguf`):

| | |
|---|---|
| Path | `$HOME/Library/Caches/solenta-speech-spike/nemotron-speech-streaming-en-0.6b.q8_0.gguf` |
| Bytes | 699,872,960 (matches HF API `gguf.totalFileSize`) |
| sha256 (measured) | `d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d` |
| License metadata | HF `license_name=nvidia-open-model-license` |

macOS binary path after extract:

`~/Library/Caches/solenta-speech-spike/macos-metal/nemo-speech/bin/nemo-speech`

`file`: Mach-O 64-bit executable arm64. Adjacent dylibs include `libggml-metal.0.12.0.dylib`.

Linux binary: ELF 64-bit LSB pie executable, x86-64, BuildID `187e240b64e1878ecf622116d407045a432816a1`.

Windows binary: PE32+ console x86-64 `nemo-speech.exe` (1.2M) plus these DLLs in the same `bin/` directory:

`concrt140.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml.dll`, `llama.dll`, `msvcp140.dll`, `msvcp140_1.dll`, `msvcp140_2.dll`, `msvcp140_atomic_wait.dll`, `msvcp140_codecvt_ids.dll`, `nemo_speech_asr.dll`, `nemo_speech_asr_c.dll`, `nemo_speech_nmt.dll`, `nemo_speech_nmt_c.dll`, `nemo_speech_tts.dll`, `vcomp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`.

`strings` on the exe shows `0.1.0`, `doctor`, `serve`, `--api-key`, `--no-ui`, `realtime_websocket`. Live Windows gates were not executed.

## Serve command line used (macOS Metal)

```
nemo-speech serve \
  --host 127.0.0.1 --port 18080 --api-key <32-char random> --no-ui \
  --asr-model <gguf path> --device metal \
  --read-timeout 600 --write-timeout 600
```

Ready after 7 s. Unauthenticated `GET /ready`:

```json
{"capabilities":["asr"],"device":"metal","ready":true}
```

`GET /health` -> `{"status":"ok","version":"0.1.0"}`. Sidecar log: `backend=MTL0`, streaming RNNT, `left=70 center=1 right=1`, encoder step 160 ms.

Probes:

- `GET /` with `--no-ui` -> 404 `the browser playground is disabled`
- `GET /v1/models` without bearer -> 401 `missing or invalid bearer token`
- `GET /v1/models` with `Authorization: Bearer` -> metal device, local GGUF id

Audio: macOS `say` + `afconvert` to 16 kHz mono little-endian PCM16 WAV. Phrase ~6.11 s; longer clip ~12.0 s, looped for the 300 s run. Streamed as 3200-byte (100 ms) binary frames.

## Gates x platforms

Numbers from `spike/speech/results/*.summary.json`. Live websocket is the gate; CLI transcribe is extra.

| Gate | macOS arm64 Metal | Linux x64 CPU | Windows x64 CPU |
|---|---|---|---|
| 1. Live partial AND final text | **PASS** (54 deltas + completed on 6.11 s phrase; 292 deltas on 30 s live) | **PASS** (54 deltas + completed; [ubuntu job](https://github.com/currentbits/solenta/actions/runs/33743047536/job/100609156196)) | **PASS** (54 deltas + completed; [windows job](https://github.com/currentbits/solenta/actions/runs/33743047536/job/100609155945)) |
| 2. First partial ≤ 1.5 s | **PASS** 824 ms (6 s live), 823 ms (30 s live), 66 ms (300 s dump) | **PASS** 909 ms live / 508 ms max-pace | **PASS** 918 ms live / 436 ms max-pace |
| 3. Final ≤ 1.5 s after commit | **PASS** 79 ms (6 s live), 65 ms (30 s live). Max-pace 300 s dump was 19.1 s because commit raced a 300 s backlog; that is not the product stop path | **PASS** 187 ms live-paced. Max-pace dump settle 162 s (backlog, not product stop) | **PASS** 223 ms live-paced. Max-pace dump settle 152 s (backlog, not product stop) |
| 4. RTF ≤ 1.0 for ≥ 300 s audio | **PASS** wall 19.133 s / 300 s audio = **RTF 0.064** (max-pace websocket). Live-paced 30 s wall/audio ≈ 1.01 by construction | **PASS** wall 162.452 s / 300 s = **RTF 0.542** | **PASS** wall 152.127 s / 300 s = **RTF 0.507** |
| 5. Sidecar RSS < 2.5 GiB | **PASS** peak **1010.8 MiB** (1,035,104 KB; 588 samples / 1 s) | **PASS** peak **935.4 MiB** | **PASS** peak **935.9 MiB** |
| 6. Warm-cache transcription, outbound blocked | **PASS** `sandbox-exec` deny-network profile: `urlopen(https://example.com)` failed; `nemo-speech transcribe --device metal --json` returned English text | not re-run on GHA (runners are networked; cache-hit transcription did run) | not re-run on GHA |
| 7. Licenses | **PASS** (see below). Runtime may be bundled. Model must stay user-downloaded | same legal text | same legal text |
| Binary starts / doctor / help | **PASS** `nemo-speech 0.1.0`, Metal device | **PASS** doctor CPU `AMD EPYC 9V45`, `/ready` device=cpu. Apple Silicon QEMU SIGILL is irrelevant | **PASS** doctor CPU `AMD EPYC 9V74`, exe run from extracted `bin/` so DLLs loaded |

### Sample transcripts (macOS)

Live websocket final (6.11 s phrase): `Quick brown fox jumps over the lazy dog Solenta transcribes English speech privately on this machine.`

Offline CLI (same WAV, sandbox): `The quick brown fox jumps over the lazy dog Selena transcribes English speech privately on this machine.`

Synthetic `say` audio is not a WER gate. Both runs produced English words from the prompt.

### Linux smoke detail

Tried `docker run --platform linux/amd64 node:22-bookworm` (pulled amd64; `uname -m` = `x86_64`). Mounted the pinned linux CPU tree and GGUF.

- `/opt/nemo-speech/bin/nemo-speech --version` -> `nemo-speech 0.1.0`
- `doctor` and `serve` -> `Illegal instruction (core dumped)`
- Serve log got as far as `[nemo-speech] serve session started` then died
- No `/ready`, no websocket turn

This is QEMU/instruction-set emulation, not a measured Linux x64 CPU fail. **Do not treat it as RTF or as a reason to switch backends.** Native `ubuntu-latest` must still prove live gates.

### Windows detail

Cannot run PE32+ here. Download+sha256 verified. DLLs sit beside `nemo-speech.exe` (MSVC runtime + ggml/llama + nemo_speech_*). Live gates remain **not-proven**.

## License conclusion

### Bundle the Apache-2.0 runtime in a MIT app? **Yes**, with the usual Apache notices.

v0.1.0 `LICENSE` is Apache-2.0. Section 2:

> each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.

Section 4 redistribution requires giving recipients a copy of the License, modification notices, retained attribution, and a readable copy of `NOTICE`. The archive ships `share/licenses/nemo-speech/{LICENSE,NOTICE,THIRD_PARTY_NOTICES.md}`. MIT and Apache-2.0 can coexist in one distribution if those files ship with the sidecar.

The same LICENSE file ends with:

> NOTICE AND DISCLAIMER: This software automatically retrieves, accesses or interacts with external materials. Those retrieved materials are not distributed with this software and are governed solely by separate terms, conditions and licenses.

`NOTICE`:

> This product includes software developed by third parties. See THIRD_PARTY_NOTICES.md for applicable notices, attributions, and license terms.

Retrieved GGUFs are **not** covered by the runtime Apache-2.0 grant.

### User-download the GGUF into `userData` after explicit confirmation? **Yes**. Do not ship it in app archives.

HF card: use is governed by the [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/) (last modified 2025-10-24). Section 2.2:

> NVIDIA hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, revocable (as stated in Section 2.1) license to publicly perform, publicly display, reproduce, use, create derivative works of, make, have made, sell, offer for sale, distribute (through multiple tiers of distribution) and import the Model.

Commercial use is in-scope ("Models are commercially usable"). Section 3.1 applies **if Solenta redistributes the Model**:

> If you distribute the Model, You must give any other recipients of the Model a copy of this Agreement and include the following attribution notice within a "Notice" text file with such copies: "Licensed by NVIDIA Corporation under the NVIDIA Open Model License"

The design does **not** redistribute the GGUF in Solenta archives. A confirmed download into `userData` is the user exercising reproduce/use. Solenta should still show the NVIDIA Open Model License URL at confirmation time. If a future change shipped the GGUF inside the app, that would be redistribution and would need the Notice file; this spike does **not** fail on that, because redistribution is not required.

## Protocol notes for the product manager

This is **not** the OpenAI Realtime API. v0.1.0 `docs/api.md` / `docs/server.md` (also shipped under `share/doc/nemo-speech/`):

1. Bind `127.0.0.1`. Default already is loopback.
2. `--no-ui` / `http.playground` off. `GET /` then 404s with playground-disabled.
3. `--api-key <random>`. `/health`, `/ready`, `/version` stay unauthenticated. `/v1/*` needs `Authorization: Bearer`. WebSocket may use `?api_key=`.
4. Connect `ws://127.0.0.1:<port>/v1/realtime?api_key=...`. Server sends `session.created` (`sample_rate` 16000, `input_audio_format` `pcm16`).
5. Optional `{"type":"session.update","session":{"sample_rate":16000,"automatic_punctuation":true}}` **before** any audio. Server replies `session.updated`. Audio after update is rejected if you invert the order.
6. Binary little-endian PCM16 frames. 100 ms at 16 kHz mono = 3200 bytes. Observed encoder step is 160 ms with `right=1`.
7. Finish with `{"type":"input_audio_buffer.commit"}`. Also `input_audio_buffer.clear` / `response.cancel`.
8. Partials: `conversation.item.input_audio_transcription.delta` with incremental **`delta`** (suffix tokens, often `""` heartbeats) and `audio_processed` seconds. **Not a full snapshot.** Concatenate non-empty `delta` strings.
9. Final: `conversation.item.input_audio_transcription.completed` with full **`transcript`**. Then `input_audio_buffer.committed`.
10. Raise `--read-timeout` / `--write-timeout` above the default 30 s for a held websocket. Cumulative realtime audio cap is `--max-upload-mb` (default 512 MiB); five minutes of PCM16 is ~9.6 MiB.
11. Prefer `NEMO_SPEECH_HTTP_API_KEY` over putting the token on the argv (it showed up in `ps`).
12. One session at a time matches the server: reconnect per recording is fine; do not overlap sockets.

## What would have to change in the design

1. **Partial text handling.** The design says each partial *replaces* the provisional range. v0.1.0 deltas are incremental suffixes (`"Quick"` then `" brown"` then `" fox"`). Replacing would drop earlier words. Concatenate `delta`, and on `completed` replace the whole provisional range with `transcript`.
2. **Sidecar timeouts.** Document `--read-timeout` / `--write-timeout` well above 30 s (spike used 600).
3. **CPU is enough on Linux and Windows.** Native `ubuntu-latest` / `windows-latest` hit RTF 0.54 / 0.51. Do not add CUDA/Vulkan for the first ship. Delete throwaway `speech-spike.yml` after product CI exists; do not keep a 700 MB GGUF download on every PR.
4. **QEMU is useless for this binary.** Apple Silicon `docker --platform linux/amd64` SIGILLs on `doctor`/`serve`. Do not use it as a Linux gate.
5. **No Python/NeMo or Parakeet fallback** remains correct: the native macOS pair works.
6. **Windows packaging** must copy the full `bin/` DLL set next to `nemo-speech.exe` (MSVC + ggml + nemo_speech_*), not the exe alone.
7. **Model digest.** Pin the measured GGUF sha256 `d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d` (699,872,960 bytes) in the download verifier. Hugging Face does not publish a sibling `.sha256` on the GitHub runtime release.

## Verdict

**PASS**

The pinned pair is live-capable on all three release targets.

- macOS arm64 Metal (this machine): first partial 824 ms, stop-to-final 79 ms, 300 s RTF 0.064, RSS 1.01 GiB, sandbox-offline transcribe.
- Linux x64 CPU (`ubuntu-latest`): first partial 909 ms, stop-to-final 187 ms, 300 s RTF 0.542, RSS 935.4 MiB. [job](https://github.com/currentbits/solenta/actions/runs/33743047536/job/100609156196)
- Windows x64 CPU (`windows-latest`): first partial 918 ms, stop-to-final 223 ms, 300 s RTF 0.507, RSS 935.9 MiB. [job](https://github.com/currentbits/solenta/actions/runs/33743047536/job/100609155945)

Licenses allow bundled Apache-2.0 runtime + user-downloaded GGUF. No Python/NeMo or Parakeet fallback. No product code. Draft PR: https://github.com/currentbits/solenta/pull/850

Helpers: `spike/speech/live-client.mjs`, `spike/speech/run-ci.mjs`, `spike/speech/run-macos.sh`, `spike/speech/linux-smoke.sh`, `spike/speech/no-network.sb`, fixture `spike/speech/fixtures/phrase-16k.wav`, compact numbers under `spike/speech/results/`.

## Native GitHub Actions (Linux x64 CPU / Windows x64 CPU)

Throwaway workflow: `.github/workflows/speech-spike.yml` (does not touch `test.yml`). Matrix is `ubuntu-latest` and `windows-latest` only. It caches the GGUF by sha256, verifies the pinned CPU archives, starts `serve` with `NEMO_SPEECH_HTTP_API_KEY` (not argv), then runs `spike/speech/run-ci.mjs` against `spike/speech/fixtures/phrase-16k.wav`.

Passing run: [33743047536](https://github.com/currentbits/solenta/actions/runs/33743047536) (workflow [speech-spike.yml](https://github.com/currentbits/solenta/actions/workflows/speech-spike.yml)). Artifacts: `spike/speech/results/ci-ubuntu-gates.json`, `ci-windows-gates.json`.

| | Linux x64 CPU (`ubuntu-latest`) | Windows x64 CPU (`windows-latest`) |
|---|---|---|
| Job | [cpu-live (ubuntu-latest)](https://github.com/currentbits/solenta/actions/runs/33743047536/job/100609156196) | [cpu-live (windows-latest)](https://github.com/currentbits/solenta/actions/runs/33743047536/job/100609155945) |
| doctor | **PASS** CPU `AMD EPYC 9V45` (15.6 GiB) | **PASS** CPU `AMD EPYC 9V74` (16.0 GiB) |
| GET /ready | **PASS** `device=cpu` | **PASS** `device=cpu` |
| first partial ≤ 1.5 s | **PASS** 909 ms | **PASS** 918 ms |
| stop-to-final ≤ 1.5 s | **PASS** 187 ms (live-paced) | **PASS** 223 ms (live-paced) |
| 300 s audio RTF ≤ 1.0 | **PASS** 0.542 (wall 162.5 s) | **PASS** 0.507 (wall 152.1 s) |
| peak RSS < 2.5 GiB | **PASS** 935.4 MiB | **PASS** 935.9 MiB |

First Actions attempt ([33742563265](https://github.com/currentbits/solenta/actions/runs/33742563265)) failed only because max-pace settle was 20 s; CPU needed ~150-160 s after an instant 300 s dump. Live latency already passed on that run. QEMU SIGILL on Apple Silicon is irrelevant.
