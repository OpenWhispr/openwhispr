# Plan — 1.16.1 hotfix: size the local model against memory that actually exists

Date: 2026-08-12
Base: `main` @ `69c382b1` (v1.16.0)
Branch: `fix/memory-aware-context-budget`
Target version: **1.16.1** (patch — bug fix, no new capability)

---

## Symptom

Running a note action on a previous transcript with the local model made the
machine unresponsive again. The user could not type into a terminal and force-quit
the app while it was stuck on **pass 3 of 5**.

This is the same class of failure 1.15.0 was supposed to have fixed.

---

## Measured evidence

From `~/Library/Application Support/open-whispr/logs/debug-2026-08-12T17-30-21-370Z.log`
(the `notice`-level instrumentation added in 1.15.0 — this is exactly what it was for):

```
[17:50:55] Starting llama-server {
  model: "google_gemma-4-E4B-it-Q4_K_M.gguf",
  modelBytes: 5405168384,          // 5.40 GB
  contextSize: 32768,              // NOT 131072 — the 1.15.0 bound held
  trainedContext: 131072,
  estimatedKvBytes: 3523215360,    // 3.52 GB — NOT 13.1 GB
  kvBudgetBytes: 3614262937,
  source: "memory-bound",
  totalMemBytes: 25769803776       // 24 GB
}
[17:51:46] Local inference finished { elapsedMs: 43236, promptChars: 54888, outputChars: 2931 }
[17:52:27] Local inference finished { elapsedMs: 40338, promptChars: 55125, outputChars: 1887 }
[17:53:55] WARN qdrant health check failed        // starvation signature
[17:54:07] WARN macos-mic-listener exited          // force quit
```

Pass 3 started ~17:52:27 and never finished. Passes 1 and 2 took 43 s and 40 s.

Machine state measured **with OpenWhispr not running**:

| measurement | value |
|---|---|
| total RAM | 24 GB |
| active + wired + compressed | **17.4 GB** |
| `os.freemem()` | **0.07 GB** |
| genuinely reclaimable (`vm_stat`: free + inactive + speculative + purgeable) | **3.70 GB** |
| swap used | **44.2 GB of 45 GB** |

Ruled out by measurement, not assumption:

- **No orphaned `llama-server`.** `ps` after the force-quit shows none; the child did not survive.
- **Not competing with the local build.** `dist/OpenWhispr-1.16.0-arm64.dmg` was written at
  13:27:07 local; the app launched 13:30 and the note action ran at 13:50 — 24 minutes later.
- **Not a context-sizing regression.** The log proves 32768/3.52 GB, exactly as 1.15.0 intended.

---

## Verified root causes

### RC1 — the KV budget is computed from *total* RAM, not available RAM

`src/helpers/llamaContext.js:29-33`:

```js
const kvBudgetBytes = Math.min(
  Math.max(Math.floor((totalMemBytes || 0) * MEMORY_SHARE) - modelFileBytes, MIN_KV_BUDGET),
  MAX_KV_BUDGET
);
```

`MEMORY_SHARE = 0.35` (`:19`) of **`os.totalmem()`**. On a 24 GB machine that is 8.4 GB
regardless of what is already resident. Subtracting the 5.40 GB of weights leaves
3.61 GB — which the log confirms.

Total `llama-server` footprint is therefore **weights 5.40 GB + KV 3.52 GB ≈ 8.9 GB**,
requested on a machine with **17.4 GB already committed**. 17.4 + 8.9 = **26.3 GB on a
24 GB machine.** Swap was inevitable.

The resolver did precisely what it was told. What it was told was wrong.

**Why this did not bite before 1.16.0.** A single over-long call either fit or was
rejected by the pre-flight guard in seconds. Multi-pass holds 8.9 GB resident across
5 sequential passes of 40 s+ — the same allocation, sustained for minutes instead of
spiking briefly. The defect is 1.15.0's; 1.16.0 is what made it lethal.

### RC2 — the batch request timeout removed the escape hatch (introduced by me in 1.16.0)

`src/helpers/llamaServer.js:14` and the `run-note-action` handler pass
`BATCH_REQUEST_TIMEOUT_MS = 900000` in place of the previous hard 300000.

Once pass 3 began thrashing it had **15 minutes** to grind rather than 5. The user
force-quit rather than wait. I introduced this constant in 1.16.0 to help the CPU
backend — a platform this machine cannot test — and it directly worsened the platform
it can.

