"""Explicit, one-time installation. The caption worker never downloads models.

Each model is pinned to the revision evaluated with this app. Interrupted
downloads resume automatically. Every file's size, and the SHA-256 of large
files, is checked against Hugging Face's metadata and recorded in
installation.json.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

# Use ordinary resumable HTTPS downloads; the optional Xet transport can stall
# on some Windows networks. These settings apply only to explicit installation.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")
from huggingface_hub import HfApi, snapshot_download

MODELS = {
    "parakeet-en": ("csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "1ab9323565ddb038682214b292f588070a538ce2"),
    "small": ("Systran/faster-whisper-small", "536b0662742c02347bc0e980a01041f333bce120"),
    # Formerly mobiuslabsgmbh/faster-whisper-large-v3-turbo (same revision).
    "large-v3-turbo": ("dropbox-dash/faster-whisper-large-v3-turbo", "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"),
}
PATTERNS = ["config.json", "model.bin", "tokenizer.json", "preprocessor_config.json", "vocabulary.*",
            "README.md", "*.onnx", "tokens.txt", "LICENSE*", "test_wavs/*"]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def install(repo, revision, folder):
    for attempt in range(1, 6):
        try:
            snapshot_download(repo, revision=revision, local_dir=str(folder), allow_patterns=PATTERNS)
            break
        except Exception as error:  # a stalled or dropped connection; the next attempt resumes
            if attempt == 5:
                raise
            print(f"Download interrupted ({error}). Resuming in {10 * attempt} s ...", flush=True)
            time.sleep(10 * attempt)
    files = {}
    for sibling in HfApi().model_info(repo, revision=revision, files_metadata=True).siblings:
        path = folder / sibling.rfilename
        if not path.is_file():
            continue
        if path.stat().st_size != sibling.size:
            raise RuntimeError(f"{sibling.rfilename} is incomplete. Re-run setup to resume.")
        files[sibling.rfilename] = {"size": sibling.size}
        if sibling.lfs:
            digest = sha256(path)
            if digest != sibling.lfs.sha256:
                path.unlink()
                raise RuntimeError(f"{sibling.rfilename} failed its checksum and was removed. Re-run setup.")
            files[sibling.rfilename]["sha256"] = digest
    return files


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=[*MODELS, "all"], default="all")
    args = parser.parse_args()
    root = Path(os.environ["APPDATA"]) / "private-meeting-overlay" / "models"
    for name, (repo, revision) in MODELS.items():
        if args.model not in ("all", name):
            continue
        folder = root / (name if name == "parakeet-en" else f"whisper-{name}")
        print(f"Installing {name} locally from {repo} at {revision[:7]} ...", flush=True)
        files = install(repo, revision, folder)
        required_files = ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt") if name == "parakeet-en" else ("config.json", "model.bin", "tokenizer.json")
        for required in required_files:
            if not (folder / required).is_file():
                raise RuntimeError(f"Download incomplete: missing {required}")
        (folder / "installation.json").write_text(
            json.dumps({"repository": repo, "revision": revision, "files": files}, indent=2), encoding="utf-8"
        )
        print(f"Ready and verified: {folder}", flush=True)


if __name__ == "__main__":
    main()
