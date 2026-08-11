# Plan — The local model hangs the machine, and long calls get cut short

Date: 2026-08-11
Base: `fix/meeting-detection-resilience-and-telemetry` @ `0948f9ef` (v1.14.0, PR #34 open)
Branch: `fix/local-llm-context-and-long-transcripts`
Target version: 1.15.0

---

## Symptom

Running a note action ("generate notes") on a meeting note with the local model
made the whole machine unresponsive. The user force-quit after ~3 min 17 s.

---

## Measured evidence

On the user's machine, from the 1.14.0 session (17:03:21–17:06:38 local):

| measurement | result |
|---|---|
| `gemma4.context_length` in the GGUF header | **131072** |
| GGUF geometry | `block_count=42`, `head_count_kv=2`, `embedding_length=2560`, `head_count=8` ⇒ head_dim 320 |
| naive f16 KV at 131072 ctx | `131072 × 42 × 2 × 640 × 2 B` ≈ **14.1 GB** (upper bound — llama.cpp may reduce via SWA) |
| model weights | **5.0 GB** |
| machine RAM | **24 GB** |
| GGUF `atime` | **17:03:23**, 2 s after launch — the server pre-warms at startup |
| whisper model `atime` | Jul 16 / Jul 27 — **no re-transcription ran** |
| largest note prompt | note 14: **494,243 chars ≈ 124k tokens** (fits inside 131k ⇒ not rejected, fully processed) |
| notes written today | **none** — nothing completed |
| log | `qdrant health check failed` ×2 (17:05:13, 17:06:13) — consistent with a starved machine |
| crash / jetsam | **none** — the machine thrashed rather than something being killed |

---

## Verified root causes

### 1. `--ctx-size` is never passed to `llama-server`

`src/helpers/modelManagerBridge.js:368-372` computes and passes it:

```js
await this.serverManager.start(modelPath, {
  contextSize: options.contextSize || modelInfo.model.contextLength || 4096,
  threads: options.threads || 4,
  gpuLayers: 99,
});
```

`src/helpers/llamaServer.js:131-145` builds its args from `--model`, `--host`,
`--port`, `--threads`, `--jinja`, plus a hardcoded `--n-gpu-layers 99` on darwin.
**`contextSize` and `gpuLayers` are silently dropped** — `llamaServer.js` never
references `contextSize` (`grep` → 0 hits). The binary's default is
`-c 0` = "loaded from model" (confirmed from `--help`), so it allocates the
model's full 131,072-token KV cache on every run.

**The registry is not a safe source for this bound.** `modelRegistryData.json`
declares `contextLength: 262144` for `gemma-4-e4b-it-q4_k_m` — *twice* the
GGUF's real 131072. Wiring the existing plumbing through unchanged would ask for
**more** context, not less. The bound must come from the machine.

### 2. The note-action prompt is unbounded

`src/components/notes/PersonalNotesView.tsx:1052-1057` assembles
`note content + "## Meeting Transcript\n" + entire formatted transcript`, and
`src/stores/actionProcessingStore.ts:164` passes it to `processText` uncapped.
The post-call pipeline truncates (`postCallPipelineManager.js:359,394` →
`slice(0, 2000)`; `:448` → `slice(0, 8000)`); this path does not.

Both defects are **pre-existing**: `llamaServer.js` last changed 2026-06-30,
the action path 2026-07-30. Neither is in the 1.14.0 diff (verified against
`git diff main..HEAD`).

### 3. Cancellation is cosmetic

`actionProcessingStore.ts:209-217` sets a flag and clears UI state; the in-flight
HTTP request keeps running. During the incident there was no way to stop it.

### 4. The failure was undiagnosable from the log

1.14.0 persists `warn`+ only. Inference and pipeline progress log at `info`, so
the log showed the qdrant failures and nothing about what was actually grinding.

---

## Proposed fix

### Part 1 — bound the context (this is what stops the hang)

New pure module `src/helpers/llamaContext.js`:

```js
resolveContextSize({ requested, totalMemBytes })
```

- Ceiling from RAM: ≤8 GB → 4096; ≤16 GB → 8192; ≤32 GB → 16384; else 32768.
- Returns `clamp(requested || ceiling, 2048, ceiling)`.
- Pure, no Electron import ⇒ directly unit-testable.

`llamaServer._doStart` passes `--ctx-size <resolved>`. On this machine:
131072 → **16384**, cutting the KV allocation ~8× (~14 GB → ~1.8 GB).

`gpuLayers` stays hardcoded — out of scope, noted as follow-up.

### Part 2 — extract → compose for long transcripts (user decision, 2026-08-11)

Chosen over map-reduce (double compression loses the specifics the user cares
about) and rolling notes (one bad pass poisons the rest). **No cloud routing**
and **no consent prompt** — it runs and shows progress.

**New pure util `src/utils/transcriptChunker.ts`:**
- `estimateTokens(text)` → `ceil(len / 3.6)` (deliberately conservative).
- `chunkSegments(segments, budgetTokens)` → packs whole segments, never splits
  one, overlaps the last segment of the previous chunk for continuity.

**New `src/stores/noteActionOrchestrator.ts`**, called from
`runBackgroundAction` (`actionProcessingStore.ts:~150`):

1. Estimate the assembled prompt. If it fits the budget → **exactly today's
   single call** (cloud path therefore unchanged).
2. Over budget → chunk, then per chunk run a fixed **extraction** prompt
   (decisions, action items with owner/deadline, facts and numbers, open
   questions, notable quotes) at `maxTokens 800`, `temperature 0.1`, instructed
   to quote rather than paraphrase. Extraction prompts are AI system prompts ⇒
   **not** translated (CLAUDE.md).
3. Compose once: the user's real action prompt over
   `note content + all extracts`, `maxTokens 2048`.
4. **Compose-overflow guard:** if the extracts themselves exceed the input
   budget, fold adjacent pairs once (deterministic, at most one extra level).
5. Between passes, check `cancelledFlags` — cancellation becomes real at
   ~1-pass granularity.
6. A failed chunk is retried once; on second failure insert
   `[extraction failed for this section]` and continue. A note that marks a gap
   beats losing the whole run at pass 3 of 7.
7. Extracts cached by `(noteId, contentHash, chunkIndex)` in a module-level map,
   so a retry resumes. Not persisted across app restart — follow-up.

**Budget source.** Local: new IPC `get-local-inference-limits` returning the
same `resolveContextSize` value the server was started with — we set it, so we
know it; no need to query the server. Cloud: registry `contextLength` (fine as a
floor for cloud; all relevant entries ≥128k). Input budget =
`floor(ctx × 0.6)`, leaving room for system prompt + output.

**Progress.** `NoteActionState` gains `{ phase: "extracting"|"composing",
currentPass, totalPasses }`; `ActionProcessingOverlay.tsx:90-97` swaps its
indeterminate bar for a determinate one plus "pass k of N". i18n in all 10
locales.

Estimated wall clock on this machine for the 124k-token note: ~11–14 passes,
**~9–16 min**, shown as progress and cancellable throughout. Today's behaviour
is an unbounded swap-bound grind against a 300 s timeout it usually loses.

### Part 3 — make this class of failure debuggable

**3a. 30-day retention.** `_pruneOldLogs` currently keeps 10 files by mtime.
Change to prune by **age (30 days)** with a file-count backstop (keep ≤60) so a
restart loop cannot fill the disk. Both bounds, not either.

**3b. A `notice` level that always persists.** `LOG_LEVELS.notice = 35`,
`PERSIST_FROM = 35`. `notice` and above reach disk at the default `info` level;
`debug`/`info` stay gated. This gives a way to record heavyweight lifecycle
events without turning on full debug logging.

**3c. Instrument the path that hung**, at `notice`:
- `llama-server` start: model, resolved ctx, requested ctx, estimated KV bytes,
  threads, backend.
- inference start: prompt chars, estimated tokens, budget, single-pass vs
  `pass k of N`.
- inference finish: elapsed ms, output chars.
- `warn` when a single request exceeds a slow threshold (60 s) or when a prompt
  is over budget and gets chunked.

That turns tonight's silence into: server started at ctx N with an estimated KV
of X GB, prompt was Y tokens against budget Z, split into N passes, pass 3 took
88 s.

---

## Test plan

Baseline to preserve: **628 tests / 623 pass / 0 fail / 5 skipped**
(`npm rebuild better-sqlite3` first — ABI toggle).

Part 1
- [ ] `resolveContextSize` clamps by RAM tier; never exceeds the ceiling; floors at 2048
- [ ] A registry value of 262144 on a 24 GB machine resolves to 16384 (the actual bug)
- [ ] `llamaServer` spawn args contain `--ctx-size` (source-level wiring test, since
      spawning the real server is not viable in `node --test`)

Part 2
- [ ] `estimateTokens` is conservative (never under-estimates for ASCII)
- [ ] `chunkSegments` never splits a segment, respects the budget, overlaps by one
- [ ] A transcript that fits produces **exactly one** `processText` call (cloud unchanged)
- [ ] An over-budget transcript produces N extraction calls + 1 compose call
- [ ] Cancelling between passes stops further passes
- [ ] A chunk that fails twice yields a gap marker and the run still completes
- [ ] Cached extracts are reused on a re-run with the same content hash
- [ ] Compose-overflow folds once rather than sending an over-budget compose

Part 3
- [ ] `notice` persists at the default level; `info` still does not
- [ ] Files older than 30 days are pruned; newer ones survive; the count backstop holds
- [ ] Slow-request warning fires past the threshold

Manual (needs a build)
- [ ] Note 14 (494k chars) with the local model: progress shows N passes, machine stays usable
- [ ] Cancel mid-run actually stops it
- [ ] Log shows ctx, KV estimate, prompt size, per-pass timings

---

## Alternatives rejected

- **Truncate like the pipeline does.** Explicitly rejected by the user: losing
  the tail of a long call is the thing to avoid. (The pipeline's own
  `slice(0, 8000)` — under 2 % of a 494k-char call — is the same disease and is
  flagged as follow-up.)
- **Route long calls to the cloud.** Fast and full-fidelity, but sending a
  meeting transcript off-device must stay an explicit choice; the user picked
  local multi-pass.
- **Map-reduce.** Summary-of-summaries erodes exactly the specifics (numbers,
  owners, decisions) that matter.
- **Semantic/topic chunking via embeddings.** Better coherence, but an
  embeddings pass over 124k tokens on an already-strained machine for a marginal
  gain. The chunker interface leaves room for it later.
- **Fix only the context size.** Stops the hang but leaves long calls unusable
  locally (a 124k-token prompt into a 16k context would now be rejected outright).

---

## Review outcomes (adversarial review, 2026-08-11)

Verdict: **diagnosis sound, fix defective.** Three CRITICAL findings, each
independently re-verified against the code before acceptance.

| # | Finding | Resolution |
|---|---|---|
| C1 | Nothing on the request path asks for 131072. `localReasoningBridge.js:40` sends `contextSize: config.contextSize \|\| 4096`, so note actions request **4096**; only `prewarmServer` (`modelManagerBridge.js:443`) sends the registry's 262144. `clamp(requested \|\| ceiling, …)` therefore yields **4096** on the path that hung, and the effective ctx flips between 4096 and 16384 depending on who started the server. **Verified.** | `resolveContextSize` becomes **authoritative** — the caller's `contextSize` is ignored, not used as the base. The resolved value is deterministic per (model, machine), so it no longer matters who starts the server. The manager records it for the IPC to read. |
| C2 | **0 of 42** cloud models in `modelRegistryData.json` declare `contextLength` — the key exists only on `localProviders`. The planned cloud budget source does not exist; a naive read gives `undefined` → NaN. **Verified.** | Chunking applies **only when the resolved provider is local**. Cloud and self-hosted keep today's single call exactly. No registry dependency, no cloud regression. |
| C3 | Extract cache keyed on `(noteId, contentHash, chunkIndex)` is unsound both ways: chunk boundaries move with the budget, so the same key can name different text (stale extract composed into notes, silently wrong); and editing one character of manual notes busts the whole cache though every transcript-derived chunk is identical. | **Cache cut from v1.** Correctness first; if reintroduced, key by a hash of the chunk text plus an extraction-prompt version. |
| I1 | `localReasoningBridge`'s `isProcessing` mutex is shared with dictation cleanup/agent (`ipcHandlers.js:3237`) and the post-call pipeline (`mainProcessInference.js:50`). A 9–16 min run makes all of them throw "Already processing a request", and the planned retry-then-gap-marker would turn a transient collision into a **silent hole in the user's notes**. | Orchestrator must treat mutex-busy as transient (wait and retry, never a gap marker) and abort after K consecutive genuine failures. The dictation-blocked-during-a-long-run limitation is inherent to one local server and must be stated in the PR. |
| I2 | `chunkSegments` needs segments, but `runBackgroundAction` receives only the pre-assembled string — segments are parsed and discarded inside the closure at `PersonalNotesView.tsx:1036-1057`. An interface change the plan never mentioned. | `runAction`/`runBackgroundAction` signature carries the raw transcript/segments. Non-meeting notes (no segments) fall back to paragraph-boundary packing. |
| I3 | Static RAM tiers break setups that work today: a small model with a tiny KV runs full-context happily on 8 GB, and the ≤8 GB tier would cap it at 4096, breaking local chat-agent prompts. llama.cpp does **not** error when ctx > trained ctx — it warns and silently degrades quality. | Tiers replaced with **geometry-aware math** from the GGUF header (open question 1 resolved as *yes, now*): `ctx = clamp(kvBudgetBytes / kvBytesPerToken, floor, trainedCtx)`. The registry is proven wrong (262144 vs 131072), so the GGUF is the only trustworthy bound. |
| I4 | `llamaServer.js:217` deliberately sets `LLAMA_ARG_FIT` off ("adds ~70s to startup") — upstream's own fit-to-memory remedy for this exact class of hang. Unevaluated. | Recorded under Alternatives rejected: ~70 s added to every cold start is too high a price for a bound we can compute in microseconds from the header, and it would not bound the *prompt*. |
| I5 | With the ctx capped and no Part 2, an over-budget prompt now fails with a raw llama-server error body, untranslated, and on paths Part 2 never covers (chat agent, long dictation). | This PR adds a pre-flight budget check that fails with a typed code and **one translated message in all 10 locales**, rather than letting a raw 400 reach a toast. |
| M1–M9 | Citation drift (`:163` not `:164`, `:369-373` not `:368-372`); per-pass notices must keep variable data in `meta` not the message (throttle keys); renderer `logger.ts` needs `notice` too; retention's 60-file backstop can evict the 30-day history during a warn storm; `--ctx-size` needs a source-level test since `llamaServer.js` requires Electron at module scope; new IPC needs preload + types. | All accepted and folded in. Retention: the count backstop is raised and the age bound is primary. |

### Sequencing decision

The review recommends three PRs; this is now **two**, because the user asked for
the hang fix and the logging together:

- **This PR** — Part 1 (correctly wired per C1/I3) + Part 3 + the translated
  over-budget error (I5). Everything here is fully understood and testable
  offline, and it converts "machine unresponsive" into a clean, explained
  failure.
- **Next PR** — Part 2, with the corrected design (local-only, no cache,
  transient-aware retry, segment-carrying signature). It is the largest and
  least certain piece — by the plan's own admission the extraction prompt
  quality cannot be validated offline — and it should not gate the hang fix.

## Open questions

1. **`--ctx-size` vs models with a smaller trained context.** Asking for 16384
   on a model trained at 4096 makes llama.cpp apply RoPE scaling rather than
   fail. Should the resolved value also be capped by the GGUF's real
   `context_length` (needs a small GGUF header reader — ~40 lines, already
   prototyped during the investigation), or is the RAM ceiling enough for now?
2. **Is `floor(ctx × 0.6)` the right input budget?** Chosen so system prompt +
   800-token output + overhead fit with margin. Unverified against a real run.
3. **The extraction prompt is a quality lever I cannot test offline.** Its
   wording decides whether specifics survive. Needs one real long-call run
   before anyone trusts the output.
4. **Wall clock is an estimate**, extrapolated from typical Metal prefill/decode
   rates for a 4–8 B Q4 model — not measured on this machine. It could be
   materially wrong in either direction.
5. **Stacked on PR #34.** Part 3 edits the rotation code introduced there.
   Merge #34 first; this PR's base is that branch so GitHub retargets on merge.
