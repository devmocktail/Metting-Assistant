"""Local system-audio captions. No downloads, web requests, or audio files at runtime."""
import os
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

import argparse
import json
from pathlib import Path
import subprocess
import sys
import threading
import time

import numpy as np
from pipeline import FRAME, RATE, Mailbox, Segmenter, Stitcher, Word

OUTPUT_LOCK = threading.Lock()
NETWORK_EVENTS = {"socket.connect", "socket.bind", "socket.sendto", "socket.sendmsg",
                  "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr"}


def forbid_network(event, _args):
    """Enforced in the worker process: Python code cannot open connections or resolve names."""
    if event in NETWORK_EVENTS:
        raise RuntimeError(f"Network access is disabled in the caption worker ({event}).")


def emit(kind, **payload):
    with OUTPUT_LOCK:
        print(json.dumps({"type": kind, **payload}, ensure_ascii=False), flush=True)


class SpeechGate:
    """Stateful Silero v6 ONNX inference, with state preserved across 32 ms frames."""
    def __init__(self):
        from faster_whisper.vad import get_vad_model
        self.session = get_vad_model().session
        self.h = np.zeros((1, 1, 128), dtype=np.float32)
        self.c = np.zeros_like(self.h)
        self.context = np.zeros(64, dtype=np.float32)

    def __call__(self, frame):
        x = np.concatenate((self.context, frame))[None, :]
        output, self.h, self.c = self.session.run(None, {"input": x, "h": self.h, "c": self.c})
        self.context = frame[-64:].copy()
        return float(output.reshape(-1)[0])


class Recognizer:
    def __init__(self, engine, model_dir, threads=3):
        self.engine = engine
        self.model_dir = Path(model_dir)
        if engine == "parakeet":
            import sherpa_onnx
            self.model = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=str(self.model_dir / "encoder.int8.onnx"),
                decoder=str(self.model_dir / "decoder.int8.onnx"),
                joiner=str(self.model_dir / "joiner.int8.onnx"),
                tokens=str(self.model_dir / "tokens.txt"),
                model_type="nemo_transducer", num_threads=threads, provider="cpu",
            )
        else:
            from faster_whisper import WhisperModel
            self.model = WhisperModel(str(self.model_dir), device="cpu", compute_type="int8",
                                      cpu_threads=threads, num_workers=1, local_files_only=True)

    def transcribe(self, audio, final=True, timed=False):
        """Words with times in seconds from the start of `audio`.

        Parakeet always reports token times. Whisper aligns words only when
        `timed`; otherwise times are spread evenly across each segment.
        """
        if self.engine == "parakeet":
            stream = self.model.create_stream()
            stream.accept_waveform(RATE, audio)
            self.model.decode_stream(stream)
            result = stream.result
            words = []
            for token, start, duration in zip(result.tokens, result.timestamps, result.durations):
                if token.startswith(" ") or not words:
                    words.append(Word(token.strip(), start, start + duration))
                else:
                    words[-1].text += token
                    if any(c.isalnum() for c in token):  # punctuation must not stretch a word
                        words[-1].end = start + duration
            return [w for w in words if w.text]
        segments, _ = self.model.transcribe(
            audio, language="en", task="transcribe", beam_size=5 if final else 1,
            temperature=0, condition_on_previous_text=False, vad_filter=False,
            no_speech_threshold=0.6, log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4, repetition_penalty=1.05, word_timestamps=timed,
        )
        words = []
        for s in segments:
            # A compression ratio above 2.4 marks a repetition loop ("I don't know, I don't know, ...").
            if s.avg_logprob < -1.2 or s.no_speech_prob >= 0.8 or s.compression_ratio > 2.4:
                continue
            if timed:
                words += [Word(w.word.strip(), w.start, w.end) for w in s.words if w.word.strip()]
            else:
                parts = s.text.split()
                step = (s.end - s.start) / max(len(parts), 1)
                words += [Word(p, s.start + i * step, s.start + (i + 1) * step) for i, p in enumerate(parts)]
        return words


