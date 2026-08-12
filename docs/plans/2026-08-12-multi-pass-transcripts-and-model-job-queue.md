# Plan — Long calls processed in passes, on a persisted priority job queue

Date: 2026-08-12
Base: `main` @ `68ad05f8` (v1.15.0)
Branch: `feature/multi-pass-transcripts-and-model-job-queue`
Target version: 1.16.0 (minor — two user-visible surfaces; **needs user confirmation**)

---

## Symptom

Two failures, one cause.

**1. A long meeting note fails instead of being processed.** Running a note
action on a long meeting with the local model shows a translated "prompt is too
long for the local model" message and produces nothing. This is the deliberate
intermediate state shipped in 1.15.0 — it replaced a bug that drove the machine
into swap — but it is not the intended behaviour. The user's requirement, in
their words: *"I don't want to miss anything from a long or extensive call cause
we just cut it short."*

**2. Clicking generate on several old meetings at once fails.** The second and
subsequent notes throw `Already processing a request`.

Both are the single local llama-server being treated as a resource that either
is free or errors, with no queue and no way to split work that does not fit.

---

## Verified root causes

Every claim below was re-read from the working tree at `68ad05f8`, not carried
over from the previous plan.

### RC1 — the local inference gate throws instead of queueing

`src/services/localReasoningBridge.js:26-30`:

```js
if (this.isProcessing) {
  throw new Error("Already processing a request");
}
```

`LocalReasoningService` is a module singleton (`module.exports = { default: new
LocalReasoningService() }`, `:91-93`) living in the **main** process. Every local
inference in the app converges on it:

| caller | path | file:line |
|---|---|---|
| note actions, dictation cleanup, dictation agent, chat agent (all renderer) | `process-local-reasoning` IPC | `src/helpers/ipcHandlers.js:3235-3245` |
| post-call pipeline (main) | `MainProcessInference._callLocal` | `src/helpers/mainProcessInference.js:50-57` |

So the flag is a single chokepoint — which is what makes a priority scheduler a
small change rather than a rewrite. It is also why a multi-minute run currently
makes dictation throw for its whole duration.

### RC2 — no bound exists between "fits" and "fails"

`src/helpers/modelManagerBridge.js:386-405` runs the pre-flight guard added in
1.15.0 and throws `LOCAL_CONTEXT_EXCEEDED` when the prompt exceeds
`floor(contextSize × 0.6)` (`src/helpers/llamaContext.js:74,81-89`). There is no
third branch: nothing splits an over-budget prompt. The action path assembles the
entire transcript uncapped at
`src/components/notes/PersonalNotesView.tsx:1050-1057` and passes it straight to
`reasoningService.processText` (`src/stores/actionProcessingStore.ts:164`).

### RC3 — the existing queue cannot be persisted or prioritised

`src/helpers/backgroundJobQueue.js` (68 lines) is serial and emits `status`, but:

- `enqueue(jobId, fn)` (`:19-22`) takes a **closure**. A closure cannot be
  written to SQLite, so persistence is impossible without changing every call
  site to a data descriptor. Five call sites:
  `postCallAutoEnqueue.js:31`, `reprocessMeetings.js:23`,
  `ipcHandlers.js:7156` (`post-call-retry`), `ipcHandlers.js:7180`
  (`regenerate-notes`), `ipcHandlers.js:7466` (drain after model download).
- It has no notion of priority, and dictation does not go through it at all —
  dictation calls `process-local-reasoning` directly.
- `main.js:1231-1232` calls `cancelPending()` on quit, i.e. today the queue is
  explicitly discarded at shutdown.

### RC4 — the queue is invisible

`get-pipeline-status` exists (`ipcHandlers.js:7150-7153`, returning
`{queueLength, activeJob}`) and is bridged at `preload.js:337` as
`getPipelineStatus`. **`grep` finds no renderer consumer.** `regenerate-notes`
(`ipcHandlers.js:7176-7185`) returns `{success:true}` the instant it enqueues, so
a queued regeneration looks like nothing happened.

### RC5 — the renderer holds input the database does not

The 2026-08-11 review's finding **I2** said `runAction`/`runBackgroundAction`
must change signature to carry transcript segments, because
`PersonalNotesView.tsx:1037-1048` parses them and discards them.

An earlier draft of this plan tried to avoid that by having the main-process
orchestrator read `notes.transcript` (`database.js:396`) itself, as
`postCallPipelineManager._flattenTranscript` (`:464-478`) already does.
**That draft was wrong and the review caught it.** The renderer runs the action
over state the DB does not have:

- `editorNote.content` is `isLocalSynced ? localContent : activeNote.content`
  (`PersonalNotesView.tsx:596-600`) — the **live editor buffer**.
- `activeNoteRawTranscript` is the in-memory realtime transcript while
  recording (`:506-507`); the DB copy is flushed on a **30-second interval**
  (`:582-591`).

Reading from the DB would silently process stale or empty input. **I2 stands:
the payload carries a snapshot of exactly what the user saw.** Recorded here
because the earlier reasoning is superficially convincing and should not be
re-derived by a future reader.

---

## Design

Four layers, each independently testable. Layers 0–2 are pure-ish main-process
modules with no Electron import at module scope, so `node --test` can load them.

