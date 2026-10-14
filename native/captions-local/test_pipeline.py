import threading
import unittest
import numpy as np
from pipeline import FRAME, RATE, Job, Mailbox, Segmenter, Stitcher, Word, choose_cut
from worker import Finalizer


def feed(segmenter, probabilities):
    """Push frames whose samples equal their absolute frame index."""
    for p in probabilities:
        segmenter.push(np.full(FRAME, segmenter.position, dtype=np.float32), p)


def frame_of(job, offset=0):
    return int(job.audio[offset * FRAME])


def words(*items, offset=0.0):
    return [Word(text, start - offset, end - offset) for text, start, end in items]


def job(final, start, seconds, split=None):
    start, length = int(start * RATE), int(seconds * RATE)
    return Job(1, np.zeros(length, dtype=np.float32), final, start, 0,
               split=None if split is None else int(split * RATE))


class SegmenterTests(unittest.TestCase):
    def test_silence_never_reaches_recognizer(self):
        jobs = []
        segmenter = Segmenter(jobs.append)
        feed(segmenter, [0.01] * 1000)
        segmenter.finish()
        self.assertEqual(jobs, [])

    def test_keeps_initial_audio_and_finalizes_once_after_pause(self):
        jobs = []
        segmenter = Segmenter(jobs.append)
        feed(segmenter, [0.01] * 20 + [0.9] * 60 + [0.01] * 21)
        segmenter.finish()
        finals = [j for j in jobs if j.final]
        self.assertEqual(len(finals), 1)
        self.assertEqual(frame_of(finals[0]), 11)  # 320 ms preroll, including the first voiced frame
        self.assertIsNone(finals[0].split)
        self.assertTrue(any(not j.final for j in jobs))

    def test_soft_speech_starts_a_phrase_after_three_moderate_frames(self):
        jobs = []
        segmenter = Segmenter(jobs.append)
        # Measured on a soft-spoken opening that one-frame starts (>= 0.5) missed.
        feed(segmenter, [0.01] * 5 + [0.47, 0.32, 0.35, 0.32, 0.28, 0.36, 0.32] + [0.01] * 30)
        finals = [j for j in jobs if j.final]
        self.assertEqual(len(finals), 1)
        self.assertEqual(frame_of(finals[0]), 0)  # the preroll reaches back to the soft onset

    def test_isolated_moderate_frames_do_not_start_a_phrase(self):
        jobs = []
        segmenter = Segmenter(jobs.append)
        feed(segmenter, ([0.35, 0.35, 0.1] * 20) + [0.01] * 30)
        self.assertEqual(jobs, [])

    def test_short_pauses_do_not_end_a_young_phrase(self):
        jobs = []
        segmenter = Segmenter(jobs.append)
        feed(segmenter, ([0.9] * 30 + [0.05] * 12) * 4 + [0.05] * 20)
        self.assertEqual(len([j for j in jobs if j.final]), 1)

    def test_long_phrases_end_at_shorter_pauses(self):
        jobs = []
        segmenter = Segmenter(jobs.append)
        feed(segmenter, [0.9] * 200 + [0.05] * 12 + [0.9] * 100 + [0.05] * 6 + [0.9] * 40 + [0.05] * 20)
        finals = [j for j in jobs if j.final]
        self.assertEqual(len(finals), 2)
        self.assertEqual(len(finals[0].audio), 212 * FRAME)  # 6.4 s of speech then 384 ms
        self.assertTrue(all(j.split is None for j in finals))

    def test_continuous_speech_splits_at_the_quietest_point(self):
        jobs = []
        segmenter = Segmenter(jobs.append)
        probabilities = [0.95] * 500
        probabilities[300:303] = [0.2, 0.1, 0.2]  # a brief dip, too short to end the phrase
        feed(segmenter, probabilities)
        segmenter.finish()
        finals = [j for j in jobs if j.final]
        self.assertEqual(len(finals), 2)
        first, second = finals
        self.assertEqual(first.split, (301 - Segmenter.SHARED) * FRAME)
        self.assertEqual(first.end, (301 + Segmenter.SHARED) * FRAME)
        self.assertEqual(second.start, first.split)  # 1.6 s decoded by both
        self.assertEqual(frame_of(second), 301 - Segmenter.SHARED)
        self.assertTrue(all(len(j.audio) <= 12 * RATE for j in jobs))
        # The continuation is shown at once instead of waiting for the next interval.
        after_split = jobs[next(i for i, j in enumerate(jobs) if j is first) + 1]
        self.assertFalse(after_split.final)
        self.assertEqual(after_split.start, first.split)

    def test_split_without_any_dip_stays_in_the_search_window(self):
        jobs = []
        segmenter = Segmenter(jobs.append)
        feed(segmenter, [0.95] * 400)
        first = next(j for j in jobs if j.final)
        self.assertIsNotNone(first.split)
        self.assertLessEqual(first.end, 12 * RATE)
        self.assertGreaterEqual(first.split, (375 - 94 - Segmenter.SHARED) * FRAME)

    def test_preroll_never_reuses_previous_phrase(self):
        jobs = []
        segmenter = Segmenter(jobs.append)
        feed(segmenter, [0.9] * 30 + [0.05] * 20 + [0.05] * 3 + [0.9] * 30 + [0.05] * 20)
        finals = [j for j in jobs if j.final]
        self.assertEqual(finals[0].end, 50 * FRAME)
        self.assertEqual(finals[1].start, 50 * FRAME)



