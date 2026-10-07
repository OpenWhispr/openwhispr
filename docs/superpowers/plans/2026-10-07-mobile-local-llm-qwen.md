# Mobile On-Device LLM (Qwen3.5-2B) Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. All paths are relative to `openwhispr-mobile/` unless they start with `/` or `src/helpers` (desktop).

**Goal:** Let users download Qwen3.5-2B (~1.3 GB GGUF) to the mobile app, and use it on the phone for dictation cleanup and AI meeting notes. It also runs note chat. The assistant comes in a later phase. Phones without enough memory see a clear explanation instead of a download button.

**Architecture:** "On-Device" text mode today means Apple Foundation Models only (`modules/apple-llm`, `src/lib/localReasoning.ts`, `src/services/reasoning/LocalReasoningService.ts`). This plan puts a small **engine layer** behind those existing seams, so every caller keeps working unchanged:
- **Apple engine:** wraps `AppleLLM`.
- **Qwen engine:** wraps `llama.rn`.

`ReasoningService`, `cleanupTranscript`, `localMeetingNotes`, `useNotesStore` and the note chat keep calling the same functions. Those functions now pick an engine per task and report which engine ran.

**Platform:** iOS only. There is no Android app; Android-related code paths are out of scope.

**Tech stack:**
- `llama.rn` 0.12.9: llama.cpp for React Native; Metal on iOS, new architecture only.
- `expo-device`: model name and total RAM.
- `expo-file-system/legacy` downloads, following the Parakeet downloader pattern.
- Jest with inline `jest.mock`.

## Decisions (made with the user; do not re-litigate)

- **One downloadable model:** Qwen3.5-2B Q4_K_M, the same file as desktop's `qwen3.5-2b-q4_k_m` entry: `bartowski/Qwen_Qwen3.5-2B-GGUF` / `Qwen_Qwen3.5-2B-Q4_K_M.gguf`, ~1.3 GB, Apache 2.0. There is no 4B option.
- **Eligibility by RAM, not by model list:** total RAM ≥ 5 GiB.
  - On iPhone that means all 6 GB+ models: 12 Pro, 13 Pro, the 14 line and everything since.
  - The 4 GB phones (11, 12, 13, SE 2/3, XS/XR) see why it isn't available, with the phone's name and RAM.
- **Thinking off** (`enable_thinking: false`). `stripThinkingTags` (`src/services/reasoning/buildProviderPrompt.ts:20`) stays as a safety net.
- **Runtime:** `llama.rn`, so any future GGUF can replace the model without native changes.

## Answered by the user (2026-10-07)

- **Engine choice when both engines are ready (iOS with Apple Intelligence):**
  - Cleanup → Apple. It's fast, needs no extra memory, and works in the background.
  - Meeting notes and note chat → Qwen. It has a 16K context instead of 4K, so most meetings fit in one pass.
  - If the preferred engine isn't ready, use the other.
- **iPhones with Apple Intelligence** are offered the download too, for long meetings.
- **Backgrounded keyboard cleanup** that Qwen can't finish in the background is cleaned when the user next opens OpenWhispr. It is not skipped.
- **Onboarding:** the LLM download is **not** added to onboarding (1.3 GB is too much there). It is offered from Settings, and when a user picks On-Device for a text workflow with no engine ready.

## Facts this plan relies on (verified in the code)

- **Every text-LLM call** goes through `ReasoningService.processText` (`src/services/reasoning/ReasoningService.ts:118`). The one exception is local meeting notes, which call `AppleLLM.generateMeetingNotes` from `src/lib/notes/localMeetingNotes.ts:180`.
- **Local readiness** is `getLocalReasoningReadiness()` (`src/lib/localReasoning.ts:37`).
  - It is gated by `appleLocalIntelligenceEnabled` and cached.
  - Statuses are `ready | disabled | unavailable | appleIntelligenceOff | modelNotReady` (`src/types/index.ts:127`).