```
renderer  ── enqueue-note-action (local provider only) ──┐
                                                          v
        ┌───────────────────────────────────────────────────────┐
        │ L3  modelJobQueue      serial, persisted in SQLite     │
        │     "3 queued, 1 running", survives restart            │
        └───────────────┬───────────────────────────────────────┘
                        │ one job = 1..N inferences
        ┌───────────────v───────────────────────────────────────┐
        │ L2  noteActionRunner   extract -> compose              │
        │     plan frozen at job start, progress persisted       │
        └───────────────┬───────────────────────────────────────┘
                        │ L1 transcriptPassChunker (pure)
        ┌───────────────v───────────────────────────────────────┐
        │ L0  localInferenceScheduler  priority semaphore, N=1   │
        │     dictation preempts batch between passes            │
        └───────────────┬───────────────────────────────────────┘
                        v
                  llama-server (one process, one request)
```

### L0 — `src/helpers/localInferenceScheduler.js` (new)

Replaces the throwing flag with a priority FIFO semaphore, concurrency 1.

```js
const PRIORITY = { interactive: 0, batch: 1 };
async acquire({ priority = "batch", timeoutMs, signal })  // -> release()
```

- Waiters ordered by `(priority, seq)`; `seq` keeps FIFO within a priority so a
  stream of dictations cannot starve a batch job forever.
- **`interactive` waiters get `timeoutMs` (default 180 s)** and reject with code
  `LOCAL_INFERENCE_BUSY` if the holder wedges. Dictation must never hang
  indefinitely; a typed error it can translate is strictly better than today's
  raw throw, and the existing renderer error path already surfaces `code`
  (`local.ts:28-32`).
- **`batch` waiters are capped** (`MAX_BATCH_WAITERS = 4`) and reject beyond
  that. L3 is serial so this should never bind; the cap exists so a bug cannot
  grow an unbounded waiter list.
- `signal` (an `AbortSignal`) removes a waiter that is cancelled before it is
  granted.

**The slot covers the server, not just the request.** `runInference` may restart
llama-server for a different model (`modelManagerBridge.js:363-376`), and
`serverManager.start` calls `stop()` on the running process
(`llamaServer.js:117-119`). So the slot must be held across *start + inference*,
which means acquiring **before** the `serverManager.start` at
`modelManagerBridge.js:370`, not around the inference call at `:420`. Otherwise
one caller's model switch SIGTERMs another caller's in-flight request.

**The chat agent must take a lease (review C1).** `ReasoningService` does **not**
go through the bridge for local chat: `processTextStreaming` (`:405-409`) and
`processTextStreamingAI` (`:628-633`) call
`window.electronAPI.llamaServerStart(model)` and then stream **directly from the
renderer** to `http://127.0.0.1:<port>/v1/chat/completions`. That path is
invisible to any main-process semaphore, and its `llamaServerStart`
(`ipcHandlers.js:3346-3365`) is exactly the model-switch `stop()` above.

New IPC `acquire-local-inference-lease` / `release-local-inference-lease`:
- The renderer acquires (`priority: "interactive"`) *before* `llamaServerStart`
  and releases in a `finally` around the stream.
- The lease is keyed to `event.sender.id`; `webContents` `destroyed` releases it,
  so a closed or crashed window cannot hold the server forever.
- Hard max hold of 120 s (above the stream's own 60 s abort at
  `ReasoningService.ts:485`), after which the lease is reclaimed and logged at
  `notice`.

This is the fix for both halves of C1: the agent no longer contends invisibly,
**and** a model switch can only happen while its initiator holds the slot, so it
can never kill a batch pass mid-flight. It also bounds review finding I3
(model-swap thrash) to one swap per lease rather than an unsynchronised
ping-pong.

`localReasoningBridge.processText` gains `config.priority` and wraps its body in
acquire/release. `isProcessing` stays as a derived getter so nothing that reads
it breaks.

**Priority defaults are pinned (review I1).** The scheduler's and the bridge's
default is **`batch`**. `interactive` is set in exactly one place —
`ipcHandlers.js:3235`'s `process-local-reasoning`, for renderer callers — plus
the lease IPC. `MainProcessInference.processText` (`:14`) and `_callLocal`
(`:50-57`) must thread `priority` through explicitly, or the post-call pipeline
inherits `interactive` and its notes step dies with `LOCAL_INFERENCE_BUSY` after
180 s behind a multi-pass job. Batch title generation from the upload queue
(`batchQueueStore.ts` → `generateNoteTitle`) is likewise tagged `batch`.

**Consequence to state in the PR:** dictation now *waits* for the current pass
instead of failing. Worst case is one extraction pass (est. 40–90 s) plus, if
dictation uses a different local model, one server restart; past 180 s it falls
back to pasting the raw transcript, which is what
`audioManager.js:1317-1325` already does on any reasoning error. That is the
user's chosen trade (asked and answered 2026-08-12).

### L1 — `src/helpers/transcriptPassChunker.js` (new, dependency-free CommonJS)

*(Named to avoid confusion with the unrelated `src/helpers/conversationChunker.js`,
which chunks chat history for embeddings.)*

CommonJS in `src/helpers/` deliberately: `postCallPipelineManager.js` is main
CommonJS and cannot require a renderer `.ts` util, and its own
`slice(0, 8000)` truncation (`:448`) is the same disease — this module must be
mechanically reusable there later.

