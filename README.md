# Private Meeting Assistant

An always-on-top Electron overlay with a live Google Docs view and local English captions for audio played by Windows. AI assistance remains a placeholder.

## Run

```powershell
npm install
npm start
```

## Install on another PC

Build one installer on a development PC (after the *Install once* setup below):

```powershell
.venv-captions\Scripts\python.exe -m pip install -r native\captions-local\requirements-build.txt
npm run dist
```

This writes `dist\A2solveX-Meeting-Assistant-Setup-<version>.exe`. Copy it to the other PC and run it; it needs 64-bit Windows 10 2004 or later and no Python, Rust, or Node. The installer bundles the app, the audio capture helper, and the speech recognizer frozen with PyInstaller. It installs per user (no administrator rights), with Start menu and desktop shortcuts and an uninstaller. It is not code-signed, so Windows SmartScreen shows *Windows protected your PC* the first time: choose **More info → Run anyway**.

Speech models are not in the installer. On first use, **Captions → Caption settings** lists them best first, with a suggestion for that PC (from its memory, processor threads, and architecture). **Download** fetches the pinned files from Hugging Face, resumes if interrupted, checks free disk space, and verifies every file's SHA-256. A speed check on a bundled 11-second public-domain sample (President Kennedy's 1961 inaugural address) then reports whether captions will keep up on that PC. Models are stored in `%APPDATA%\private-meeting-overlay\models`; the uninstaller leaves them, so delete that folder to reclaim the space.

## Local English captions

**No subscription, API key, cloud transcription, or per-minute fees.** Recognition uses downloaded machine-learning models on this PC. Installation needs internet; captioning afterwards does not. Google Docs still needs its normal internet connection.

The default is **NVIDIA Parakeet TDT 0.6B v2**, using a quantized ONNX export and sherpa-onnx on the CPU. It is designed for English, including varied speakers; accuracy still depends on the accent, recording, vocabulary, and background noise. Whisper Small and Whisper Large v3 Turbo are optional alternatives. Whisper always processes a 30-second window, so every update costs the same however short the phrase: about 2 s for Small and about 9 s for Turbo on the test laptop (Core i5-12500H). Turbo is slower than live speech there and falls behind. There is no cloud fallback.

### Install once

Prerequisites: Windows, Node.js, Python 3.11, Rust stable, and Visual Studio C++ Build Tools. From this project directory:

```powershell
npm install
npm run build:captions
npm run setup:captions-local
npm start
```

Setup creates `.venv-captions` and installs Parakeet under `%APPDATA%\private-meeting-overlay\models\parakeet-en`. Downloads are hundreds of MB; optional larger models need more disk space. Each model is pinned to the revision evaluated with this app. Interrupted downloads resume automatically, and every file is checked against the size and SHA-256 published by Hugging Face before `installation.json` records the repository, revision, and hashes. Runtime versions are pinned in `native/captions-local/requirements-lock.txt`.

> **Packaged terminals and agents.** When setup or the app is launched from inside a packaged (MSIX) desktop app, Windows can silently redirect `%APPDATA%` writes into that app's private folder (`%LOCALAPPDATA%\Packages\<app>\LocalCache\Roaming`). Models installed that way are invisible when the overlay is started normally. If captions report missing models after setup, look there and copy the `models` folder to `%APPDATA%\private-meeting-overlay\`.

Optional engines:

```powershell
npm run setup:captions-local -- -Model small
npm run setup:captions-local -- -Model large-v3-turbo
```

Restart after installing a model. Open **Captions** (`Ctrl+2`), choose **Caption settings** if needed, then **Start captions**. Stop captions before changing settings. System default follows output device changes; selecting a specific output keeps capture on that device.

### Audio and caption flow

1. A Rust helper uses WASAPI loopback on the selected playback output.
2. Windows converts audio to mono 16 kHz float samples. No microphone is opened.
3. Local Silero voice activity detection starts a phrase on one confident frame or on three moderate frames in a row (so soft speech is not dropped), keeps 320 ms before speech, and closes a phrase after a pause. The pause needed shrinks as a phrase grows (640 ms, then 384 ms after 6 s, then 192 ms after 9 s), so long speech usually ends at a natural break.
4. Speech still running at 12 seconds is split at the quietest point of its last 3 seconds. Both sides decode 1.6 s of shared audio. The finished phrase ends at a pause between words chosen from word timings, and the continuation resumes after that phrase's last word, matched by spelling and time. Words are never deduplicated by spelling alone, so genuine repetitions ("very, very important") are kept.
5. A local worker produces revisable interim captions and final phrases. Obsolete interim work is discarded; final phrases have a bounded queue. Delays and capture failures are shown in the overlay.
6. A phrase decoded on its own loses the words around it. With Parakeet, while phrases follow each other within 2 s, each finished phrase is decoded together with the phrases before it (up to 12 s), so it is recognized with its left context; the previous phrase, which now has context on both sides, is updated once if its words changed (only while it is still shown). Whisper decodes each phrase alone, because the longer joint audio sent it into a repetition loop in testing, and Whisper output that repeats itself (compression ratio above 2.4) is dropped.
7. Captioning continues while changing tabs or using compact mode. If the selected output disappears (for example, a headset is unplugged), captions show *Waiting for playback output* and resume when it returns; *System default* follows Windows to the new default. Stopping or closing the app shuts down the recognizer and capture helper, and both also exit on their own if the app is killed.

