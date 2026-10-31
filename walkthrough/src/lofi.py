#!/usr/bin/env python3
"""Original lo-fi jazz bed for Packet's walkthrough, written for Null Grid (no
samples, no outside recordings: every sound is synthesised here, so the track
belongs to the project and needs no licence or credit).

    python3 walkthrough/src/lofi.py out.wav [seconds]

Slow swung beat (72 BPM), soft electric-piano chords on a ii-V-I-vi in C
(Dm9 G13 Cmaj9 Am9), round sine bass, brushed drums, a little tape wobble,
a warm low-pass and vinyl crackle. Keys alone for the first bar, drums from
bar 2, a simple melody from bar 9, fades out at the end.
"""
import sys
import numpy as np
from scipy.signal import butter, sosfilt
from scipy.io import wavfile

SR = 44100
SECONDS = float(sys.argv[2]) if len(sys.argv) > 2 else 78.0
OUT = sys.argv[1] if len(sys.argv) > 1 else 'lofi.wav'
BPM = 72
BEAT = 60 / BPM
BAR = 4 * BEAT
SWING = 0.16 * BEAT          # the off-beat 8th is pushed late
rng = np.random.default_rng(404)   # fixed seed: the same track every time
N = int(SR * SECONDS)
mix = np.zeros((N, 2))

def midi(n): return 440.0 * 2 ** ((n - 69) / 12)
def env(n, a, d, sus=0.0, r=None):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4)) * (sus + (1 - sus) * np.exp(-t / d))
    if r:
        tail = int(r * SR)
        if tail < n: e[-tail:] *= np.linspace(1, 0, tail)
    return e
def put(sig, start, pan=0.0, gain=1.0):
    i = int(start * SR)
    if i >= N: return
    sig = sig[: N - i] * gain
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    mix[i:i + len(sig), 0] += sig * l
    mix[i:i + len(sig), 1] += sig * r
def lp(x, hz, order=2): return sosfilt(butter(order, hz, 'low', fs=SR, output='sos'), x)
def hp(x, hz, order=2): return sosfilt(butter(order, hz, 'high', fs=SR, output='sos'), x)
def bp(x, lo, hi): return sosfilt(butter(2, [lo, hi], 'band', fs=SR, output='sos'), x)

# ---- electric piano: sine + soft bell partial, gentle tremolo ----
def epiano(note, dur, vel=0.8):
    n = int(dur * SR); t = np.arange(n) / SR; f = midi(note)
    tone = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t / 0.4) + 0.08 * np.sin(2 * np.pi * 3.01 * f * t) * np.exp(-t / 0.15)
    trem = 1 + 0.12 * np.sin(2 * np.pi * 4.2 * t)
    return tone * trem * env(n, 0.008, 1.6, 0.15, 0.25) * vel
def chord(notes, start, dur, vel=0.5):
    for k, nn in enumerate(notes):
        put(epiano(nn, dur, vel / len(notes) ** 0.5), start + k * 0.012, pan=-0.25 + 0.5 * k / max(1, len(notes) - 1), gain=0.55)

# ---- bass: round sine with a little warmth ----
def bass(note, dur):
    n = int(dur * SR); t = np.arange(n) / SR; f = midi(note)
    s = np.sin(2 * np.pi * f * t) + 0.15 * np.sin(2 * np.pi * 2 * f * t)
    return np.tanh(1.4 * s) * env(n, 0.01, 0.9, 0.35, 0.12)

# ---- drums ----
def kick():
    n = int(0.45 * SR); t = np.arange(n) / SR
    f = 50 + 70 * np.exp(-t / 0.035)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.16)
def snare():
    n = int(0.35 * SR); t = np.arange(n) / SR
    noise = bp(rng.standard_normal(n), 900, 5200) * np.exp(-t / 0.09)
    body = np.sin(2 * np.pi * 185 * t) * np.exp(-t / 0.05)
    return 0.55 * noise + 0.35 * body
def hat(open_=False):
    n = int((0.22 if open_ else 0.07) * SR); t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 6500) * np.exp(-t / (0.08 if open_ else 0.022))