```js
chunkSegments(segments, budgetTokens, { overlapSegments = 1 })  // -> string[]
chunkText(text, budgetTokens)                                    // paragraph packing
```

- Token estimate reuses `estimatePromptTokens` from `llamaContext.js:76`
  (`ceil(len / 3.6)`) so the chunker and the pre-flight guard cannot disagree.
- Packs whole segments; carries the last `overlapSegments` of the previous chunk
  into the next for continuity.
- **A single segment larger than the budget is split on sentence, then
  whitespace, boundaries.** The 2026-08-11 plan said "never splits a segment",
  which would emit an over-budget chunk that the pre-flight guard then rejects —
  turning one long uninterrupted monologue into a hard failure. Rare but real
  (a 20-minute uninterrupted stretch from one source). Fixed here.
- Non-meeting notes (`segments.length === 0`) use `chunkText`.

### L2 — `src/helpers/noteActionRunner.js` (new)

Extract → compose. Local provider only.

1. **Input comes from the job payload, not the DB** (RC5). The renderer sends a
   snapshot: `noteContent` (the editor buffer) and `segments` — already labelled
   `You:`/`Them:` using the i18n strings at `PersonalNotesView.tsx:1041-1046` —
   or `text` for a non-meeting note. Main reads the DB only to *write* the
   result and to confirm the note still exists.
2. **The context budget is computed from the model file, not from a running
   server (review C2).** `serverManager.contextSize` is assigned **only** inside
   `_doStart` (`llamaServer.js:150`) and is never cleared by `stop()`, so at plan
   time it is `undefined` on a cold server (5-minute idle stop, `:455-463`) or
   **stale from a different model**. The pre-flight guard's own fallback is
   `|| 4096` (`modelManagerBridge.js:388`) — planning against that would split
   the user's 494k-char note into ~75 chunks instead of ~10, and planning against
   a stale larger value would make every chunk fail the guard.

   Instead, resolve it offline with the same function the server uses:

   ```js
   resolveContextSize({ gguf: readGgufMetadata(modelPath),
                        totalMemBytes: os.totalmem(), modelFileBytes })
   ```

   This is a header read, no server needed, and agrees with `_doStart` by
   construction. It is computed **at job start** (not at enqueue) and frozen into
   the job row. Additionally `llamaServer.stop()` must clear `this.contextSize`
   so no other reader can see a stale value.

   `inputBudget = floor(contextSize × 0.6)` — the same `PROMPT_SHARE` as the
   guard (`llamaContext.js:74`). `chunkBudget = floor(inputBudget × 0.75)`,
   leaving room for the extraction system prompt and compose scaffolding.

   **On resume, recompute.** If the recomputed `contextSize` differs from the
   value frozen in the job row, the stored extracts are discarded and the job is
   re-planned. The earlier draft said "the stored plan is still the plan", which
   the review correctly identified as converting C3's unsoundness into
   deterministic failure rather than closing it.
3. **If the whole assembled prompt fits → exactly one call, today's behaviour
   byte-for-byte.** Single-pass is the common case and must not regress.
4. Over budget → per chunk, a fixed English extraction prompt (an AI system
   prompt — **not** translated, per CLAUDE.md) asking for decisions, action
   items with owner and deadline, facts and numbers, open questions, and notable
   quotes, instructed to quote rather than paraphrase. `maxTokens 800`,
   `temperature 0.1`.
5. Compose once: the user's real action prompt (built in the renderer, carried
   in the payload, complete with dictionary suffix) over
   `note content + all extracts`, `maxTokens 2048`.
6. **Compose-overflow guard.** If the extracts exceed `inputBudget`, fold
   adjacent extract pairs with the same extraction prompt and re-check; at most
   **2 fold levels**, then fail with `LOCAL_CONTEXT_EXCEEDED`.

   Arithmetic, re-checked by the review against the real constants. At
   ctx 32768: `inputBudget = floor(32768 × 0.6) = 19,660`;
   `chunkBudget = 14,745`. The user's 494,243-char note is
   `ceil(494243 / 3.6) = 137,290` estimated tokens ⇒ **10 chunks**, so ~12
   passes including compose and title, not the 9/11 stated in the first draft.
   Ten extracts of ≤800 generated tokens re-measure at ~889 estimated tokens
   each ⇒ ~8,900 tokens, plus note content and a ~2k system prompt — well under
   19,660. **Zero folds**, confirmed. The first fold is only reached around 24
   chunks (~380k tokens, a six-hour call); two levels covers ~96.

   Also confirmed by the review: `localReasoningBridge.js:35` is
   `config.maxTokens || calculateMaxTokens(...)`, so **the caller wins** and the
   2048 cap does not silently override the runner's 800. Reply headroom is the
   other 40 % of the context (13,107 tokens ≫ 2048).

   **The fold cannot rescue a note whose manual content alone exceeds
   `inputBudget`** (review M4) — folding shrinks extracts only. That case fails
   exactly as it does today, and must be surfaced as such rather than looping.
7. Title generation, when `allowTitleGeneration`, reuses the pipeline's existing
   `TITLE_PROMPT` (`postCallPipelineManager.js:110`, to be exported) rather than
   creating a third copy of the same logic alongside `generateTitle.ts:14-22`.
   It counts as a pass. **It re-checks that the title is still auto-generatable
   immediately before writing** — `_mayGenerateTitle` (`:240-261`) exists for
   exactly this race, and a job resumed hours later must not overwrite a title
   the user typed in the meantime (review M1).

