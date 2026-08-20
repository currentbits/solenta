#!/usr/bin/env python3
"""40s bed for the second Solenta teaser, built from Apple Loops (GarageBand's
"02 Electro House" pack: 128 BPM, C minor). Sleek minimal tech pulse — no
trailer braams, no dubstep — matching the clean product-film look of the video.

Bar grid: bar 0 at 2.0s, bar = 60/128*4 = 1.875s. Video cuts sit on even bars
(every 3.75s). Arrangement:
  pre-roll   0-2      dream pad tail + warp riser into the downbeat
  bars 0-4   2-9.5    Blueprint Beat 01 + sparse silk bass + pad bed
  bars 4-8   9.5-17   Blueprint 02 + Progressive Techno pulse
  bars 8-12  17-24.5  Blueprint 03 + Gene Sequence driving bass
  bars 12-14 24.5-28.25 Blueprint 04 + Night Vision layers (drive peak)
  bars 14-16 28.25-32 BREAKDOWN: Deep Dream pad alone (memory beat)
  bars 16-18 32-35.75 everything together (finale)
  bar 18     35.75    final downbeat, pad tail to 40

Requires the GarageBand sound library (loops under /Library/Audio/Apple Loops).
For an ElevenLabs-generated score instead, see scripts/eleven-score2.sh
(needs a paid-plan key with Music API access).
"""

from __future__ import annotations

import math
import struct
import subprocess
import wave
from pathlib import Path

SR = 44100
DUR = 40.0
N = int(SR * DUR)
BAR = 60.0 / 128 * 4


def bar(n: float) -> float:
    return 2.0 + n * BAR


LOOPS = Path("/Library/Audio/Apple Loops/Apple/02 Electro House")
ROOT = Path(__file__).resolve().parents[1]
WAV = ROOT / "public" / "score2.wav"
MP3 = ROOT / "public" / "score2.mp3"

L = [0.0] * N
R = [0.0] * N

_cache: dict[str, tuple[list[float], list[float]]] = {}


def load(name: str) -> tuple[list[float], list[float]]:
    if name in _cache:
        return _cache[name]
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(LOOPS / f"{name}.caf"),
         "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "2", "-ar", str(SR), "-"],
        check=True, capture_output=True,
    ).stdout
    n = len(out) // 4
    lch = [0.0] * n
    rch = [0.0] * n
    for i in range(n):
        lch[i] = struct.unpack_from("<h", out, i * 4)[0] / 32768.0
        rch[i] = struct.unpack_from("<h", out, i * 4 + 2)[0] / 32768.0
    _cache[name] = (lch, rch)
    return _cache[name]


def place(name: str, t0: float, gain: float = 1.0, cut: float | None = None) -> None:
    """Mix a loop at t0 (may be negative), optionally truncated to `cut` secs.
    5ms edge ramps to avoid clicks at truncation points."""
    lch, rch = load(name)
    n = len(lch)
    if cut is not None:
        n = min(n, int(cut * SR))
    ramp = int(0.005 * SR)
    for i in range(n):
        j = int(t0 * SR) + i
        if not (0 <= j < N):
            continue
        g = gain
        if i < ramp:
            g *= i / ramp
        if i > n - ramp:
            g *= (n - i) / ramp
        L[j] += lch[i] * g
        R[j] += rch[i] * g


def boom(t0: float, amp: float = 0.7) -> None:
    """Minimal sub impact for the big transitions."""
    start = int(t0 * SR)
    for i in range(int(0.7 * SR)):
        t = i / SR
        env = math.exp(-t * 6)
        f = 64 * math.exp(-t * 9) + 30
        v = amp * env * math.sin(2 * math.pi * f * t)
        if i < int(0.005 * SR):
            v *= i / (0.005 * SR)
        if 0 <= start + i < N:
            L[start + i] += v
            R[start + i] += v


def main() -> None:
    global L, R
    # Deep Dream pad in its own stem so its level can be automated: quiet bed
    # under the drive, alone in the breakdown, tail on the lockup.
    saveL, saveR = L, R
    L = [0.0] * N
    R = [0.0] * N
    place("Deep Dream Synth", bar(-4))  # tail lands under the logo, ends at 2.0
    for b in (0, 4, 8, 12, 16):
        place("Deep Dream Synth", bar(b))
    padL, padR = L, R
    L, R = saveL, saveR

    def pad_level(t: float) -> float:
        if t < 2.0:
            return 0.5 * (t / 2.0)
        if t < bar(14):
            return 0.22
        if t < bar(16):
            return 0.85  # breakdown carries the memory beat
        if t < bar(18):
            return 0.25
        return 0.7 * max(0.0, 1.0 - (t - bar(18)) / 3.9)

    for i in range(N):
        g = pad_level(i / SR)
        L[i] += padL[i] * g
        R[i] += padR[i] * g

    # Drums: the Blueprint family escalates 01 -> 04.
    for b, v in ((0, "01"), (2, "01"), (4, "02"), (6, "02"),
                 (8, "03"), (10, "03"), (12, "04"),
                 (16, "04")):
        place(f"Blueprint Beat {v}", bar(b), 0.9)
    # Bass: sparse and roomy first, sequenced drive later.
    for b in (0, 4):
        place("Melodic Silk Bass", bar(b), 0.75)
    # Cut to 2 bars where a 4-bar loop would cross the breakdown (bar 14) or
    # run past the finale downbeat (bar 18).
    for b in (8, 12, 16):
        place("Gene Sequence Bass", bar(b), 0.7, cut=None if b == 8 else BAR * 2)
    for b in (4, 8, 16):
        place("Progressive Techno Synth", bar(b), 0.55, cut=BAR * 2 if b == 16 else None)
    for b in (12, 16):
        place("Night Vision Synth Layers", bar(b), 0.6, cut=BAR * 2)

    # Risers into the transitions.
    place("Warp Speed Effect 02", 2.0 - 1.875, 0.55)       # into the downbeat
    place("Warp Speed Effect 02", bar(3), 0.45)            # into bar 4
    place("Warp Speed Effect 11", bar(6), 0.5)             # into bar 8
    place("Warp Speed Effect 02", bar(11), 0.45)           # into bar 12
    place("Warp Speed Effect 11", bar(14), 0.55)           # through the breakdown
    place("Warp Speed Effect 02", bar(17), 0.5)            # into the finale

    for t, a in ((2.0, 0.8), (bar(12), 0.5), (bar(16), 0.7), (bar(18), 0.9)):
        boom(t, a)

    peak = max(max(abs(x) for x in L), max(abs(x) for x in R)) or 1.0
    gain = 0.94 / peak
    fade_n = int(0.5 * SR)
    frames = bytearray()
    for i in range(N):
        g = gain
        if i > N - fade_n:
            g *= (N - i) / fade_n
        lv = max(-1.0, min(1.0, L[i] * g))
        rv = max(-1.0, min(1.0, R[i] * g))
        frames += struct.pack("<hh", int(lv * 32767), int(rv * 32767))

    with wave.open(str(WAV), "w") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(frames)

    subprocess.check_call(
        ["ffmpeg", "-y", "-i", str(WAV), "-codec:a", "libmp3lame", "-b:a", "192k", str(MP3)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    WAV.unlink(missing_ok=True)
    print("wrote", MP3, "bytes", MP3.stat().st_size)


if __name__ == "__main__":
    main()