### RC3 — a timed-out pass is retried three times

`inferenceErrorClass.js` classifies `LLAMA_REQUEST_TIMEOUT` as `transient`, and
`noteActionRunner.runPass` gives transient failures `TRANSIENT_ATTEMPTS = 4` attempts.

**Restoring the 300 s timeout alone would make things worse, not better:** 4 attempts ×
300 s = **20 minutes** of sustained thrash on a single wedged pass, against the 15 the
user just experienced. Any fix that touches the timeout must touch this too.

This is a defect the adversarial review did not catch and the tests did not cover,
because every test injects a fake `infer` that fails instantly — retry *count* is
asserted, elapsed *time* is not.

---

## Design

**User decision, 2026-08-12: no pre-flight refusal.** Size the context down and always
try. I raised the concern that the 5.40 GB of weights is an unshrinkable floor — on a
machine with 3.70 GB reclaimable, even `MIN_CONTEXT` will swap — and the user reaffirmed.
Recorded, proceeding as decided. The consequence is that **damage-bounding, not
prevention, is the entire safety story**, which is why RC2 and RC3 matter as much as RC1.

### 1. `src/helpers/systemMemory.js` (new)

```js
availableMemBytes()  // -> { bytes, source }
```

| platform | source | why |
|---|---|---|
| darwin | `vm_stat`: (free + inactive + speculative + purgeable) × page size | `os.freemem()` counts only truly-free pages — 0.07 GB here vs 3.70 GB genuinely reclaimable. Using it would clamp every Mac to `MIN_CONTEXT`. |
| linux | `/proc/meminfo` `MemAvailable` | the kernel's own answer to this exact question |
| win32 | `os.freemem()` | already reports available physical memory |
| fallback | `os.freemem()` | any parse failure degrades to the pessimistic number rather than the optimistic one |

Synchronous (`execFileSync`/`readFileSync`) and called once per server start — not on a
hot path. Result cached for 5 s so a burst of starts cannot spawn a burst of `vm_stat`.

**Pure and injectable**: the parsing functions take raw text, so `node --test` covers
real `vm_stat` and `/proc/meminfo` fixtures without spawning anything.

### 2. `resolveContextSize` honours both bounds

```js
const shareOfTotal     = Math.floor(totalMemBytes * MEMORY_SHARE);      // 0.35, unchanged
const shareOfAvailable = Math.floor(availableMemBytes * AVAILABLE_SHARE); // 0.70, new
const kvBudgetBytes = clamp(
  Math.min(shareOfTotal, shareOfAvailable) - modelFileBytes,
  MIN_KV_BUDGET, MAX_KV_BUDGET
);
```

Taking the **minimum** keeps the existing ceiling (never hog a big machine) and adds a
floor-of-reality (never claim memory that is not there). `AVAILABLE_SHARE = 0.70` leaves
the OS headroom to page other things out gracefully.

On the incident machine: `min(8.4 GB, 0.70 × 3.70 GB = 2.59 GB) - 5.40 GB` → negative →
clamped to `MIN_KV_BUDGET` (256 MB) → ctx ≈ **2048** instead of 32768. KV 3.52 GB →
**0.22 GB**. That does not make the run fast, and the 5.40 GB of weights still will not
fit comfortably — but it stops the app *adding* 3.3 GB of avoidable pressure.

`resolveContextSize` keeps `availableMemBytes` optional, defaulting to `totalMemBytes`,
so existing callers and tests are unaffected.

The resolved `source` gains `"available-bound"` so the log states which bound applied.

### 3. Restore the timeout, and stop multiplying it (RC2 + RC3)

- `BATCH_REQUEST_TIMEOUT_MS` → **300000**, the same as interactive. The CPU-backend
  rationale for 900 s was speculative and is withdrawn until someone can measure it;
  the smaller `chunkBudget` on non-GPU backends already addresses that case.
- **`LLAMA_REQUEST_TIMEOUT` gets its own class: `slow`.** Retried **once**, not three
  times. A request that already burned the full timeout is not a transient blip.
  Worst case for a wedged pass becomes 2 × 300 s = 10 min, down from 15 (today) and
  from the 20 a naive timeout revert would have produced.
- **Run-level deadline.** `runNoteAction` takes `deadlineMs` (default 30 min). Checked
  between passes; exceeding it aborts with `LOCAL_MULTIPASS_TIMEOUT`. Bounds the whole
  run regardless of how the individual passes fail.