class StitchingTests(unittest.TestCase):
    def test_sentence_across_a_forced_split_appears_once(self):
        stitcher = Stitcher()
        # Shared audio 9.6..11.2 s. The two sides disagree about words near their edges.
        first = job(True, 0, 11.2, split=9.6)
        text = stitcher.text(first, words(("we", 8.8, 9.0), ("will", 9.1, 9.3), ("discuss", 9.4, 9.9),
                                          ("the", 10.2, 10.3), ("pricing", 10.35, 10.8), ("tom-", 10.9, 11.2)))
        self.assertEqual(text, "we will discuss")
        second = job(True, 9.6, 3.0)
        text = stitcher.text(second, words(("discussed", 9.6, 9.9), ("the", 10.2, 10.3), ("pricing,", 10.35, 10.8),
                                           ("tomorrow.", 10.9, 11.5), offset=9.6))
        self.assertEqual(text, "the pricing, tomorrow.")

    def test_word_cut_by_the_split_comes_from_the_side_that_heard_it_whole(self):
        stitcher = Stitcher()
        first = job(True, 0, 11.2, split=9.6)
        # One word fills the shared audio up to the edge; the earlier pause is outside it.
        self.assertEqual(stitcher.text(first, words(("ask", 9.0, 9.3), ("Americ-", 9.62, 11.2))), "ask")
        self.assertEqual(stitcher.text(job(False, 9.6, 2.0), words(("Americans,", 9.62, 10.4), offset=9.6)),
                         "Americans,")

    def test_genuine_repetition_across_a_split_survives(self):
        stitcher = Stitcher()
        first = job(True, 0, 11.2, split=9.6)
        self.assertEqual(stitcher.text(first, words(("This", 9.0, 9.2), ("is", 9.3, 9.4), ("very,", 9.5, 9.9),
                                                    ("very", 10.3, 10.7), ("impor-", 10.8, 11.2))), "This is very,")
        second = job(True, 9.6, 2.5)
        self.assertEqual(stitcher.text(second, words(("very,", 9.6, 9.9), ("very", 10.3, 10.7),
                                                     ("important.", 10.8, 11.5), offset=9.6)), "very important.")

    # Timings below are from Parakeet decoding a forced split of continuous speech:
    # the continuation placed the same words 0.10-0.15 s later than the first decode.
    SPLIT_DECODE = (("important", 3.44, 3.68), ("for", 3.68, 3.92), ("everyone", 3.92, 4.40), ("on", 4.40, 4.56),
                    ("the", 4.56, 4.72), ("call", 4.72, 4.88), ("because.", 4.96, 5.12))

    def continuation(self, shift):
        stitcher = Stitcher()
        self.assertEqual(stitcher.text(job(True, 0, 5.3, split=3.7), words(*self.SPLIT_DECODE)),
                         "important for everyone on")
        later = [(t, s + shift, e + shift) for t, s, e in (("For", 3.76, 4.0), ("everyone", 3.92, 4.4),
                 ("on", 4.40, 4.56), ("the", 4.56, 4.72), ("call,", 4.72, 4.88), ("because", 4.96, 5.2),
                 ("the", 5.2, 5.36), ("customer", 5.36, 5.9))]
        return stitcher.text(job(False, 3.7, 2.5), words(*later, offset=3.7))

    def test_continuation_decoded_late_does_not_repeat_a_word(self):
        self.assertEqual(self.continuation(+0.12), "the call, because the customer")

    def test_continuation_decoded_early_does_not_lose_a_word(self):
        self.assertEqual(self.continuation(-0.12), "the call, because the customer")

    def test_unmatched_continuation_falls_back_to_the_time_cut(self):
        stitcher = Stitcher()
        stitcher.text(job(True, 0, 5.3, split=3.7), words(*self.SPLIT_DECODE))
        text = stitcher.text(job(False, 3.7, 2.5), words(("one", 4.40, 4.56), ("the", 4.60, 4.72),
                                                         ("call", 4.75, 4.88), offset=3.7))
        self.assertEqual(text, "the call")

    def test_repetition_inside_a_phrase_is_untouched(self):
        self.assertEqual(Stitcher().text(job(True, 0, 3), words(("very,", 0.5, 0.9), ("very", 1.0, 1.3),
                                                                 ("important.", 1.4, 2.0))), "very, very important.")

    def test_cut_prefers_the_longest_pause_inside_shared_audio(self):
        candidates = [Word("a", 0.0, 1.0), Word("b", 1.05, 1.5), Word("c", 1.9, 2.2), Word("d", 2.25, 3.0)]
        self.assertAlmostEqual(choose_cut(candidates, 1.0, 2.6), 1.7)

    def test_cut_without_words_in_shared_audio_gives_it_to_the_next_phrase(self):
        self.assertEqual(choose_cut([Word("done.", 0.0, 0.8)], 1.0, 2.6), 1.0)
        self.assertEqual(choose_cut([], 1.0, 2.6), 1.0)

    def test_timing_requested_only_when_stitching_needs_it(self):
        stitcher = Stitcher()
        self.assertFalse(stitcher.needs_timing(job(False, 0, 3)))
        self.assertTrue(stitcher.needs_timing(job(True, 0, 11, split=9.6)))
        stitcher.text(job(True, 0, 11, split=9.6), words(("a", 9.0, 9.5), ("b", 10.0, 10.5)))
        self.assertTrue(stitcher.needs_timing(job(False, 9.6, 2)))  # cut at 9.75 s
        # Nothing heard in the shared audio: the cut is the next job's start, so nothing to drop.
        stitcher = Stitcher()
        stitcher.text(job(True, 0, 11, split=9.6), [])
        self.assertFalse(stitcher.needs_timing(job(False, 9.6, 2)))
        self.assertFalse(stitcher.needs_timing(job(False, 30, 2)))


