#!/usr/bin/env bash
# Linux x64 CPU smoke inside docker --platform linux/amd64 (QEMU on Apple Silicon).
# RTF from this path is INVALID. Success = binary starts, GET /ready, one websocket turn.
# 2026-09-03 on Apple M5 Pro: nemo-speech --version prints 0.1.0, then doctor
# and serve die with SIGILL even with QEMU_CPU=max. Treat as emulator failure.
# Re-run on native ubuntu-latest.
set -euo pipefail
CACHE="${CACHE:-$HOME/Library/Caches/solenta-speech-spike}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${IMAGE:-debian:bookworm-slim}"
PORT="${PORT:-18081}"
TOKEN="${TOKEN:-linux-smoke-token}"
MODEL="$CACHE/nemotron-speech-streaming-en-0.6b.q8_0.gguf"
WAV="$CACHE/audio/phrase-16k.wav"
LINUX_BIN_DIR="$CACHE/linux-cpu/nemo-speech-0.1.0-linux-x86_64-cpu"

if [[ ! -x "$LINUX_BIN_DIR/bin/nemo-speech" ]]; then
  echo "missing linux binary at $LINUX_BIN_DIR" >&2
  exit 1
fi
if [[ ! -f "$MODEL" || ! -f "$WAV" ]]; then
  echo "missing model or wav" >&2
  exit 1
fi

docker run --rm --platform linux/amd64 \
  -v "$LINUX_BIN_DIR:/opt/nemo-speech:ro" \
  -v "$MODEL:/models/asr.q8_0.gguf:ro" \
  -v "$WAV:/audio/phrase.wav:ro" \
  -v "$ROOT/spike/speech:/spike:ro" \
  -p "127.0.0.1:${PORT}:8080" \
  -e TOKEN="$TOKEN" \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    export LD_LIBRARY_PATH=/opt/nemo-speech/lib
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl python3 >/dev/null
    /opt/nemo-speech/bin/nemo-speech doctor || true
    /opt/nemo-speech/bin/nemo-speech serve \
      --host 0.0.0.0 --port 8080 --api-key "$TOKEN" --no-ui \
      --asr-model /models/asr.q8_0.gguf \
      --device cpu \
      --read-timeout 120 --write-timeout 120 \
      >/tmp/serve.log 2>&1 &
    pid=$!
    for i in $(seq 1 120); do
      if curl -fsS http://127.0.0.1:8080/ready >/tmp/ready.json; then
        cat /tmp/ready.json
        echo
        break
      fi
      if ! kill -0 "$pid" 2>/dev/null; then
        echo "serve died" >&2
        tail -50 /tmp/serve.log >&2
        exit 1
      fi
      sleep 2
    done
    test -s /tmp/ready.json
    # one websocket turn via python stdlib
    python3 - <<PY
import json, socket, base64, struct, time, urllib.request, os, sys, hashlib, wave

# Minimal RFC6455 client
def ws_connect(host, port, path, extra_headers=None):
    key = base64.b64encode(os.urandom(16)).decode()
    s = socket.create_connection((host, port), timeout=30)
    hdrs = [
        f"GET {path} HTTP/1.1",
        f"Host: {host}:{port}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
    ]
    if extra_headers:
        hdrs.extend(extra_headers)
    s.sendall(("\r\n".join(hdrs) + "\r\n\r\n").encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = s.recv(4096)
        if not chunk:
            raise RuntimeError("no handshake")
        resp += chunk
    if b"101" not in resp.split(b"\r\n", 1)[0]:
        raise RuntimeError(resp[:400].decode("latin1", "replace"))
    return s

def mask_send(s, payload, opcode=1):
    if isinstance(payload, str):
        payload = payload.encode()
    n = len(payload)
    hdr = bytearray([0x80 | opcode])
    mask_bit = 0x80
    if n < 126:
        hdr.append(mask_bit | n)
    elif n < 65536:
        hdr.append(mask_bit | 126)
        hdr += struct.pack("!H", n)
    else:
        hdr.append(mask_bit | 127)
        hdr += struct.pack("!Q", n)
    mask = os.urandom(4)
    hdr += mask
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    s.sendall(bytes(hdr) + masked)

def recv_msg(s, timeout=30):
    s.settimeout(timeout)
    def readn(n):
        buf = b""
        while len(buf) < n:
            c = s.recv(n - len(buf))
            if not c:
                raise RuntimeError("eof")
            buf += c
        return buf
    b1, b2 = readn(2)
    opcode = b1[0] & 0x0F
    n = b2[0] & 0x7F
    if n == 126:
        n = struct.unpack("!H", readn(2))[0]
    elif n == 127:
        n = struct.unpack("!Q", readn(8))[0]
    if b2[0] & 0x80:
        mask = readn(4)
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(readn(n)))
    else:
        data = readn(n)
    if opcode == 1:
        return "text", data.decode()
    if opcode == 2:
        return "bin", data
    if opcode == 8:
        return "close", data
    return opcode, data

token = os.environ["TOKEN"]
with wave.open("/audio/phrase.wav") as w:
    pcm = w.readframes(w.getnframes())
s = ws_connect("127.0.0.1", 8080, f"/v1/realtime?api_key={token}")
kind, payload = recv_msg(s, 30)
print("first", kind, payload[:300])
assert kind == "text"
msg = json.loads(payload)
assert msg.get("type") == "session.created", msg
mask_send(s, json.dumps({"type":"session.update","session":{"sample_rate":16000,"automatic_punctuation":True}}))
time.sleep(0.3)
# 100ms chunks
chunk = 3200
for i in range(0, len(pcm), chunk):
    mask_send(s, pcm[i:i+chunk], opcode=2)
mask_send(s, json.dumps({"type":"input_audio_buffer.commit"}))
got_delta = got_final = False
texts = []
deadline = time.time() + 30
while time.time() < deadline:
    try:
        kind, payload = recv_msg(s, 10)
    except Exception as e:
        print("recv end", e)
        break
    if kind != "text":
        continue
    msg = json.loads(payload)
    print("event", msg.get("type"), json.dumps(msg)[:240])
    t = msg.get("type")
    if t == "conversation.item.input_audio_transcription.delta":
        got_delta = True
        texts.append(msg)
    if t == "conversation.item.input_audio_transcription.completed":
        got_final = True
        texts.append(msg)
        break
print(json.dumps({"got_delta": got_delta, "got_final": got_final}))
sys.exit(0 if (got_delta or got_final) else 1)
PY
    kill "$pid" 2>/dev/null || true
  '