# ---- the song ----
# ii-V-I-vi in C, rootless-ish voicings around middle C
PROG = [
    ('D', 38, [53, 57, 60, 64, 65]),       # Dm9   (F A C E F)
    ('G', 43, [53, 57, 59, 64]),           # G13   (F A B E)
    ('C', 36, [52, 55, 59, 62]),           # Cmaj9 (E G B D)
    ('A', 45, [55, 60, 64, 67, 71]),       # Am9   (G C E G B)
]
MELODY = [  # (beat offset in a 4-bar phrase, midi note, length in beats): C major pentatonic, lazy
    (0.5, 74, 1), (1.5, 72, .5), (2, 69, 1.5), (4.5, 67, 1), (6, 69, 1.5), (8.5, 72, .5), (9, 74, 1),
    (10, 76, 2), (12.5, 74, .5), (13, 72, 1), (14, 69, 1.5),
]
bars = int(np.ceil(SECONDS / BAR))
for b in range(bars):
    t0 = b * BAR
    _, root, voicing = PROG[b % 4]
    # keys: a long chord on 1, a softer stab on the "and" of 2 (swung)
    chord(voicing, t0, BAR * 0.75, 0.55)
    if b > 0: chord(voicing, t0 + 1.5 * BEAT + SWING, BEAT * 1.2, 0.3)
    # bass from bar 2: root on 1, fifth on 3, a passing note into the next bar
    if b >= 1:
        put(bass(root, BEAT * 1.8), t0, gain=0.5)
        put(bass(root + 7, BEAT * 1.4), t0 + 2 * BEAT, gain=0.42)
        put(bass(root + 5 if b % 2 else root + 3, BEAT * .6), t0 + 3.5 * BEAT + SWING, gain=0.35)
    # drums from bar 2: lazy boom-bap with swung hats
    if b >= 1:
        put(kick(), t0, gain=0.9); put(kick(), t0 + 2.5 * BEAT + SWING, gain=0.6)
        put(snare(), t0 + BEAT, gain=0.45); put(snare(), t0 + 3 * BEAT, gain=0.45)
        for e8 in range(8):
            off = e8 * BEAT / 2 + (SWING if e8 % 2 else 0)
            put(hat(open_=(e8 == 7 and b % 4 == 3)), t0 + off, pan=0.3, gain=0.10 if e8 % 2 else 0.16)
    # melody from bar 9, in 4-bar phrases
    if b >= 8 and b % 4 == 0 and t0 + 4 * BAR <= SECONDS + BAR:
        for beat, note, ln in MELODY:
            put(epiano(note, ln * BEAT + 0.4, 0.5), t0 + beat * BEAT + (SWING if beat % 1 else 0), pan=0.15, gain=0.32)

# ---- lo-fi: tape wobble, warm low-pass, vinyl ----
t = np.arange(N) / SR
delay = SR * (0.0025 * (1 + np.sin(2 * np.pi * 0.55 * t)) + 0.0004 * np.sin(2 * np.pi * 3.1 * t))   # a slowly moving delay = pitch wobble
idx = np.clip(np.arange(N) - delay, 0, N - 1)
for ch in range(2):
    mix[:, ch] = np.interp(idx, np.arange(N), mix[:, ch])
    mix[:, ch] = lp(mix[:, ch], 4200)
    mix[:, ch] = hp(mix[:, ch], 35)
hiss = lp(rng.standard_normal(N), 3000) * 0.004
clicks = np.zeros(N)
for i in rng.integers(0, N, int(SECONDS * 7)): clicks[i] = rng.uniform(-1, 1) * rng.uniform(0.05, 0.35)
crackle = bp(clicks, 1200, 7000)
for ch in range(2): mix[:, ch] += hiss + crackle * 0.6

# ---- fades, gentle glue, level ----
fade_in, fade_out = int(0.8 * SR), int(4 * SR)
mix[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
mix[-fade_out:] *= np.linspace(1, 0, fade_out)[:, None]
mix = np.tanh(mix * 1.2) / 1.2
mix *= 0.5 / max(1e-6, np.max(np.abs(mix)))          # peak around -6 dBFS: it sits under the video
wavfile.write(OUT, SR, (mix * 32767).astype(np.int16))
print(f'wrote {OUT}: {SECONDS:.0f}s, {BPM} BPM, {bars} bars')