class FakeRecognizer:
    """Words are runs of one sample value (an index into WORDS). Like a real model
    missing context, the first word of any decode reads 'word?' and the last 'word!'."""
    WORDS = ["", "good", "morning", "world", "peace"]

    def __init__(self, engine="parakeet"):
        self.engine = engine
        self.lengths = []

    def transcribe(self, audio, final=True, timed=False):
        self.lengths.append(len(audio))
        found, i = [], 0
        while i < len(audio):
            j = i + 1
            while j < len(audio) and audio[j] == audio[i]:
                j += 1
            if audio[i]:
                found.append(Word(self.WORDS[int(audio[i])], i / RATE, j / RATE))
            i = j
        if found:
            found[0].text += "?"
            found[-1].text += "!"
        return found


def phrase(id, start, *word_values, split=None):
    """A final job: 0.2 s silence, then 0.4 s per word with 0.1 s between, then 0.3 s."""
    parts = [np.zeros(int(0.2 * RATE))]
    for value in word_values:
        parts += [np.full(int(0.4 * RATE), value), np.zeros(int(0.1 * RATE))]
    parts.append(np.zeros(int(0.2 * RATE)))
    return Job(id, np.concatenate(parts).astype(np.float32), True, int(start * RATE), 0,
               split=None if split is None else int(split * RATE))