**Failure semantics.** The first draft's taxonomy was unimplementable and the
review was right to call it CRITICAL (C3). The real error surfaces:
`modelManagerBridge.js:441-443` collapses **every** in-flight inference error
into `ModelError("Inference failed: …", "INFERENCE_FAILED")`, and
`serverManager.start()` is called at `:370` — **outside** the `try` that begins
at `:420` — so startup failures like
`"llama-server process died during startup (signal: SIGKILL)"`
(`llamaServer.js:333-339`) and `"llama-server failed to start within 120000ms"`
(`:355`) escape as raw `Error`s with no code at all. SIGKILL-on-startup is the
*most likely* failure on the memory-pressured machine this feature targets, and
it appeared in none of the three classes.

Rather than substring-matching wrapped messages, **codes are added at the
source** (~15 lines): `llamaServer.js` tags its own errors
`LLAMA_REQUEST_TIMEOUT` (`:556-559`), `LLAMA_REQUEST_FAILED` (`:552-554`),
`LLAMA_BAD_STATUS` (`:521`), `LLAMA_START_FAILED` (`:333-339`),
`LLAMA_START_TIMEOUT` (`:355`); `modelManagerBridge` preserves `error.code`
when wrapping and moves the `start()` call inside the `try`.

| class | membership | handling |
|---|---|---|
| transient | `LOCAL_INFERENCE_BUSY`, `LLAMA_REQUEST_TIMEOUT`, `LLAMA_REQUEST_FAILED`, `LLAMA_START_FAILED`, `LLAMA_START_TIMEOUT`, **and anything unrecognised** | 3 retries, 2/4/8 s backoff. **Never a gap marker.** Does not count toward K. |
| genuine | empty or unparseable output; `LOCAL_CONTEXT_EXCEEDED` on a single chunk *after* one re-split at 0.75× budget | 1 retry, then `[extraction unavailable for this section]`, `partial = 1`, continue |
| fatal | `MODEL_NOT_DOWNLOADED`, `LLAMASERVER_NOT_FOUND`, model not found, note deleted, job cancelled, **transient retries exhausted**, `K = 3` consecutive genuine failures | abort, persist `status='failed'` + reason, surface per-note error |

Two rules the review forced and that must not be softened:

- **Unrecognised errors default to `transient`, never `genuine`.** A gap marker
  is a permanent hole in the user's notes; a retry costs seconds. This is the
  generalisation of the prior review's I1.
- **Transient exhaustion is fatal, not a gap marker.** Three failed retries mean
  the machine or the server is broken, not that this section of the call was
  unreadable. Failing the job says so; a gap marker would lie about it.

A run that produces *any* gap marker sets `partial = 1` on the job so the UI can
say so. Silently handing the user notes with a hole in them is the failure mode
review finding I1 warned about; a marker plus a flag is the honest version.

**Progress and resumption.** After each pass the runner persists
`progress_json = {chunkCount, completedExtracts:[...], phase}` on the job row.
On restart the job resumes from the first missing extract.

*This is not the extract cache cut by review finding C3.* C3's key was
`(noteId, contentHash, chunkIndex)` across runs, unsound because chunk
boundaries move with the budget. Here the **chunk plan is frozen into the job
row at enqueue time** and the extracts are scoped to that one job. If
`serverContextSize` differs on resume (different machine state), the stored plan
is still the plan; if `content_hash` no longer matches the note, the job is
discarded rather than resumed. Both directions of C3's unsoundness are closed by
construction, not by a policy.

### L3 — `src/helpers/modelJobQueue.js` (replaces `backgroundJobQueue.js`)

Serial, persisted, handler-registry based.

```sql
CREATE TABLE IF NOT EXISTS model_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  note_id       INTEGER,
  payload_json  TEXT NOT NULL,
  content_hash  TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',  -- queued|running|complete|failed|cancelled
  progress_json TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  partial       INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at    DATETIME,
  finished_at   DATETIME
);
CREATE INDEX IF NOT EXISTS idx_model_jobs_status ON model_jobs(status, id);
```

Follows the existing `CREATE TABLE IF NOT EXISTS` + guarded `ALTER TABLE` idiom
in `database.js` (`:29-77`). There is no `user_version` *framework* here, but
the pragma is **not unused**: `database.js:214-224` uses `user_version < 1` as a
one-time seed guard and sets it to 1. New schema code must not touch that
pragma (review M2).

- `register(kind, handler)` — handlers live in `ipcHandlers.js` where the
  managers are. The queue stores data only.
- `enqueue({kind, noteId, payload, contentHash})` → row + `id`.
- **Boot recovery** (`resumeOnBoot()`, called after `databaseManager` init):
  rows in `running` → back to `queued`. A job whose note no longer exists →
  `cancelled`.

  `attempts` increments **only on an unclean interruption** (review I4). A
  `clean_shutdown` flag is written on `will-quit` and cleared on boot; a
  `running` row found with the flag set was a normal quit and does not count.
  `attempts` also resets to 0 whenever `progress_json` shows more completed
  extracts than at the last interruption. Without both rules, a user who closes
  their laptop three evenings running has a 90 %-complete job marked
  `failed ("interrupted repeatedly")` on the fourth boot — quitting during a
  7–17-minute job is routine, not a crash signal. The `attempts > 3` fail-stop
  is retained purely as a crash-loop backstop.

  The job is **not** cancelled when `content_hash` no longer matches the note.
  The payload is a self-contained snapshot, so the work is still valid; the
  result is written with the stored hash and the existing
  `enhanced_at_content_hash` staleness indicator (`PersonalNotesView.tsx:509-518`)
  shows the user it was computed against older content, exactly as it does today.
