"""Write a non-speech test file: no caption should appear for any of it.

Silence, a near-silent noise floor, white and pink noise, tones, synthetic
music, keyboard-like clicks, and Windows system sounds, in that order.
Usage: python make_nonspeech.py <output.wav>
"""
from pathlib import Path
import sys
import wave

import numpy as np
from faster_whisper.audio import decode_audio

RATE = 16000
rng = np.random.default_rng(7)


def seconds(n):
    return np.arange(int(n * RATE)) / RATE


def level(x, dbfs):
    return x / (np.sqrt(np.mean(x ** 2)) + 1e-12) * 10 ** (dbfs / 20)


def pink(n):
    spectrum = np.fft.rfft(rng.standard_normal(n))
    spectrum /= np.sqrt(np.maximum(np.arange(len(spectrum)), 1))
    return np.fft.irfft(spectrum, n)


def music(n_seconds):
    t, out = seconds(n_seconds), np.zeros(int(n_seconds * RATE))
    chords = [(220, 277.2, 329.6), (196, 246.9, 293.7), (174.6, 220, 261.6), (196, 246.9, 293.7)]
    for beat in range(int(n_seconds * 2)):
        start = int(beat * RATE / 2)
        for f in chords[(beat // 4) % 4]:
            note = np.sin(2 * np.pi * f * t[:RATE // 2]) * np.exp(-4 * t[:RATE // 2])
            out[start:start + len(note)] += note[:len(out) - start]
        kick = np.sin(2 * np.pi * 60 * t[:2000]) * np.exp(-30 * t[:2000])
        out[start:start + 2000] += 2 * kick[:len(out[start:start + 2000])]
    return out


def clicks(n_seconds):
    out = np.zeros(int(n_seconds * RATE))
    for at in rng.uniform(0, n_seconds - 0.05, int(n_seconds * 6)):
        i = int(at * RATE)
        out[i:i + 240] += rng.standard_normal(240) * np.exp(-np.arange(240) / 40)
    return out


parts = [np.zeros(10 * RATE), level(rng.standard_normal(10 * RATE), -60), level(rng.standard_normal(10 * RATE), -25),
         level(pink(10 * RATE), -25), level(np.sign(np.sin(2 * np.pi * 2 * seconds(10))).clip(0) *
                                            np.sin(2 * np.pi * 440 * seconds(10)), -20),
         level(music(15), -18), level(clicks(10), -25)]
media = sorted(Path(r"C:\Windows\Media").glob("*.wav"))
sounds = [level(decode_audio(str(p), sampling_rate=RATE), -20) for p in media[:40]]
parts += [np.concatenate([np.concatenate((s, np.zeros(RATE // 2))) for s in sounds])[:25 * RATE]]
audio = np.clip(np.concatenate(parts), -1, 1)
with wave.open(sys.argv[1], "wb") as f:
    f.setnchannels(1); f.setsampwidth(2); f.setframerate(RATE)
    f.writeframes((audio * 32767).astype("<i2").tobytes())
print(f"{len(audio) / RATE:.0f} s written, {len(sounds)} Windows sounds")