class FinalizerTests(unittest.TestCase):
    def test_close_phrases_are_decoded_together_and_the_earlier_one_is_revised(self):
        finalize = Finalizer(FakeRecognizer(), Stitcher())
        first = phrase(1, 0, 1, 2)
        self.assertEqual(finalize(first), [(1, "good? morning!")])
        second = phrase(2, first.end / RATE + 1.0, 3, 4)
        self.assertEqual(finalize(second), [(1, "good? morning"), (2, "world peace!")])

    def test_distant_phrases_are_decoded_alone(self):
        finalize = Finalizer(FakeRecognizer(), Stitcher())
        first = phrase(1, 0, 1, 2)
        finalize(first)
        self.assertEqual(finalize(phrase(2, first.end / RATE + 2.5, 3, 4)), [(2, "world? peace!")])

    def test_revision_can_be_disabled(self):
        finalize = Finalizer(FakeRecognizer(), Stitcher(), revise=False)
        first = phrase(1, 0, 1, 2)
        finalize(first)
        self.assertEqual(finalize(phrase(2, first.end / RATE + 1.0, 3, 4)), [(2, "world? peace!")])

    def test_whisper_phrases_are_decoded_alone(self):
        finalize = Finalizer(FakeRecognizer(engine="whisper"), Stitcher())
        first = phrase(1, 0, 1, 2)
        finalize(first)
        self.assertEqual(finalize(phrase(2, first.end / RATE + 1.0, 3, 4)), [(2, "world? peace!")])

    def test_a_revised_phrase_keeps_context_on_both_sides(self):
        finalize = Finalizer(FakeRecognizer(), Stitcher())
        first = phrase(1, 0, 1)  # one word: alone it reads "good?!"
        finalize(first)
        second = phrase(2, first.end / RATE + 0.5, 3)
        self.assertEqual(finalize(second), [(1, "good?"), (2, "world!")])
        third = phrase(3, second.end / RATE + 0.5, 4)
        # Decoded with phrases 1 and 2, so phrase 2 is no longer at either edge.
        self.assertEqual(finalize(third), [(2, "world"), (3, "peace!")])

    def test_context_is_limited_to_twelve_seconds(self):
        recognizer = FakeRecognizer()
        finalize = Finalizer(recognizer, Stitcher())
        jobs, start = [], 0.0
        for i, value in enumerate((1, 2, 3), 1):  # 5 s phrases, 0.5 s apart: three span 16 s
            job = phrase(i, start, value)
            job.audio = np.concatenate((job.audio, np.zeros(int(5 * RATE) - len(job.audio), dtype=np.float32)))
            jobs.append(job)
            start = job.end / RATE + 0.5
        for job in jobs:
            finalize(job)
        second, third = jobs[1], jobs[2]
        self.assertEqual(recognizer.lengths[-1], len(second.audio) + len(third.audio))  # the first was dropped

    def test_a_phrase_that_showed_nothing_is_not_revised(self):
        class ContextOnly(FakeRecognizer):
            def transcribe(self, audio, final=True, timed=False):  # hears nothing in very short audio
                return super().transcribe(audio, final, timed) if len(audio) >= 1.5 * RATE else []
        finalize = Finalizer(ContextOnly(), Stitcher())
        first = phrase(1, 0, 1)
        self.assertEqual(finalize(first), [(1, "")])
        self.assertEqual(finalize(phrase(2, first.end / RATE + 0.5, 3, 4)), [(2, "world peace!")])

    def test_forced_split_continuations_are_not_joined(self):
        recognizer = FakeRecognizer()
        finalize = Finalizer(recognizer, Stitcher())
        split = phrase(1, 0, 1, 2, split=0.6)
        finalize(split)
        continuation = phrase(2, 0.6, 3)
        finalize(continuation)
        later = phrase(3, continuation.end / RATE + 0.5, 4)
        finalize(later)
        self.assertEqual(recognizer.lengths[-1], len(later.audio))  # decoded alone


class MailboxTests(unittest.TestCase):
    def test_backlog_coalesces_interims_and_preserves_finals(self):
        box = Mailbox()
        audio = np.zeros(FRAME, dtype=np.float32)
        box.put(Job(1, audio, False, 0, 0))
        box.put(Job(1, audio, False, 0, 1))
        box.put(Job(1, audio, True, 0, 2))
        box.put(Job(2, audio, False, 0, 3))
        box.close()
        self.assertTrue(box.get().final)
        self.assertEqual(box.get().id, 2)
        self.assertIsNone(box.get())

    def test_overload_is_explicit(self):
        box = Mailbox()
        with self.assertRaisesRegex(RuntimeError, 'cannot keep up'):
            box.put(Job(1, np.zeros(61 * RATE, dtype=np.float32), True, 0, 0))

    def test_close_wakes_waiting_decoder(self):
        box = Mailbox()
        result = []
        thread = threading.Thread(target=lambda: result.append(box.get()))
        thread.start()
        box.close()
        thread.join(timeout=1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, [None])


if __name__ == '__main__':
    unittest.main()