- **`main.js:1231-1232` must stop calling `cancelPending()`** — that line is
  what would defeat persistence. It becomes a no-op stop that leaves rows
  `queued`.
- Emits `model-job-status` via the existing broadcast helper:
  `{jobId, kind, noteId, status, phase, currentPass, totalPasses, queuePosition, partial, error}`.
- The five existing `enqueue(id, fn)` call sites (RC3) convert to descriptors:
  `post-call` / `post-call-reprocess` / `post-call-retry` / `regenerate-notes`,
  each a `{noteId, fromStep?}` payload against a handler that calls
  `postCallPipelineManager`. Behaviour identical; only the shape changes.

### L4 — renderer

- `runBackgroundAction` (`actionProcessingStore.ts:124`) branches: **local
  provider → `window.electronAPI.enqueueNoteAction(...)`** with the snapshot
  (`noteContent`, labelled `segments`), the fully built `systemPrompt`,
  `disableThinking`, `contentHash` and options; **every other provider → today's
  code path, untouched.** Cloud stays concurrent, unqueued and unchunked (0 of
  42 cloud models declare `contextLength` — prior review C2).
  The branch condition must use the same tolerant resolution as
  `MainProcessInference.resolveProvider` (`mainProcessInference.js:32-39`), not
  `provider === "local"`: settings have been observed persisting a model
  *family* ("gemma") into the provider field, and a mislabelled local config
  would otherwise stay on the path that fails on long notes (review M3).
- New `src/stores/modelJobStore.ts` subscribing to `model-job-status`, mirroring
  the existing `postCallPipelineStore` pattern.
- **Per-note badge**: `queued` / `pass k of N` / `failed` / `partial`, driven
  from the store, replacing the local `processingFlags` state for local jobs.
- **Global chip**: "3 queued, 1 running" in the control panel header, expanding
  to the list. Uses the existing `getPipelineStatus` bridge
  (`preload.js:337`), extended to return the job rows.
- `src/components/notes/ActionProcessingOverlay.tsx:88-97` swaps the indeterminate bar
  (`animation: indeterminate`) for a determinate one when `totalPasses > 1`,
  plus "pass k of N".
- New IPC: `enqueue-note-action`, `cancel-model-job`, `list-model-jobs`;
  preload bridges; `src/types/electron.ts` declarations.
- i18n keys in **all 10 locales** (`en, es, fr, de, pt, it, ru, zh-CN, zh-TW,
  ja` — 10 dirs, note CLAUDE.md says 9).

---

## Why this over the alternatives

- **Extract → compose** over map-reduce and rolling notes: user decision,
  2026-08-11. Not re-litigated.
- **Orchestrator in main, not renderer.** Persistence needs main; the mutex is
  in main; local inference already executes in main; the transcript is already
  parsed in main (RC5). A renderer orchestrator would need the window open for
  ten minutes and could not survive restart.
- **Route only local note actions to the queue.** Moving all providers to main
  would regress the four providers `mainProcessInference` does not implement
  (`groq`, `lan`, `enterprise`, `openwhispr` — `SUPPORTED_PROVIDERS` is
  `["openai","anthropic","gemini","local"]`, `mainProcessInference.js:181`).
  Cloud actions do not need the queue: they have no mutex and run concurrently
  today.
- **Priority semaphore over a second queue for dictation.** One resource, one
  gate. Two queues in front of one server can both think they hold it.
- **Scheduler-level preemption, not request-level.** Aborting an in-flight
  llama-server request is possible (`req.destroy()` is already used for the
  timeout path, `llamaServer.js:556-559`) but throws away a completed prefill.
  The user chose "running pass finishes".

