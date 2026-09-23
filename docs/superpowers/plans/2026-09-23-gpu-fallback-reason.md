# GPU Fallback Reason Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a GPU whisper-server (Vulkan or CUDA) fails and OpenWhispr falls back to CPU, save the one stderr line that explains why next to the existing failure flag, show it on the existing "GPU acceleration unavailable" card, and put it in the warn log instead of the first 200 characters. Part of #1736; it does not close it.

**Architecture:** A pure helper (`src/helpers/whisperGpuFailureReason.js`) picks the key line from whisper-server stderr and turns it into one safe line. `whisperServer.js` sends it on the two existing fallback events. `ipcHandlers.js` saves it in `.env` beside `WHISPER_GPU_FAILED` (one key per backend) and returns it from the existing status IPC. The settings card renders it as a muted, selectable, left-to-right line. The reason shares the flag's whole lifecycle: set on fallback; cleared on Retry, pack delete, pack re-download, the once-per-upgrade reset, and Reset app data.

**Tech Stack:** Electron main process (CommonJS), React 19 + TypeScript renderer, `node:test` with `tsx`, Vite SSR renderer harness (`test/lib/rendererTestHarness.js`), dotenv 17.4.2.

**Spec:** There is no spec file. The spec is the maintainer's decision below, plus the #1736 diagnosis (whisper-server call chain and the desktop fallback code), summarised in the PR description. Issues: #1736 (open) and #1340 (the original report with log excerpts).

## Decision (Josh, the maintainer; do not re-litigate)

> No fork rebase, no release, no safe-mode retry. Instead ship a diagnostics change, "Part of #1736" (it does NOT close the issue): when a GPU whisper-server (Vulkan or CUDA) fails and the app falls back to CPU, save the key error line (e.g. `vk::PhysicalDevice::createDevice: ErrorDeviceLost`) alongside the existing failure memory, and show it on the existing "GPU activation failed" card in settings, and in the warn-level log summary.

Why: on a default install today the reason for a GPU failure is never saved anywhere. Only `WHISPER_GPU_FAILED=vulkan` lands in `.env`, and that flag stops Vulkan from being retried, so a debug log turned on afterwards cannot capture the error unless the user presses Retry first. With this change, a user can report the cause with a screenshot.

## Gap verification (done before planning, against origin/main d61e5213)

The gap is real. Nothing on origin/main stores or shows the reason:

| Layer | What happens today | Evidence |
|---|---|---|
| Server fallback | The warn log keeps `stderr: stderrBuffer.slice(0, 200)`. `err.message` also embeds the first 200 characters (`waitForReady`). The event is emitted with **no payload** at both sites. | `src/helpers/whisperServer.js:682-690`, `:781-784`, `:1089` |
| Failure memory | The listeners take no arguments and record only the backend name: `WHISPER_GPU_FAILED=cuda\|vulkan`. The broadcast payload is `{}`. | `src/helpers/ipcHandlers.js:687-694`, `:1275-1279` |
| Preload | Both fallback listeners call `callback()` with no data, so even a payload would be dropped. | `preload.js:441-444`, `:455-458` |
| Status IPC | Returns only `gpuFailed: boolean`. | `src/helpers/ipcHandlers.js:3438`, `:3500` |
| UI | Card and toast show fixed strings only. | `src/components/TranscriptionModelPicker.tsx:1363-1374`; `src/hooks/useMainProcessNotifications.tsx:39-59` |
| Logs | A log file exists only at debug level, and packaged Windows builds write no console output without `--console-logs`. So on a default Windows install the warn line is written nowhere. | `src/helpers/debugLogger.js:44`, `:117-119` |
| Other stores | No electron-store, no analytics event for GPU fallback (grep of `src/`). `gpuPackMigrationNotice.js` is the unrelated legacy-layout notice. | — |

In-memory dry runs (nothing written to the repo) reproduced the gap at every layer:
- Real `_doStart` with a fake Vulkan process that prints the #1340 stderr and exits 3: the fallback payload was `undefined`, and the warn meta held `{error, exitCode, stderr}`, neither containing `ErrorDeviceLost`.
- Real IPC handlers: the status answered `{…, gpuFailed: true}` with no reason.
- Real `TranscriptionModelPicker`: after the fallback notification the card flipped to failed, but the status was not read again (1 call).
- Real `EnvironmentManager.saveAllKeysToEnvFile()` kept `WHISPER_GPU_FAILED` but would drop any key missing from `PERSISTED_KEYS`.

The second emit site (`whisperServer.js:1080-1091`, `_fallbackToCpuAndRetry`) covers a GPU server that **started fine and then died during a transcription**. The CUDA "no kernel image" abort at the first kernel launch is one example; the picker comment at `TranscriptionModelPicker.tsx:719-720` describes it. It records the same failure flag, so it must carry a reason too.

## Design decisions

### 1. Extracting the reason: `extractWhisperGpuFailureReason({ stderr, exitCode, signal, timeoutMs, homeDir })`

It reads only the **last 16 KB** of stderr (`STDERR_TAIL_CHARS`). The cause is printed last, just before the process exits, and the tail keeps a long-running server's old output out of the answer (relevant to the mid-transcription site). It splits on `\r\n|\r|\n` and trims each line. Then the first rule that matches wins:

1. `/exception during model load: (.+)/`, keeping only the captured text. Source: `src/whisper.cpp:3732`, where `whisper_init_with_params_no_state` catches the backend's C++ exception. For #1340 this yields `vk::PhysicalDevice::createDevice: ErrorDeviceLost`.
2. `/(vk::\S+: Error\w+)/`: vulkan-hpp's exception text anywhere else, such as the libstdc++ `what():` line of an uncaught throw on Linux. A generic error-word rule cannot catch these, because `\berror\b` does not match `ErrorDeviceLost`.
3. `/(CUDA error: .+)/`. Source: `ggml-cuda.cu:99`, `ggml_cuda_error`.
4. The **first** line matching `/\b(?:error|failed|failure|exception|abort(?:ed)?)\b/i` that is not one of the two load-failure echoes. This covers `cudaMalloc failed: out of memory`, `ggml_vulkan: Error: …`, `failed to initialize CUDA: …` and `GGML_ASSERT(…) failed`.
5. The first load-failure echo, `failed to load model` or `error: failed to initialize whisper context`. These say that loading failed, never why, so they come last.
6. No line matched, so report how the process ended:
   - `terminated by <SIGNAL>` for a signal death.
   - `exit code <N>` when it exited. This covers a Windows driver crash (3221225477) or a missing DLL with no stderr at all.
   - `startup timed out after <N> s` when it is still running at the startup deadline.
   - Otherwise `null`.

   The **last non-empty line** is deliberately not used: after an abort it is a backtrace frame or a banner line, which would mislead.

Then it normalizes the chosen text into one line that is safe to show and to save:
- **Home folder → `~`.** `os.homedir()` is replaced in any letter case and in either slash style. People screenshot this into public issues, and home folders are often named after their owner. Windows 8.3 short names (`ALEXAN~1`) are a known gap.
- Control characters, including CR/LF/TAB/C1, and U+2028/U+2029 become spaces. Whitespace runs collapse, and the result is trimmed.
- **`#` is removed, and leading quotes or backticks are stripped.** Both are load-bearing for `.env`, as shown in §2.
- **Cap: 240 characters** (`MAX_REASON_LENGTH`). The first 239 are kept, then `…`.

### 2. Persistence: `.env`, one key per backend, same lifecycle as `WHISPER_GPU_FAILED`

- **Keys:** `WHISPER_GPU_FAILED_REASON_CUDA` and `WHISPER_GPU_FAILED_REASON_VULKAN`, exported as `WHISPER_GPU_FAILURE_REASON_KEYS` from the helper. Per-backend keys match the per-backend flag and the per-backend clear in `_clearWhisperGpuFailure`.
- **Why the existing mechanism, and why it is safe here.** `_syncStartupEnv` → `saveAllKeysToEnvFile()` writes values raw as `${key}=${value}\n` (`environment.js:228-241`), with no quoting. dotenv 17.4.2's parser (`node_modules/dotenv/lib/main.js`, `LINE` regex) then:
  - treats `#` as a comment (checked: `R=error: bad #5 value` reads back `error: bad`);
  - stops at CR/LF;
  - trims the value;
  - strips a matching pair of surrounding quotes;
  - lets a value that **starts with a quote** run on until the next line that ends with that quote, silently swallowing later keys. Checked: `…_VULKAN='open quote` swallowed `WHISPER_THREADS` and `TRANSCRIPTION_GPU_UUID`.

  So `.env` is unsafe for **arbitrary** text. The reason is not arbitrary: the helper is its only producer, and the helper guarantees a single line with no `#`, no leading quote, and at most 240 characters. A test round-trips hostile inputs through the real `dotenv.parse` and checks that later keys survive. This keeps one mechanism and one lifecycle instead of adding a JSON file that needs its own clear at five sites.
- **Allowlist:** `_writeEnvFile` writes only `PERSISTED_KEYS` (`environment.js:25-60`), so both keys must be added there. Adding them also makes Reset app data (`clearAllPersistedData`, `environment.js:488-491`, reached from `cleanup-app` at `ipcHandlers.js:4031`) clear them for free.
- **Lifecycle:** this is every place `WHISPER_GPU_FAILED` is set or cleared on origin/main.

| Event | Today | After |
|---|---|---|
| Fallback, startup or mid-transcription | `_recordWhisperGpuFailure(backend)` | `_recordWhisperGpuFailure(backend, reason)` sets the reason key, or **clears** it when the reason is null, so an older reason is never shown for a newer failure |
| Retry (`whisper-gpu-retry`, `ipcHandlers.js:3563-3568`) | clears `WHISPER_GPU_FAILED` | also clears both reason keys |
| Pack download, CUDA and Vulkan (`:3461`, `:3522`) | `_clearWhisperGpuFailure(backend)` | same call, now also clears that backend's reason |
| Pack delete, CUDA (only on success) and Vulkan (`:3485`, `:3545`) | `_clearWhisperGpuFailure(backend)` | same call, now also clears that backend's reason |
| Upgrade (`whisperGpuUpgradeReset.js:19-45`) | removes `WHISPER_GPU_FAILED` | removes the flag and both reason keys, from memory and with targeted `.env` line removals |
| Reset app data | `PERSISTED_KEYS` loop | same loop, now including the reason keys |

### 3. Surfacing

- **IPC:** `get-cuda-whisper-status` and `get-vulkan-whisper-status` gain `gpuFailReason: string | null`. It is non-null only when that backend is in `WHISPER_GPU_FAILED`, which is defence in depth against a stale key. Preload needs **no change**, because `invoke` passes the object through. Types: `CudaWhisperStatus` and `VulkanWhisperStatus` in `src/types/electron.ts:686-703`.
- **Live update:** the fallback notification keeps its `{}` payload, so preload and the toast hook are unchanged. The card re-reads the status when the notification arrives. Main saves the reason synchronously in `process.env` before it broadcasts (`_syncStartupEnv` sets env, then writes the file asynchronously), so the re-read sees it. This matters because the main path is: download pack → activation → failure, **while the card is on screen**.
- **UI:** one line, placed between the card description and the Retry button:
  ```tsx
  <p dir="ltr" className="mt-1 select-text wrap-break-word font-mono text-[11px] leading-snug text-muted-foreground">{gpuFailReason}</p>
  ```
  It has **no label, so no new i18n keys**. The monospace, muted styling marks it as a technical detail, matching `ui/TechnicalErrorDetails.tsx`. `dir="ltr"` follows the repo's content-direction policy for technical text under the Arabic RTL UI, pinned in `test/components/directionalContentPolicy.test.js`. `TechnicalErrorDetails` itself is not reused: it is a collapsed `<details>`, so a screenshot would not show the reason without an extra click.
- **Fallback texts are not translated.** The outcome strings (`exit code N`, `terminated by SIGSEGV`, `startup timed out after N s`) are diagnostic data rendered verbatim, like the engine's own English lines. They are written for the maintainer who reads the report, and the same string is saved, logged and shown.

### 4. Warn log

- Startup: `debugLogger.warn("<CUDA|Vulkan> whisper-server failed, falling back to CPU", { error: err.message, exitCode, reason })`. The `stderr: stderrBuffer.slice(0, 200)` field is removed.
- Mid-transcription: `debugLogger.warn("<backend> whisper-server died during transcription, falling back to CPU", { port, model, reason })`.
- Not changed: `waitForReady`'s own message still embeds the first 200 characters of stderr. That message is also the error that a failing CPU start propagates to callers, so it is out of scope.

## Global Constraints

