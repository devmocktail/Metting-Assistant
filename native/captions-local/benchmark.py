"""Reproducible local speed/quality check on user-supplied, non-confidential WAV files."""
import argparse
import json
import socket
import time

import numpy as np
from faster_whisper.audio import decode_audio
from worker import Recognizer, SpeechGate


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", required=True, choices=["parakeet", "whisper"])
    parser.add_argument("--model", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--threads", type=int, default=6)
    args = parser.parse_args()

    def offline_only(*args, **kwargs):
        raise AssertionError("Network access attempted during offline recognition")

    socket.socket.connect = offline_only
    socket.socket.connect_ex = offline_only
    socket.create_connection = offline_only
    socket.getaddrinfo = offline_only
    audio = decode_audio(args.audio, sampling_rate=16000)
    started = time.perf_counter()
    recognizer = Recognizer(args.engine, args.model, args.threads)
    load_seconds = time.perf_counter() - started
    results = []
    for final, seconds in [(False, 3), (True, len(audio) / 16000)]:
        sample = audio[:int(seconds * 16000)]
        started = time.perf_counter()
        text = recognizer.transcribe(sample, final=final)
        elapsed = time.perf_counter() - started
        results.append({"final": final, "audio_seconds": len(sample) / 16000,
                        "processing_seconds": round(elapsed, 3), "text": text})
    gate = SpeechGate()
    silent_probability = max(gate(np.zeros(512, dtype=np.float32)) for _ in range(100))
    print(json.dumps({"engine": args.engine, "model": args.model, "threads": args.threads,
                      "load_seconds": round(load_seconds, 3), "network_connections_allowed": False,
                      "silence_max_speech_probability": silent_probability, "results": results}, indent=2))


if __name__ == "__main__":
    main()
