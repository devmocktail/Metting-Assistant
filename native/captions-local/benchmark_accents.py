"""Compare local recognition against a supplied evaluation manifest.

Manifest items: {"name", "audio", "reference", optional "source", optional
"reference_kind"}. Use reference_kind "prompt" when the reference is the text a
speaker was asked to read rather than a transcript of what was said; prompt
WER also counts the speaker's own deviations. Samples are not bundled and
small sample sets are not population-wide accuracy measurements.

Each sample runs through the app's own VAD, segmentation, and stitching, and
also as one whole-file decode, which shows what segmentation itself costs.
"""
import argparse
import json
from pathlib import Path
import re
import socket
import time
import unicodedata

import sys
import numpy as np
from faster_whisper.audio import decode_audio
sys.path.insert(0, str(Path(__file__).resolve().parent))  # sibling modules, also under python -I
from pipeline import FRAME, RATE, Segmenter, Stitcher
from worker import Finalizer, Recognizer, SpeechGate

ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen " \
       "sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
ORDINALS = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
            "nine": "ninth", "twelve": "twelfth"}
FILLERS = {"uh", "um", "er", "ah", "eh", "hmm", "mm", "mhm", "uhm", "erm"}


def spell(number):
    if number < 20:
        return ONES[number]
    if number < 100:
        return TENS[number // 10] + ("" if number % 10 == 0 else " " + ONES[number % 10])
    for size, name in ((10**9, "billion"), (10**6, "million"), (1000, "thousand"), (100, "hundred")):
        if number >= size:
            rest = number % size
            return f"{spell(number // size)} {name}" + (f" {spell(rest)}" if rest else "")
    return str(number)


def ordinal(words):
    *head, last = words.split()
    last = ORDINALS.get(last, last.rstrip("y") + "ieth" if last.endswith("y") else last + "th")
    return " ".join([*head, last])


def normalize(text):
    """Lowercase words; digits spelled out; accents, punctuation, fillers, and bracketed notes removed."""
    text = unicodedata.normalize("NFKD", text.lower().replace("đ", "d"))
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"\[[^\]]*\]|<[^>]*>|\([^)]*\)", " ", text)
    text = text.replace("%", " percent").replace("&", " and ")
    text = re.sub(r"(\d),(\d{3})", r"\1\2", text)
    text = re.sub(r"\d+(st|nd|rd|th)\b", lambda m: ordinal(spell(int(m.group()[:-2]))), text)
    text = re.sub(r"(\d+)\.(\d+)", lambda m: f"{spell(int(m.group(1)))} point {' '.join(ONES[int(d)] for d in m.group(2))}", text)
    text = re.sub(r"\d+", lambda m: f" {spell(int(m.group()))} ", text)
    words = re.findall(r"[a-z]+(?:'[a-z]+)*", text.replace("-", " "))
    return [{"ok": "okay"}.get(w, w) for w in words if w not in FILLERS]


def alignment(reference, hypothesis):
    """(substitutions, deletions, insertions) of a minimum word alignment."""
    a, b = normalize(reference), normalize(hypothesis)
    rows = [[(j, 0, 0, j) for j in range(len(b) + 1)]]  # (cost, sub, del, ins)
    for i, x in enumerate(a, 1):
        row = [(i, 0, i, 0)]
        for j, y in enumerate(b, 1):
            diagonal = rows[-1][j - 1]
            options = [(diagonal[0] + (x != y), diagonal[1] + (x != y), diagonal[2], diagonal[3])]
            up, left = rows[-1][j], row[j - 1]
            options.append((up[0] + 1, up[1], up[2] + 1, up[3]))
            options.append((left[0] + 1, left[1], left[2], left[3] + 1))
            row.append(min(options))
        rows.append(row)
    return rows[-1][-1][1:], len(a)


def error_positions(a, b):
    """Indices into token list `a` where a minimum alignment with `b` has an error."""
    rows = [list(range(len(b) + 1))]
    for i, x in enumerate(a, 1):
        row = [i]
        for j, y in enumerate(b, 1):
            row.append(min(rows[-1][j - 1] + (x != y), rows[-1][j] + 1, row[j - 1] + 1))
        rows.append(row)
    i, j, found = len(a), len(b), []
    while i or j:
        if i and j and rows[i][j] == rows[i - 1][j - 1] + (a[i - 1] != b[j - 1]):
            if a[i - 1] != b[j - 1]:
                found.append(i - 1)
            i, j = i - 1, j - 1
        elif i and rows[i][j] == rows[i - 1][j] + 1:
            found.append(i - 1)
            i -= 1
        else:
            found.append(i)  # insertion before reference token i
            j -= 1
    return found