- **Degradation abort.** If a pass takes more than **4×** the median of completed
  passes, abort the run rather than continuing into passes 4 and 5 of a machine that is
  already thrashing. Passes 1 and 2 took 43 s and 40 s; pass 3 was still running at
  88 s and would have tripped this. This is failure handling, not a consent gate, so it
  is compatible with the "always try" decision.

### 4. Log what the machine actually had

The `Starting llama-server` notice gains `availableMemBytes` and `memorySource`. The
existing log told us the context and the KV estimate but *not* that the machine had
0.07 GB free — which is the one number that would have made this diagnosable in one
read instead of five.

---

## Test plan

Baseline to preserve: **705 tests / 700 pass / 0 fail / 5 skipped**
(`npm rebuild better-sqlite3` first — the build flipped the ABI to Electron).

**`systemMemory`** — new
- [ ] parses real `vm_stat` output (fixture) to the expected byte count
- [ ] parses `/proc/meminfo` `MemAvailable` (fixture)
- [ ] a malformed / empty / truncated payload falls back to `os.freemem()`, never throws
- [ ] the reported `source` names the mechanism used
- [ ] the 5 s cache prevents repeat probes

**`llamaContext`** — extend
- [ ] **the incident case**: total 24 GB, available 3.70 GB, model 5.40 GB → ctx ≤ 2048,
      not 32768 (regression test for this exact bug, with the real numbers)
- [ ] plentiful available memory reproduces today's answer exactly (no regression on a
      healthy machine)
- [ ] the total-RAM ceiling still binds when available memory is huge
- [ ] omitting `availableMemBytes` behaves exactly as before
- [ ] `source` reports `available-bound` vs `memory-bound` vs `trained-context`

**`inferenceErrorClass`** — extend
- [ ] `LLAMA_REQUEST_TIMEOUT` classifies as `slow`, not `transient`
- [ ] `slow` is still never `genuine` — no gap marker for a timeout

**`noteActionRunner`** — extend
- [ ] a `slow` failure is retried **once**, then fatal (assert the attempt count)
- [ ] exceeding `deadlineMs` aborts with `LOCAL_MULTIPASS_TIMEOUT`
- [ ] a pass 4× slower than the median aborts the run (injected clock)
- [ ] the degradation check does **not** fire on a normal run, or on the first pass
      where there is no median yet

**Manual — the only thing that actually proves this**
- [ ] on the incident machine, in its normal working state, run the same note action:
      the log shows a small `contextSize` with `source: "available-bound"`, and the
      desktop stays responsive
- [ ] confirm a healthy machine (memory free) still resolves 32768 and is not slowed

---

## Open questions

1. **`AVAILABLE_SHARE = 0.70` is a guess.** Too high and it still swaps; too low and
   every run is slow. Unmeasured.
2. **The degradation threshold (4× median) is a guess.** A legitimately larger final
   chunk could trip it. Mitigated by only comparing after two completed passes.
3. **This does not make the feature *work* on a loaded 24 GB machine** — it stops it
   making things worse. With 5.40 GB of weights and 3.70 GB reclaimable, the honest
   answer for this machine in this state is a cloud model or fewer open apps. The user
   has explicitly declined a pre-flight refusal, so the app will try and be slow rather
   than decline and be fast.
4. **`vm_stat`'s "inactive" is not all reclaimable** — some is dirty and must be written
   to swap first. 0.70 is partly a hedge against that; a more accurate figure would
   subtract dirty pages, which `vm_stat` does not report directly.
5. **Whether `estimatedKvBytes` matches what llama.cpp actually allocates** is still
   unverified — the app does not capture `llama-server`'s own memory report. Gemma's
   sliding-window attention may mean the real KV is smaller than the estimate, in which
   case the pressure came proportionally more from the weights.

## Review outcomes (adversarial review, 2026-08-12)

Verdict: **direction right, plan not implementable as written.** Three CRITICAL. Each
re-verified against the code and by re-deriving the arithmetic before acceptance.

