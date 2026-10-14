"""Bounded streaming segmentation, scheduling, and stitching, independent of the recognizer."""
from collections import deque
from dataclasses import dataclass
import re
import threading
import time

import numpy as np

RATE = 16000
FRAME = 512
FRAME_SECONDS = FRAME / RATE


@dataclass
class Word:
    text: str
    start: float  # seconds
    end: float

    @property
    def middle(self):
        return (self.start + self.end) / 2


@dataclass
class Job:
    id: int
    audio: np.ndarray
    final: bool
    start: int  # absolute sample index of audio[0]
    created: float
    split: int | None = None  # forced split: absolute sample where the next job starts

    @property
    def end(self):
        return self.start + len(self.audio)


class Mailbox:
    """Never queue obsolete partials. Preserve finals, with a finite backlog."""
    def __init__(self):
        self.condition = threading.Condition()
        self.finals = deque()
        self.partial = None
        self.closed = False

    def put(self, job):
        with self.condition:
            if job.final:
                if sum(len(j.audio) for j in self.finals) + len(job.audio) > RATE * 60:
                    raise RuntimeError("Captions cannot keep up with playback. Stop and choose a faster engine.")
                self.finals.append(job)
                if self.partial is not None and self.partial.id <= job.id:
                    self.partial = None
            else:
                self.partial = job
            self.condition.notify()

    def get(self):
        with self.condition:
            self.condition.wait_for(lambda: self.finals or self.partial is not None or self.closed)
            if self.finals:
                return self.finals.popleft()
            if self.partial is not None:
                job, self.partial = self.partial, None
                return job
            return None

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()


class Segmenter:
    """Keep 320 ms before speech and close a phrase after a pause.

    A phrase starts on one confident frame (speech probability >= 0.5) or on
    three moderate frames in a row (>= 0.3), so soft speech is not dropped; on
    the non-speech test file no frame scored above 0.15.
    The pause needed to close a phrase shrinks as it grows (640 ms, then 384 ms
    after 6 s, then 192 ms after 9 s), so long speech usually ends at a natural
    break. Speech still running at max_seconds is split at the quietest point
    of its last 3 s. Both sides share 1.6 s of audio centered there, and
    Stitcher picks the exact cut from word timings.
    """
    PREROLL = 10
    PAUSE_FRAMES = (20, 12, 6)  # pause that closes a phrase under 6 s, 6-9 s, over 9 s long
    SHARED = 25  # frames (800 ms) on each side of a forced split
    SPLIT_WINDOW = (94, 25)  # search 3.0 s .. 0.8 s before the limit

    def __init__(self, submit, interval=1.2, max_seconds=12):
        self.submit = submit
        self.interval = int(interval * RATE / FRAME)
        self.limit = int(max_seconds * RATE / FRAME)
        self.history = deque(maxlen=self.PREROLL)
        self.position = 0  # absolute index of the next frame
        self.last_end = None  # absolute index after the previous phrase's last frame
        self.moderate = 0  # consecutive frames >= 0.30 while no phrase is open
        self.id = 0
        self._reset()

    def _reset(self):
        self.frames, self.probabilities = [], []
        self.start = 0  # absolute index of frames[0]
        self.voiced = self.silence = self.last_partial = 0

    def push(self, frame, probability):
        index, self.position = self.position, self.position + 1
        self.history.append((frame.copy(), probability))
        voiced = probability >= 0.30
        if not self.frames:
            self.moderate = self.moderate + 1 if voiced else 0
            if probability < 0.50 and self.moderate < 3:
                return
            self.id += 1
            # The preroll never reaches into the previous phrase's audio.
            available = index + 1 - self.last_end if self.last_end is not None else len(self.history)
            preroll = min(self.PREROLL, len(self.history), available)
            recent = list(self.history)[-preroll:]
            self.frames, self.probabilities = [f for f, _ in recent], [p for _, p in recent]
            self.start = index + 1 - len(self.frames)
            self.voiced = min(self.moderate, preroll) - 1  # the run so far; this frame is added below
            self.moderate = 0
        else:
            self.frames.append(frame.copy())
            self.probabilities.append(probability)
        self.voiced += int(voiced)
        self.silence = 0 if voiced else self.silence + 1
        heard = self.position - self.start
        if self.silence >= self.PAUSE_FRAMES[0 if heard < 188 else 1 if heard < 282 else 2]:
            self.finish()
        elif len(self.frames) >= self.limit:
            self._split()
        elif voiced and self.voiced >= 5 and heard - self.last_partial >= self.interval:
            self._submit(final=False)
            self.last_partial = heard

    def _split(self):
        # Quietest point (3-frame average speech probability) in the search window.
        count = len(self.frames)
        low, high = max(count - self.SPLIT_WINDOW[0], self.SHARED + 1), count - self.SPLIT_WINDOW[1]
        p = np.convolve(self.probabilities, np.ones(3) / 3, mode="same")
        middle = low + int(np.argmin(p[low:high]))
        keep, carry = middle + self.SHARED, middle - self.SHARED
        self._submit(final=True, frames=keep, split=(self.start + carry) * FRAME)
        frames, probabilities = self.frames[carry:], self.probabilities[carry:]
        start, silence = self.start + carry, self.silence
        self.id += 1
        self._reset()
        self.frames, self.probabilities, self.start = frames, probabilities, start
        self.voiced = sum(p >= 0.30 for p in probabilities)
        self.silence = silence
        # Show the continuation at once; the cut removes it from the finished phrase.
        self._submit(final=False)
        self.last_partial = self.position - self.start

    def _submit(self, final, frames=None, split=None):
        self.submit(Job(self.id, np.concatenate(self.frames[:frames]), final, self.start * FRAME,
                        time.monotonic(), split=split))

    def finish(self):
        if self.frames and self.voiced >= 5:
            self._submit(final=True)
            self.last_end = self.start + len(self.frames)
        self._reset()