def segmented(recognizer, audio, revise=True):
    jobs = []
    segmenter = Segmenter(lambda job: jobs.append(job) if job.final else None)
    gate = SpeechGate()
    padded = np.pad(audio, (0, -len(audio) % FRAME))
    for offset in range(0, len(padded), FRAME):
        frame = padded[offset:offset + FRAME]
        segmenter.push(frame, gate(frame))
    segmenter.finish()
    finalize, texts = Finalizer(recognizer, Stitcher(), revise=revise), {}
    for job in jobs:
        texts.update(finalize(job))  # a revision replaces an earlier phrase's text in place
    return " ".join(t for t in texts.values() if t), len(jobs), sum(j.split is not None for j in jobs)


def condition(audio, spec, other):
    """clean | gain:<dB> | noise:<SNR dB, pink> | overlap:<dB of another clip relative to this one>."""
    kind, _, value = spec.partition(":")
    if kind == "gain":
        return audio * 10 ** (float(value) / 20)
    power = np.sqrt(np.mean(audio ** 2))
    if kind == "noise":
        spectrum = np.fft.rfft(np.random.default_rng(1).standard_normal(len(audio)))
        noise = np.fft.irfft(spectrum / np.sqrt(np.maximum(np.arange(len(spectrum)), 1)), len(audio))
        return audio + noise / np.sqrt(np.mean(noise ** 2)) * power * 10 ** (-float(value) / 20)
    if kind == "overlap":
        other = np.resize(other, len(audio))
        return audio + other / np.sqrt(np.mean(other ** 2)) * power * 10 ** (float(value) / 20)
    return audio


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--profiles", nargs="+", default=["parakeet", "whisper-small"])
    parser.add_argument("--conditions", nargs="+", default=["clean"],
                        help="clean, gain:-25 (quiet), noise:10 (pink noise SNR), overlap:-6 (another speaker)")
    parser.add_argument("--no-whole", action="store_true", help="skip the whole-file decode")
    parser.add_argument("--no-app", action="store_true", help="skip the app's segmented decode")
    parser.add_argument("--no-revise", action="store_true", help="do not revise a phrase with the next one")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    def block_network(*_args, **_kwargs):
        raise AssertionError("Network connection attempted during recognition")
    socket.socket.connect = socket.socket.connect_ex = block_network
    socket.create_connection = socket.getaddrinfo = block_network
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    root = Path(args.model_root)
    profiles = {"parakeet": ("parakeet", "parakeet-en"),
                "whisper-small": ("whisper", "whisper-small"),
                "whisper-turbo": ("whisper", "whisper-large-v3-turbo")}
    # Results are saved after every decode; a rerun resumes after the last one saved.
    output = Path(args.output)
    results = json.loads(output.read_text(encoding="utf-8")) if output.exists() else []
    done = {(r["profile"], r["mode"], r["condition"], r["sample"]) for r in results}
    wanted = [m for m, skip in (("app", args.no_app), ("whole", args.no_whole)) if not skip]
    for profile in args.profiles:
        engine, folder = profiles[profile]
        recognizer = None
        for index, item in enumerate(manifest):
            clean = None
            for spec in args.conditions:
                modes = [m for m in wanted if (profile, m, spec, item["name"]) not in done]
                if not modes:
                    continue
                recognizer = recognizer or Recognizer(engine, root / folder)
                clean = decode_audio(item["audio"], sampling_rate=RATE) if clean is None else clean
                other = decode_audio(manifest[(index + 1) % len(manifest)]["audio"], sampling_rate=RATE) \
                    if spec.startswith("overlap") else None
                audio = np.clip(condition(clean, spec, other), -1, 1).astype(np.float32)
                for mode in modes:
                    started = time.perf_counter()
                    if mode == "app":
                        text, segments, splits = segmented(recognizer, audio, revise=not args.no_revise)
                    else:
                        text, segments, splits = " ".join(w.text for w in recognizer.transcribe(audio)), 1, 0
                    seconds = time.perf_counter() - started
                    (sub, dele, ins), words = alignment(item["reference"], text)
                    result = dict(profile=profile, mode=mode, condition=spec, sample=item["name"],
                                  accent=item.get("accent"), reference_kind=item.get("reference_kind", "transcript"),
                                  audio_seconds=round(len(audio) / RATE, 2), processing_seconds=round(seconds, 2),
                                  segments=segments, forced_splits=splits, words=words,
                                  substitutions=sub, deletions=dele, insertions=ins,
                                  wer=round((sub + dele + ins) / max(words, 1), 4), text=text)
                    results.append(result)
                    output.write_text(json.dumps(results, indent=2), encoding="utf-8")
                    print(json.dumps({k: v for k, v in result.items() if k != "text"}), flush=True)
        del recognizer


if __name__ == "__main__":
    main()
