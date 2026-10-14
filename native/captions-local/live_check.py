"""End-to-end check of the real worker at real-time pace, without speakers.

Runs worker.py with file_capture.py and timestamps every event. Reports, per
phrase, the delay from detected speech to the first caption and from the end
of speech to the final text; processing lag over the session; worker CPU and
memory; TCP/UDP endpoints owned by the worker or capture process (netstat);
leftover processes after stopping; and, with --reference, word error rate.
"""
import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

import numpy as np
from faster_whisper.audio import decode_audio
sys.path.insert(0, str(Path(__file__).resolve().parent))  # sibling modules, also under python -I
from benchmark_accents import alignment, normalize
from pipeline import FRAME, RATE, Segmenter
from worker import SpeechGate

HERE = Path(__file__).resolve().parent
kernel32, psapi = ctypes.windll.kernel32, ctypes.windll.psapi
kernel32.OpenProcess.restype = wt.HANDLE
kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
kernel32.GetProcessTimes.argtypes = [wt.HANDLE] + [ctypes.POINTER(wt.FILETIME)] * 4
kernel32.CreateToolhelp32Snapshot.restype = wt.HANDLE


class Counters(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD)] + [
        (name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                                            "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                                            "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]


class Entry(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
                ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
                ("szExeFile", ctypes.c_char * 260)]


def processes():
    snapshot, entry, found = kernel32.CreateToolhelp32Snapshot(2, 0), Entry(), []
    entry.dwSize = ctypes.sizeof(Entry)
    ok = kernel32.Process32First(snapshot, ctypes.byref(entry))
    while ok:
        found.append((entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile.decode(errors="replace")))
        ok = kernel32.Process32Next(snapshot, ctypes.byref(entry))
    kernel32.CloseHandle(snapshot)
    return found


def tree(pid, table=None):
    """pid and all its descendants. A venv python.exe is a launcher whose child is the interpreter."""
    table = table or processes()
    found = [pid]
    for child, parent, _ in table:
        if parent == pid:
            found += tree(child, table)
    return found


def usage(pid):
    """(cpu_seconds, working_set_mb) or None if the process is gone."""
    handle = kernel32.OpenProcess(0x1000 | 0x0010, False, pid)  # QUERY_LIMITED_INFORMATION | VM_READ
    if not handle:
        return None
    try:
        times = [wt.FILETIME() for _ in range(4)]
        kernel32.GetProcessTimes(handle, *[ctypes.byref(t) for t in times])
        cpu = sum((t.dwHighDateTime << 32 | t.dwLowDateTime) for t in times[2:]) / 1e7
        counters = Counters(); counters.cb = ctypes.sizeof(Counters)
        psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
        return cpu, counters.WorkingSetSize / 2**20
    finally:
        kernel32.CloseHandle(handle)


def phrases(audio):
    """Replay the worker's VAD and segmentation: per final phrase, speech onset and end (seconds)."""
    jobs, probabilities = [], []
    segmenter, gate = Segmenter(lambda job: jobs.append(job) if job.final else None), SpeechGate()
    padded = np.pad(audio, (0, -len(audio) % FRAME))
    for offset in range(0, len(padded), FRAME):
        frame = padded[offset:offset + FRAME]
        probabilities.append(gate(frame))
        segmenter.push(frame, probabilities[-1])
    for _ in range(40):  # trailing silence, as the capture stand-in provides
        segmenter.push(np.zeros(FRAME, dtype=np.float32), gate(np.zeros(FRAME, dtype=np.float32)))
    probabilities += [0.0] * 40
    result, previous = {}, None
    for job in jobs:
        first, last = job.start // FRAME, job.end // FRAME
        voiced = [i for i in range(first, last) if probabilities[i] >= 0.5] or [first]
        # A continuation starts inside the split phrase's audio; its first words were
        # already shown by that phrase's interim captions.
        result[job.id] = {"onset": (voiced[0] + 1) * FRAME / RATE, "speech_end": (voiced[-1] + 1) * FRAME / RATE,
                          "audio_end": job.end / RATE, "forced_split": job.split is not None,
                          "continuation": previous is not None and previous.split is not None}
        previous = job
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["parakeet", "whisper"], required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--reference", help="text file with the expected transcript")
    parser.add_argument("--tail", type=float, default=6.0, help="seconds to keep running after the audio")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    audio = decode_audio(args.audio, sampling_rate=RATE)
    expected = phrases(audio)
    env = {**os.environ, "PYTHONUTF8": "1", "HF_HUB_OFFLINE": "1"}
    worker = subprocess.Popen([sys.executable, "-u", str(HERE / "worker.py"), "--model", args.model,
                               "--engine", args.engine, "--capture", str(HERE / "file_capture.py"),
                               "--threads", "3", "--device", args.audio],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW)
    events, started = [], time.perf_counter()
    source_at = threading.Event()

    def read():
        for line in worker.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            event["t"] = time.perf_counter() - started
            events.append(event)
            if event["type"] == "source":
                source_at.set()

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    threading.Thread(target=lambda: worker.stderr.read(), daemon=True).start()
    if not source_at.wait(180):
        worker.kill()
        raise SystemExit("worker did not start")
    zero = next(e["t"] for e in events if e["type"] == "source")
    table = processes()
    family = tree(worker.pid, table)
    # The recognizer is the interpreter that the venv launcher started.
    recognizer = next((pid for pid, parent, exe in table if parent == worker.pid and exe.lower() == "python.exe"),
                      worker.pid)
    samples, network = [], []
    deadline = zero + len(audio) / RATE + args.tail
    while time.perf_counter() - started < deadline and worker.poll() is None:
        now = time.perf_counter() - started - zero
        u = usage(recognizer)
        if u:
            samples.append({"t": round(now, 1), "cpu_s": round(u[0], 2), "mb": round(u[1])})
        if len(samples) % 5 == 1:
            family = sorted(set(family) | set(tree(worker.pid)))
            pids = {str(pid) for pid in family}
            rows = subprocess.run(["netstat", "-ano"], capture_output=True, text=True).stdout.splitlines()
            network += [line.strip() for line in rows if line.split() and line.split()[-1] in pids]
        time.sleep(1)
    stop_requested = time.perf_counter()
    worker.stdin.write("stop\n"); worker.stdin.flush()
    try:
        code = worker.wait(timeout=20)
    except subprocess.TimeoutExpired:
        worker.kill()
        code = "killed after 20 s"
    stop_seconds = round(time.perf_counter() - stop_requested, 2)
    reader.join(2)
    time.sleep(0.5)
    leftovers = [p for p in processes() if p[0] in family]

    per_phrase = []
    for pid, info in expected.items():
        mine = [e for e in events if e.get("id") == pid and e["type"] in ("partial", "final")]
        first = next((e["t"] - zero for e in mine if e.get("text")), None)
        final = next((e for e in mine if e["type"] == "final"), None)
        per_phrase.append({"id": pid, **{k: round(v, 2) if isinstance(v, float) else v for k, v in info.items()},
                           "first_caption_delay": None if first is None else round(first - info["onset"], 2),
                           "final_delay_after_speech": None if final is None else round(final["t"] - zero - info["speech_end"], 2),
                           "final_text": None if final is None else final["text"]})
    latest = {}  # a revision replaces its phrase's text, as on screen
    for e in events:
        if e["type"] == "final":
            latest[e["id"]] = e.get("text", "")
    transcript = " ".join(text for _, text in sorted(latest.items()) if text)
    lag = [e["behindMs"] for e in events if e["type"] == "metrics"]
    half = len(lag) // 2
    duration = samples[-1]["t"] - samples[0]["t"] if len(samples) > 1 else 0
    report = {
        "engine": args.engine, "model": Path(args.model).name, "audio": Path(args.audio).name,
        "audio_seconds": round(len(audio) / RATE, 1), "exit_code": code, "stop_seconds": stop_seconds,
        "errors": [e["message"] for e in events if e["type"] == "error"],
        "phrases_expected": len(expected), "phrases_captioned": sum(1 for t in latest.values() if t),
        "revisions": sum(1 for e in events if e["type"] == "final" and e.get("revision")),
        "first_caption_delay": summary([p["first_caption_delay"] for p in per_phrase if not p["continuation"]]),
        "continuations": sum(p["continuation"] for p in per_phrase),
        "final_delay_after_speech": summary([p["final_delay_after_speech"] for p in per_phrase]),
        "processing_lag_ms": {**summary(lag), "first_half_mean": mean(lag[:half]), "second_half_mean": mean(lag[half:])},
        "cpu_percent_of_one_core": round(100 * (samples[-1]["cpu_s"] - samples[0]["cpu_s"]) / duration, 1) if duration else None,
        "logical_cores": os.cpu_count(),
        "working_set_mb": {"first": samples[0]["mb"] if samples else None, "max": max((s["mb"] for s in samples), default=None),
                           "last": samples[-1]["mb"] if samples else None},
        "processes_watched": len(family), "network_endpoints": sorted(set(network)), "leftover_processes": leftovers,
        "transcript": transcript, "phrases": per_phrase, "samples": samples,
        "events": [{**e, "t": round(e["t"] - zero, 3)} for e in events if e["type"] in ("partial", "final", "metrics")],
    }
    if args.reference:
        reference = Path(args.reference).read_text(encoding="utf-8")
        (sub, dele, ins), words = alignment(reference, transcript)
        report["wer"] = round((sub + dele + ins) / max(words, 1), 4)
        report["errors_by_type"] = {"substitutions": sub, "deletions": dele, "insertions": ins, "words": words}
    else:
        report["words_captioned"] = len(normalize(transcript))
    Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k not in ("phrases", "samples", "transcript")}, indent=1))


def mean(values):
    return round(sum(values) / len(values), 1) if values else None


def summary(values):
    values = sorted(v for v in values if v is not None)
    if not values:
        return {"count": 0}
    pick = lambda q: values[min(len(values) - 1, int(q * len(values)))]
    return {"count": len(values), "median": pick(0.5), "p90": pick(0.9), "max": values[-1]}


if __name__ == "__main__":
    main()