- **Budgets assume Apple:** a 4,096-token context and a 900-token output reserve (`localReasoning.ts:10-13`).
  - Cleanup skips transcripts over 720 tokens (`src/lib/cleanupTranscript.ts:54`).
  - Meeting notes map-reduce over chunks sized from `contextSize` (`localMeetingNotes.ts:131-305`). A larger `contextSize` therefore means fewer, larger chunks, with no new chunking code.
- **Copy is Apple-specific** in:
  - `localReasoning.ts:174-186`
  - `src/lib/localReasoningFallback.ts`
  - `src/screens/AIModelsScreen.tsx:168-169`
  - `src/screens/WorkflowSettingsScreen.tsx:671-673`
  - `src/screens/NoteEditorScreen.tsx:856`
  - Mobile has no i18n; strings are inline English.
- **Keyboard extension:** it runs no inference. Cleanup for keyboard dictation runs in the **host app while it is backgrounded** (`src/hooks/useKeyboardHandoff.ts:952`). iOS does not allow Metal work in the background.
- **ASR memory arbitration** already exists: `LocalTranscriptionService.transcribe` releases the idle engine (`src/services/transcription/LocalTranscriptionService.ts:104-116`).
  - `LocalWhisperService` already runs whisper.rn with `useGpu: false` because of an iOS 26 Metal abort (`LocalWhisperService.ts:59-66`). **The spike must check llama.rn's Metal backend for the same problem.**
- **Download pattern to copy:** `src/services/transcription/parakeetModelDownloader.ts`, which provides:
  - revision pinning and staging, then a move into place;
  - background `URLSession` resume;
  - a stall watchdog;
  - a size check;
  - `cancelAsync` on cancel.
  `src/store/useModelDownloadStore.ts` adds a single global download slot and a free-space gate (20% headroom).
- **Memory probes:**
  - `MemoryProbe.availableBytes()` (`os_proc_available_memory`) and `deviceInfo()` exist in `modules/parakeet-asr`, but only the dev benchmark screen calls them.
  - `ParakeetBenchmarkScreen` / `runParakeetBenchmark.ts` already sample the peak `phys_footprint`, which is the value Jetsam enforces.
- **Entitlements:** `com.apple.developer.kernel.increased-memory-limit` is set nowhere.
  - Main-app entitlements are spread in `app.config.js:129-132`.
  - `runtimeVersion` follows `appVersion`, so this needs a new app version, not an OTA update.

---

## Phase 0: Spike (dev build, about 2 days). Go/no-go before Phase 1

Throwaway branch off this one. Results are written into "Spike results" at the bottom of this file.

- [ ] **0.1 Native dependency**
  - `npx expo install llama.rn@0.12.9`, then add the `llama.rn` config plugin to `app.base.json`.
  - Add `com.apple.developer.kernel.increased-memory-limit` and `com.apple.developer.kernel.extended-virtual-addressing` to the main-app entitlements in `app.config.js` only, not the extensions.
  - Prebuild and build on a device.
  - Confirm it links next to `whisper.rn`: both vendor ggml and should use prefixed symbols (`lm_ggml_*` vs `wsp_ggml_*`).
- [ ] **0.2 Benchmark screen.** Add a dev-only `QwenBenchmarkScreen`, modelled on `ParakeetBenchmarkScreen`. It sideloads the GGUF, then runs cleanup and meeting-notes prompts while the existing `PeakSampler` (`startMemorySampling`) records:
  - peak `phys_footprint` and minimum available memory;
  - load time;
  - prefill and decode speed;
  - all of the above at `n_ctx` 4096 and 16384.
- [ ] **0.3 Device matrix**
  - iPhone 13 (4 GB): expect a failure. This is the proof for the eligibility threshold.
  - iPhone 14 or 15 (6 GB).
  - iPhone 15 Pro or 16 (8 GB).