Rejected, recorded: automatic cloud routing for long calls (privacy decision is
the user's); consent prompt before a long run (user chose progress instead);
truncation (the thing being fixed); semantic/embedding chunking (an embeddings
pass over 124k tokens on an already-strained machine for a marginal coherence
gain — the chunker interface leaves room).

---

## Test plan

Baseline to preserve: **648 tests / 643 pass / 0 fail / 5 skipped**.
`npm rebuild better-sqlite3` first (ABI toggle).

**L0 scheduler / lease** — `test/helpers/localInferenceScheduler.test.js`
- [ ] a lease is released when its owning `webContents` is destroyed
- [ ] a lease is reclaimed after the 120 s max hold
- [ ] a model switch cannot begin while another holder has the slot
- [ ] concurrency is 1; a second `acquire` does not resolve until release
- [ ] an `interactive` waiter is granted before a `batch` waiter enqueued earlier
- [ ] FIFO holds within a priority
- [ ] an `interactive` waiter rejects with `LOCAL_INFERENCE_BUSY` after `timeoutMs`
- [ ] a batch flood cannot starve interactive; interactive flood does not
      permanently starve batch
- [ ] an aborted waiter is removed and does not later take the slot
- [ ] release on a rejected/thrown body still frees the slot

**Error classification** — `test/helpers/inferenceErrorClass.test.js`
- [ ] each new `LLAMA_*` code lands in the intended class
- [ ] a startup SIGKILL is `transient`, not `genuine` — no gap marker
- [ ] an unrecognised error defaults to `transient`
- [ ] transient exhaustion produces a **fatal** job failure, not a gap marker

**L1 chunker** — `test/helpers/transcriptPassChunker.test.js`
- [ ] the budget is derived from the GGUF header with **no server running**, and
      equals what `_doStart` would resolve for the same model and machine
- [ ] `estimateTokens` never under-estimates ASCII
- [ ] no emitted chunk exceeds the budget — including when one segment alone does
- [ ] a segment is never split when it fits
- [ ] overlap carries exactly the last segment
- [ ] empty / single-segment / all-oversized inputs
- [ ] `chunkText` packs on paragraph boundaries

**L2 runner** — `test/helpers/noteActionRunner.test.js` (fake inference fn)
- [ ] a prompt that fits produces **exactly one** inference call
- [ ] an over-budget transcript produces N extraction calls + 1 compose
- [ ] a transient failure retries and produces **no** gap marker
- [ ] a genuine failure twice produces a gap marker, `partial = 1`, run completes
- [ ] 3 consecutive genuine failures abort the job as `failed`
- [ ] cancellation between passes stops further passes
- [ ] compose overflow folds once and only once when one fold suffices
- [ ] compose still over budget after 2 folds → `LOCAL_CONTEXT_EXCEEDED`
- [ ] resume from persisted progress skips completed extracts

**L3 queue** — `test/helpers/modelJobQueue.test.js` (in-memory better-sqlite3)
- [ ] jobs run strictly one at a time, in insertion order
- [ ] a `running` row is requeued on boot
- [ ] a clean shutdown does **not** increment `attempts`
- [ ] `attempts` resets when `progress_json` advanced since the last interruption
- [ ] an unclean crash loop is failed after 3 attempts
- [ ] a job whose note was deleted is cancelled on boot
- [ ] a job whose `content_hash` drifted still runs (snapshot stays valid)
- [ ] a failing handler marks `failed` and the queue proceeds to the next job
- [ ] `cancel` on a queued job removes it; on the running job it stops after the
      current pass
- [ ] the four converted pipeline kinds enqueue and dispatch identically to today

**Regression**
- [ ] `test/helpers/reprocessMeetings.test.js` still passes against the new API
- [ ] a cloud-provider note action takes the renderer path and is not enqueued

**Manual (needs a build, cannot be done offline)**
- [ ] note 14 (494k chars) with the local model: progress shows N passes, the
      machine stays usable, notes contain specifics from the last third of the call
- [ ] dictation during a running multi-pass job completes within ~1 pass
- [ ] the local chat agent during a running multi-pass job waits and then works,
      and neither side kills the other's server (review C1)
- [ ] a meeting ending mid-job queues its pipeline behind the job and both finish
- [ ] enqueue 5 old meetings, quit mid-run, relaunch — the queue resumes
- [ ] cancel mid-run stops after the current pass
- [ ] global chip and per-note badge agree

---

## Review outcomes (adversarial review, 2026-08-12)

Verdict: **architecture right, plan not implementable as written.** Three
CRITICAL. Each was independently re-verified by reading the cited code before
acceptance — none was taken on the reviewer's word.

| # | Finding | Verified? | Resolution |
|---|---|---|---|
| C1 | The scheduler's premise is false: the chat agent's local path never touches the bridge. `ReasoningService.ts:405-409,628-633` call `llamaServerStart` then stream **direct from the renderer** to `127.0.0.1:<port>`. Worse, `llamaServerStart` → `serverManager.start` → `stop()` (`llamaServer.js:117-119`) can SIGTERM the server mid-pass on a model switch. | **Yes** — read both call sites, the IPC at `ipcHandlers.js:3346-3365`, and the 60 s renderer abort at `:485`. | Added the lease IPC (L0). The renderer holds an `interactive` lease across `llamaServerStart` + stream, keyed to `event.sender.id`, released on `webContents` destroy, hard max hold 120 s. Also moved slot acquisition to **before** `serverManager.start`, so a model switch can only occur under the slot. Fixes I3 as a side effect. |
| C2 | The chunk plan is frozen against `serverManager.contextSize`, which is set **only** in `_doStart` (`llamaServer.js:150`) and never cleared by `stop()`. Cold ⇒ `undefined` ⇒ guard fallback 4096 ⇒ ~75 chunks instead of 10. Stale-from-another-model ⇒ every chunk over budget ⇒ 3 gap markers ⇒ K=3 ⇒ job failed. | **Yes** — `grep` confirms one assignment site; `stop()` does not clear; `modelManagerBridge.js:388` really is `|| 4096`. | Budget now resolved offline from the GGUF header via `resolveContextSize`, at **job start** not enqueue; `llamaServer.stop()` clears `contextSize`; on resume the value is **recomputed** and a mismatch re-plans rather than reusing the frozen plan. The draft's "the stored plan is still the plan" is withdrawn. |
| C3 | The failure taxonomy is unimplementable. `modelManagerBridge.js:441-443` collapses all inference errors to `INFERENCE_FAILED`; `serverManager.start()` at `:370` sits **outside** the try at `:420`, so SIGKILL-at-startup and start-timeout escape uncoded and match no class. No default class, and no defined outcome for transient exhaustion. | **Yes** — read the try boundary and both raw `Error` constructions at `llamaServer.js:333-339,355`. | Codes added at the source in `llamaServer.js`; `start()` moved inside the try; `error.code` preserved on wrap. Taxonomy rewritten with an explicit **default of `transient`** and transient exhaustion defined as **fatal, never a gap marker**. |
| I1 | `priority` would be silently dropped by `MainProcessInference.processText` (`:14`) / `_callLocal` (`:50-57`); an `interactive` bridge default would make the pipeline's notes step fail with `LOCAL_INFERENCE_BUSY` after 180 s. | **Yes** — both destructure fixed field lists. | Defaults pinned: scheduler and bridge default `batch`; `interactive` set only at `ipcHandlers.js:3235` and the lease IPC. `mainProcessInference` threads `priority` through; upload-queue title generation tagged `batch` (M6). |
| I2 | Reading input from the DB processes something different from what the user saw: `editorNote.content` is the live editor buffer (`PersonalNotesView.tsx:596-600`) and the transcript is flushed only every 30 s (`:582-591`). `makeContentHash` (`:88-90`) is computed over renderer state. | **Yes** — read all three sites; the hash is `length + first 50 chars` of renderer state. | RC5 rewritten and its conclusion **reversed**: the payload carries a snapshot of `noteContent` + labelled `segments`. The prior review's I2 stands after all. Boot recovery no longer cancels on hash drift — the snapshot stays valid and the existing staleness indicator already covers it. |
| I3 | Model swaps between scopes make "worst case one pass" wrong — dictation on model B behind a job on model A costs a pass **plus two cold multi-GB loads**. | **Yes** — `modelManagerBridge.js:363-376`. | Bounded by C1's fix (swaps happen under the slot, never concurrently). The residual cost is stated honestly in L0 and in open question 4. |
| I4 | `attempts += 1` on every `running→queued` fails a 90 %-complete job after four ordinary quits. | Accepted on reasoning — a 7–17-minute job makes mid-job quit routine. | Clean-shutdown flag; `attempts` increments only on unclean interruption and resets when `progress_json` advances. `>3` retained as a crash-loop backstop only. |
| I5 | The 300 s request timeout (`llamaServer.js:508`) will be **hit every pass** on the CPU backend (`_startWithGpuFallback`, `:226-235`), turning each chunk into 3 × 5 min of grinding. Wall-clock estimate is Metal-only. | **Yes** — the timeout is a hard literal and the CPU fallback is real. | Two changes: the batch request timeout is raised (900 s) and made per-call rather than a module constant; and `chunkBudget` is reduced on a non-GPU backend. Both are now open question 5 because neither is measured. |
| M1 | Title generation on a resumed job overwrites a title the user typed; also becomes a third copy of the same logic. | **Yes** — `_mayGenerateTitle` (`:240-261`) exists for this race. | Reuse the pipeline's `TITLE_PROMPT` and re-check regenerability immediately before writing. |
| M2 | "No `user_version` framework" is imprecise — `database.js:214-224` uses the pragma for a one-time seed. | **Yes**. | Wording corrected; new schema must not touch the pragma. |
| M3 | `provider === "local"` misses configs with a model family in the provider field. | **Yes** — that is why `resolveProvider` (`:32-39`) exists. | Branch uses the tolerant resolution. |
| M4 | The fold cannot rescue oversized manual note content. | Accepted. | Stated explicitly as a known terminal case. |
| M5 | Citation drift (`:3235` not `:3236`; `ActionProcessingOverlay` path; `:7466` is drain-after-download, not retry-on-failure); 10 chunks not 9; name collides with `conversationChunker.js`. | **Yes**. | Citations corrected; arithmetic corrected to 10 chunks / ~12 passes; module renamed `transcriptPassChunker.js`. |
| M6 | Upload-batch title generation would default to `interactive`. | Accepted. | Tagged `batch` under I1. |

**Cleared by the review** (checked, no change needed): RC1's quote and lines;
RC2 in full; RC3's closure signature and all five call sites; RC4's "no renderer
consumer" for `get-pipeline-status`; `main.js:1232` `cancelPending` really does
defeat persistence; `SUPPORTED_PROVIDERS` is 4 vs 8 renderer providers, so
routing everything to main would regress; the schema idiom; 10 locale dirs; the
compose-fold arithmetic and the `maxTokens` precedence question (d); no
re-entrancy deadlock; no caller relies on failing fast (dictation already falls
back to raw paste, `audioManager.js:1317-1325`); the renderer-side
`LocalReasoningService.ts` / `ModelManager.ts` gate is **dead code**, zero
importers; and the pipeline cannot bypass the queue once all five sites convert.
Test baseline re-verified by running the suite: **648 / 643 / 0 / 5**.

## Sequencing (user decisions, 2026-08-12)

**Two PRs, never stacked — both based on `main`.**

| PR | version | contents |
|---|---|---|
| **A** | 1.16.0 | L0 scheduler + lease IPC + `LLAMA_*` error codes, L1 `transcriptPassChunker`, L2 `noteActionRunner`, a `run-note-action` IPC that executes in main and broadcasts `note-action-progress`, determinate "pass k of N" in the overlay, i18n. **Long calls stop being cut short and dictation stops throwing.** |
| **B** | 1.17.0 | L3 persisted `model_jobs` queue (converting the five closure call sites), L4 per-note badge and global chip, boot recovery, retention. Rebased on `main` after A merges. |

In PR A the multi-pass run is executed directly by main and serialised by the L0
scheduler — correct, just not persisted and not visible as a queue. PR B wraps
the same runner in the persisted queue without changing it.

**CPU backend (open question 5) — resolved: adapt, don't gate.** On a non-GPU
backend `chunkBudget` is reduced (~4×) and the batch request timeout is raised
to 900 s, so multi-pass works on Windows/Linux CPU rather than falling back to
today's failure. The honest caveat, which belongs in the PR text: this path
**cannot be measured here** — the only test machine is Metal — and a long call
on CPU may take well over an hour.

**Retention (open question 7) — defaulted:** PR B deletes `complete`/`cancelled`
rows older than 7 days on boot. Rows carry a transcript snapshot, so they are not
free to keep.

## Deviations taken during implementation of PR A

Recorded so the next reader does not assume the plan and the code agree.

| # | Plan said | Shipped | Why |
|---|---|---|---|
| D1 | Port title generation into main, reusing the pipeline's `TITLE_PROMPT`, re-checking regenerability before writing (review M1). | Title generation **stays in the renderer**, unchanged, running after the composed text returns. | M1's race only exists because a *persisted* job can resume hours later. PR A has no persistence, so the race is not introduced, and porting it would have created the third copy of the logic M1 warned about. **This must be revisited in PR B**, where resumption makes M1 real. |
| D2 | `noteActionRunner` reads the note to confirm it still exists. | The runner is pure: it receives the snapshot and never touches the database. | Keeps the module free of Electron and directly unit-testable. Existence checking belongs with the persisted queue in PR B. |
| D3 | Compose-overflow failure is surfaced as an error only. | A run that completes **with** gap markers also raises a warning toast (`notes.actions.errors.partialResult`, 10 locales) and sets `partial` on the note state. | The plan required gap markers to be visible; returning notes with a silent hole is the exact failure this feature exists to prevent. |
| D4 | Cancellation is checked between passes. | Also wired end-to-end: `cancelAction` now calls `cancel-note-action`, which aborts the main-process run. | Today's cancel was cosmetic; a 15-minute run makes that unacceptable. Granularity is still one pass. |

## Open questions — genuinely unverified

1. **Extraction prompt quality.** Whether specifics survive extraction is a
   wording problem I cannot test offline. Needs one real long-call run before
   anyone trusts the output. This is the single biggest risk in the plan and it
   is not closable by review.
2. **Wall clock.** 10 chunks + 1 compose + 1 title = **~12 passes** for the
   user's 494k-char note; at an estimated 40–90 s per pass that is **8–18 min**.
   Extrapolated from typical Metal prefill/decode rates for a 4 B Q4 model,
   **not measured on this machine**. The review judged the per-pass range
   defensible on Metal (compose, with a 2048-token decode, sits at the top of
   it) but it remains an estimate.
3. **Is `chunkBudget = inputBudget × 0.75` right?** Chosen so the extraction
   system prompt plus an 800-token reply fit with margin. Unverified against a
   real run; too high fails the pre-flight guard mid-run, too low costs passes.
4. **`interactive` timeout of 180 s, and the model-swap cost (I3).** If a pass
   plus a cold multi-GB model load exceeds 180 s, dictation falls back to raw
   paste while a perfectly healthy job runs. Whether 180 s clears that ceiling
   depends on (2) and on load time for the user's second model — neither
   measured. A user running one local model for every scope never sees this.
5. **The CPU backend (I5).** The 300 s per-request timeout is a hard literal at
   `llamaServer.js:508`, and on the non-GPU fallback (`:226-235`) a ~15k-token
   prefill may exceed it on every pass. The proposed remedy — a raised batch
   timeout plus a smaller `chunkBudget` when the backend is CPU — is
   **unmeasured**, and this repo's only test machine is Metal. The honest
   fallback is to state that multi-pass is Metal/Vulkan-viable and let the CPU
   path keep today's fail-fast behaviour. Needs a decision.
6. **Idle-timeout interaction.** `llamaServer` stops the server on idle to free
   VRAM (`:455-463`). Each pass resets the timer, so a run holds it open — but a
   *gap between jobs* will stop and restart the server, adding a cold load
   inside a batch. Not measured.
7. **`model_jobs` growth.** Rows carry a full transcript snapshot (up to ~500 KB
   each). Proposal: delete `complete`/`cancelled` rows older than 7 days on
   boot. Not yet agreed.
8. **Scope size.** Four new modules, a new lease IPC, error codes in
   `llamaServer`, a schema change, five converted call sites, two new UI surfaces
   and 10 locales — larger than the first draft, because the review's fixes are
   not free. Splitting (L0 + L1 + L2 multi-pass first; L3 + L4 queue second) is
   plausible. **The user must decide** — flagged, not assumed.
9. **`postCallPipelineManager`'s own `slice(0, 8000)`** (`:448`) is the same
   disease and is deliberately *not* fixed here, to keep the blast radius to the
   note-action path. L1 is built CommonJS specifically so that follow-up is a
   mechanical port.

## Review outcomes

*(to be filled in after the adversarial review — nothing here has been reviewed
yet)*
