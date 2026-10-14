"""Test stand-in for audio-capture.exe: streams a file at real-time pace.

Same protocol as the Rust helper: stdout carries f32 LE / 16 kHz / mono,
stderr carries JSON events, and "stop" or EOF on stdin ends it. After the file
it streams silence, as loopback does when playback goes idle. Usage (through
the worker): --capture file_capture.py --device <audio file>.
"""
import json
import sys
import threading
import time

import numpy as np
from faster_whisper.audio import decode_audio

RATE, BLOCK = 16000, 320  # 20 ms


def main():
    path = sys.argv[sys.argv.index("--device") + 1]
    audio = decode_audio(path, sampling_rate=RATE).astype("<f4")
    stop = threading.Event()

    def watch_stdin():
        for line in sys.stdin:
            if line.strip() == "stop":
                break
        stop.set()

    threading.Thread(target=watch_stdin, daemon=True).start()
    print(json.dumps({"type": "source", "name": f"File: {path.replace(chr(92), '/').rsplit('/', 1)[-1]}"}),
          file=sys.stderr, flush=True)
    silence = np.zeros(BLOCK, dtype="<f4").tobytes()
    started, sent = time.perf_counter(), 0
    try:
        while not stop.is_set():
            block = audio[sent:sent + BLOCK].tobytes() if sent < len(audio) else silence
            sys.stdout.buffer.write(block.ljust(BLOCK * 4, b"\0"))
            sys.stdout.buffer.flush()
            sent += BLOCK
            delay = started + sent / RATE - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
    except (BrokenPipeError, OSError):
        pass


if __name__ == "__main__":
    main()
