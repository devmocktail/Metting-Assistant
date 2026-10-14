"""Fetch a balanced EdAcc test sample for local evaluation. Not used by the app.

EdAcc, the Edinburgh International Accents of English Corpus (CC BY-SA 4.0):
https://huggingface.co/datasets/edinburghcstr/edacc. Conversations recorded
over video calls, with human transcripts and self-reported accents. Rows come
from the Hugging Face datasets-server; nothing else is contacted. Writes WAV
files and manifest.json (for benchmark_accents.py) into --output.
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

ROWS = "https://datasets-server.huggingface.co/rows?dataset=edinburghcstr/edacc&config=default&split=test"


def get(url, attempts=7):
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "local-caption-evaluation"})
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code in (403, 404) or attempt == attempts - 1:  # expired link: the caller refreshes it
                raise
        except OSError:
            if attempt == attempts - 1:
                raise
        time.sleep(min(60, 5 * 2 ** attempt))  # the server answers 5xx while it loads data


def rows(offset, length):
    return json.loads(get(f"{ROWS}&offset={offset}&length={length}"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--accents", nargs="+", required=True)
    parser.add_argument("--per-accent", type=int, default=20)
    parser.add_argument("--min-words", type=int, default=4)
    parser.add_argument("--max-mb", type=float, default=110)
    parser.add_argument("--scan-step", type=int, default=200, help="read 100 of every N rows")
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    first = rows(0, 100)
    found = first["rows"]
    for offset in range(args.scan_step, first["num_rows_total"], args.scan_step):
        try:
            found += rows(offset, 100)["rows"]
        except OSError as error:  # the server can stay unavailable for some blocks; sample the rest
            print(f"Skipped rows {offset}-{offset + 99}: {error}", flush=True)
    print(f"Scanned {len(found)} of {first['num_rows_total']} rows", flush=True)
    by_accent = defaultdict(lambda: defaultdict(list))
    for r in found:
        words = re.sub(r"\[[^\]]*\]|<[^>]*>", " ", r["row"]["text"]).split()
        if len(words) >= args.min_words:
            by_accent[r["row"]["accent"]][r["row"]["speaker"]].append(r)
    manifest, total = [], 0  # total counts new downloads only
    for accent in args.accents:
        slug = re.sub(r"[^a-z]+", "-", accent.lower()).strip("-")
        have = {int(p.stem.rsplit("-", 1)[1]) for p in out.glob(f"{slug}-*.wav")}
        chosen, queues = [], [list(q) for q in by_accent[accent].values()]
        while len(chosen) < args.per_accent and any(queues):  # round-robin across speakers
            for q in queues:
                if q and len(chosen) < args.per_accent:
                    chosen.append(q.pop(len(q) // 2))
        # Clips from an earlier run are reused, never downloaded twice.
        chosen += [r for q in by_accent[accent].values() for r in q if r["row_idx"] in have and r not in chosen]
        for r in chosen:
            row, index = r["row"], r["row_idx"]
            path = out / f"{slug}-{index}.wav"
            if index not in have:
                if total > args.max_mb * 2**20:
                    continue
                try:
                    data = get(row["audio"][0]["src"])
                except urllib.error.HTTPError:
                    data = get(rows(index, 1)["rows"][0]["row"]["audio"][0]["src"])
                if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
                    continue
                path.write_bytes(data)
                total += len(data)
            manifest.append({"name": f"{slug}-{index}", "audio": str(path.resolve()), "reference": row["text"],
                             "reference_kind": "transcript", "accent": accent, "speaker": row["speaker"],
                             "l1": row["l1"], "source": f"EdAcc test row {index}"})
        print(f"{accent}: {sum(m['accent'] == accent for m in manifest)} utterances, "
              f"{len({m['speaker'] for m in manifest if m['accent'] == accent})} speakers, "
              f"{total / 2**20:.1f} MB downloaded this run", flush=True)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