- Scope is "Part of #1736". The PR must not say "Fixes", "Closes" or "Resolves #1736". Suggested title: `fix(whisper): save and show why GPU acceleration fell back to CPU`.
- No fork rebase, no `WHISPER_CPP_TAG`/`EXPECTED_DIGESTS` change, no safe-mode retry ladder, no `-nfa`. No change to the toast (`useMainProcessNotifications.tsx`), to `preload.js`, or to the llama-server GPU path.
- New `.env` keys: exactly `WHISPER_GPU_FAILED_REASON_CUDA` and `WHISPER_GPU_FAILED_REASON_VULKAN`.
- Saved value invariant:
  - one line;
  - no `#`;
  - no leading `'`, `"` or `` ` ``;
  - at most `MAX_REASON_LENGTH = 240` characters;
  - home folder replaced with `~`.
- `STDERR_TAIL_CHARS = 16 * 1024`.
- No new i18n keys, so `node scripts/check-i18n.js` must stay green. (`src/locales` has 11 locale folders if a key is ever added later.)
- Node 24 per `.nvmrc`. Run tests with `nvm exec 24 node --import tsx --test --test-concurrency=4 <files>` from the repository root. Load nvm first if needed: `source ~/.nvm/nvm.sh`.
- CI gates:
  - `npm run quality-check`: ESLint at the root and in `src/`, `prettier --check` under `src/` only (printWidth 100, no Tailwind class sorting), and `tsc --noEmit` in `src/`.
  - `npm run i18n:check`.
  - `npm test`.
- Tests must never touch the OS keychain. Any test that runs the real `EnvironmentManager` `.env` writer stubs `src/helpers/secretCrypto.js`: `isAvailable()` opens the real keychain through `@napi-rs/keyring` and can write a master key.
- Code comments explain *why* and cite `#1736`, matching the surrounding style.
- macOS behaviour must not change (see "Cross-platform effects").

## Review Focus

1. **Upgrading from a build without saved reasons.** `.env` holds `WHISPER_GPU_FAILED=vulkan` and no reason key. The card must look exactly as it does today: no empty line, no "null". Test: Task 5, "a failure saved before this change renders the card exactly as before".
2. **Settings stays open and the GPU fails again with a different error** (for example, Retry fails differently). Only the newest reason may show, never the old one. Test: Task 5, "a live fallback re-reads the status: the new reason shows and replaces the old one".
3. **Both backends have failed on one machine.** Each status reports only its own reason, and removing one pack keeps the other's. Tests: Task 3, "the status IPC reports each backend's own saved reason" and "deleting or re-downloading one pack clears only that pack's reason".
4. **A crash that prints no recognisable line** (driver access violation, missing DLL, hang). The reason must be a stable `exit code N`, `terminated by SIG…` or `startup timed out after N s`, never a banner line. Tests: Task 1, "without an error line, reports how the process ended"; Task 2, "a GPU server that never answers is reported as a startup timeout".
5. **Stderr that could corrupt `.env` or leak identity**: a `#`, a leading quote, CR/LF, or a home path in another case or slash style. The saved line must round-trip, later keys must survive, and the home folder must become `~`. Tests: Task 1, "the reason survives the raw KEY=value line it is saved as in .env" and "replaces the user's home folder with ~ in any letter case or slash style". Known, untested gap: Windows 8.3 short names.

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/helpers/whisperGpuFailureReason.js` | Create (Task 1), extend (Task 3) | Pick and sanitize the reason; own the `.env` key names |
| `test/helpers/harness/whisperServerStderr.js` | Create (Task 1) | Realistic stderr fixtures from the pinned fork and #1340/#1606 |
| `test/helpers/whisperGpuFailureReason.test.js` | Create (Task 1) | Extractor rules, fallbacks, cap, redaction, dotenv round-trip |
| `src/helpers/whisperServer.js` | Modify (Task 2) | Send `{ reason }` on both fallback events; log it |
| `test/helpers/whisperServerGpuFailureReason.test.js` | Create (Task 2) | Real `_doStart` with a fake whisper-server process |
| `test/helpers/whisperCudaRequestFallback.test.js` | Modify (Task 2) | Mid-transcription fallback carries the reason |
| `src/helpers/ipcHandlers.js` | Modify (Task 3) | Save/clear the reason with the flag; return it from status |
| `test/helpers/whisperGpuFailureRecordIpc.test.js` | Create (Task 3) | Real handlers: record, status, retry, delete, download |
| `src/helpers/environment.js` | Modify (Task 4) | Add both keys to `PERSISTED_KEYS` |
| `src/helpers/whisperGpuUpgradeReset.js` | Modify (Task 4) | Clear the reasons with the flag on upgrade |
| `test/helpers/whisperGpuUpgradeReset.test.js` | Modify (Task 4) | Upgrade clears reasons; `.env` rewrite keeps them |
| `src/types/electron.ts` | Modify (Task 5) | `gpuFailReason` on both status types |
| `src/components/TranscriptionModelPicker.tsx` | Modify (Task 5) | Reason line on the failed card; re-read on fallback |
| `test/components/gpuFailureReasonCard.test.js` | Create (Task 5) | Mounted picker: shown, hidden, live update |
| `test/components/directionalContentPolicy.test.js` | Modify (Task 5) | Pin `dir="ltr"` on the reason line |
| `TROUBLESHOOTING.md` | Modify (Task 5) | One sentence: report the line on the card |

---

### Task 1: Reason extractor (pure helper) and stderr fixtures

**Files:**
- Create: `src/helpers/whisperGpuFailureReason.js`
- Create: `test/helpers/harness/whisperServerStderr.js`
- Test: `test/helpers/whisperGpuFailureReason.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `extractWhisperGpuFailureReason({ stderr?: string, exitCode?: number|null, signal?: string|null, timeoutMs?: number|null, homeDir?: string|null }) => string | null`. `homeDir` defaults to `os.homedir()`; pass `null` to skip redaction.
  - `MAX_REASON_LENGTH = 240`.
  - Fixtures: `VULKAN_DEVICE_LOST_STDERR`, `CUDA_KERNEL_IMAGE_STDERR`, `CUDA_OUT_OF_MEMORY_STDERR` (strings).

- [ ] **Step 1: Write the fixtures**

Create `test/helpers/harness/whisperServerStderr.js`:

```js
// whisper-server stderr, rebuilt line by line from the pinned OpenWhispr/whisper.cpp
// tag (src/whisper.cpp, ggml/src/ggml-vulkan, ggml/src/ggml-cuda, ggml-alloc.c,
// ggml-backend.cpp, examples/server/server.cpp) and the logs on #1340 and #1606.

// #1340: RX 9070 XT on the AMD proprietary driver (Windows). ggml-vulkan's
// createDevice throws inside model load; whisper.cpp logs the exception and the
// server exits 3. The cause sits far past the first 200 characters.
const VULKAN_DEVICE_LOST_STDERR = [
  "whisper_init_from_file_with_params_no_state: loading model from 'C:\\Users\\Mika\\.cache\\openwhispr\\whisper-models\\ggml-large-v3-turbo.bin'",
  "whisper_init_with_params_no_state: use gpu    = 1",
  "whisper_init_with_params_no_state: flash attn = 1",
  "whisper_init_with_params_no_state: gpu_device = 0",
  "whisper_init_with_params_no_state: dtw        = 0",
  "ggml_vulkan: Found 1 Vulkan devices:",
  "ggml_vulkan: 0 = AMD Radeon RX 9070 XT (AMD proprietary driver) | uma: 0 | fp16: 1 | bf16: 1 | warp size: 64 | shared memory: 32768 | int dot: 1 | matrix cores: KHR_coopmat",
  "whisper_init_with_params_no_state: devices    = 2",
  "whisper_init_with_params_no_state: backends   = 2",
  "whisper_model_load: loading model",
  "whisper_model_load: n_vocab       = 51866",
  "whisper_model_load: n_audio_ctx   = 1500",
  "whisper_model_load: n_audio_state = 1280",
  "whisper_model_load: n_mels        = 128",
  "whisper_model_load: type          = 5 (large v3)",
  "whisper_model_load: adding 1609 extra tokens",
  "whisper_model_load: n_langs       = 100",
  "whisper_init_with_params_no_state: exception during model load: vk::PhysicalDevice::createDevice: ErrorDeviceLost",
  "whisper_init_with_params_no_state: failed to load model",
  "error: failed to initialize whisper context",
  "",
].join("\r\n");

// A CUDA pack on a card below its kernel floor (the Maxwell case the model
// picker steers to Vulkan): the server starts, then aborts at the first
// kernel launch, mid-transcription.
const CUDA_KERNEL_IMAGE_STDERR = [
  "ggml_cuda_init: found 1 CUDA devices (Total VRAM: 4096 MiB):",
  "  Device 0: NVIDIA GeForce GTX 970, compute capability 5.2, VMM: yes, VRAM: 4096 MiB",
  "whisper_init_from_file_with_params_no_state: loading model from '/home/ana/.cache/openwhispr/whisper-models/ggml-base.bin'",
  "whisper_backend_init_gpu: using CUDA0 backend",
  "whisper_model_load:        CUDA0 total size =   147.37 MB",
  "CUDA error: no kernel image is available for execution on the device",
  "  current device: 0, in function ggml_cuda_compute_forward at /home/runner/work/whisper.cpp/whisper.cpp/ggml/src/ggml-cuda/ggml-cuda.cu:2503",
  "  err",
  "/home/runner/work/whisper.cpp/whisper.cpp/ggml/src/ggml-cuda/ggml-cuda.cu:88: CUDA error",
  "",
].join("\n");

// A model larger than free VRAM: the weight buffer allocation fails and the
// load then aborts on the unallocated tensor.
const CUDA_OUT_OF_MEMORY_STDERR = [
  "ggml_cuda_init: found 1 CUDA devices (Total VRAM: 2048 MiB):",
  "  Device 0: NVIDIA GeForce GTX 1050, compute capability 6.1, VMM: yes, VRAM: 2048 MiB",
  "whisper_init_from_file_with_params_no_state: loading model from 'C:\\Users\\Ana\\.cache\\openwhispr\\whisper-models\\ggml-large-v3-turbo.bin'",
  "whisper_backend_init_gpu: using CUDA0 backend",
  "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 1533.14 MiB on device 0: cudaMalloc failed: out of memory",
  "alloc_tensor_range: failed to allocate CUDA0 buffer of size 1607598080",
  'D:\\a\\whisper.cpp\\whisper.cpp\\ggml\\src\\ggml-backend.cpp:327: GGML_ASSERT(buf != NULL && "tensor buffer not set") failed',
  "",
].join("\r\n");

module.exports = {
  VULKAN_DEVICE_LOST_STDERR,
  CUDA_KERNEL_IMAGE_STDERR,
  CUDA_OUT_OF_MEMORY_STDERR,
};
```

- [ ] **Step 2: Write the failing tests**

