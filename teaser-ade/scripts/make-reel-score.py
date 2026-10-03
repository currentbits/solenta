#!/usr/bin/env python3
"""30s score for SolentaReel, built from GarageBand's "02 Electro House" Apple
Loops. Every loop here is tagged C minor, so they stack without clashing.

112 BPM (loops stretched from 128), bar = 2.143s, 14 bars = exactly 30s.
The video in src/Reel.tsx cuts on this same grid (see BAR/BEAT there):
  bars 0-2   intro      pad + the hook through a lowpass, riser into the drop
  bars 2-8   drop A     beat + bass + Big Anthem hook, candy layers from bar 6
  bars 8-10  build      drums out, snare roll + riser, half-beat of silence
  bars 10-12 drop B     everything, Rocket Fuel 04, lead layers
  bars 12-14 lockup     final hit, pad + filtered hook tail
Requires the GarageBand sound library under /Library/Audio/Apple Loops.
"""

from __future__ import annotations

import math
import struct
import subprocess
import wave
from array import array
from pathlib import Path

SR = 44100
DUR = 30.0  # 14 bars at 112 BPM
N = int(SR * DUR)
BAR = 60.0 / 112 * 4
BEAT = BAR / 4

LOOPS = Path("/Library/Audio/Apple Loops/Apple/02 Electro House")
ROOT = Path(__file__).resolve().parents[1]
WAV = ROOT / "public" / "reel-score.wav"
MP3 = ROOT / "public" / "reel-score.mp3"

L = array("d", bytes(8 * N))
R = array("d", bytes(8 * N))
_cache: dict[tuple[str, str], tuple[array, array]] = {}


def bar(n: float) -> float:
    return n * BAR


def load(name: str, af: str = "") -> tuple[array, array]:
    key = (name, af)
    if key not in _cache:
        cmd = ["ffmpeg", "-v", "error", "-i", str(LOOPS / f"{name}.caf")]
        # Loops are 128 BPM; stretch to 112 without changing pitch.
        cmd += ["-af", ",".join(x for x in ("atempo=0.875", af) if x)]
        cmd += ["-f", "s16le", "-acodec", "pcm_s16le", "-ac", "2", "-ar", str(SR), "-"]
        raw = subprocess.run(cmd, check=True, capture_output=True).stdout
        pcm = array("h", raw)
        _cache[key] = (
            array("d", (s / 32768.0 for s in pcm[0::2])),
            array("d", (s / 32768.0 for s in pcm[1::2])),
        )
    return _cache[key]


def place(name: str, t0: float, gain: float = 1.0, cut: float | None = None,
          af: str = "", fade_in: float = 0.005) -> None:
    lch, rch = load(name, af)
    n = len(lch) if cut is None else min(len(lch), int(cut * SR))
    start = int(round(t0 * SR))
    rin = max(1, int(fade_in * SR))
    rout = int(0.006 * SR)
    for i in range(n):
        j = start + i
        if j < 0:
            continue
        if j >= N:
            break
        g = gain
        if i < rin:
            g *= i / rin
        if i > n - rout:
            g *= (n - i) / rout
        L[j] += lch[i] * g
        R[j] += rch[i] * g


def boom(t0: float, amp: float = 0.8, dur: float = 1.1) -> None:
    """Sub drop: pitch falls 70 -> 32 Hz under the big downbeats."""
    start = int(t0 * SR)
    phase = 0.0
    for i in range(int(dur * SR)):
        t = i / SR
        f = 38 * math.exp(-t * 7) + 32
        phase += 2 * math.pi * f / SR
        v = amp * math.exp(-t * 3.2) * math.sin(phase)
        if i < 220:
            v *= i / 220
        j = start + i
        if 0 <= j < N:
            L[j] += v
            R[j] += v


def silence(t0: float, t1: float) -> None:
    """Hard gap before a drop (short ramps, no clicks)."""
    a, b = int(t0 * SR), int(t1 * SR)
    ramp = int(0.004 * SR)
    for j in range(max(0, a - ramp), min(N, b)):
        g = 0.0 if j >= a else (a - j) / ramp
        L[j] *= g
        R[j] *= g


def main() -> None:
    lp = "lowpass=f=520,lowpass=f=520"
    lp_open = "lowpass=f=1400"

    # Intro: pad bed and the hook muffled, as if heard through a wall.
    place("Deep Dream Synth", bar(0), 0.55, fade_in=1.2)
    place("Big Anthem Synth", bar(0), 0.7, cut=BAR * 2, af=lp, fade_in=0.8)
    place("Warp Speed Effect 02", bar(2) - BAR, 0.55)

    # Drop A + groove: hook, bass, beats escalating.
    for b in (2, 6):
        place("Big Anthem Synth", bar(b), 0.62, cut=None if b == 2 else BAR * 2)
        place("Gene Sequence Bass", bar(b), 0.62, cut=None if b == 2 else BAR * 2)
    for b, v in ((2, "01"), (4, "02"), (6, "03")):
        place(f"Rocket Fuel Beat {v}", bar(b), 0.9)
    place("Pure Candy Synth Layers", bar(6), 0.38, cut=BAR * 2)
    place("Warp Speed Effect 11", bar(5), 0.35)

    # Build: drums out, pad + muffled hook opening, snare roll, riser.
    place("Deep Dream Synth", bar(8), 0.6)
    place("Big Anthem Synth", bar(8), 0.55, cut=BAR * 2, af=lp_open)
    place("Big Snare Roll Topper", bar(8), 0.75)
    place("Warp Speed Effect 02", bar(10) - BAR, 0.6)
    silence(bar(10) - BEAT / 2, bar(10))

    # Drop B: everything, two bars.
    place("Big Anthem Synth", bar(10), 0.75, cut=BAR * 2)
    place("Epic Anthem Synth", bar(10), 0.36, cut=BAR * 2)
    place("Lightspeed Lead Layers", bar(10), 0.3, cut=BAR * 2)
    place("Gene Sequence Bass", bar(10), 0.65, cut=BAR * 2)
    place("Rocket Fuel Beat 04", bar(10), 1.1)

    # Lockup: one hit, then the hook drifts off through the lowpass.
    place("Deep Dream Synth", bar(12), 0.6)
    place("Big Anthem Synth", bar(12), 0.5, cut=BAR * 2, af=lp)

    for t, a in ((bar(2), 0.85), (bar(6), 0.45), (bar(10), 0.95), (bar(12), 0.9)):
        boom(t, a)

    peak = max(max(map(abs, L)), max(map(abs, R))) or 1.0
    gain = 0.93 / peak
    fade_n = int(1.6 * SR)
    frames = bytearray()
    pack = struct.Struct("<hh").pack
    for i in range(N):
        g = gain
        if i > N - fade_n:
            g *= ((N - i) / fade_n) ** 1.5
        lv = max(-1.0, min(1.0, L[i] * g))
        rv = max(-1.0, min(1.0, R[i] * g))
        frames += pack(int(lv * 32767), int(rv * 32767))

    with wave.open(str(WAV), "w") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(frames))
    subprocess.check_call(
        ["ffmpeg", "-y", "-v", "error", "-i", str(WAV),
         "-af", "acompressor=threshold=0.25:ratio=3:attack=5:release=120,loudnorm=I=-13:TP=-1:LRA=9", "-ar", "44100",
         "-codec:a", "libmp3lame", "-b:a", "256k", str(MP3)])
    WAV.unlink(missing_ok=True)
    print("wrote", MP3, MP3.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