Captured audio stays in memory and is not recorded to files. Transcript text stays in the renderer, is capped at 100 visible phrases, and can be cleared. Workers only load local model paths with offline flags, and the worker process refuses network access at runtime: a Python audit hook makes any attempt to connect, bind, send, or resolve a host name raise an error. Download code runs only during explicit setup.

This captures **the selected output endpoint**, not every Windows output device at once. Audio routed to another device must be selected in Caption settings. Protected media, overlapping speakers, names, and very noisy audio can be difficult or unavailable. This is phrase-based recognition, not a guarantee of Windows Live Captions accuracy or zero latency. No Windows language-pack files are reused.

### Measured on the test laptop

Core i5-12500H, 16 GB RAM, CPU only, 6 inference threads. Other hardware will differ. Raw results are written to the ignored `artifacts/captions/` folder by the tools listed under *Development checks*.

**Time per update** (JFK speech sample, median of three):

| Engine | 1.5 s of audio | 6 s | 11 s | Model load | Peak memory |
|---|---|---|---|---|---|
| Parakeet (default) | 0.25 s | 0.66 s | 0.94 s | 2.8 s | 0.8 GB |
| Whisper Small | 2.0 s | 2.1 s | 2.5 s | 1.8 s | 0.7 GB |
| Whisper Turbo | 9.0 s | 9.0 s | 9.2 s | 5.7 s | 1.9 GB |

On read-aloud accent samples, Turbo needed 1.38 s of processing per second of speech in the app's segmentation, so it cannot keep up live on this laptop.

These times were measured with 6 inference threads. The app uses 3: on this hybrid CPU, 3 threads decoded as fast as 6 (Parakeet 836 vs 797 ms for 8 s of audio; Whisper Small 3.0 vs 3.2 s per update, both on battery) while using about 60% less CPU (Parakeet 377% vs 904% of one core under repeated interim decoding).