Create `test/helpers/whisperGpuFailureReason.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { parse: parseDotenv } = require("dotenv");

const {
  MAX_REASON_LENGTH,
  extractWhisperGpuFailureReason: extractReason,
} = require("../../src/helpers/whisperGpuFailureReason");
const {
  VULKAN_DEVICE_LOST_STDERR,
  CUDA_KERNEL_IMAGE_STDERR,
  CUDA_OUT_OF_MEMORY_STDERR,
} = require("./harness/whisperServerStderr");

const DEVICE_LOST = "vk::PhysicalDevice::createDevice: ErrorDeviceLost";

test("#1340: finds the createDevice error that a 200-character slice of stderr cuts off", () => {
  // The warn log kept stderrBuffer.slice(0, 200): all banner, no cause
  assert.equal(VULKAN_DEVICE_LOST_STDERR.slice(0, 200).includes("ErrorDeviceLost"), false);
  assert.equal(extractReason({ stderr: VULKAN_DEVICE_LOST_STDERR, exitCode: 3 }), DEVICE_LOST);
});

test("CUDA: the kernel-image error wins over the abort lines after it", () => {
  assert.equal(
    extractReason({ stderr: CUDA_KERNEL_IMAGE_STDERR, signal: "SIGABRT" }),
    "CUDA error: no kernel image is available for execution on the device"
  );
});

test("CUDA: an out-of-memory load reports the first failed allocation, not the assert", () => {
  assert.equal(
    extractReason({ stderr: CUDA_OUT_OF_MEMORY_STDERR, exitCode: 3 }),
    "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 1533.14 MiB on device 0: cudaMalloc failed: out of memory"
  );
});

test("reads an uncaught Vulkan exception from its what() line", () => {
  const stderr = [
    "terminate called after throwing an instance of 'vk::DeviceLostError'",
    "  what():  vk::Queue::submit: ErrorDeviceLost",
  ].join("\n");
  assert.equal(
    extractReason({ stderr, signal: "SIGABRT" }),
    "vk::Queue::submit: ErrorDeviceLost"
  );
});

test("an unrecognised error line beats the generic load-failure lines after it", () => {
  const stderr = [
    "ggml_vulkan: Found 1 Vulkan devices:",
    "ggml_vulkan: Error: Vulkan 1.2 required.",
    "whisper_init_with_params_no_state: failed to load model",
    "error: failed to initialize whisper context",
  ].join("\n");
  assert.equal(extractReason({ stderr, exitCode: 3 }), "ggml_vulkan: Error: Vulkan 1.2 required.");
});

test("with only the generic load-failure lines, the first one is kept", () => {
  const stderr = [
    "whisper_model_load: invalid model data (bad magic)",
    "whisper_init_with_params_no_state: failed to load model",
    "error: failed to initialize whisper context",
  ].join("\n");
  assert.equal(
    extractReason({ stderr, exitCode: 3 }),
    "whisper_init_with_params_no_state: failed to load model"
  );
});

test("without an error line, reports how the process ended", () => {
  const banner = "ggml_vulkan: Found 1 Vulkan devices:\n";
  // A driver crash or a missing DLL on Windows prints nothing and exits with an NTSTATUS code
  assert.equal(extractReason({ stderr: banner, exitCode: 3221225477 }), "exit code 3221225477");
  assert.equal(extractReason({ stderr: banner, signal: "SIGSEGV" }), "terminated by SIGSEGV");
  assert.equal(
    extractReason({ stderr: banner, timeoutMs: 120000 }),
    "startup timed out after 120 s"
  );
  assert.equal(extractReason({ stderr: "", exitCode: 3, timeoutMs: 120000 }), "exit code 3");
  assert.equal(extractReason({}), null);
});

test("reads only the last 16 KB, so a long-running server's old lines are ignored", () => {
  const stderr =
    "error: failed to read WAV file 'old.wav'\n" +
    "whisper_print_timings:    total time =    10.00 ms\n".repeat(400);
  assert.ok(stderr.length > 16 * 1024);
  assert.equal(extractReason({ stderr, exitCode: 3221225477 }), "exit code 3221225477");
});

test("returns one line, capped at MAX_REASON_LENGTH", () => {
  const long = extractReason({ stderr: `error: ${"x".repeat(500)}` });
  assert.equal(long.length, MAX_REASON_LENGTH);
  assert.ok(long.endsWith("…"));
  assert.equal(extractReason({ stderr: "error:\tfirst \u0007 second" }), "error: first second");
});

test("replaces the user's home folder with ~ in any letter case or slash style", () => {
  const homeDir = "C:\\Users\\Mika";
  assert.equal(
    extractReason({ stderr: "error: failed to read 'c:\\users\\MIKA\\a.wav'", homeDir }),
    "error: failed to read '~\\a.wav'"
  );
  assert.equal(
    extractReason({ stderr: "error: failed to read 'C:/Users/Mika/a.wav'", homeDir }),
    "error: failed to read '~/a.wav'"
  );
});

test("the reason survives the raw KEY=value line it is saved as in .env", () => {
  // EnvironmentManager writes KEY=value unquoted. dotenv reads "#" as a comment,
  // and a value that starts with a quote runs on to the next line ending in that
  // quote, swallowing the keys between. Each later line ends in a quote to prove it.
  const laterLines = "WHISPER_THREADS=4\nA=1'\nB=2\"\nC=3`\n";
  for (const line of [
    "error: bad #5",
    "'error: single quoted'",
    '"error: C:\\new\\folder',
    "`error` in backticks",
    "error: a=b: c",
    "error: $HOME",
  ]) {
    const reason = extractReason({ stderr: line, homeDir: null });
    const env = parseDotenv(`WHISPER_GPU_FAILED_REASON_VULKAN=${reason}\n${laterLines}`);
    assert.equal(env.WHISPER_GPU_FAILED_REASON_VULKAN, reason, line);
    assert.equal(env.WHISPER_THREADS, "4", `${line} swallowed the next key`);
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `nvm exec 24 node --import tsx --test test/helpers/whisperGpuFailureReason.test.js`
Expected: FAIL with `Cannot find module '../../src/helpers/whisperGpuFailureReason'`.

- [ ] **Step 4: Write the implementation**

Create `src/helpers/whisperGpuFailureReason.js`:

```js
const os = require("os");

// A GPU whisper-server that falls back to CPU used to leave only its backend
// name behind (WHISPER_GPU_FAILED), so neither the settings card nor a bug
// report could say why (#1736). This picks the stderr line that explains it.

// The cause is printed last, just before the process exits. Reading only the
// tail also keeps a long-running server's older output out of the answer.
const STDERR_TAIL_CHARS = 16 * 1024;
const MAX_REASON_LENGTH = 240;

// Most specific first; the capture group is the reason. Formats are from the
// pinned OpenWhispr/whisper.cpp tag.
const CAUSE_PATTERNS = [
  // src/whisper.cpp (whisper_init_with_params_no_state) catches the backend's
  // C++ exception around model load, e.g. ggml-vulkan's createDevice throwing
  // vk::DeviceLostError: "...: exception during model load: <what()>"
  /exception during model load: (.+)/,
  // vulkan-hpp's exception text wherever else it surfaces, e.g. the "what():"
  // line of an exception nothing caught. \berror\b cannot see "ErrorDeviceLost".
  /(vk::\S+: Error\w+)/,
  // ggml-cuda.cu ggml_cuda_error: "CUDA error: <cudaGetErrorString>"
  /(CUDA error: .+)/,
];
// Any other error line; the first one is the closest to the cause.
const ERROR_LINE = /\b(?:error|failed|failure|exception|abort(?:ed)?)\b/i;
// What whisper.cpp and whisper-server print after any failed load. They say
// that loading failed, never why, so they are the answer of last resort.
const LOAD_FAILURE_ECHO = /failed to load model|failed to initialize whisper context/;

function findCauseLine(lines) {
  for (const pattern of CAUSE_PATTERNS) {
    for (const line of lines) {
      const match = line.match(pattern);
      if (match) return match[1];
    }
  }
  return (
    lines.find((line) => ERROR_LINE.test(line) && !LOAD_FAILURE_ECHO.test(line)) ||
    lines.find((line) => LOAD_FAILURE_ECHO.test(line)) ||
    null
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One line that is safe to show and to save. EnvironmentManager writes .env
// values raw (KEY=value), and dotenv reads "#" as a comment and a leading
// quote as the start of a quoted value that can run over later keys.
function sanitizeReason(text, homeDir) {
  let reason = String(text);
  if (homeDir) {
    // People screenshot this into public issues, and a home folder is often
    // named after its owner.
    for (const home of new Set([homeDir, homeDir.replace(/\\/g, "/")])) {
      reason = reason.replace(new RegExp(escapeRegExp(home), "gi"), "~");
    }
  }
  reason = reason
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/#/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^['"`\s]+/, "");
  if (reason.length > MAX_REASON_LENGTH) {
    reason = `${reason.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}…`;
  }
  return reason || null;
}

/**
 * The key line explaining why a GPU whisper-server failed, or how the process
 * ended when its output names no cause. One line of at most MAX_REASON_LENGTH
 * characters, or null when there is nothing to report.
 */
function extractWhisperGpuFailureReason({
  stderr = "",
  exitCode = null,
  signal = null,
  timeoutMs = null,
  homeDir = os.homedir(),
} = {}) {
  const lines = String(stderr || "")
    .slice(-STDERR_TAIL_CHARS)
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const cause = findCauseLine(lines);
  const reason = cause ? sanitizeReason(cause, homeDir) : null;
  if (reason) return reason;
  // No line names the cause (a driver crash, a missing DLL, a hang): say how it ended
  if (signal) return `terminated by ${signal}`;
  if (exitCode !== null && exitCode !== undefined) return `exit code ${exitCode}`;
  if (timeoutMs) return `startup timed out after ${Math.round(timeoutMs / 1000)} s`;
  return null;
}

module.exports = { MAX_REASON_LENGTH, extractWhisperGpuFailureReason };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nvm exec 24 node --import tsx --test test/helpers/whisperGpuFailureReason.test.js`
Expected: PASS, 11 tests. (Every assertion here was checked against this exact code in memory before the plan was written.)

- [ ] **Step 6: Format and commit**

`prettier --check` in CI covers `src/` only.

```bash
nvm exec 24 npx prettier --write src/helpers/whisperGpuFailureReason.js
git add src/helpers/whisperGpuFailureReason.js test/helpers/harness/whisperServerStderr.js test/helpers/whisperGpuFailureReason.test.js
git commit -m "feat(whisper): pick the key error line from a failed GPU whisper-server"
```

---

### Task 2: Send the reason on both fallback events, and log it

**Files:**
- Modify: `src/helpers/whisperServer.js:17-20` (imports), `:305-307` (constructor), `:643-694` (`_doStart`), `:1080-1091` (`_fallbackToCpuAndRetry`)
- Create: `test/helpers/whisperServerGpuFailureReason.test.js`
- Modify: `test/helpers/whisperCudaRequestFallback.test.js` (one import, one test)

**Interfaces:**
- Consumes: `extractWhisperGpuFailureReason` (Task 1); the fixtures (Task 1).
- Produces:
  - `"gpu-fallback"` and `"cuda-fallback"` are emitted with `{ reason: string | null }` from both sites.
  - `WhisperServerManager#_lastProcessInfo: null | (() => { stderr: string, exitCode: number | null, signal: string | null })`, assigned on every spawn in `_doStart`.

- [ ] **Step 1: Write the failing startup-path tests (real `_doStart`, fake process)**

Create `test/helpers/whisperServerGpuFailureReason.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  VULKAN_DEVICE_LOST_STDERR,
  CUDA_OUT_OF_MEMORY_STDERR,
} = require("./harness/whisperServerStderr");

// Drives the real _doStart against a fake whisper-server process: a GPU start
// that fails must hand the fallback its key error line, where the warn log used
// to keep only the first 200 characters of the device banner (#1736, #1340).
const serverModulePath = require.resolve("../../src/helpers/whisperServer");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-gpu-reason-"));
const modelPath = path.join(userDataDir, "ggml-large-v3-turbo.bin");
fs.writeFileSync(modelPath, "model");
test.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

const BINARY = {
  cpu: "/fake/whisper-server",
  cuda: "/fake/whisper-server-cuda",
  vulkan: "/fake/whisper-server-vulkan",
};
// Binary path -> how its fake process behaves
const behaviours = new Map();
const warnings = [];

function fakeWhisperServer({ stderr = "", exit = null, healthy = false } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.killed = false;
  child.exitCode = null;
  child.healthy = healthy;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let closed = false;
  const close = (code, signal) => {
    if (closed) return;
    closed = true;
    child.exitCode = code;
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    setImmediate(() => close(null, signal));
    return true;
  };
  // Output lands after _doStart attaches its handlers; then the process ends.
  setImmediate(() => {
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    if (exit) setImmediate(() => close(exit.code ?? null, exit.signal ?? null));
  });
  return child;
}

const originalLoad = Module._load;
Module._load = function loadWithFakeProcess(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => userDataDir, isReady: () => false } };
  }
  if (parent?.filename === serverModulePath) {
    if (request === "child_process") {
      return { ...childProcess, spawn: (binary) => fakeWhisperServer(behaviours.get(binary)) };
    }
    if (request === "./debugLogger") {
      const ignore = () => {};
      return {
        debug: ignore,
        info: ignore,
        error: ignore,
        warn: (message, meta) => warnings.push({ message, meta }),
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
let WhisperServerManager;
try {
  WhisperServerManager = require(serverModulePath);
} finally {
  Module._load = originalLoad;
}

function createManager(t) {
  behaviours.clear();
  warnings.length = 0;
  behaviours.set(BINARY.cpu, { healthy: true });
  const manager = new WhisperServerManager();
  manager.getServerBinaryPath = (options = {}) =>
    options.preferCuda ? BINARY.cuda : options.preferVulkan ? BINARY.vulkan : BINARY.cpu;
  manager.findAvailablePort = async () => 8199;
  manager.getFFmpegPath = () => null;
  manager.checkHealth = async () => Boolean(manager.process?.healthy);
  t.after(() => manager.stop());
  return manager;
}

function fallbackWarning() {
  return warnings.find(({ message }) =>
    message.endsWith("whisper-server failed, falling back to CPU")
  );
}

test("#1340: a Vulkan server that dies at startup reports the createDevice error", async (t) => {
  const manager = createManager(t);
  behaviours.set(BINARY.vulkan, { stderr: VULKAN_DEVICE_LOST_STDERR, exit: { code: 3 } });
  const events = [];
  manager.on("gpu-fallback", (payload) => events.push(payload));

  await manager.start(modelPath, { useVulkan: true });

  assert.equal(manager.useVulkan, false, "the CPU server took over");
  assert.deepEqual(events, [{ reason: "vk::PhysicalDevice::createDevice: ErrorDeviceLost" }]);
  const warning = fallbackWarning();
  assert.equal(warning.meta.reason, "vk::PhysicalDevice::createDevice: ErrorDeviceLost");
  assert.equal("stderr" in warning.meta, false, "no 200-character banner slice");
});

test("a CUDA server that runs out of memory at startup reports the failed allocation", async (t) => {
  const manager = createManager(t);
  behaviours.set(BINARY.cuda, { stderr: CUDA_OUT_OF_MEMORY_STDERR, exit: { code: 3 } });
  const events = [];
  manager.on("cuda-fallback", (payload) => events.push(payload));

  await manager.start(modelPath, { useCuda: true });

  assert.equal(manager.useCuda, false);
  assert.deepEqual(events, [
    {
      reason:
        "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 1533.14 MiB on device 0: cudaMalloc failed: out of memory",
    },
  ]);
});

test("a GPU server that never answers is reported as a startup timeout", async (t) => {
  const manager = createManager(t);
  // Prints its banner and hangs
  behaviours.set(BINARY.vulkan, { stderr: "ggml_vulkan: Found 1 Vulkan devices:\n" });
  // Stands in for the real 120 s wait, which throws exactly this at its deadline
  const waitForReady = manager.waitForReady.bind(manager);
  manager.waitForReady = async (getProcessInfo, timeoutMs) => {
    if (manager.useVulkan) {
      throw new Error(`whisper-server failed to start within ${timeoutMs}ms`);
    }
    return waitForReady(getProcessInfo, timeoutMs);
  };
  const events = [];
  manager.on("gpu-fallback", (payload) => events.push(payload));

  await manager.start(modelPath, { useVulkan: true });

  assert.deepEqual(events, [{ reason: "startup timed out after 120 s" }]);
});
```

