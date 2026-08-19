#!/usr/bin/env python3
"""Hit-locked 25s industrial trailer bed for the Solenta ADE teaser.

Scene cuts (seconds): 0, 2, 6, 10, 14.5, 18.5, 23.
140 BPM from the slam at 2s. No vocals.
"""

from __future__ import annotations

import math
import random
import struct
import subprocess
import wave
from pathlib import Path

SR = 44100
DUR = 25.0
N = int(SR * DUR)
BPM = 140
BEAT = 60.0 / BPM
HITS = (0.0, 2.0, 6.0, 10.0, 14.5, 18.5, 23.0)

ROOT = Path(__file__).resolve().parents[1]
WAV = ROOT / "public" / "score.wav"
MP3 = ROOT / "public" / "score.mp3"


def clamp(x: float) -> float:
    return -1.0 if x < -1.0 else 1.0 if x > 1.0 else x


samples = [0.0] * N


def add(i: int, v: float) -> None:
    if 0 <= i < N:
        samples[i] += v


def kick(t0: float, amp: float = 0.92) -> None:
    start = int(t0 * SR)
    length = int(0.22 * SR)
    for i in range(length):
        t = i / SR
        env = math.exp(-t * 26)
        freq = 62 * math.exp(-t * 16) + 36
        add(start + i, amp * env * math.sin(2 * math.pi * freq * t))
        add(start + i, amp * 0.28 * env * math.sin(2 * math.pi * freq * 2 * t))
        if i < int(0.006 * SR):
            add(start + i, amp * 0.55 * (1 - i / (0.006 * SR)) * (random.random() * 2 - 1))


def snare(t0: float, amp: float = 0.32) -> None:
    start = int(t0 * SR)
    rng = random.Random(int(t0 * 10000) + 3)
    length = int(0.14 * SR)
    for i in range(length):
        t = i / SR
        env = math.exp(-t * 38)
        tone = math.sin(2 * math.pi * 180 * t)
        add(start + i, amp * env * (0.78 * (rng.random() * 2 - 1) + 0.22 * tone))


def hat(t0: float, amp: float = 0.12) -> None:
    start = int(t0 * SR)
    rng = random.Random(int(t0 * 8000) + 9)
    length = int(0.045 * SR)
    for i in range(length):
        t = i / SR
        env = math.exp(-t * 90)
        add(start + i, amp * env * (rng.random() * 2 - 1))


def braam(t0: float, amp: float = 0.7) -> None:
    start = int(t0 * SR)
    length = int(1.05 * SR)
    for i in range(length):
        t = i / SR
        attack = min(1.0, t / 0.012)
        env = attack * math.exp(-t * 2.8)
        f = 48 * (1 - 0.1 * t)
        v = 0.0
        for h, a in ((1, 1.0), (2, 0.48), (3, 0.24), (4.04, 0.14), (5.02, 0.08), (6.97, 0.05)):
            v += a * math.sin(2 * math.pi * f * h * t + 0.15 * math.sin(2 * math.pi * 1.7 * t))
        add(start + i, amp * env * v * 0.28)


def riser(t0: float, dur: float = 1.7, amp: float = 0.22) -> None:
    start = int(t0 * SR)
    length = int(dur * SR)
    rng = random.Random(int(t0 * 50) + 21)
    for i in range(length):
        t = i / SR
        p = t / dur
        env = p * p
        noise = rng.random() * 2 - 1
        tone = math.sin(2 * math.pi * (180 + 2100 * p * p) * t)
        add(start + i, amp * env * (0.72 * noise + 0.28 * tone))


def drone() -> None:
    for i in range(N):
        t = i / SR
        # Pressure bed that opens after the slam and eases on the lockup.
        if t < 2:
            env = 0.12 * (t / 2)
        elif t < 18.5:
            env = 0.22 + 0.08 * math.sin(2 * math.pi * t / 8)
        else:
            env = 0.22 * max(0.0, 1 - (t - 18.5) / 6.2)
        v = math.sin(2 * math.pi * 36.7 * t)
        v += 0.45 * math.sin(2 * math.pi * 73.4 * t + 0.2)
        v += 0.18 * math.sin(2 * math.pi * 110.0 * t)
        samples[i] += env * v * 0.55


def drive() -> None:
    t = 2.0
    n = 0
    while t < 18.55:
        kick(t, 0.78 if n % 4 == 0 else 0.62)
        if n % 2 == 1:
            snare(t, 0.28)
        hat(t, 0.10)
        hat(t + BEAT * 0.5, 0.07)
        if n % 8 == 7:
            for k in range(4):
                hat(t + BEAT * 0.25 * k, 0.11)
        n += 1
        t += BEAT


def main() -> None:
    random.seed(7)
    drone()
    drive()
    for t in HITS:
        braam(t, 0.85 if t in (0.0, 2.0, 18.5, 23.0) else 0.62)
        kick(t, 1.0)
    riser(0.2, 1.8, 0.28)
    riser(4.4, 1.6, 0.24)
    riser(8.5, 1.5, 0.26)
    riser(13.0, 1.5, 0.22)
    riser(16.8, 1.7, 0.3)

    peak = max(abs(x) for x in samples) or 1.0
    gain = 0.92 / peak
    fade_n = int(0.45 * SR)
    frames = bytearray()
    for i, x in enumerate(samples):
        if i > N - fade_n:
            x *= (N - i) / fade_n
        if i < int(0.02 * SR):
            x *= i / (0.02 * SR)
        frames += struct.pack("<h", int(clamp(x * gain) * 32767))

    WAV.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(WAV), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(frames)

    subprocess.check_call(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(WAV),
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "192k",
            str(MP3),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    WAV.unlink(missing_ok=True)
    print("wrote", MP3, "bytes", MP3.stat().st_size)


if __name__ == "__main__":
    main()