**Accented conversation (EdAcc).** 192 utterances (48 speakers, 17 accent groups, 29 minutes) from the test split of the [Edinburgh International Accents of English Corpus](https://huggingface.co/datasets/edinburghcstr/edacc), recorded over video calls with human transcripts, at least four words each, 6–20 per accent. Five groups have a single speaker. The transcripts are verbatim (every "uh", restart, and repetition), so every engine scores far worse here than on clean benchmarks; compare engines and settings with each other, not with published numbers. Word error rate after normalizing case, punctuation, numbers, and fillers:

| Accent | Speakers | Words | Handed-over pipeline | Final pipeline | Whole utterance (offline) |
|---|---|---|---|---|---|
| Mainstream US English | 8 | 713 | 17.4% | 16.7% | 15.3% |
| Nigerian English | 5 | 608 | 24.5% | 23.5% | 24.2% |
| Vietnamese | 6 | 489 | 28.2% | 23.7% | 22.9% |
| Kenyan English | 2 | 402 | 23.6% | 21.6% | 20.1% |
| Indian English | 2 | 275 | 12.4% | 12.4% | 12.4% |
| Spanish | 5 | 268 | 32.8% | 29.1% | 26.1% |
| Chinese | 2 | 233 | 11.6% | 9.4% | 9.4% |
| Italian | 1 | 205 | 8.8% | 8.3% | 7.3% |
| Lithuanian | 2 | 164 | 28.0% | 25.6% | 15.9% |
| Irish English | 3 | 139 | 15.8% | 15.1% | 14.4% |
| Jamaican English | 4 | 122 | 11.5% | 11.5% | 12.3% |
| Romanian | 1 | 122 | 16.4% | 18.9% | 13.9% |
| Southern British English | 2 | 105 | 18.1% | 15.2% | 15.2% |
| Scottish English | 2 | 94 | 20.2% | 20.2% | 19.1% |
| Israeli | 1 | 71 | 35.2% | 32.4% | 31.0% |
| Indonesian | 1 | 60 | 31.7% | 26.7% | 25.0% |
| Ghanain English | 1 | 56 | 30.4% | 30.4% | 30.4% |
| **All (192 utterances)** | 48 | 4126 | **21.2%** | **19.6%** | **18.3%** |

Parakeet throughout. *Handed-over pipeline* is the segmentation and overlap removal this app used before (fixed 640 ms pause, hard split at 12 s, exact-word overlap removal), run on the same audio. *Final pipeline* is the current app: it was better on 35 utterances and worse on 14, with substitutions down from 9.1% to 7.4% of words and deletions up from 9.3% to 10.1% (with more context, the model writes fewer of the transcripts' verbatim restarts). *Whole utterance* decodes each recording in one piece, which live captions cannot do; it shows how much the phrase-by-phrase approach still costs. Variants measured on the same 192 utterances and not shipped: restoring a fixed 640 ms pause (19.7–20.1%), and padding joined phrases with the real silence between them (20.1%).

**Parakeet or Whisper Small?** On a balanced subset of 68 of those utterances (four per accent group, 17 groups, 40 speakers), both through the app's live pipeline: Parakeet 17.8% and Whisper Small 26.2% WER; Parakeet was better on 38 utterances and worse on 9. On the four read-aloud samples (reading-prompt references, where speakers' own deviations count as errors) the two were close (Parakeet 6.9%, Whisper Small 4.7% with the earlier pipeline); four speakers are too few to rank engines. Whisper Large v3 Turbo was not run on EdAcc: it cannot keep up live on this laptop.

**Live delay and a 14-minute session.** `live_check.py` streamed 14.3 minutes of continuous speech (the read-aloud accent samples, JFK, and synthetic passages, joined with 0.8 s pauses) through the real worker at real-time pace, with Parakeet, 3 threads, on battery power:

| Measure | Result |
|---|---|
| First caption after speech starts | median 1.0 s, 90% within 1.2 s, slowest 1.4 s |
| Final text after speech ends | median 1.5 s, 90% within 3.9 s |
| Processing lag, first half vs second half | 0.65 s vs 0.66 s (no build-up) |
| CPU | about 3.1 cores of 16, steady throughout |
| Memory | 1.0 GB, steady |
| Phrases captioned | 123 of 123; 16 earlier lines revised |

The first-caption figures leave out the 26 continuations after forced splits, whose opening words were already showing in the previous line. With 6 threads the same session used about 7 cores. Whisper Small on the first 3 minutes of the same audio, also on battery: first caption median 7.3 s, final text median 5.9 s after speech ends, about 2.9 cores; it kept up (no build-up) but runs several seconds behind Parakeet.

**Phrase boundaries.** Forced splits are uncommon in conversation: 18 among 393 phrases in 29 minutes of EdAcc speech. `boundary_check.py` forced a split at every half second of 11 clips and compared the stitched text with one whole-clip decode by Parakeet, counting differences within four words of the split:

| | Splits with a boundary difference | Words |
|---|---|---|
| Previous method (640 ms overlap, exact-word removal) | 108 of 401 | 270 |
| Current method | 31 of 401 | 42 |

On five voices reading a passage with "very very" and "please please" the current method had no boundary difference at any of 144 positions and kept every repetition (the previous method had 23). Most remaining differences are on two accented speakers' hesitant recordings and are one-word recognition changes near the split ("slips"/"slip", "her"/"here"), or disagreement about a speaker's own restart ("fresh snow… fresh snow peas"); a word fragment can occasionally repeat ("Wednesday day"). Whisper can also drop a repeated word on its own: one Whisper Small continuation wrote "so please make" for "so please please make", although the stitching resumed at the right word.

**Quiet speech, noise, and overlapping speakers** (Parakeet, final pipeline, eight clips: four read-aloud accent samples, JFK, three synthetic passages):

| Condition | WER |
|---|---|
| Clean | 4.9% |
| Speaker 20 dB / 35 dB quieter | 4.9% / 6.0% |
| Pink noise at 20 / 10 / 5 dB SNR | 4.7% / 7.7% / 9.7% |
| Another speaker 10 dB below | 9.4% |
| Another speaker nearly as loud (−3 dB) | 47.6% |

Overlapping speech at similar volume is not separated: words from both speakers are captioned together. The 4.9% clean figure includes number formatting that normalization does not reconcile ("4.30" for "four thirty").

**Nothing captioned without speech.** 100 seconds of silence, noise, tones, synthetic music, clicks, and 40 Windows system sounds produced no caption from Parakeet or Whisper Small through the live worker. The voice detector's highest score on that audio was 0.15, below the 0.3 needed to start a phrase. While listening to it, the Parakeet worker used about 3% of one CPU core and 0.8 GB of memory.

**Lifecycle.** All nine cases in `lifecycle-captions.cjs` pass, including a worker crash, a capture crash, the parent process being killed, and stopping while a model loads (3–4 s, the rest of the load); no worker or capture process remains afterwards.

**Network.** Inside the worker, DNS lookups, TCP connections, UDP sends, HTTPS requests, and binding a port were each refused by the runtime audit hook. During live checks, `netstat` showed no TCP or UDP endpoint owned by the worker's processes. `audio-capture.exe` imports no networking library (only kernel, COM/audio, and C runtime DLLs). The network adapter itself was not disconnected for these tests.

### Development checks

```powershell
npm run build:captions
npm run test:captions            # unit tests, no models needed
npm run test:captions-lifecycle  # caption service lifecycle, no audio
npm run test:captions-smoke      # plays artifacts/captions/jfk.wav aloud
```

- **Unit tests** cover segmentation (pauses, long speech, split points, preroll), stitching across forced splits (late and early word timings, genuine repetitions, disagreeing decodes), and the job queue. No models needed.
- **`lifecycle-captions.cjs`** exercises the caption service without the UI or audio: missing and corrupt models, stopping while a model loads, an unavailable output, worker and capture crashes, and the parent process being killed. After each case no worker, interpreter, or capture process may remain. Results: `artifacts/captions/lifecycle.json`.
- **`smoke-captions.cjs`** plays a public WAV through the speakers (audible) and drives the real app over WASAPI loopback: Docs toolbar and embedded view visibility per tab and in compact mode (with an offline stub document), header/status sync, transcript behavior (100-line cap, reading position, follow mode, clearing mid-phrase), settings at the minimum window size, interim and final captions, duplicate-start rejection, and stop/restart. Any renderer console error, preload error, or renderer crash fails the run. It always writes `artifacts/captions/ui-smoke.json` with a timestamp, including on failure, and exits non-zero on failure.

Recognition tools in `native/captions-local` (models required; nothing is played aloud):

- `boundary_check.py` forces a split at every position of each clip, as the segmenter does at its limit, and compares the stitched text with one whole-clip decode. Only boundary errors count.
- `live_check.py` runs the real worker at real-time pace using `file_capture.py` in place of WASAPI. It reports per-phrase delay to the first caption and to the final text, processing lag over the session, CPU and memory, network endpoints owned by any worker process (netstat), leftover processes, and WER against a reference.
- `benchmark_accents.py` scores a manifest of clips through the app's own segmentation and as whole-file decodes, normalizing case, punctuation, numbers, and fillers. `fetch_edacc.py` downloads a balanced sample of the EdAcc corpus for it (an explicit, optional download for evaluation only). `benchmark.py` measures model load and single-file speed.
- `make_nonspeech.py` writes noise, tones, synthetic music, clicks, and Windows system sounds for checking that nothing is captioned. `scripts/make-tts-samples.ps1` synthesizes known text with the voices built into Windows, for boundary checks; synthetic voices say nothing about accent accuracy.

These tools block or monitor network access during recognition. Public audio and generated results belong in ignored `artifacts/captions/`; no meeting audio is required. Small sample results are not population-wide accuracy measurements or a comparison against Windows Live Captions.

The previous Zipformer and experimental Windows AI workers remain as reference implementations under `native/`. They are not selected by the app.

## Google Docs

Paste an HTTPS `docs.google.com/document/...` link. The isolated Chromium view uses the live Docs client. Grant visitors **Viewer** access and give the developer edit access separately. Google permissions determine whether the document can be edited. Public documents are not confidential merely because this overlay is protected.

## Screen-sharing behavior

The main process requests `BrowserWindow.setContentProtection(true)` before showing the overlay. The Docs view and captions belong to the same top-level window. This OS setting does **not** verify what a remote participant receives. Exclusion still requires independent local and remote checks for the actual OS, meeting client, sharing mode, and display configuration. See `PRIVACY.md` for the manual acceptance matrix. There is no universal exclusion guarantee.

## Model and runtime attribution

- [NVIDIA Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2): NVIDIA, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This app uses the [sherpa-onnx ONNX/int8 conversion](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8), not the original NeMo checkpoint. Conversion and quantization modify the model representation.
- [OpenAI Whisper](https://github.com/openai/whisper): MIT; optional models run via [faster-whisper](https://github.com/SYSTRAN/faster-whisper) and CTranslate2.
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx): Apache 2.0.
- [Silero VAD](https://github.com/snakers4/silero-vad): MIT; bundled with faster-whisper.

Keep upstream license notices when packaging dependencies or models.