- [ ] **Step 2: Write the failing mid-transcription test**

In `test/helpers/whisperCudaRequestFallback.test.js`, add below the existing `require` of `WhisperServerManager` (after line 9):

```js
const { CUDA_KERNEL_IMAGE_STDERR } = require("./harness/whisperServerStderr");
```

Then add this test after the test "falls back to CPU and emits gpu-fallback when a Vulkan server dies mid-request":

```js
test("the mid-transcription fallback carries the crashed server's error line", async (t) => {
  let manager;
  let requestCount = 0;

  const { server, port } = await startServer((req, res) => {
    requestCount += 1;
    if (requestCount === 1) {
      manager.process = null;
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "hello" }));
  });
  t.after(() => server.close());

  manager = createManager(port, { useCuda: true });
  // What _doStart records for the server it spawned: its output and how it ended
  manager._lastProcessInfo = () => ({
    stderr: CUDA_KERNEL_IMAGE_STDERR,
    exitCode: null,
    signal: "SIGABRT",
  });
  manager.start = async () => {
    // The CPU restart spawns a new process, so the reason must be read before it
    manager._lastProcessInfo = () => ({ stderr: "", exitCode: null, signal: null });
    manager.useCuda = false;
    manager.ready = true;
  };

  const events = [];
  manager.on("cuda-fallback", (payload) => events.push(payload));

  const result = await manager.transcribe(Buffer.from("audio"));

  assert.equal(result.text, "hello");
  assert.deepEqual(events, [
    { reason: "CUDA error: no kernel image is available for execution on the device" },
  ]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `nvm exec 24 node --import tsx --test test/helpers/whisperServerGpuFailureReason.test.js test/helpers/whisperCudaRequestFallback.test.js`
Expected:
- The 3 new startup tests fail with `AssertionError … deep-equal`, because `events` is `[ undefined ]`. That is today's defect: the fallback happens and the reason is lost.
- The new mid-transcription test fails the same way.
- Every existing test in `whisperCudaRequestFallback.test.js` still passes.

- [ ] **Step 4: Implement in `src/helpers/whisperServer.js`**

4a. Imports. After the `transcriptionTimeout` require (ends at line 20), add:

```js
const { extractWhisperGpuFailureReason } = require("./whisperGpuFailureReason");
```

4b. Constructor. After `this.lastStartOptions = {};` (line 307), add:

```js
    // Output and exit of the last spawned server, read when a GPU server that
    // started fine dies mid-transcription (_fallbackToCpuAndRetry). See #1736.
    this._lastProcessInfo = null;
