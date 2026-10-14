"""Boundary regression on real audio: split everywhere, compare with one decode.

For each clip and each split time t (every --step seconds) the clip is decoded
as two phrases sharing t-0.8..t+0.8 s, as Segmenter does at its limit, and
stitched. The words are compared with a single whole-clip decode by the same
engine. Two decodes can also differ away from the split (for example "4:30"
versus "4.30"), so errors within four words of the split are reported
separately as the boundary's own. The previous method (split at t, 640 ms
overlap, exact-word suffix removal) runs on the same splits for comparison.
Requires installed models; plays nothing. --rescore recomputes an existing report.
"""
import argparse
import json
from pathlib import Path
import re

import sys
import numpy as np
from faster_whisper.audio import decode_audio
sys.path.insert(0, str(Path(__file__).resolve().parent))  # sibling modules, also under python -I
from benchmark_accents import alignment, error_positions, normalize
from pipeline import RATE, Job, Segmenter, Stitcher
from worker import Recognizer

SHARED = Segmenter.SHARED * 512 / RATE
RADIUS = 4  # words on each side of a split


def previous_method(previous, text):
    """The exact-word suffix/prefix removal this check replaced, for comparison."""
    a, b = previous.split(), text.split()
    norm = lambda word: re.sub(r"[^\w']", "", word).casefold()
    for count in range(min(12, len(a), len(b)), 0, -1):
        if [norm(w) for w in a[-count:]] == [norm(w) for w in b[:count]]:
            return " ".join(b[count:])
    return text


def joined(words):
    return " ".join(w.text for w in words)


def score(rows, words, whole):
    """Add whole-text and near-boundary error counts to each split's results."""
    tokens = [(token, w.start) for w in words for token in normalize(w.text)]
    reference = [token for token, _ in tokens]
    for row in rows:
        boundary = next((i for i, (_, start) in enumerate(tokens) if start >= row["t"]), len(tokens))
        for name in ("new", "old"):
            text = row[name]["text"]
            (sub, dele, ins), _ = alignment(whole, text)
            near = sum(abs(p - boundary) <= RADIUS for p in error_positions(reference, normalize(text)))
            row[name].update(errors=sub + dele + ins, insertions=ins, deletions=dele, near=near)


def summarize(sample, profile, rows, whole):
    summary = {"sample": sample, "profile": profile, "splits": len(rows), "whole": whole}
    for name in ("new", "old"):
        summary[name] = {
            "splits_with_boundary_errors": sum(r[name]["near"] > 0 for r in rows),
            "boundary_errors": sum(r[name]["near"] for r in rows),
            "splits_with_any_difference": sum(r[name]["errors"] > 0 for r in rows),
            "total_differences": sum(r[name]["errors"] for r in rows),
            "insertions": sum(r[name]["insertions"] for r in rows),
            "deletions": sum(r[name]["deletions"] for r in rows)}
    reference = " ".join(normalize(whole))
    for phrase in ("very very", "please please"):
        if phrase in reference:
            summary[f"keeps '{phrase}'"] = {name: sum(phrase in " ".join(normalize(r[name]["text"])) for r in rows)
                                           for name in ("new", "old")}
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--profile", default="parakeet", choices=["parakeet", "whisper-small", "whisper-turbo"])
    parser.add_argument("--step", type=float, default=0.25)
    parser.add_argument("--only", nargs="*", help="sample names to include")
    parser.add_argument("--rescore", help="existing report to score again instead of decoding splits")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    engine, folder = {"parakeet": ("parakeet", "parakeet-en"), "whisper-small": ("whisper", "whisper-small"),
                      "whisper-turbo": ("whisper", "whisper-large-v3-turbo")}[args.profile]
    recognizer = Recognizer(engine, Path(args.model_root) / folder)
    items = {item["name"]: item for item in json.loads(Path(args.manifest).read_text(encoding="utf-8"))}
    previous = json.loads(Path(args.rescore).read_text(encoding="utf-8")) if args.rescore else None
    report = []
    for name in ([entry["sample"] for entry in previous] if previous else items):
        if args.only and name not in args.only:
            continue
        audio = decode_audio(items[name]["audio"], sampling_rate=RATE)
        words = recognizer.transcribe(audio, timed=True)
        whole = joined(words)
        if previous:
            rows = next(entry["rows"] for entry in previous if entry["sample"] == name)
        else:
            rows = []
            for t in np.arange(2.0, len(audio) / RATE - 1.0, args.step):
                low, high = int((t - SHARED) * RATE), int((t + SHARED) * RATE)
                first = Job(1, audio[:high], True, 0, 0, split=low)
                second = Job(2, audio[low:], True, low, 0)
                stitcher = Stitcher()
                new = stitcher.text(first, recognizer.transcribe(first.audio, timed=True))
                new += " " + stitcher.text(second, recognizer.transcribe(second.audio, timed=stitcher.needs_timing(second)))
                head = joined(recognizer.transcribe(audio[:int(t * RATE)]))
                tail = joined(recognizer.transcribe(audio[int((t - 0.64) * RATE):]))
                rows.append({"t": round(float(t), 2), "new": {"text": new},
                             "old": {"text": head + " " + previous_method(head, tail)}})
        score(rows, words, whole)
        summary = summarize(name, args.profile, rows, whole)
        print(json.dumps({k: v for k, v in summary.items() if k != "whole"}), flush=True)
        report.append({**summary, "rows": rows})
        Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")  # saved per clip


if __name__ == "__main__":
    main()