def choose_cut(words, low, high):
    """Choose the time (seconds) where a forced split ends.

    `low`..`high` is the audio both sides decoded. Prefer the longest pause
    between two words inside it, near its center, so that neither side's
    edge, where recognition is least reliable, decides a word.
    """
    center = (low + high) / 2
    best = None
    for a, b in zip(words, words[1:]):
        gap = (a.end + b.start) / 2
        if low <= gap <= high:
            score = (b.start - a.end) - 0.25 * abs(gap - center)
            if best is None or score > best[0]:
                best = (score, gap)
    if best is not None:
        return best[1]
    # No word boundary inside: silence, or a single word spanning the shared audio.
    inside = [w for w in words if w.end > low and w.start < high]
    if not inside:
        return low
    return inside[0].start if inside[0].middle >= center else inside[-1].end


def spelling(text):
    return re.sub(r"[^\w']", "", text).casefold()


class Stitcher:
    """Turn recognized words into caption text without repeating shared audio.

    Audio shared across a forced split is decoded twice. The finished phrase
    ends at a cut chosen from its word timings. The two decodes can place the
    same word a frame or two (80 ms each) apart, so the continuation resumes
    after the finished phrase's last word, found by spelling within 0.35 s of
    its time, and falls back to the time cut alone. A genuine repetition is a
    separate word at a later time, so it is kept.
    """
    MATCH_SECONDS = 0.35

    def __init__(self):
        self.committed = 0.0  # seconds; earlier words already appeared in a final
        self.last = None  # last word shown before the most recent forced split

    def needs_timing(self, job):
        return job.start < self.committed * RATE or (job.final and job.split is not None)

    def text(self, job, words):
        offset = job.start / RATE
        words = [Word(w.text, w.start + offset, w.end + offset) for w in words]
        shown = [w for w in words if w.middle >= self.committed]
        if self.last is not None and job.start < self.committed * RATE:
            near = [i for i, w in enumerate(words) if spelling(w.text) == spelling(self.last.text)
                    and abs(w.start - self.last.start) <= self.MATCH_SECONDS]
            if near:
                shown = words[min(near, key=lambda i: abs(words[i].start - self.last.start)) + 1:]
        if job.final and job.split is not None:
            cut = max(choose_cut(words, job.split / RATE, job.end / RATE), self.committed)
            shown = [w for w in shown if w.middle < cut]
            self.committed, self.last = cut, (shown[-1] if shown else None)
        return " ".join(w.text for w in shown)