- [ ] **0.4 Metal on iOS 26.** Check that `n_gpu_layers > 0` doesn't abort the way whisper.rn did. If it does, use CPU only and re-measure.
- [ ] **0.5 Background behaviour.** From the keyboard handoff flow, with the app backgrounded, run cleanup:
  - (a) with a GPU context;
  - (b) with a CPU-only context (`n_gpu_layers: 0`).
  Record whether it completes, how long it takes, and whether iOS kills the process.
- [ ] **0.6 Output controls**
  - `enable_thinking: false` produces no `<think>` block.
  - `response_format: { type: 'json_schema' }` returns valid `StructuredMeetingNotes` JSON (schema in `src/types/index.ts` / `modules/apple-llm/src/index.types.ts:32-43`).
  - Tokenizer counts are available through `context.tokenize`.
- [ ] **0.7 Pick the numbers Phase 1 uses:**
  - `n_ctx`;
  - the minimum available memory before loading (measured peak + 20%);
  - the background strategy (GPU in foreground and CPU in background, always CPU, or skip in background);
  - the idle-unload delay.

**Go/no-go:** no-go if a 6 GB iPhone cannot hold a 16K-context meeting-notes run without being killed. In that case, fall back to `n_ctx` 8192 and let the existing map-reduce chunk the meeting, or raise eligibility to 8 GB. Bring the result to the user before Phase 1.

---

## Phase 1: Engine, download, eligibility, routing

### 1.1 Device capability (`src/lib/deviceCapability.ts`, new)

- [ ] `npx expo install expo-device`.
- [ ] `getDeviceCapability(): Promise<DeviceCapability>` returns:
  - `{ modelName, totalMemoryBytes, platform, llmEligible, reason? }`;
  - `modelName` from `Device.modelName`, falling back to "this iPhone" or "this phone";
  - `totalMemoryBytes` from `Device.totalMemory`;
  - `llmEligible = totalMemoryBytes >= LLM_MIN_TOTAL_MEMORY_BYTES` (5 GiB, a constant).
- [ ] `formatIneligibleReason(cap)` produces, for example: "On-device AI needs a phone with at least 6 GB of memory. iPhone 13 has 4 GB, so cleanup and notes use OpenWhispr Cloud." Show the RAM rounded to the advertised size: `Math.round(bytes / 2^30)`.
- [ ] iOS runtime headroom: add `availableMemoryBytes()` to a new tiny local module `modules/memory-probe`, which moves `MemoryProbe.swift` out of `parakeet-asr` so both modules share it.
- [ ] Tests: `src/lib/__tests__/deviceCapability.test.ts`, covering 3.7 GB (4 GB phone) → ineligible, 5.6 GB → eligible, a missing `modelName`, and a `null` total memory → ineligible with a generic reason.

### 1.2 Model catalog and downloader

- [ ] **Catalog: `src/lib/localLlmCatalog.ts`.** Keep it separate from `LocalModelKey`, which stays speech-only so `isLocalModelKey` can never accept an LLM key as a transcription `modelId`.
  - `LocalLlmKey = 'qwen3.5-2b'`.
  - Fields: title "Qwen3.5 2B", `hfRepo`, `fileName`, a **pinned revision sha** (looked up at implementation time and hard-coded), `sizeBytes`, and license "Apache 2.0".
- [ ] **Downloader: `src/services/llm/llmModelDownloader.ts`.** Factor the model-agnostic parts out of `parakeetModelDownloader.ts` (resumable download, stall watchdog, resume-rejected retry, HTML/non-2xx rejection) into `src/services/download/resumableDownload.ts`, and use them from both downloaders.
  - Stage under `${documentDirectory}llm-models/.staging/`, then `moveAsync` into `llm-models/qwen3.5-2b/`.
  - Verify the exact byte size against the catalog.
  - Exclude the file from iCloud backup.
  - API: `downloadLlmModel(key, onProgress)`, `cancelLlmDownload(key)`, `deleteLlmModel(key)` (which unloads first), `isLlmModelDownloaded(key)`, `stagedLlmBytes(key)`.