```

4c. `_doStart`. Replace this block (lines 643-694):

```js
    let stderrBuffer = "";
    let exitCode = null;

    this.process.stdout.on("data", (data) => {
```

with:

```js
    let stderrBuffer = "";
    let exitCode = null;
    let exitSignal = null;
    const getProcessInfo = () => ({ stderr: stderrBuffer, exitCode, signal: exitSignal });
    this._lastProcessInfo = getProcessInfo;

    this.process.stdout.on("data", (data) => {
```

and replace:

```js
    this.process.on("close", (code) => {
      exitCode = code;
      debugLogger.debug("whisper-server process exited", { code });
```

with:

```js
    this.process.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      debugLogger.debug("whisper-server process exited", { code, signal });
```

and replace:

```js
    try {
      await this.waitForReady(
        () => ({ stderr: stderrBuffer, exitCode }),
        usingVulkan ? VULKAN_STARTUP_TIMEOUT_MS : STARTUP_TIMEOUT_MS
      );
    } catch (err) {
      // An intentional stop() during startup is not a GPU/thread failure
      if (err.isStopped) throw err;
      if (usingCuda || usingVulkan) {
        // Fall back on ANY startup rejection — a GPU server can exit early
        // (missing kernels), die late (VRAM OOM mid-model-load), or hang, and
        // in every case the CPU binary is the working answer. stop() reaps a
        // hung process before the CPU restart.
        debugLogger.warn(
          `${usingCuda ? "CUDA" : "Vulkan"} whisper-server failed, falling back to CPU`,
          {
            error: err.message,
            exitCode,
            stderr: stderrBuffer.slice(0, 200),
          }
        );
        this.emit(usingCuda ? "cuda-fallback" : "gpu-fallback");
```

with:

```js
    const startupTimeoutMs = usingVulkan ? VULKAN_STARTUP_TIMEOUT_MS : STARTUP_TIMEOUT_MS;
    try {
      await this.waitForReady(getProcessInfo, startupTimeoutMs);
    } catch (err) {
      // An intentional stop() during startup is not a GPU/thread failure
      if (err.isStopped) throw err;
      if (usingCuda || usingVulkan) {
        // Fall back on ANY startup rejection — a GPU server can exit early
        // (missing kernels), die late (VRAM OOM mid-model-load), or hang, and
        // in every case the CPU binary is the working answer. stop() reaps a
        // hung process before the CPU restart. The reason travels with the
        // event so it is saved beside the failure and shown on the GPU card:
        // the device banner is far longer than 200 characters (#1736).
        const reason = extractWhisperGpuFailureReason({
          ...getProcessInfo(),
          timeoutMs: startupTimeoutMs,
        });
        debugLogger.warn(
          `${usingCuda ? "CUDA" : "Vulkan"} whisper-server failed, falling back to CPU`,
          { error: err.message, exitCode, reason }
        );
        this.emit(usingCuda ? "cuda-fallback" : "gpu-fallback", { reason });
```

Leave the next three lines untouched: `await this.stop();`, `this.gpuFallbackActive = true;`, and `return this._doStart(...)`.

4d. `_fallbackToCpuAndRetry`. Replace the whole method (lines 1080-1091):

```js
  async _fallbackToCpuAndRetry(body, boundary, modelPath) {
    const backend = this.useCuda ? "cuda" : "vulkan";
    // Read the crashed server's output now: the CPU start below replaces it
    const reason = extractWhisperGpuFailureReason(this._lastProcessInfo?.() ?? {});
    debugLogger.warn(`${backend} whisper-server died during transcription, falling back to CPU`, {
      port: this.port,
      model: modelPath ? path.basename(modelPath) : null,
      reason,
    });
    await this.start(modelPath, { ...this.lastStartOptions, useCuda: false, useVulkan: false });
    this.gpuFallbackActive = true;
    // Emit only once the CPU server is up — the notification tells the user CPU is in use
    this.emit(backend === "cuda" ? "cuda-fallback" : "gpu-fallback", { reason });
    return await this._postInference(body, boundary);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nvm exec 24 node --import tsx --test --test-concurrency=4 test/helpers/whisperServerGpuFailureReason.test.js test/helpers/whisperCudaRequestFallback.test.js test/helpers/whisperServerGpuGuard.test.js test/helpers/whisperVulkanDevicePin.test.js test/helpers/whisperServerVadArgs.test.js test/helpers/whisperServerWavInput.test.js test/helpers/whisperServerInferenceFields.test.js`
Expected: PASS, all of them. The existing listeners ignore the new payload.

- [ ] **Step 6: Format and commit**

```bash
nvm exec 24 npx prettier --write src/helpers/whisperServer.js
git add src/helpers/whisperServer.js test/helpers/whisperServerGpuFailureReason.test.js test/helpers/whisperCudaRequestFallback.test.js
git commit -m "feat(whisper): carry the GPU failure reason on the CPU fallback events"
```

---

### Task 3: Save the reason with the failure flag, clear it with the flag, and return it from status

**Files:**
- Modify: `src/helpers/whisperGpuFailureReason.js` (add the key names)
- Modify: `src/helpers/ipcHandlers.js:13` (import), `:683-704` (constructor listeners), `:1271-1287` (record/clear), `:3438` and `:3500` (status), `:3564` (retry)
- Create: `test/helpers/whisperGpuFailureRecordIpc.test.js`

**Interfaces:**
- Consumes: the `{ reason }` event payload (Task 2).
- Produces:
  - `WHISPER_GPU_FAILURE_REASON_KEYS = { cuda: "WHISPER_GPU_FAILED_REASON_CUDA", vulkan: "WHISPER_GPU_FAILED_REASON_VULKAN" }`, exported from `whisperGpuFailureReason.js`.
  - `IPCHandlers#_attachWhisperServerListeners(serverManager)`
  - `_recordWhisperGpuFailure(backend, reason = null)`
  - `_clearWhisperGpuFailure(backend)`
  - `_whisperGpuFailureStatus(backend) => { gpuFailed: boolean, gpuFailReason: string | null }`
  - Both status IPC replies gain `gpuFailReason: string | null`.

- [ ] **Step 1: Write the failing tests (real handlers, stubbed Electron)**

Create `test/helpers/whisperGpuFailureRecordIpc.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// Runs the real GPU-failure handlers from ipcHandlers.js outside Electron. The
// saved reason must follow WHISPER_GPU_FAILED everywhere the flag is set,
// cleared or reported (#1736).
const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const broadcasts = [];
// A private userData, so nothing (e.g. tokenStore's auth-token.bin) is read from a shared temp dir
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-gpu-ipc-"));
const electronStub = {
  app: {
    getPath: () => userDataDir,
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on() {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, handler) => handlers.set(channel, handler),
    on() {},
    removeHandler() {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class {
    static getAllWindows() {
      return [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, data) => broadcasts.push({ channel, data }) },
        },
      ];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  // Never reach the OS keychain (tokenStore and environment.js load secretCrypto)
  if (request === "./secretCrypto") return { isAvailable: () => false };
  if (parent?.filename === handlersModulePath) {
    if (request === "./debugLogger") return new Proxy({}, { get: () => () => {} });
    // The status handlers probe the machine's GPUs; the answer is irrelevant here
    if (request === "../utils/gpuDetection") {
      return { detectNvidiaGpu: async () => ({ hasNvidiaGpu: false }) };
    }
    if (request === "../utils/vulkanDetection") {
      return { detectVulkanGpu: async () => ({ available: true }) };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

const FAILURE_KEYS = [
  "WHISPER_GPU_FAILED",
  "WHISPER_GPU_FAILED_REASON_CUDA",
  "WHISPER_GPU_FAILED_REASON_VULKAN",
];
const ENV_KEYS = [
  ...FAILURE_KEYS,
  "WHISPER_CUDA_ENABLED",
  "WHISPER_VULKAN_ENABLED",
  "WHISPER_VULKAN_DEVICE",
];
const savedEnv = {};
test.beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  broadcasts.length = 0;
});
test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const DEVICE_LOST = "vk::PhysicalDevice::createDevice: ErrorDeviceLost";
const KERNEL_IMAGE = "CUDA error: no kernel image is available for execution on the device";

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function createHandlers() {
  const IPCHandlers = require(handlersModulePath);
  const serverManager = new EventEmitter();
  serverManager.isRemote = false;
  // What each .env rewrite would persist, captured at the moment of the write
  const envWrites = [];
  const target = Object.assign(Object.create(IPCHandlers.prototype), {
    environmentManager: {
      saveAllKeysToEnvFile: async () => {
        envWrites.push(Object.fromEntries(FAILURE_KEYS.map((key) => [key, process.env[key]])));
        return { success: true };
      },
    },
    whisperManager: {
      serverManager,
      currentServerModel: null,
      stopServer: async () => {},
      restartServerWithGpuPreference: async () => ({ success: true, restarted: false }),
    },
    whisperCudaManager: {
      isDownloaded: () => true,
      isDownloading: () => false,
      getCudaBinaryPath: () => null,
      download: async () => {},
      delete: async () => ({ success: true }),
    },
    whisperVulkanManager: {
      isDownloaded: () => true,
      isDownloading: () => false,
      download: async () => {},
      delete: async () => ({ success: true, deletedCount: 1 }),
    },
  });
  const context = new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
  IPCHandlers.prototype.setupHandlers.call(context);
  context._attachWhisperServerListeners(serverManager);
  const invoke = (channel) => handlers.get(channel)({ sender: { isDestroyed: () => true } });
  return { serverManager, invoke, envWrites };
}

test("a Vulkan fallback saves its reason with the flag, in one .env write", () => {
  const { serverManager, envWrites } = createHandlers();

  serverManager.emit("gpu-fallback", { reason: DEVICE_LOST });

  assert.equal(process.env.WHISPER_GPU_FAILED, "vulkan");
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_VULKAN, DEVICE_LOST);
  assert.deepEqual(envWrites, [
    {
      WHISPER_GPU_FAILED: "vulkan",
      WHISPER_GPU_FAILED_REASON_CUDA: undefined,
      WHISPER_GPU_FAILED_REASON_VULKAN: DEVICE_LOST,
    },
  ]);
  assert.deepEqual(broadcasts, [{ channel: "gpu-fallback-notification", data: {} }]);
});

test("the status IPC reports each backend's own saved reason", async () => {
  const { serverManager, invoke } = createHandlers();
  serverManager.emit("gpu-fallback", { reason: DEVICE_LOST });
  serverManager.emit("cuda-fallback", { reason: KERNEL_IMAGE });

  const vulkan = await invoke("get-vulkan-whisper-status");
  const cuda = await invoke("get-cuda-whisper-status");

  assert.equal(vulkan.gpuFailed, true);
  assert.equal(vulkan.gpuFailReason, DEVICE_LOST);
  assert.equal(cuda.gpuFailed, true);
  assert.equal(cuda.gpuFailReason, KERNEL_IMAGE);
});

test("a failure with no readable reason clears the older one instead of showing it", async () => {
  const { serverManager, invoke } = createHandlers();
  process.env.WHISPER_GPU_FAILED_REASON_CUDA = KERNEL_IMAGE;

  serverManager.emit("cuda-fallback", { reason: null });

  assert.equal(process.env.WHISPER_GPU_FAILED, "cuda");
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_CUDA, undefined);
  assert.equal((await invoke("get-cuda-whisper-status")).gpuFailReason, null);
  // An emitter that passes nothing at all is tolerated
  assert.doesNotThrow(() => serverManager.emit("gpu-fallback"));
  assert.equal(process.env.WHISPER_GPU_FAILED, "cuda,vulkan");
});

test("no reason is reported for a backend that is not marked failed", async () => {
  const { invoke } = createHandlers();
  // A leftover reason without its flag, e.g. from a hand-edited .env
  process.env.WHISPER_GPU_FAILED_REASON_VULKAN = DEVICE_LOST;

  const vulkan = await invoke("get-vulkan-whisper-status");

  assert.equal(vulkan.gpuFailed, false);
  assert.equal(vulkan.gpuFailReason, null);
});

test("Retry clears every saved reason with the flag", async () => {
  const { serverManager, invoke } = createHandlers();
  serverManager.emit("gpu-fallback", { reason: DEVICE_LOST });
  serverManager.emit("cuda-fallback", { reason: KERNEL_IMAGE });

  await invoke("whisper-gpu-retry");

  for (const key of FAILURE_KEYS) assert.equal(process.env[key], undefined, key);
});

test("deleting or re-downloading one pack clears only that pack's reason", async () => {
  const { serverManager, invoke } = createHandlers();
  serverManager.emit("gpu-fallback", { reason: DEVICE_LOST });
  serverManager.emit("cuda-fallback", { reason: KERNEL_IMAGE });

  await invoke("delete-vulkan-whisper-binary");
  assert.equal(process.env.WHISPER_GPU_FAILED, "cuda");
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_VULKAN, undefined);
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_CUDA, KERNEL_IMAGE);

  await invoke("download-cuda-whisper-binary");
  assert.equal(process.env.WHISPER_GPU_FAILED, undefined);
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_CUDA, undefined);
});

test("deleting the CUDA pack and re-downloading Vulkan clear their reasons too", async () => {
  const { serverManager, invoke } = createHandlers();

  serverManager.emit("cuda-fallback", { reason: KERNEL_IMAGE });
  await invoke("delete-cuda-whisper-binary");
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_CUDA, undefined);

  serverManager.emit("gpu-fallback", { reason: DEVICE_LOST });
  await invoke("download-vulkan-whisper-binary");
  assert.equal(process.env.WHISPER_GPU_FAILED_REASON_VULKAN, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nvm exec 24 node --import tsx --test test/helpers/whisperGpuFailureRecordIpc.test.js`
Expected: FAIL. `_attachWhisperServerListeners` does not exist yet, so the proxy turns the call into a no-op and the assertions fail. For example: `Expected values to be strictly equal: undefined !== 'vulkan'`. `gpuFailReason` is also `undefined` in the status replies.

- [ ] **Step 3: Add the key names to the helper**

In `src/helpers/whisperGpuFailureReason.js`, add after `const MAX_REASON_LENGTH = 240;`:

```js

// Where the reason is saved: one .env key per backend beside WHISPER_GPU_FAILED,
// set and cleared with it (ipcHandlers, whisperGpuUpgradeReset) and listed in
// environment.js PERSISTED_KEYS so a .env rewrite keeps it.
const WHISPER_GPU_FAILURE_REASON_KEYS = Object.freeze({
  cuda: "WHISPER_GPU_FAILED_REASON_CUDA",
  vulkan: "WHISPER_GPU_FAILED_REASON_VULKAN",
});
```

and change the export line to:

```js
module.exports = {
  MAX_REASON_LENGTH,
  WHISPER_GPU_FAILURE_REASON_KEYS,
  extractWhisperGpuFailureReason,
};
```

- [ ] **Step 4: Implement in `src/helpers/ipcHandlers.js`**

4a. After line 13 (`const { resolveFailedGpuBackends } = require("./whisper");`) add:

```js
const { WHISPER_GPU_FAILURE_REASON_KEYS } = require("./whisperGpuFailureReason");
```

4b. Constructor (lines 683-704). Replace this block:

```js
    if (this.whisperManager?.serverManager) {
      // Remember the failed backend so it isn't re-attempted (and its model
      // reload re-paid) on every launch; cleared by retry, re-download, delete.
      this.whisperManager.serverManager.on("cuda-fallback", () => {
        this._recordWhisperGpuFailure("cuda");
        broadcastToWindows("cuda-fallback-notification", {});
      });
      this.whisperManager.serverManager.on("gpu-fallback", () => {
        this._recordWhisperGpuFailure("vulkan");
        broadcastToWindows("gpu-fallback-notification", {});
      });
      // Persist the discrete-GPU pin so later launches spawn pinned directly
      // instead of paying a second Vulkan cold start. See #1606.
      this.whisperManager.serverManager.on("vulkan-device-pinned", ({ index }) => {
        this._syncStartupEnv({ WHISPER_VULKAN_DEVICE: String(index) });
      });
      this.whisperManager.serverManager.on("vulkan-device-pin-cleared", () => {
        this._syncStartupEnv({}, ["WHISPER_VULKAN_DEVICE"]);
      });
    }
```

with the following. The listeners move, unchanged except for the reason, into `_attachWhisperServerListeners` below, so a test can attach them without constructing `IPCHandlers`.

```js
    if (this.whisperManager?.serverManager) {
      this._attachWhisperServerListeners(this.whisperManager.serverManager);
    }
```

4c. Replace these two methods (lines 1275-1287). Keep `_whisperGpuFailedBackends()` above them unchanged:

```js
  _recordWhisperGpuFailure(backend) {
    const failed = this._whisperGpuFailedBackends();
    if (!failed.includes(backend)) failed.push(backend);
    this._syncStartupEnv({ WHISPER_GPU_FAILED: failed.join(",") });
  }

  _clearWhisperGpuFailure(backend) {
    const failed = this._whisperGpuFailedBackends().filter((b) => b !== backend);
    if (failed.length > 0) {
      this._syncStartupEnv({ WHISPER_GPU_FAILED: failed.join(",") });
    } else {
      this._syncStartupEnv({}, ["WHISPER_GPU_FAILED"]);
    }
  }
```

with the listener method, the two updated methods, and the status method:

```js
  // Remember the failed backend, and the error line that explains it, so the
  // backend isn't re-attempted (and its model reload re-paid) on every launch
  // and the settings card can say why (#1736). Cleared by retry, re-download,
  // delete, and the once-per-upgrade reset.
  _attachWhisperServerListeners(serverManager) {
    serverManager.on("cuda-fallback", ({ reason } = {}) => {
      this._recordWhisperGpuFailure("cuda", reason);
      broadcastToWindows("cuda-fallback-notification", {});
    });
    serverManager.on("gpu-fallback", ({ reason } = {}) => {
      this._recordWhisperGpuFailure("vulkan", reason);
      broadcastToWindows("gpu-fallback-notification", {});
    });
    // Persist the discrete-GPU pin so later launches spawn pinned directly
    // instead of paying a second Vulkan cold start. See #1606.
    serverManager.on("vulkan-device-pinned", ({ index }) => {
      this._syncStartupEnv({ WHISPER_VULKAN_DEVICE: String(index) });
    });
    serverManager.on("vulkan-device-pin-cleared", () => {
      this._syncStartupEnv({}, ["WHISPER_VULKAN_DEVICE"]);
    });
  }

  // The reason is written in the same .env write as the flag. A failure with
  // no readable reason clears the older one, so a stale cause is never shown.
  _recordWhisperGpuFailure(backend, reason = null) {
    const failed = this._whisperGpuFailedBackends();
    if (!failed.includes(backend)) failed.push(backend);
    const reasonKey = WHISPER_GPU_FAILURE_REASON_KEYS[backend];
    this._syncStartupEnv(
      { WHISPER_GPU_FAILED: failed.join(","), ...(reason ? { [reasonKey]: reason } : {}) },
      reason ? [] : [reasonKey]
    );
  }

  _clearWhisperGpuFailure(backend) {
    const failed = this._whisperGpuFailedBackends().filter((b) => b !== backend);
    const reasonKey = WHISPER_GPU_FAILURE_REASON_KEYS[backend];
    if (failed.length > 0) {
      this._syncStartupEnv({ WHISPER_GPU_FAILED: failed.join(",") }, [reasonKey]);
    } else {
      this._syncStartupEnv({}, ["WHISPER_GPU_FAILED", reasonKey]);
    }
  }

  // A reason is only ever reported for a backend that is marked failed
  _whisperGpuFailureStatus(backend) {
    const gpuFailed = this._whisperGpuFailedBackends().includes(backend);
    const reason = gpuFailed ? process.env[WHISPER_GPU_FAILURE_REASON_KEYS[backend]] : null;
    return { gpuFailed, gpuFailReason: reason || null };
  }
```

4d. `get-cuda-whisper-status` (line 3438). Replace `gpuFailed: this._whisperGpuFailedBackends().includes("cuda"),` with:

```js
        ...this._whisperGpuFailureStatus("cuda"),
```

4e. `get-vulkan-whisper-status` (line 3500). Replace `gpuFailed: this._whisperGpuFailedBackends().includes("vulkan"),` with:

```js
        ...this._whisperGpuFailureStatus("vulkan"),
```

4f. `whisper-gpu-retry` (line 3564). Replace `this._syncStartupEnv({}, ["WHISPER_GPU_FAILED"]);` with:

```js
      this._syncStartupEnv({}, [
        "WHISPER_GPU_FAILED",
        ...Object.values(WHISPER_GPU_FAILURE_REASON_KEYS),
      ]);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nvm exec 24 node --import tsx --test --test-concurrency=4 test/helpers/whisperGpuFailureRecordIpc.test.js test/helpers/whisperGpuFailureReason.test.js test/helpers/whisperGpuResolve.test.js test/helpers/dictationPreviewStop.test.js`
Expected: PASS, all. `dictationPreviewStop` also runs `setupHandlers`, so it guards against a registration regression.

- [ ] **Step 6: Format and commit**

```bash
nvm exec 24 npx prettier --write src/helpers/whisperGpuFailureReason.js src/helpers/ipcHandlers.js
git add src/helpers/whisperGpuFailureReason.js src/helpers/ipcHandlers.js test/helpers/whisperGpuFailureRecordIpc.test.js
git commit -m "feat(whisper): save the GPU failure reason with the failure flag"
```

---

### Task 4: Keep the reason in `.env` across rewrites, and clear it on upgrade

**Files:**
- Modify: `src/helpers/environment.js:49` (`PERSISTED_KEYS`)
- Modify: `src/helpers/whisperGpuUpgradeReset.js` (whole function)
- Modify: `test/helpers/whisperGpuUpgradeReset.test.js` (replace the file)

**Interfaces:**
- Consumes: `WHISPER_GPU_FAILURE_REASON_KEYS` (Task 3).
- Produces:
  - Both keys are written by `saveAllKeysToEnvFile()` and cleared by `clearAllPersistedData()`.
  - `resetWhisperGpuFailureOnUpgrade(environmentManager) => boolean` now clears the flag and both reasons. It returns `true` when anything was cleared.

- [ ] **Step 1: Write the failing tests**

Replace `test/helpers/whisperGpuUpgradeReset.test.js` with the version below. The first two tests and the assertions of the third are unchanged; the third moves onto a shared helper. Three tests are new.

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
// The real parser, taken before any test stubs dotenv's loader
const { parse: parseDotenv } = require("dotenv");

// Runs outside Electron: stub the app userData path and version before loading.
let userDataDir = null;
let appVersion = "1.9.1";

require.cache[require.resolve("electron")] = {
  exports: { app: { getPath: () => userDataDir, getVersion: () => appVersion } },
};

// Never touch the OS keychain: EnvironmentManager's .env writer asks secretCrypto
// whether encryption is available, which opens the real keychain.
const secretCryptoPath = require.resolve("../../src/helpers/secretCrypto.js");
require.cache[secretCryptoPath] = {
  id: secretCryptoPath,
  filename: secretCryptoPath,
  loaded: true,
  exports: { isAvailable: () => false },
};

const { resetWhisperGpuFailureOnUpgrade } = require("../../src/helpers/whisperGpuUpgradeReset.js");

const DEVICE_LOST = "vk::PhysicalDevice::createDevice: ErrorDeviceLost";
const KERNEL_IMAGE = "CUDA error: no kernel image is available for execution on the device";
// The failure flag and the reasons saved with it (#1736) are one record
const FAILURE_KEYS = [
  "WHISPER_GPU_FAILED",
  "WHISPER_GPU_FAILED_REASON_CUDA",
  "WHISPER_GPU_FAILED_REASON_VULKAN",
];

function makeEnvManager() {
  const manager = { removals: [] };
  manager.removeKeyFromEnvFile = async (key) => {
    manager.removals.push(key);
  };
  return manager;
}

function clearFailureKeys() {
  for (const key of FAILURE_KEYS) delete process.env[key];
}

test.beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-upgrade-reset-"));
  appVersion = "1.9.1";
  clearFailureKeys();
});

test.afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  clearFailureKeys();
});

// Real EnvironmentManager (electron and secretCrypto stubbed above) with
// dotenv's loader stubbed and resourcesPath pinned, so the test owns the .env.
async function withRealEnvironmentManager(run) {
  const dotenvPath = require.resolve("dotenv");
  const originalDotenv = require.cache[dotenvPath];
  require.cache[dotenvPath] = {
    id: dotenvPath,
    filename: dotenvPath,
    loaded: true,
    exports: { config: () => ({ parsed: {} }) },
  };
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDir;
  try {
    const EnvironmentManager = require("../../src/helpers/environment.js");
    await run(new EnvironmentManager(), path.join(userDataDir, ".env"));
  } finally {
    if (originalDotenv) require.cache[dotenvPath] = originalDotenv;
    else delete require.cache[dotenvPath];
    process.resourcesPath = originalResourcesPath;
  }
}

// Removals are queued one after another, so the last one settles after all
function trackRemovals(envManager) {
  const realRemove = envManager.removeKeyFromEnvFile.bind(envManager);
  const tracked = { last: null };
  envManager.removeKeyFromEnvFile = (key) => (tracked.last = realRemove(key));
  return tracked;
}

test("clears the remembered GPU failure exactly once per version change", () => {
  process.env.WHISPER_GPU_FAILED = "cuda";
  const envManager = makeEnvManager();

  // First launch of this version (no sentinel yet, e.g. upgrading from 1.8.3)
  assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), true);
  assert.equal(process.env.WHISPER_GPU_FAILED, undefined);
  assert.deepEqual(envManager.removals, ["WHISPER_GPU_FAILED"]);

  // GPU failed again on this version — the flag survives relaunches
  process.env.WHISPER_GPU_FAILED = "cuda";
  assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), false);
  assert.equal(process.env.WHISPER_GPU_FAILED, "cuda");
  assert.equal(envManager.removals.length, 1);

  // The next upgrade earns one more fresh attempt
  appVersion = "1.9.2";
  assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), true);
  assert.equal(process.env.WHISPER_GPU_FAILED, undefined);
  assert.equal(envManager.removals.length, 2);
});

test("records the running version without persisting when no failure is stored", () => {
  const envManager = makeEnvManager();
  assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), false);
  assert.deepEqual(envManager.removals, []);

  // The sentinel now pins this version: a failure recorded later on it sticks
  process.env.WHISPER_GPU_FAILED = "vulkan";
  assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), false);
  assert.equal(process.env.WHISPER_GPU_FAILED, "vulkan");
  assert.deepEqual(envManager.removals, []);
});