| # | Finding | Verified? | Resolution |
|---|---|---|---|
| C1 | Adding a time-varying input **breaks the invariant between the two `resolveContextSize` call sites** (`llamaServer.js:156` at start, `modelManagerBridge.js:480` at planning). My own docstring at `:458-466` claims they "agree by construction" — true only while every input is stable. Worse, when the server is **already running** its weights and KV are *already excluded* from available memory, so subtracting `modelFileBytes` again double-counts. Concrete: second note action on the incident machine plans ctx 2048 against a server actually running at 32768 → ~64 needless passes; the reverse skew makes every chunk fail the pre-flight guard → gap markers → abort at 3. | **Yes** — read `resolveModelContext`; it never consults `serverManager.contextSize`. | `resolveModelContext` returns the **live** `serverManager.contextSize` when the server is up with the target model; the cold estimate is used only otherwise. Available memory is snapshotted once per resolution. `modelFileBytes` is subtracted only on a cold start (weights are mmapped and file-backed). |
| C2 | **The fix as designed is strictly worse than the bug.** At `MIN_CONTEXT = 2048`, `chunkBudget` = 921 tokens. Re-derived: the incident transcript → **65 chunks**, a 137k-token note → **150 chunks**. Then the fold cap (`MAX_FOLD_LEVELS = 2`) reduces 150 → 75 → 38 extracts of ≤800 tokens = **30,400 tokens against an inputBudget of 1,228** — a *provable* `LOCAL_CONTEXT_EXCEEDED` at `noteActionRunner.js:267`, reached only **after** 150+ inference calls and hours of the exact thrash being fixed. | **Yes** — computed with the real functions. Output in the session log. | **Fail-fast arithmetic pre-check before pass 1.** If `ceil(chunks / 2^MAX_FOLD_LEVELS) × EXTRACTION_MAX_TOKENS + notePreamble > inputBudget`, throw `LOCAL_CONTEXT_EXCEEDED` immediately. This is **not** the memory consent gate the user refused — it is the identical error the runner already throws, moved before the wasted hours. Also: `COMPOSE_MAX_TOKENS` must be clamped to the resolved context (2048 output at ctx 2048 leaves nothing for the prompt). |
| C3 | The degradation abort **could not fire on the incident it claims to catch.** `runPass` is awaited (`noteActionRunner.js:210`); control returns only when a pass settles. A between-pass 4×-median check catches a *slow completed* pass, never a hung one. My claim that pass 3 "would have tripped this" is false. | **Yes** — read the await. | Replaced with a **per-pass watchdog that races `infer`**, aborting the in-flight HTTP request via `req.destroy()`. Because aborting the runner does not stop `llama-server` — which keeps weights and KV resident and may keep prefilling — the abort path also stops the server, and the idle timer is cleared so it cannot linger 5 more minutes. |
| I1 | RC1's magnitudes are overstated. Weights are **mmapped, file-backed and evictable** — not commit — so "17.4 + 8.9 = 26.3 GB" is not sound accounting. And `kvBytesPerToken` (`ggufMetadata.js:137-141`) assumes every layer caches the full context; if this Gemma uses sliding-window attention, real KV may be several times smaller. Net benefit is likely ~0.5–1.5 GB, not 3.3 GB. The overestimate *also* shrinks ctx below what is truly affordable on every machine, amplifying C2. | Accepted — the reasoning is sound and my own Open Questions 3/5 already conceded it. | RC1's arithmetic softened below. A **SWA-aware KV estimator** is recorded as the highest-leverage follow-up, not attempted in a hotfix. |
| I2 | Healthy-machine parity holds only when available ≥ 0.5 × total. 64 GB/40 GB → 65536 unchanged; 16 GB/10 GB → 4096 unchanged (**today's value is 4096, not 2048** as I wrote). But **24 GB with 8 GB available: 32768 → 4096**, ~8× the passes on a machine that completes fine today. | **Yes** — the middle band is real. | `AVAILABLE_SHARE` raised to **0.80** and a **`MULTIPASS_MIN_CONTEXT` floor of 8192** introduced: below it, multi-pass is not viable anyway (C2), so the arithmetic pre-check fails fast instead of the budget silently producing a 150-pass run. |
| I3 | `execFileSync` on a machine deep in swap can block the **Electron main process** for seconds — freezing all windows and IPC, the exact symptom under repair. Also: `vm_stat`'s page size is **16384 on Apple Silicon**, not 4096, and "Pages purgeable" **overlaps** active/inactive, so including it double-counts and overestimates available memory. | **Yes** — both call sites are already async. | Async `execFile` with a 2 s timeout, falling back to `os.freemem()`. Page size parsed from `vm_stat`'s own header. `purgeable` **dropped** from the sum. |
| I4 | `actionProcessingStore.ts:290` translates only `LOCAL_CONTEXT_EXCEEDED`; new codes would surface raw English. CLAUDE.md requires all 10 locales. | **Yes**. | i18n added for `LOCAL_MULTIPASS_TIMEOUT` and the degradation abort, in all 10 locales. |
| I5 | `slow`-class spec gaps: backoff applies only to `transient` (`:107`), so a `slow` retry fires immediately at a server still grinding; exhaustion behaviour unspecified; `TRANSIENT_PATTERNS` `/timed out/i` (`inferenceErrorClass.js:33`) would silently regress timeouts to 4 attempts if the code were ever lost in a rewrap; `LLAMA_START_FAILED`/`LLAMA_START_TIMEOUT` stay transient ×4 = up to four consecutive 5.4 GB model loads under thrash. | **Yes**. | `slow` gets backoff, throws on exhaustion, and a test pins that a timeout is `slow` **by code and by message**. Start failures capped at **2** attempts. |
| M1 | RC2 understates today's defect: retries apply now too, so the current worst case is 4 × 900 s ≈ **60 min**, not 15. | **Yes**. | Prose corrected. Strengthens the case for the fix. |
| M2 | In *this* incident the timeouts were never reached — the user force-quit ~100 s into pass 3. RC2/RC3 matter for the wait-it-out counterfactual. The main-process event loop stayed alive (the qdrant warning fired at 17:53:55), so timers would have fired, late but reliably. | **Yes**. | Recorded; RC2/RC3 retained as real but correctly scoped. |

**Cleared by the review** (checked, no change needed): RC1's arithmetic re-derived exactly
against the log — `floor(0.35 × 25769803776) − 5405168384 = 3614262937` = logged
`kvBudgetBytes`, and `3523215360 / 32768 = 107520` per token → 32768 = logged
`contextSize`, every number matching; RC3 confirmed real (`LLAMA_REQUEST_TIMEOUT` ∈
`TRANSIENT_CODES` at `inferenceErrorClass.js:15`, `TRANSIENT_ATTEMPTS = 4`); RC2
confirmed real against `git show 6c24f7c2:src/helpers/llamaServer.js`; a wedged request
*does* eventually reject via `req.destroy()` (`llamaServer.js:578-581`); local-only still
holds — zero of the cloud models declare `contextLength`, 31 local ones do; nothing in
the plan is already implemented; no existing test could catch this (the harness `sleep`
is a no-op and fakes throw instantly — retry *count* is asserted, elapsed time never);
64 GB and 16 GB machines resolve identically before and after; **1.16.1 patch is the
correct bump**; and no per-pass memory-growth mechanism exists, so "pass 3 not pass 1" is
cumulative system pressure as the plan says.

---

## Revised design (supersedes the Design section above where they conflict)

1. **`systemMemory.js`** — async `execFile` (2 s timeout), page size parsed from
   `vm_stat`'s header, `purgeable` excluded, `os.freemem()` fallback. Pure parsers,
   fixture-tested.
2. **`resolveContextSize({ availableMemBytes })`** — `min(0.35 × total, 0.80 × available)`,
   `modelFileBytes` subtracted **only on a cold start**.
3. **`resolveModelContext`** — returns the **live** server context when the server is up
   with the target model; cold estimate otherwise. Kills the C1 divergence.
4. **Fail-fast arithmetic pre-check** in `runNoteAction` before pass 1 (C2), plus
   `COMPOSE_MAX_TOKENS` clamped to the resolved context.
5. **Per-pass watchdog** racing `infer`, destroying the in-flight request and stopping
   the server on abort (C3).
6. **`slow` class** for `LLAMA_REQUEST_TIMEOUT`: 2 attempts with backoff, throws on
   exhaustion. Start failures capped at 2. Batch timeout back to **300000**.
7. **i18n** for the new failure codes in all 10 locales.

### The consequence the user must know

On the incident machine **in its current state** (3.70 GB reclaimable, 5.40 GB of
weights), the memory-aware budget resolves a context too small for multi-pass to close
arithmetically. The run will therefore **fail fast with the translated "too long for the
local model" message** — 1.15.0's behaviour — rather than stalling the desktop.

That is a direct consequence of the "size smaller and always try" decision meeting the
fold arithmetic: it *does* try, determines in milliseconds that it cannot finish, and
says so. It is not the memory consent gate that was refused. But it means **the feature
will not run on this machine until memory is freed or a cloud model is used**, and that
should be stated plainly rather than discovered.