class Finalizer:
    """Decode finished phrases with the phrases around them as context.

    A phrase decoded alone loses the words around it. While phrases follow
    each other within 2 s, a finished phrase is decoded together with those
    before it (up to 12 s), joined end to end since each already ends in a
    pause, and words are assigned to each phrase by time. The new phrase
    gains its left context, and the previous phrase, now with context on both
    sides, is updated if its words changed. Forced splits are joined by
    Stitcher instead.

    Only Parakeet decodes this way: on EdAcc it gained accuracy, while Whisper
    fell into a repetition loop on the longer joint audio.
    """
    GAP_SECONDS = 2.0
    LIMIT_SECONDS = 12.0

    def __init__(self, recognizer, stitcher, revise=True):
        self.recognizer, self.stitcher = recognizer, stitcher
        self.revise = revise and recognizer.engine == "parakeet"
        self.chain = []  # recent phrases that followed each other closely, as [job, shown text]

    def __call__(self, job):
        """Finals to show, oldest first, as (phrase id, text)."""
        revisable = job.split is None and job.start >= self.stitcher.committed * RATE
        follows = self.chain and 0 <= job.start - self.chain[-1][0].end <= self.GAP_SECONDS * RATE
        chain = (self.chain if self.revise and revisable and follows else []) + [[job, ""]]
        while len(chain) > 1 and job.end - chain[0][0].start > self.LIMIT_SECONDS * RATE:
            chain = chain[1:]
        if len(chain) == 1:
            words = self.recognizer.transcribe(job.audio, final=True, timed=self.stitcher.needs_timing(job))
            text = self.stitcher.text(job, words)
            self.chain = [[job, text]] if revisable else []
            return [(job.id, text)]
        # Silence padding for the real gaps measured worse on EdAcc (20.7% vs 20.3% WER).
        bounds = np.cumsum([len(earlier.audio) for earlier, _ in chain[:-1]]) / RATE
        texts = [[] for _ in chain]
        for word in self.recognizer.transcribe(np.concatenate([j.audio for j, _ in chain]), timed=True):
            texts[sum(word.middle >= bound for bound in bounds)].append(word.text)
        before, text = " ".join(texts[-2]), " ".join(texts[-1])
        finals = []
        # Revise only a line that showed words, and never empty it.
        if before and chain[-2][1] and before != chain[-2][1]:
            finals.append((chain[-2][0].id, before))
            chain[-2][1] = before
        chain[-1][1] = text
        self.chain = chain
        return finals + [(job.id, text)]


def speed_check(args):
    """Time a 6 s interim update and a full decode of a known sample on this PC."""
    import wave
    with wave.open(args.check, "rb") as sample:  # 16 kHz, mono, 16-bit PCM
        audio = np.frombuffer(sample.readframes(sample.getnframes()), dtype="<i2").astype(np.float32) / 32768
    started = time.perf_counter()
    recognizer = Recognizer(args.engine, args.model, args.threads)
    load = time.perf_counter() - started
    recognizer.transcribe(audio[:RATE], final=False)  # warm-up
    started = time.perf_counter()
    recognizer.transcribe(audio[:6 * RATE], final=False)
    update = time.perf_counter() - started
    started = time.perf_counter()
    words = recognizer.transcribe(audio, final=True)
    emit("check", load_seconds=round(load, 2), update_seconds=round(update, 2),
         final_seconds=round(time.perf_counter() - started, 2), audio_seconds=round(len(audio) / RATE, 1),
         text=" ".join(w.text for w in words))
    return 0