test("an upgrade clears the saved reasons together with the flag", () => {
  process.env.WHISPER_GPU_FAILED = "cuda,vulkan";
  process.env.WHISPER_GPU_FAILED_REASON_CUDA = KERNEL_IMAGE;
  process.env.WHISPER_GPU_FAILED_REASON_VULKAN = DEVICE_LOST;
  const envManager = makeEnvManager();

  assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), true);

  for (const key of FAILURE_KEYS) assert.equal(process.env[key], undefined, key);
  assert.deepEqual(envManager.removals, FAILURE_KEYS);
});

test("reset removes only the WHISPER_GPU_FAILED line; hand-added .env lines survive", async () => {
  await withRealEnvironmentManager(async (envManager, envPath) => {
    fs.writeFileSync(
      envPath,
      [
        "# OpenWhispr Environment Variables",
        "OPENWHISPR_LOG_LEVEL=debug", // hand-added: not in PERSISTED_KEYS
        "WHISPER_GPU_FAILED=cuda",
        "WHISPER_CUDA_ENABLED=true",
        "",
      ].join("\n")
    );
    process.env.WHISPER_GPU_FAILED = "cuda";
    const removals = trackRemovals(envManager);

    assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), true);
    assert.equal(process.env.WHISPER_GPU_FAILED, undefined);
    assert.ok(removals.last);
    await removals.last;

    assert.equal(
      fs.readFileSync(envPath, "utf8"),
      [
        "# OpenWhispr Environment Variables",
        "OPENWHISPR_LOG_LEVEL=debug",
        "WHISPER_CUDA_ENABLED=true",
        "",
      ].join("\n"),
      "every line except WHISPER_GPU_FAILED is preserved verbatim"
    );

    // A missing .env is tolerated (fresh install: nothing to remove)
    fs.unlinkSync(envPath);
    await envManager.removeKeyFromEnvFile("WHISPER_GPU_FAILED");
    assert.equal(fs.existsSync(envPath), false);
  });
});

test("an upgrade removes the reason lines from .env too; hand-added lines survive", async () => {
  await withRealEnvironmentManager(async (envManager, envPath) => {
    fs.writeFileSync(
      envPath,
      [
        "# OpenWhispr Environment Variables",
        "OPENWHISPR_LOG_LEVEL=debug",
        "WHISPER_GPU_FAILED=vulkan",
        `WHISPER_GPU_FAILED_REASON_VULKAN=${DEVICE_LOST}`,
        "WHISPER_VULKAN_ENABLED=true",
        "",
      ].join("\n")
    );
    process.env.WHISPER_GPU_FAILED = "vulkan";
    process.env.WHISPER_GPU_FAILED_REASON_VULKAN = DEVICE_LOST;
    const removals = trackRemovals(envManager);

    assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), true);
    await removals.last;

    assert.equal(
      fs.readFileSync(envPath, "utf8"),
      [
        "# OpenWhispr Environment Variables",
        "OPENWHISPR_LOG_LEVEL=debug",
        "WHISPER_VULKAN_ENABLED=true",
        "",
      ].join("\n")
    );
  });
});