- [ ] **Store: `src/store/useModelDownloadStore.ts`.**
  - Widen the key type to `LocalModelKey | LocalLlmKey` and add the LLM branch to `startDownload` / `cancelDownload` / `idleDownloads` / `requestIds`.
  - In `markCompleted`, stamp the Parakeet nudge flag for Parakeet keys only (today it stamps any key that isn't `whisper-base`).
  - The free-space gate already applies; make sure it runs for this key.
- [ ] **Cellular confirmation.** Use `expo-network` `getNetworkStateAsync()`. When the connection is cellular, confirm first: "Download 1.3 GB over cellular?"
- [ ] **Tests:**
  - `src/services/llm/__tests__/llmModelDownloader.test.ts`: pinned URL, size mismatch → error and staging cleared, resume skip, cancel. Use the fake `httpClient` pattern from `parakeetModelDownloader.test.ts`.
  - Extend `src/store/__tests__/useModelDownloadStore.test.ts` with the LLM key and no nudge stamp.
  - Keep `parakeetModelDownloader.test.ts` green after the refactor.

### 1.3 Qwen engine service (`src/services/llm/LocalQwenService.ts`, new)

- [ ] **Shape.** A static singleton with a `runExclusive` chain, the same as `LocalWhisperService` and `LocalParakeetService`.
  - `ensureLoaded({ background })` calls `initLlama({ model, n_ctx, n_gpu_layers, use_mlock: false, ctx_shift: false })` with the values from the spike.
- [ ] **Generation API:**
  - `generateText({ instructions, prompt, temperature, maxTokens })` builds `messages: [{system}, {user}]` with `enable_thinking: false`, then applies `stripThinkingTags`.
  - `generateMeetingNotes(...)` uses the same messages with `response_format: json_schema` (the `StructuredMeetingNotes` schema), then `JSON.parse`. `localMeetingNotes.ts` still normalises the result, as it does for Apple.
  - `countTokens({ instructions, prompt })` uses `context.tokenize` on the formatted prompt.
  - `release()`.
- [ ] **Memory:**
  - Before `initLlama`, release the ASR engines (`LocalWhisperService.cleanup()` and `LocalParakeetService.cleanup()`). Add the reverse in `LocalTranscriptionService.transcribe`: release Qwen before loading ASR.
  - On iOS, refuse to load when `availableMemoryBytes() <` the spike's minimum. That raises `LOCAL_LLM_INSUFFICIENT_MEMORY` instead of letting iOS kill the app.
  - Unload after the idle delay, on `AppState` → background (unless a job is running), and when meeting recording starts. Recording needs ASR memory and must never compete with the LLM.
- [ ] **Background:** follow the spike's choice. The default if it's unclear: when `AppState.currentState !== 'active'`, use a CPU-only context, and if that is too slow, queue the dictation and clean it when the app next becomes active (the user's choice: deferred, never skipped). The queue needs a pending-cleanup marker on the transcript and a drain on `AppState` → active; design it in Phase 1 from the spike's numbers.
- [ ] **Errors:** map them to new `LocalReasoningErrorCode` values: `LOCAL_LLM_FAILED`, `LOCAL_LLM_INSUFFICIENT_MEMORY`, `LOCAL_LLM_NOT_DOWNLOADED`.
- [ ] **Tests:** `src/services/llm/__tests__/LocalQwenService.test.ts`, mocking `llama.rn` inline:
  - ASR is released before load;
  - a low-memory refusal;
  - `enable_thinking: false` is passed;
  - the JSON schema is passed and the JSON parsed;
  - malformed JSON → `LOCAL_LLM_FAILED`;
  - release on background.

### 1.4 Engine layer behind the existing seams

- [ ] **`src/lib/localLlm/engines.ts` (new).** It defines:

  ```ts
  type LocalEngineId = 'apple-fm' | 'qwen3.5-2b';
  type LocalTask = 'cleanup' | 'notes' | 'chat' | 'title';
  interface LocalEngine {
    id: LocalEngineId;
    readiness(opts?): Promise<LocalReasoningReadiness>;
    countTokens(input): Promise<number | null>;
    generateText(req): Promise<{ text: string }>;
    generateMeetingNotes(req): Promise<StructuredMeetingNotes>;
    outputReserve: number;
  }
  ```

  It also defines `appleEngine`, which wraps the current `AppleLLM` calls without changing their behaviour, and `qwenEngine`, which wraps `LocalQwenService`.
- [ ] **`pickLocalEngine(task)`** returns the engine to use, or `null` with the best readiness to explain why. It encodes the engine rule under "Answered by the user". It is a pure function over `{ appleReadiness, qwenReadiness, task, appState }`, unit-tested in `src/lib/localLlm/__tests__/pickLocalEngine.test.ts`.
- [ ] **`src/lib/localReasoning.ts`:**
  - `getLocalReasoningReadiness({ refresh, task })` returns the picked engine's readiness, plus a new `engine?: LocalEngineId` field.
  - The readiness type gains the statuses `notDownloaded` and `deviceNotEligible`.
  - Keep the cache, keyed by task.
  - Clear the cache on download complete, delete, and the Apple toggle.
  - `getLocalInputTokenBudget` and `fitsLocalReasoningBudget` use the engine's `contextSize` and `outputReserve`.
  - `countLocalReasoningTokens` delegates to the engine.
  - `getLocalReasoningUnavailableMessage` becomes engine-aware. It covers Apple off, Qwen not downloaded ("Download the On-Device AI model in AI Models"), and an ineligible device (`formatIneligibleReason`).
  - `toLocalReasoningError` maps the new codes.
- [ ] **`LocalReasoningService.processText(request, { task })`** calls `pickLocalEngine` and returns `model: engine.id`, not the hard-coded `'apple-fm'`. `ReasoningService.ts:154-194` passes the task from its scope: `cleanup` → cleanup, `notes` → notes, `agent` → chat.
- [ ] **`localMeetingNotes.ts:180` `generateStructuredNotes`** calls `engine.generateMeetingNotes`. The chunk budget comes from the engine's readiness, so with Qwen at 16K a one-hour meeting is a single map call.
- [ ] **`cleanupTranscript.ts:54`:** `LOCAL_CLEANUP_MAX_TRANSCRIPT_TOKENS` becomes `0.8 × engine.outputReserve`. Set Qwen's reserve from the spike, likely 2048, so longer dictations get cleaned.
- [ ] **Routing tests:**
  - Update `localReasoning.test.ts`, `ReasoningService.localRouting.test.ts`, `localMeetingNotes.test.ts` and `transcribeAndCleanup.onDeviceCleanup.test.ts` for engine selection.
  - Add: no Apple Intelligence and Qwen ready → local cleanup runs; both ready → cleanup on Apple and notes on Qwen; Apple off and Qwen ready → everything on Qwen.

### 1.5 Settings UI and copy

- [ ] **`src/screens/LocalLlmModelScreen.tsx` (new)** at route `/(account)/local-llm-model`. Model it on the single-model `diarization-model` screen, and register it in `app/(account)/_layout.tsx`.
  - Title "On-Device AI Model".
  - Shows the model name, size, license and status: not downloaded, downloading with progress, preparing, ready (with Delete), or error (with "Clear partial download").
  - On an ineligible device, a disabled card with `formatIneligibleReason`. Tested in `src/screens/__tests__/LocalLlmModelScreen.test.tsx`.
- [ ] **`AIModelsScreen.tsx:163` On-Device section:**
  - Add an "On-Device AI Model" row. It shows Qwen's status ("Not downloaded", "Ready", "Needs 6 GB of memory") and opens the screen above.
  - Update the description copy so it no longer implies Apple is the only engine.
- [ ] **`WorkflowSettingsScreen.tsx:671` footer** names the engine that will run. Examples: "Runs on Apple Intelligence on this iPhone." / "Runs on Qwen3.5 2B on this phone." / "Download the On-Device AI model to use this."
- [ ] **`workflowModeSwitch.ts:43-67` text-scope gate:**
  - When no engine is ready but the device is eligible and Qwen isn't downloaded, push `/(account)/local-llm-model` and return `'needs-model'`, mirroring the speech-scope behaviour at L25-41.
  - When the device is ineligible, alert with `formatIneligibleReason`.
- [ ] **Generalise the Apple-specific strings** in `localReasoningFallback.ts`, `NoteEditorScreen.tsx:856` and `aiWorkflows.ts:24-38`.
- [ ] **`LicensesScreen.tsx:23-34`:** add llama.cpp (MIT), llama.rn (MIT) and Qwen3.5 (Apache 2.0).
- [ ] **Update tests:** `AIModelsScreen.test.tsx`, `WorkflowSettingsScreen.test.tsx`, `workflowModeSwitch.test.ts`, `aiWorkflows.test.ts`.

### 1.6 Native config (final)

- [ ] **`package.json`:** pin `llama.rn` to `0.12.9` exactly, and add `expo-device`.
- [ ] **`app.base.json`:** add the `llama.rn` plugin. Don't use the plugin's `enableEntitlements`; entitlements are explicit in `app.config.js`.
- [ ] **`app.config.js`:** add the two kernel entitlements to the main app only. Add a test in the style of the existing `plugins/*/__tests__` so the extensions never get them.
- [ ] **Manual step (user):** enable "Increased Memory Limit" and "Extended Virtual Addressing" on the App ID in the Apple Developer portal, or confirm EAS syncs them. Bump the app version, because `runtimeVersion` is `appVersion`.
- [ ] **`CONTRIBUTING.md`:** note the new entitlements under "Physical iOS Devices and Forks".

### 1.7 Verify

- [ ] `npm run check` and `npm test -- --runInBand` in `openwhispr-mobile`.
- [ ] Device pass over the 0.3 matrix:
  - an ineligible message on the 4 GB iPhone;
  - download → cleanup → meeting notes on 6 GB and 8 GB iPhones;
  - keyboard dictation cleanup with the app backgrounded;
  - start a meeting recording while Qwen is loaded → Qwen unloads and ASR loads;
  - delete the model → the On-Device text workflows report "not downloaded".

---

## Phase 2: Follow-ups (separate PRs)

- [ ] **Chunked manual notes.** The manual "Generate notes" action in `NoteEditorScreen` (`useActionProcessing.ts:52`) is single-shot and hits `LOCAL_CONTEXT_LIMIT` on long meetings. Route it through `generateLocalMeetingNotes`. This is an existing gap with Apple too.
- [ ] **Faster cleanup.** Reuse the system-prompt KV cache across cleanup calls on the same context to cut prefill time.
- [ ] **Integrity check.** Verify the HF `lfs.sha256` after download, off the JS thread.
- [ ] **Home nudge.** Like `ParakeetNudgeBanner`, offer the On-Device AI model to eligible users without Apple Intelligence who use On-Device transcription.

## Phase 3: Assistant (later, needs its own design)

- **Dictation agent in private mode:** `src/lib/dictationAgent.ts:14-15` disables it today. With Qwen it could run with no tools.
- **Keyboard composer on-device:** `AgentStreamClient.ts:168-171` throws today. It needs streaming (llama.rn's token callback) and a small tool set (≤ 3 tools).

## Risks

- **iOS 26 Metal abort** (as with whisper.rn) → CPU only, which is roughly 2–3× slower. Caught in 0.4.
- **Jetsam on 6 GB phones** with long contexts. Mitigated by the available-memory gate, ASR release, and the 8K-context fallback.
- **App size:** llama.rn adds native libraries per ABI. Measure the IPA/AAB growth in the spike.
- **Model drift:** the revision sha is pinned, so a bad upstream re-upload can't reach users. Swapping models later means a catalog change plus a migration that deletes the old file.

## Spike results

_To be filled in after Phase 0._
