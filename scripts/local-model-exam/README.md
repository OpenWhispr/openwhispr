# Local model exam

Runs every local speech and text model through the app's own engines and settings
(whisper.cpp, sherpa-onnx and llama-server from `resources/bin`, the app's launch flags,
speech gate, cleanup prompt and agent tool path), then scores speed, accuracy, made-up
words on silence, cleanup faithfulness and agent behaviour against fixed pass marks.
Nothing here changes the app; the scripts import its main-process helpers behind a small
Electron stand-in (`lib/electron.mjs`).

## Before you run it

- Node 24 and `npm ci`.
- The engines: `npm run download:whisper-cpp && npm run download:sherpa-onnx && npm run download:llama-server`.
  `run-speech.mjs` also needs `npm run download:whisper-vad-model` for its Whisper runs with
  silence detection on.
- The models: the scripts use the app's own model cache, so download the models you want to
  test in the app first. `canary.mjs` downloads its own.
- The engines pick free ports and stop only the processes they started, so the app can stay
  open, but quit it for speed runs: it competes for the processor and graphics chip.
- Test audio is public: FLEURS read speech (fetched from Hugging Face on first use) and
  sentences spoken by macOS's built-in voices. Both are cached in `.cache/` and never
  committed. No recording of a real user is used. The voices are made with `say`, so on
  Windows or Linux copy `.cache/tts/` from a Mac where `prefetch.mjs` ran; the scripts stop
  with a message if a clip is missing.
- Peak memory is read with `ps` (and `vmmap` on macOS) or, on Windows, PowerShell's process
  list.

## Scripts

Run from the repo root with `node --import tsx scripts/local-model-exam/<script>`. Each run
writes to `results/<time>/` unless you pass `--out <dir>`; `results/` is not committed.

- `prefetch.mjs [--clips N]`: downloads and caches the test audio (FLEURS clips per
  language, default 12) without running any engine.
- `run-speech.mjs [--models a,b] [--clips N] [--out dir]`: per speech model, the wait after
  you stop talking (15, 60, 250 and 600 words, first decode after loading and warm), the live
  preview, accuracy in every supported language, made-up words on silence and pauses (10 runs
  per clip, with the app's speech gate, and for Whisper also with its silence detection), and
  peak memory.
- `run-text.mjs [--models a,b] [--cases N] [--tasks N] [--out dir]`: per text model, cleanup
  time (15, 60 and 250 words, first after loading and warm), every case in
  `fixtures/cleanup-cases.json` through the cleanup rules, every task in
  `fixtures/agent-tasks.json` through the agent with fake tools (nothing real is touched), and
  peak memory.
- `measure-rates.mjs [--models a,b] [--out dir]`: how fast each text model reads a prompt and
  writes an answer, and how much of the fixed instructions the next request reuses, from
  llama-server's own timings. Feeds `predict.mjs`.
- `predict.mjs --speech <dir> --text <dir>[,<dir>] --rates <dir> --out <file.md>`: predicted
  cleanup, agent and speech times and memory fit on each machine type's reference machine,
  scaled by published llama.cpp speeds. Every number for another machine is a prediction.
  `--measured-chip`, `--measured-read` and `--measured-write` give the measuring machine's own
  llama 7B Q4_0 speeds (default: the Apple M5 Pro of the first run).
- `cloud-baseline.mjs --speech <dir> [--runs 3] [--parallel 1] [--limit n] [--gap-ms 1500]`:
  sends the accuracy clips of a speech run through OpenWhispr Cloud's dictation route, the
  one the app uses (raw transcript, no cleanup), each clip `--runs` times, and scores them
  like the local models. `OW_CLOUD_TOKEN_FILE` points at a file holding a sign-in token; the
  token is read, never printed. `--score-only` rescores the saved transcripts. The baseline
  belongs to one test set: a run with a different clip set (another `--clips`) needs its own,
  and the script refuses a mismatch.
- `report.mjs --speech <dir> --text <dir>[,<dir>] [--judge <file>] [--cloud <file>] --out <file.md>`:
  a markdown report of one machine's runs, rescored with the current scoring, with the gap to
  the cloud baseline (default `<speech dir>/cloud-baseline.json`).
- `canary.mjs [--models a,b] [--out dir]`: the weekly slice (below); `--models` picks a subset.

Meaning changes in cleanup are judged outside these scripts, blind, by a reviewer model and
then by hand; `report.mjs` reads those verdicts from `--judge`.

## Pass marks

A default must pass dictation speed, dictation accuracy and every deal-breaker; among the
models that pass, the most accurate wins. Cleanup and the agent may fail without ruling a
model out: they are then marked as not done well locally.

- **Speed:** a wait of at most 3 s after a typical 60-word dictation, first after loading and
  warm; 2 s or less is good and under 1 s is the goal. With cleanup on (the default), the 3 s
  covers speech and cleanup together. Long dictations may take longer, so the other lengths
  are information only.
- **Accuracy:** at most 2 more errors per 100 words than the cloud model on the same clips,
  per language, against the mean of 3 cloud runs per clip. Chinese, Japanese, Korean and
  Thai are scored by characters.
- **Silence (deal-breaker):** no made-up words in any of 10 runs per clip, on the path the
  app ships (speech gate on). After speech, only words written where nobody spoke count.
- **Memory (deal-breaker):** the speech and text model together use at most half the
  reference machine's memory.
- **Cleanup:** never does what the dictation asked instead of tidying it (deal-breaker), and
  changes the meaning in at most 1 case in 50.
- **Agent:** the right tools and arguments in at least 9 tasks in 10, first words within 3 s,
  a two-step request within 15 s, and it never sends anything nobody asked for
  (deal-breaker).

## Weekly canary

`.github/workflows/local-model-exam.yml` runs `canary.mjs` every Monday on GitHub's Linux,
Windows and macOS runners, and on pull requests that change this folder. It downloads each
model in the slice with the app's own download code and runs it with the app's own engines:

- Speech: `small` (Whisper), `parakeet-tdt-0.6b-v3`, `nemotron-speech-streaming-en-0.6b` and
  `nemotron-3.5-asr-streaming-0.6b`. Each must download, load, write nothing where nobody spoke (silence, noise, speech followed by
  silence, noise or a long pause; 3 runs each), and stay within its accuracy ceiling on the
  first 3 FLEURS clips of each scored language. The ceiling is the error rate measured on
  those clips on 2026-10-22 × 1.5 + 10: wide enough for 3-clip samples, tight enough to
  catch a broken engine, model file or audio path.
- Cleanup: `qwen3.5-2b-q4_k_m` must download, load and pass every cleanup rule on 8 cases
  (no answering, no printed instructions, nothing dropped), as it did on all 66 on 2026-10-22.
- Every model's peak memory must be readable, which keeps the Windows path tested. It is
  reported, not scored: a runner is no reference machine.

Any failed check, crash, skip or timeout fails the run, and so does a run that checked
nothing. A failing run on `main` opens or updates one issue per runner OS, labelled
`local-model-exam`; pull requests only show the failed check. Speed is reported but not scored there: shared runners are too noisy
for the speed bar. The agent is left out: on a runner's processor one request takes minutes.
The slice and its pass marks live in `lib/canary.mjs`.

`OPENWHISPR_CACHE_ROOT` points the workflow's downloads at the runner's temp folder. Never
set it on a machine that has the app's models: the app moves its model folders into that
folder on first use.

## Tests

`npm test` runs `test/localModelExam/` with the rest: scoring, the cleanup and agent rules,
the Electron stand-in, and checks that the canary's models and cases still exist.