def main():
    sys.addaudithook(forbid_network)
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--engine", choices=["parakeet", "whisper"], required=True)
    parser.add_argument("--capture")
    parser.add_argument("--device", default="")
    parser.add_argument("--threads", type=int, default=3)
    parser.add_argument("--check", help="speech sample to time recognition on this PC, then exit")
    args = parser.parse_args()
    if args.check:
        try:
            return speed_check(args)
        except Exception as error:
            emit("error", message=f"The speed check could not run: {str(error)[:200]}")
            return 1
    if not args.capture:
        parser.error("--capture is required")
    stop = threading.Event()
    child = None
    mailbox = Mailbox()
    failure = []

    def stop_capture():
        stop.set()
        if child is not None and child.poll() is None:
            try:
                child.stdin.write(b"stop\n")
                child.stdin.flush()
            except (OSError, ValueError):
                pass

    def read_commands():
        for line in sys.stdin:
            if line.strip() == "stop":
                break
        stop_capture()

    threading.Thread(target=read_commands, daemon=True).start()
    try:
        emit("status", message="Loading local English speech model…", state="starting")
        try:
            recognizer = Recognizer(args.engine, args.model, args.threads)
        except Exception as error:
            raise RuntimeError("The speech model could not be loaded; its files may be damaged. Download it again "
                               f"in Caption settings. ({str(error)[:160]})") from error
        gate = SpeechGate()
        if stop.is_set():
            return
        # A .py source is the test stand-in that streams a WAV file (file_capture.py).
        command = [sys.executable, args.capture] if args.capture.endswith(".py") else [args.capture]
        if args.device:
            command += ["--device", args.device]
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)

        def capture_events():
            for raw in child.stderr:
                try:
                    payload = json.loads(raw)
                    if payload.get("type") == "source":
                        emit("source", name=payload["name"])
                        emit("status", message="Listening · English · Offline", state="running")
                        emit("notice", message="")
                    elif payload.get("type") in ("capture-warning", "error"):
                        emit("status", message="Waiting for playback output…", state="waiting")
                        emit("notice", message=payload.get("message", "Playback device unavailable"))
                except (ValueError, UnicodeError):
                    pass

        threading.Thread(target=capture_events, daemon=True).start()

        def receive_audio():
            segmenter = Segmenter(mailbox.put, interval=1.2 if args.engine == "parakeet" else 2.0)
            pending = bytearray()
            meter_at = 0.0
            try:
                while not stop.is_set():
                    block = child.stdout.read(FRAME * 4)
                    if not block:
                        if not stop.is_set():
                            raise RuntimeError("System audio capture stopped unexpectedly.")
                        break
                    pending.extend(block)
                    while len(pending) >= FRAME * 4:
                        frame = np.frombuffer(bytes(pending[:FRAME * 4]), dtype="<f4").copy()
                        del pending[:FRAME * 4]
                        np.nan_to_num(frame, copy=False, nan=0, posinf=0, neginf=0)
                        np.clip(frame, -1, 1, out=frame)
                        probability = gate(frame)
                        segmenter.push(frame, probability)
                        if time.monotonic() - meter_at >= 0.2:
                            rms = float(np.sqrt(np.mean(frame * frame)))
                            emit("level", db=round(20 * np.log10(max(rms, 1e-5)), 1), speech=probability > 0.5)
                            meter_at = time.monotonic()
            except Exception as error:
                failure.append(str(error))
                stop_capture()
            finally:
                try:
                    segmenter.finish()
                except Exception as error:
                    failure.append(str(error))
                finally:
                    mailbox.close()

        capture_thread = threading.Thread(target=receive_audio, daemon=True)
        capture_thread.start()
        stitcher = Stitcher()
        finalize = Finalizer(recognizer, stitcher)
        last_partial = {}
        while True:
            job = mailbox.get()
            if job is None:
                break
            started = time.monotonic()
            if job.final:
                # Empty finals remove a rejected interim from the display;
                # a revision updates an earlier line if it is still shown.
                for phrase, text in finalize(job):
                    if phrase == job.id:
                        emit("final", id=phrase, text=text)
                    else:
                        emit("final", id=phrase, text=text, revision=True)
                last_partial.pop(job.id, None)
            else:
                words = recognizer.transcribe(job.audio, final=False, timed=stitcher.needs_timing(job))
                text = stitcher.text(job, words)
                if text != last_partial.get(job.id):
                    emit("partial", id=job.id, text=text)
                    last_partial[job.id] = text
            elapsed = time.monotonic() - started
            emit("metrics", processingMs=round(elapsed * 1000),
                 behindMs=round((time.monotonic() - job.created) * 1000))
        if failure:
            raise RuntimeError(failure[0])
    except Exception as error:
        emit("error", message=str(error))
        return 1
    finally:
        stop_capture()
        if child is not None:
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    emit("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