test("a saved reason survives a full .env rewrite and reads back unchanged", async () => {
  await withRealEnvironmentManager(async (envManager, envPath) => {
    process.env.WHISPER_GPU_FAILED = "cuda,vulkan";
    process.env.WHISPER_GPU_FAILED_REASON_CUDA = KERNEL_IMAGE;
    process.env.WHISPER_GPU_FAILED_REASON_VULKAN = DEVICE_LOST;

    // _syncStartupEnv rewrites the whole file from PERSISTED_KEYS
    await envManager.saveAllKeysToEnvFile();

    const saved = parseDotenv(fs.readFileSync(envPath, "utf8"));
    assert.equal(saved.WHISPER_GPU_FAILED, "cuda,vulkan");
    assert.equal(saved.WHISPER_GPU_FAILED_REASON_CUDA, KERNEL_IMAGE);
    assert.equal(saved.WHISPER_GPU_FAILED_REASON_VULKAN, DEVICE_LOST);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nvm exec 24 node --import tsx --test test/helpers/whisperGpuUpgradeReset.test.js`
Expected: 3 FAIL, 3 PASS.
- "an upgrade clears the saved reasons together with the flag" fails: `WHISPER_GPU_FAILED_REASON_CUDA` is still set.
- "an upgrade removes the reason lines…" fails: the file still contains the reason line.
- "a saved reason survives a full .env rewrite…" fails: `undefined !== 'CUDA error: …'`, because the key is not in `PERSISTED_KEYS`. This was confirmed in memory before the plan was written.

- [ ] **Step 3: Implement**

3a. `src/helpers/environment.js`, `PERSISTED_KEYS`. After `"WHISPER_GPU_FAILED",` (line 49) insert:

```js
  "WHISPER_GPU_FAILED_REASON_CUDA",
  "WHISPER_GPU_FAILED_REASON_VULKAN",
```

3b. `src/helpers/whisperGpuUpgradeReset.js`. After `const debugLogger = require("./debugLogger");` (line 4) add:

```js
const { WHISPER_GPU_FAILURE_REASON_KEYS } = require("./whisperGpuFailureReason");
```

After `const SENTINEL_FILENAME = ".whisper-gpu-retry-version";` add:

```js
// The failure flag and the reasons saved with it (#1736) are one record
const GPU_FAILURE_KEYS = ["WHISPER_GPU_FAILED", ...Object.values(WHISPER_GPU_FAILURE_REASON_KEYS)];
```

Replace the end of the function (lines 31-45):

```js
  if (!process.env.WHISPER_GPU_FAILED) return false;
  delete process.env.WHISPER_GPU_FAILED;
  debugLogger.info("Cleared remembered whisper GPU failure for a fresh attempt after upgrade", {
    from: lastRun,
    to: version,
  });
  // Targeted removal: a full saveAllKeysToEnvFile() rewrite would drop
  // hand-added .env lines (e.g. OPENWHISPR_LOG_LEVEL=debug).
  environmentManager.removeKeyFromEnvFile("WHISPER_GPU_FAILED").catch((err) => {
    debugLogger.error("Failed to persist WHISPER_GPU_FAILED clear to .env", {
      error: err.message,
    });
  });
  return true;
}
```

with:

```js
  const storedKeys = GPU_FAILURE_KEYS.filter((key) => process.env[key]);
  if (storedKeys.length === 0) return false;
  for (const key of storedKeys) delete process.env[key];
  debugLogger.info("Cleared remembered whisper GPU failure for a fresh attempt after upgrade", {
    from: lastRun,
    to: version,
  });
  // Targeted removal: a full saveAllKeysToEnvFile() rewrite would drop
  // hand-added .env lines (e.g. OPENWHISPR_LOG_LEVEL=debug).
  for (const key of storedKeys) {
    environmentManager.removeKeyFromEnvFile(key).catch((err) => {
      debugLogger.error("Failed to persist whisper GPU failure clear to .env", {
        key,
        error: err.message,
      });
    });
  }
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nvm exec 24 node --import tsx --test --test-concurrency=4 test/helpers/whisperGpuUpgradeReset.test.js test/helpers/environmentVoiceAgentHotkey.test.js test/helpers/whisperGpuFailureRecordIpc.test.js`
Expected: PASS, all.

- [ ] **Step 5: Format and commit**

```bash
nvm exec 24 npx prettier --write src/helpers/environment.js src/helpers/whisperGpuUpgradeReset.js
git add src/helpers/environment.js src/helpers/whisperGpuUpgradeReset.js test/helpers/whisperGpuUpgradeReset.test.js
git commit -m "feat(whisper): persist the GPU failure reason and clear it on upgrade"
```

---

### Task 5: Show the reason on the GPU card

**Files:**
- Modify: `src/types/electron.ts:686-703`
- Modify: `src/components/TranscriptionModelPicker.tsx:448-449` (state), `:711-737` (status read), `:776-790` (fallback listener), `:1370-1373` (card)
- Create: `test/components/gpuFailureReasonCard.test.js`
- Modify: `test/components/directionalContentPolicy.test.js` (one expectation)
- Modify: `TROUBLESHOOTING.md:105` (one sentence)

**Interfaces:**
- Consumes: `gpuFailReason` on `get-cuda-whisper-status` and `get-vulkan-whisper-status` (Task 3).
- Produces: the card renders `<p dir="ltr" …>{gpuFailReason}</p>` only inside the `gpuFailed` branch.

- [ ] **Step 1: Write the failing renderer tests**

Create `test/components/gpuFailureReasonCard.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const path = require("node:path");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The GPU card in the transcription model picker shows the whisper-server error
// line that main saved with a GPU->CPU fallback (#1736).
const DEVICE_LOST = "vk::PhysicalDevice::createDevice: ErrorDeviceLost";
const OUT_OF_DEVICE_MEMORY = "vk::Device::allocateMemory: ErrorOutOfDeviceMemory";
const noop = () => {};

const vulkanPack = (overrides = {}) => ({
  downloaded: true,
  downloading: false,
  vulkan: { available: true },
  hasNvidiaGpu: false,
  gpuFailed: false,
  gpuFailReason: null,
  ...overrides,
});

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  return findElement(node.props?.children, predicate);
}

const isFailedCard = (node) => String(node.props?.className ?? "").includes("border-warning/40");
const hasText = (text) => (node) => node.props?.children === text;

// Lets the picker's IPC reads (status on mount, re-read after a fallback) land
function settle() {
  return React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function mountPicker(t, vulkanStatus) {
  installBrowserGlobals(t, {
    window: { location: { search: "" }, electronAPI: { getPlatform: () => "win32" } },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-gpu-failure-reason-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const container = installHookDom(t);
  const pack = { status: vulkanStatus, statusReads: 0 };
  const vulkanFallbackListeners = [];
  Object.assign(globalThis.window.electronAPI, {
    checkParakeetInstallation: async () => ({ supported: true }),
    listParakeetModels: async () => ({ success: true, models: [] }),
    listWhisperModels: async () => ({ success: true, models: [] }),
    onWhisperDownloadProgress: () => noop,
    onParakeetDownloadProgress: () => noop,
    getCudaWhisperStatus: async () => ({
      downloaded: false,
      downloading: false,
      path: null,
      gpuInfo: { hasNvidiaGpu: false },
      gpuFailed: false,
      gpuFailReason: null,
    }),
    getVulkanWhisperStatus: async () => {
      pack.statusReads += 1;
      return pack.status;
    },
    whisperServerStatus: async () => ({ gpuAccelerated: false }),
    onCudaFallbackNotification: () => noop,
    onGpuFallbackNotification: (callback) => {
      vulkanFallbackListeners.push(callback);
      return noop;
    },
  });
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");
  let tree;
  function Harness() {
    tree = Picker({
      selectedLocalProvider: "whisper",
      selectedLocalModel: "base",
      useLocalWhisper: true,
      onLocalModelSelect: noop,
      onModeChange: noop,
    });
    return null;
  }
  const root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(
        ToastContext.Provider,
        { value: { toast: noop } },
        React.createElement(Harness)
      )
    );
  });
  await settle();
  return {
    pack,
    find: (predicate) => findElement(tree, predicate),
    // Main has already saved the new failure when it sends this notification
    fireVulkanFallback: async (nextStatus) => {
      pack.status = nextStatus;
      await React.act(async () => {
        for (const listener of vulkanFallbackListeners) listener();
      });
      await settle();
    },
    unmount: () => React.act(async () => root.unmount()),
  };
}

test("the failed card shows the saved reason as its own left-to-right line", async (t) => {
  const picker = await mountPicker(t, vulkanPack({ gpuFailed: true, gpuFailReason: DEVICE_LOST }));
  try {
    const card = picker.find(isFailedCard);
    const line = findElement(card, hasText(DEVICE_LOST));
    assert.ok(line, "the reason is on the failed card");
    assert.equal(line.props.dir, "ltr");
  } finally {
    await picker.unmount();
  }
});

test("a failure saved before this change renders the card exactly as before", async (t) => {
  const picker = await mountPicker(t, vulkanPack({ gpuFailed: true, gpuFailReason: undefined }));
  try {
    const card = picker.find(isFailedCard);
    assert.ok(card, "the failed card still shows");
    assert.equal(findElement(card, (node) => node.props?.dir === "ltr"), null, "no empty line");
  } finally {
    await picker.unmount();
  }
});

test("a reason is never shown while the pack is not marked failed", async (t) => {
  const stale = "a reason left over from an old failure";
  const picker = await mountPicker(t, vulkanPack({ gpuFailReason: stale }));
  try {
    assert.equal(picker.find(isFailedCard), null);
    assert.equal(picker.find(hasText(stale)), null);
  } finally {
    await picker.unmount();
  }
});

test("a live fallback re-reads the status: the new reason shows and replaces the old one", async (t) => {
  const picker = await mountPicker(t, vulkanPack());
  try {
    assert.equal(picker.find(isFailedCard), null);

    await picker.fireVulkanFallback(vulkanPack({ gpuFailed: true, gpuFailReason: DEVICE_LOST }));
    assert.ok(picker.find(hasText(DEVICE_LOST)), "shown without reopening settings");
    assert.equal(picker.pack.statusReads, 2, "the status was read again after the notification");

    // A later failure (e.g. after Retry) replaces the line; the old reason never lingers
    await picker.fireVulkanFallback(
      vulkanPack({ gpuFailed: true, gpuFailReason: OUT_OF_DEVICE_MEMORY })
    );
    assert.ok(picker.find(hasText(OUT_OF_DEVICE_MEMORY)));
    assert.equal(picker.find(hasText(DEVICE_LOST)), null);
  } finally {
    await picker.unmount();
  }
});
```

Note: this harness renders the **real** English strings; the `react-i18next` mock used in `orukeetOrganization.test.js` does not take effect under Vite SSR. So match on data (the reason string, the card's `border-warning/40` class), never on i18n keys. A dry run against origin/main confirmed that the card renders and that firing the captured Vulkan listener flips it to failed, with only 1 status read.

- [ ] **Step 2: Pin the content direction**

In `test/components/directionalContentPolicy.test.js`, add as the last entry of the `expectations` array, after the `UploadAudioView.tsx` `{f\.name}` entry:

```js
    ["src/components/TranscriptionModelPicker.tsx", /<p\s+dir="ltr"[^>]*>\s*\{gpuFailReason\}/],
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `nvm exec 24 node --import tsx --test test/components/gpuFailureReasonCard.test.js test/components/directionalContentPolicy.test.js`
Expected:
- The two guard tests pass before and after the change: "a failure saved before this change…" and "a reason is never shown while…".
- "the failed card shows the saved reason…" fails: `the reason is on the failed card`.
- "a live fallback re-reads the status…" fails: `shown without reopening settings`, with `statusReads` still 1.
- The directional policy test fails: `src/components/TranscriptionModelPicker.tsx lost its content-direction policy`.

- [ ] **Step 4: Types**

In `src/types/electron.ts`, add to `CudaWhisperStatus`, after `gpuFailed?: boolean;` (line 693):

```ts
  /** The whisper-server error line saved with that failure; null when none was readable. */
  gpuFailReason?: string | null;
```

and the same two lines to `VulkanWhisperStatus`, after its `gpuFailed?: boolean;` (line 702).

- [ ] **Step 5: Component: state, status read, fallback re-read, card line**

5a. State. After `const [gpuFailed, setGpuFailed] = useState(false);` (line 449) add:

```tsx
  // The whisper-server error line main saved with that failure (#1736)
  const [gpuFailReason, setGpuFailReason] = useState<string | null>(null);
```

5b. Replace the status-read effect (lines 711-737):

```tsx
  useEffect(() => {
    if (!effectiveLocal || internalLocalProvider !== "whisper") return;
    if (getCachedPlatform() === "darwin") return;
    const detect = async () => {
      try {
        const [cuda, vulkan] = await Promise.all([
          window.electronAPI?.getCudaWhisperStatus?.(),
          window.electronAPI?.getVulkanWhisperStatus?.(),
        ]);
        // Cards below the CUDA build's kernel floor (e.g. Maxwell) crash at the
        // first kernel launch, so they get the Vulkan pack like AMD/Intel GPUs.
        const cudaEligible = !!cuda?.gpuInfo.hasNvidiaGpu && !!cuda.gpuInfo.cudaSupported;
        // Prefer the pack that's already installed: a working Vulkan setup must
        // not be re-prompted to download the CUDA pack (matches the resolver,
        // which only prefers CUDA when it is actually downloaded).
        if (cudaEligible && (cuda.downloaded || !vulkan?.downloaded)) {
          setGpuBackend("cuda");
          setGpuDownloaded(cuda.downloaded);
          setGpuFailed(!!cuda.gpuFailed);
        } else if (vulkan?.vulkan.available) {
          setGpuBackend("vulkan");
          setGpuDownloaded(vulkan.downloaded);
          setGpuFailed(!!vulkan.gpuFailed);
        }
      } catch {}
    };
    detect();
  }, [effectiveLocal, internalLocalProvider]);
```

with (the same logic, lifted into a callback so the fallback listener can reuse it):

```tsx
  // Pack, failure and failure-reason state from main. Also re-read after a
  // fallback: main saves the reason before it notifies, and a card left open
  // while the GPU fails must show it without a remount.
  const refreshGpuStatus = useCallback(async () => {
    try {
      const [cuda, vulkan] = await Promise.all([
        window.electronAPI?.getCudaWhisperStatus?.(),
        window.electronAPI?.getVulkanWhisperStatus?.(),
      ]);
      // Cards below the CUDA build's kernel floor (e.g. Maxwell) crash at the
      // first kernel launch, so they get the Vulkan pack like AMD/Intel GPUs.
      const cudaEligible = !!cuda?.gpuInfo.hasNvidiaGpu && !!cuda.gpuInfo.cudaSupported;
      // Prefer the pack that's already installed: a working Vulkan setup must
      // not be re-prompted to download the CUDA pack (matches the resolver,
      // which only prefers CUDA when it is actually downloaded).
      if (cudaEligible && (cuda.downloaded || !vulkan?.downloaded)) {
        setGpuBackend("cuda");
        setGpuDownloaded(cuda.downloaded);
        setGpuFailed(!!cuda.gpuFailed);
        setGpuFailReason(cuda.gpuFailReason ?? null);
      } else if (vulkan?.vulkan.available) {
        setGpuBackend("vulkan");
        setGpuDownloaded(vulkan.downloaded);
        setGpuFailed(!!vulkan.gpuFailed);
        setGpuFailReason(vulkan.gpuFailReason ?? null);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!effectiveLocal || internalLocalProvider !== "whisper") return;
    if (getCachedPlatform() === "darwin") return;
    refreshGpuStatus();
  }, [effectiveLocal, internalLocalProvider, refreshGpuStatus]);
```

`useCallback` is already imported (line 1).

5c. Replace the fallback-listener effect (lines 776-790):

```tsx
  // Main falls back to CPU (and remembers it) when a GPU server crashes
  useEffect(() => {
    const onFallback = () => {
      setGpuFailed(true);
      setGpuActivating(false);
      setGpuActive(false);
    };
    const disposeCuda = window.electronAPI?.onCudaFallbackNotification?.(onFallback);
    const disposeVulkan = window.electronAPI?.onGpuFallbackNotification?.(onFallback);
    return () => {
      disposeCuda?.();
      disposeVulkan?.();
    };
  }, []);
```

with:

```tsx
  // Main falls back to CPU (and remembers it) when a GPU server crashes
  useEffect(() => {
    const onFallback = () => {
      setGpuFailed(true);
      // Never show the previous failure's reason while the new one loads
      setGpuFailReason(null);
      setGpuActivating(false);
      setGpuActive(false);
      refreshGpuStatus();
    };
    const disposeCuda = window.electronAPI?.onCudaFallbackNotification?.(onFallback);
    const disposeVulkan = window.electronAPI?.onGpuFallbackNotification?.(onFallback);
    return () => {
      disposeCuda?.();
      disposeVulkan?.();
    };
  }, [refreshGpuStatus]);
```

5d. Card. Directly after the description paragraph (lines 1371-1373):

```tsx
                          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                            {t("gpu.activationFailedDescription")}
                          </p>
```

insert:

```tsx
                          {gpuFailReason && (
                            <p
                              dir="ltr"
                              className="mt-1 select-text wrap-break-word font-mono text-[11px] leading-snug text-muted-foreground"
                            >
                              {gpuFailReason}
                            </p>
                          )}
```

Change nothing else on the card: title, description, Retry and Remove stay as they are.

- [ ] **Step 6: One sentence in `TROUBLESHOOTING.md`**

At the end of the paragraph on line 105, which ends `…toggled off from the GPU card in the transcription model picker.`, append:

```markdown
 That card also shows the error line that caused the fallback (for example `vk::PhysicalDevice::createDevice: ErrorDeviceLost`); include it, or a screenshot of the card, when you report a GPU problem.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `nvm exec 24 node --import tsx --test --test-concurrency=4 test/components/gpuFailureReasonCard.test.js test/components/directionalContentPolicy.test.js test/components/orukeetOrganization.test.js`
Expected: PASS, all.

- [ ] **Step 8: Format and typecheck the renderer**

Run: `nvm exec 24 npx prettier --write src/components/TranscriptionModelPicker.tsx src/types/electron.ts`, then `nvm exec 24 npm run typecheck`.
Expected: no new errors. The only error is the pre-existing local-only `TS2307` in `MarkdownRenderer.tsx`, identical on untouched main.

- [ ] **Step 9: Commit**

```bash
git add src/types/electron.ts src/components/TranscriptionModelPicker.tsx test/components/gpuFailureReasonCard.test.js test/components/directionalContentPolicy.test.js TROUBLESHOOTING.md
git commit -m "feat(settings): show why GPU acceleration fell back to CPU"
```

---

### Task 6: Full verification

**Files:** none changed; this task only runs checks. If a check fails, fix it in the task that owns the file.

- [ ] **Step 1: All new and changed tests together**

Run:
```bash
nvm exec 24 node --import tsx --test --test-concurrency=4 \
  test/helpers/whisperGpuFailureReason.test.js \
  test/helpers/whisperServerGpuFailureReason.test.js \
  test/helpers/whisperCudaRequestFallback.test.js \
  test/helpers/whisperGpuFailureRecordIpc.test.js \
  test/helpers/whisperGpuUpgradeReset.test.js \
  test/helpers/whisperGpuResolve.test.js \
  test/helpers/whisperServerGpuGuard.test.js \
  test/helpers/whisperVulkanDevicePin.test.js \
  test/components/gpuFailureReasonCard.test.js \
  test/components/directionalContentPolicy.test.js
```
Expected: PASS, all.

- [ ] **Step 2: CI gates**

Run each separately, so that a formatting failure does not hide the typecheck:
- `nvm exec 24 npm run format:check`. Expected: PASS.
- `nvm exec 24 npm run typecheck`. Expected: only the known local-only `TS2307` in `MarkdownRenderer.tsx`.
- `nvm exec 24 npm run i18n:check`. Expected: PASS, since no keys were added.
- `nvm exec 24 npm test`. Expected: every test passes except the 11 known local-only failures in `test/components/markdownRenderer.test.js` (`ERR_MODULE_NOT_FOUND remark-gfm`), which are identical on untouched main.

- [ ] **Step 3: Diff sanity**

Run: `git diff --stat origin/main...HEAD`
Expected: exactly the 16 files in the File map, plus this plan file if you commit it (`docs/superpowers/plans/` is tracked in this repo). There must be no change to `preload.js`, `useMainProcessNotifications.tsx`, `whisperCppRelease.js`, `whisperVulkanManager.js`, `whisperCudaManager.js`, or any locale file.

- [ ] **Step 4: Optional visual check (Windows or Linux only)**

On macOS the card never renders: GPU packs are gated off at `main.js:449` and `TranscriptionModelPicker.tsx:713`. On a Windows or Linux dev build with the Vulkan pack downloaded:
1. Quit the app.
2. Add these two lines to `<userData>/.env`:
   ```
   WHISPER_GPU_FAILED=vulkan
   WHISPER_GPU_FAILED_REASON_VULKAN=vk::PhysicalDevice::createDevice: ErrorDeviceLost
   ```
   On Windows, `<userData>` is `%APPDATA%\open-whispr`.
3. Start the app on the **same version**. The upgrade reset only fires on a version change.
4. Open Settings → Speech Recognition → Local → OpenAI tab. The warning card should show the line in small monospace under "OpenWhispr switched to CPU transcription." and the text should be selectable.
5. Click Retry GPU acceleration. The line disappears, and both keys are gone from `.env`.

## Acceptance criteria

The first three describe what a user in the #1340 situation sees after updating to a release with this change:

1. **On the first launch of the new version**, the upgrade reset clears the old `WHISPER_GPU_FAILED`, so the GPU gets one fresh try during the startup pre-warm. If Vulkan dies the same way, the app falls back to CPU as today and shows the same toast. It now also saves `WHISPER_GPU_FAILED_REASON_VULKAN=vk::PhysicalDevice::createDevice: ErrorDeviceLost` in `.env`. **The user does not have to press Retry or enable debug logging.**
2. **Settings → Speech Recognition → Local → OpenAI tab** shows the existing warning card: "GPU acceleration unavailable" / "OpenWhispr switched to CPU transcription." Beneath that is a new muted monospace line, `vk::PhysicalDevice::createDevice: ErrorDeviceLost`, then Retry and Remove as before. The line is selectable and reads left-to-right in every UI language. It appears without reopening Settings if the failure happens while the card is open.
3. The card and the line survive app restarts. Retry, Remove, re-download, the next version upgrade and Reset app data all clear the line together with the failure.
4. A CUDA failure shows its own line instead, for example `CUDA error: no kernel image is available for execution on the device` or the `cudaMalloc failed: out of memory` line. This holds for failures at startup and during a transcription.
5. When a failure prints nothing recognisable, the card shows `exit code N`, `terminated by SIG…` or `startup timed out after N s`.
6. When debug logging or `--console-logs` is on, the warn line reads `Vulkan whisper-server failed, falling back to CPU {"error": "...", "exitCode": 3, "reason": "vk::PhysicalDevice::createDevice: ErrorDeviceLost"}`. The 200-character `stderr` field is gone.
7. macOS is unchanged, and no new UI strings exist.

**What cannot be verified here** (macOS, Apple Silicon, no AMD GPU):
- whether an RX 9070 XT on the current app (0.0.10 packs, isolated pack folders since desktop v1.8.3) still fails, and with which exact line;
- the byte-exact Windows stderr: the fixture is rebuilt from the pinned fork's source and the #1340/#1606 reports, so the line order is approximate while every line's text is taken from the source;
- Windows console code-page effects on non-ASCII stderr;
- anything the Vulkan loader or third-party layers print.

The UI is verified by the mounted renderer test. A visual check needs a Windows or Linux build (Task 6, Step 4).

## Cross-platform effects

- **Windows and Linux** are the only platforms that ship the CUDA and Vulkan packs. Pack managers are constructed only when `process.platform !== "darwin"` (`main.js:449-480`), and `resolveGpuStartOptions` (`whisper.js:90-102`) is the only source of `useCuda`/`useVulkan`. Both fallback sites and the card apply here.
  - Windows specifics:
    - stderr uses CRLF, handled by the line split;
    - crash exit codes are large NTSTATUS decimals, reported as given;
    - home paths use backslashes in any case, redacted case-insensitively in both slash styles.
  - Linux specifics:
    - signal deaths give `terminated by SIGSEGV`/`SIGABRT` when no line matches;
    - uncaught vulkan-hpp exceptions print a libstdc++ `what():` line, caught by rule 2.
- **macOS** uses the bundled Metal binary. The GPU fallback branches never run, because `useCuda`/`useVulkan` are never true without pack managers, and the card never renders because of the darwin guard in the status read. The code that does run on macOS is inert:
  - `_doStart` now also records the exit signal and keeps `_lastProcessInfo`;
  - the upgrade reset finds nothing to clear;
  - `.env` gains no keys.

## Out of scope (flagged, not done)

- Safe-mode Vulkan retry (`GGML_VK_ALLOW_GRAPHICS_QUEUE`, `GGML_VK_DISABLE_COOPMAT`), the fork rebase or pin bump, and passing `-nfa`. These are the maintainer's decision; see diagnosis §7 C1–C4.
- Showing the reason in the fallback toast (`useMainProcessNotifications.tsx`) or in the notification payload. The card is the durable surface.
- The llama-server (reasoning) GPU fallback card in `ReasoningModelSelector.tsx`, which has the same "no reason" gap.
- `waitForReady`'s error message and the thread-fallback warn (`whisperServer.js:704`) still embed `stderr.slice(0, 200)`.
- `stderrBuffer` grows for the whole life of a server process. This is pre-existing; the extractor reads only the last 16 KB.
- Windows 8.3 short-name paths (`C:\Users\ALEXAN~1`) are not redacted.
- Correcting #1736's "update to the latest Adrenalin driver" workaround (diagnosis §7 C5) is a text-only issue comment, separate from this PR.

## Self-review

- **Spec coverage.** Every requirement has a task and a test:
  - Save the key line alongside the failure memory: Tasks 1–4.
  - Show it on the existing card: Task 5.
  - Warn-log summary: Task 2.
  - Vulkan and CUDA, at startup and mid-transcription: Tasks 1–3.
  - No-match fallback and the length cap: Task 1.
  - Clear on retry, delete, download, upgrade and reset: Tasks 3–4.
  - No stale reason when not failed: Tasks 3 and 5.
  - Cross-platform, validation, acceptance, "Part of #1736": the sections above.
- **Placeholders.** None: every code step carries the code.
- **Name consistency.** These names are used identically across tasks:
  - `extractWhisperGpuFailureReason`
  - `MAX_REASON_LENGTH`
  - `WHISPER_GPU_FAILURE_REASON_KEYS`
  - `_lastProcessInfo`
  - `_attachWhisperServerListeners(serverManager)`
  - `_recordWhisperGpuFailure(backend, reason)`
  - `_clearWhisperGpuFailure(backend)`
  - `_whisperGpuFailureStatus(backend)`
  - `gpuFailReason`
  - `refreshGpuStatus`
  - `setGpuFailReason`
  - the event payload `{ reason }`
- **Dry runs.** Every harness was exercised in memory against origin/main d61e5213 before this plan was written: the fake-spawn `_doStart`, the IPC `setupHandlers` proxy, the mounted picker, and the real `.env` writer with keychain stubs. Each showed the RED state described in its task, and the Task 1 assertions were run against the exact helper code above.

## As implemented (deviations from the steps above)

- **Fixture line order.** `VULKAN_DEVICE_LOST_STDERR` prints the `ggml_vulkan` banner first: whisper-server registers the Vulkan backend (`ggml_backend_load_all()`, the first statement in `main`) before whisper starts loading the model. The `devices`/`backends` lines were dropped because the pinned `src/whisper.cpp` never prints them. The cause is still far past the first 200 characters.
- **Neutral fixture names.** Home folders in fixtures and the redaction test use `Mika` and `Ana`.
- **Control-character class.** `sanitizeReason` uses `/[\p{Cc}\u2028\u2029]/gu`. It covers the same code points as the listed ranges and stays clear of ESLint's `no-control-regex`.
- **Vacuous-pass guards.** In `whisperGpuFailureRecordIpc.test.js`, "Retry clears…" and "deleting the CUDA pack…" assert that the reasons were saved before clearing them. Without that, both passed before the fix because nothing had been recorded.
- **Direction policy placement.** The `{gpuFailReason}` expectation sits in "technical output values remain LTR inside an Arabic document", beside the other `dir="ltr"` entries.
