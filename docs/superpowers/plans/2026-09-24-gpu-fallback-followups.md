# GPU Fallback Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two follow-ups to PR #2317 (Part of #1736). (1) The GPU card in Settings always describes the pack the app actually runs, would start with, or last failed on, and Remove deletes that pack. (2) Every open GPU card updates when Retry, Download or Remove changes the GPU state from anywhere, without reopening Settings.

**Architecture:** Main computes the pick once, in `WhisperManager.resolveGpuPackInUse()` (whisper.js), from the same `resolveGpuStartOptions()` every server start uses. Both status IPCs report it as `inUse: boolean`. Main broadcasts one payload-less event, `whisper-gpu-status-changed`, from `_applyWhisperGpuPreference`, the one method that all five GPU-state changes end in. The card (`TranscriptionModelPicker.tsx`) reads both statuses through one `readGpuStatus` callback: on mount, on the new event, and on either fallback notification. It follows `inUse`, and keeps its own eligibility logic only for the case where no pack is in use.

**Tech Stack:** Electron main (CommonJS), React 19 + TypeScript renderer, `node:test` + `tsx`, Vite SSR renderer harness (`test/lib/rendererTestHarness.js`).

**Spec:** There is no spec file. The spec is Josh's decisions below, plus the diagnosis evidence at e557e0f8 (summarised in "Design"). Stacked on PR #2317. HEAD is 813104f9, whose only change is to `whisperGpuFailureReason.js`; it is irrelevant here.

## Decisions (Josh; do not re-litigate)

- **Item 1: show the pack in use.** The card describes the pack the app runs, would run, or tried, and Remove deletes that pack. Single-pack users must see exactly what they see today.
  - Accepted cost: with both packs installed, a failure of the unused pack stays hidden until the used one is removed.
  - No new user-visible strings, so no locale changes.
  - Main computes the pick. The renderer must not duplicate `resolveGpuStartOptions`.
- **Item 2:** main sends one payload-less "changed, re-read" event whenever the failure record or the installed packs change. Every card re-reads its status when it arrives.

## Design

### The pick (final rule), `WhisperManager.resolveGpuPackInUse()`

1. The pack `resolveGpuStartOptions()` picks now: `"cuda"` or `"vulkan"`.
2. Otherwise, the first installed pack marked failed in `WHISPER_GPU_FAILED`, CUDA then Vulkan, so its reason and Retry show.
3. Otherwise, `null`. The card keeps today's logic: offer the pack this GPU can run, or show an opted-out installed pack as "ready", exactly as today.

**Deviation: the proposed step 1 ("if the server runs on a GPU, use its live `gpuBackend`") is dropped.** It never changes the answer, and it would make the pick depend on server state that changes without any event. The evidence:
- **Every whisper start resolves its backend with `resolveGpuStartOptions()`.** The five start paths are:
  - `whisper.js:141`, restart;
  - `:196`, startup pre-warm;
  - `:367`, wake re-warm;
  - `:461`, the start before each transcription;
  - `ipcHandlers.js:3364`, `whisper-server-start`.
- **Its inputs change at runtime in only two places:**
  - `_recordWhisperGpuFailure`. The server is then on CPU, and `gpuFallbackActive` pins it there (`whisperServer.js:518-531`).
  - The five handlers that end in `_applyWhisperGpuPreference`. That call restarts the server.
- **`.env` is read only at launch** (`environment.js:79`), so the opt-out flags cannot change while the app runs.
- **So a running GPU server always runs the pack that resolve names now.** The only exception is a restart in flight, and then resolve names the restart's target.

Without step 1, the pick is a function of saved state only, and every runtime change to that state fires an event. The card's live "active" line still comes from the existing 1 s/5 s `whisperServerStatus` poll.

**Rows whose display changes.** Measured at HEAD with the diag table, then predicted by this rule. "Eligible" means `gpuInfo.hasNvidiaGpu && gpuInfo.cudaSupported`.

| Case | Server runs | Card today | Card after |
|---|---|---|---|
| Both packs, CUDA failed, Vulkan healthy | Vulkan | Unavailable, CUDA reason; Remove deletes CUDA | Vulkan state; Remove deletes Vulkan |
| Both packs, CUDA opted out, Vulkan fails live | CPU | Vulkan reason on the CUDA card; Remove deletes CUDA | Vulkan failed card; Remove deletes Vulkan |
| Both packs, not eligible, Vulkan failed | CUDA | Unavailable, Vulkan reason | CUDA state; Remove deletes CUDA |
| **Only CUDA, on a GPU not eligible for CUDA** (e.g. Maxwell, or a GPU swap) | CUDA, or CPU once CUDA failed | Offers the Vulkan download | CUDA state or CUDA failed card with its reason; after Remove, offers Vulkan as today |

The last row has one pack, but the card and the server already disagreed there today. **It is the one single-pack change: flag it to Josh** (see Open risks).

Every eligible single-pack row is unchanged: CUDA or Vulkan, failed or not, opted out or not, and the no-pack offers. Tests pin them.

### Transport

- `get-cuda-whisper-status` and `get-vulkan-whisper-status` each gain `inUse: this.whisperManager.resolveGpuPackInUse() === "<backend>"`.
- The field is computed after the handler's `await`, so it reflects state at reply time. At most one pack reports true.
- `resolveGpuStartOptions()` logs a skipped failed pack once per state (deduped by a signature), so status reads add no log spam.

### The event

- **Channel:** `whisper-gpu-status-changed`, with no payload, following the `analytics-changed` idiom.
- **Preload:** `onWhisperGpuStatusChanged`, a `registerListener` wrapper that returns an unsubscribe function.
- **Why it is sent from `_applyWhisperGpuPreference`:** exactly five callers reach it: download CUDA/Vulkan, delete CUDA (only on success)/Vulkan, and Retry. At all five, the pack files and `process.env` are already changed. One site covers them all, and a future site that applies a GPU change announces it for free.
- **When it is sent:** right after the asynchronous restart is kicked off, not after the restart completes. The pick depends only on saved state, so it is final at that moment. The restart's outcome reaches the card through the existing poll ("active"), and a failure arrives through the fallback notifications.
- **Restarts:**
  - The restart happens only when a model was loaded (`_whisperReloadModel()`).
  - Download and delete stop the server first.
  - Retry restarts it in place.
- **Not sent from `_recordWhisperGpuFailure`:** the fallback notifications already reach every window, and the card re-reads on them. Sending both would re-read twice.
- **The upgrade reset** (`main.js:998`) runs before any window exists.

### Card

- **The fallback handler now calls the same `readGpuStatus`,** one code path consistent with reopening Settings.
- **Optimistic update kept:** it still flips the card to failed and clears the old reason immediately, so a failed status read still shows the failure, as today.
- **Single pack:** unchanged. The card shows failed at once, and the reason fills in.
- **Both packs, the used pack fails and the other is healthy:** the card moves to the other pack as "GPU acceleration ready", and Remove deletes that pack.
  - The toast in the dictation window still reports the fallback.
  - The app stays on CPU until the next launch or pack change (the existing pin), then starts on the other pack.
- **Both packs failed:** the card shows CUDA's reason, even if Vulkan failed last.
- **Staleness:** between events, a pick is stale only while a restart is in flight, when it already names the target.
- **Three cards:** Settings mounts up to three pickers (`SettingsPage.tsx:680`, `MeetingSettings.tsx:133`, `UploadSettings.tsx:131`; hidden tabs stay mounted). Each subscribes, so all three re-read.
- **macOS:** the effect returns before subscribing (darwin guard). Linux/Windows arm64 have no pack assets, so the pick is `null` and nothing changes.

## Global Constraints

- "Part of #1736". Never "Fixes", "Closes" or "Resolves".
- No locale or i18n changes; `npm run i18n:check` stays green.
- No change to:
  - `useMainProcessNotifications.tsx` (the toast);
  - the fallback notification payloads;
  - `resolveGpuStartOptions`;
  - `whisperServer.js`;
  - the llama GPU path;
  - `useGpuBannerAvailability.ts`.
- New IPC channel: exactly `whisper-gpu-status-changed`. New status field: exactly `inUse`. New preload/API name: exactly `onWhisperGpuStatusChanged`.
- Node 24. Test command: `PATH=~/.nvm/versions/node/v24.20.0/bin:$PATH node --import tsx --test --test-concurrency=4 --test-reporter=tap --test-reporter-destination=stdout <files>`. Below it is written as `$T <files>`.
- Test lines stay under 100 columns. Prettier applies only to `src/` (printWidth 100).
- Code comments explain *why* and cite `#1736`.
- **Renderer-test assertions on element presence must be booleans** (`picker.shows(...)`, or `!!findElement(...)`). A failing `assert.equal(element, null)` formats the React element with its whole fiber graph. In the dry run that ran the test process out of memory (SIGKILL, and the file reported only 15 of 19 tests). Existing passing tests may keep their current form.

## Review Focus

1. **Retry pressed in the dictation window while Settings is open on the failed card.** All three cards must drop the reason and leave the failed state without a remount. Test: Task 4, "the card re-reads when main says the GPU state changed, without remounting". Main side: Task 3, "Retry on the fallback pop-up tells every open window…".
2. **A status read fails after a fallback.** The card must still show failed, and must not show the old reason. Test: Task 2, "a fallback whose status read fails still shows as failed, with no old reason".
3. **A pack download fails, or is cancelled.** Nothing changed, so nothing is announced. Test: Task 3, "a pack download that fails changes nothing and announces nothing".
4. **Single-pack users on an eligible GPU,** failed or not. The display and the Remove target must be identical to today. Test: Task 2, "one pack (…)" ×4 and "no pack on …" ×2.
5. **Unmount, or leaving the Whisper tab.** Every listener must be removed, so no stale card re-reads. Test: Task 4, "the card stops listening for GPU changes when it unmounts".

## File map

| File | Task | Change |
|---|---|---|
| `src/helpers/whisper.js` | 1 | Add `resolveGpuPackInUse()` after `resolveGpuStartOptions()` (`:93-106`) |
| `src/helpers/ipcHandlers.js` | 1, 3 | Add `inUse` to both status IPCs (`:3448-3461`, `:3512-3523`); broadcast in `_applyWhisperGpuPreference` (`:1323-1328`) |
| `src/types/electron.ts` | 1, 3 | `inUse?` on `CudaWhisperStatus` (`:687`) and `VulkanWhisperStatus` (`:698`); add `onWhisperGpuStatusChanged` after `:1767` |
| `preload.js` | 3 | Add `onWhisperGpuStatusChanged` after `onGpuFallbackNotification` (`:455-458`) |
| `src/components/TranscriptionModelPicker.tsx` | 2, 4 | Add `pickGpuCardPack` helper and `readGpuStatus`; replace `detect` (`:712-741`) and the fallback effect (`:779-806`) |
| `test/helpers/whisperGpuResolve.test.js` | 1 | Pick-rule table |
| `test/helpers/whisperGpuFailureRecordIpc.test.js` | 1, 3 | Real `WhisperManager` in the harness; two-window stub; new tests |
| `test/components/gpuFailureReasonCard.test.js` | 2, 4 | Harness gains both packs, IPC call log, listeners and `click`/`shows`/`fire`; test 5 replaced; new tests |

---

### Task 1: Main reports the pack in use

**Interfaces:** Produces `WhisperManager#resolveGpuPackInUse(): "cuda" | "vulkan" | null`, and `inUse: boolean` on both status IPC replies. Task 2 consumes `inUse`.

- [ ] **Step 1: Pick-rule tests.** Append to `test/helpers/whisperGpuResolve.test.js`. The file already has `managerWith`, `WhisperManager`, and an env save/restore that covers `WHISPER_GPU_FAILED` and `WHISPER_CUDA_ENABLED`.

```js
// The pack the settings card describes (#1736): the pack every server start
// picks, else the installed pack that failed, CUDA first, else none
const ONLY_CUDA = { cuda: true };
const ONLY_VULKAN = { vulkan: true };
const BOTH = { cuda: true, vulkan: true };
for (const [name, packs, failed, cudaOptedOut, expected] of [
  ["only CUDA", ONLY_CUDA, "", false, "cuda"],
  ["only CUDA, failed", ONLY_CUDA, "cuda", false, "cuda"],
  ["only CUDA, opted out", ONLY_CUDA, "", true, null],
  ["only Vulkan", ONLY_VULKAN, "", false, "vulkan"],
  ["only Vulkan, failed", ONLY_VULKAN, "vulkan", false, "vulkan"],
  ["no pack", {}, "cuda,vulkan", false, null],
  ["both packs", BOTH, "", false, "cuda"],
  ["both packs, CUDA failed", BOTH, "cuda", false, "vulkan"],
  ["both packs, CUDA opted out", BOTH, "", true, "vulkan"],
  ["both packs, Vulkan failed", BOTH, "vulkan", false, "cuda"],
  ["both packs, both failed", BOTH, "cuda,vulkan", false, "cuda"],
  ["both packs, CUDA opted out, Vulkan failed", BOTH, "vulkan", true, "vulkan"],
]) {
  test(`the pack in use with ${name}: ${expected}`, () => {
    process.env.WHISPER_GPU_FAILED = failed;
    if (cudaOptedOut) process.env.WHISPER_CUDA_ENABLED = "false";
    const { cuda = false, vulkan = false } = packs;
    const manager = managerWith({ cudaDownloaded: cuda, vulkanDownloaded: vulkan });

    assert.equal(manager.resolveGpuPackInUse(), expected);
  });
}

test("without injected binary managers (macOS) no pack is in use", () => {
  process.env.WHISPER_GPU_FAILED = "cuda,vulkan";
  assert.equal(new WhisperManager().resolveGpuPackInUse(), null);
});
```

- [ ] **Step 2: Switch the IPC harness to the real `WhisperManager`,** and add the status test. In `test/helpers/whisperGpuFailureRecordIpc.test.js`:

1. Delete `const { EventEmitter } = require("node:events");`.
2. After `handlersModulePath`, add `const whisperModulePath = require.resolve("../../src/helpers/whisper");`. Resolve it only: do not require whisper.js at the top level. It must load *through* the mock hook, or `whisperServer.js` gets the real `electron` module.
3. In `Module._load`, before the `handlersModulePath` block, add:
   ```js
   // whisper.js logs a skipped pack each time the status names the pack in use
   if (request === "./debugLogger" && parent?.filename === whisperModulePath) {
     return new Proxy({}, { get: () => () => {} });
   }
   ```
4. Replace the head of `createHandlers`, down to `whisperVulkanManager` in `target`, with:
   ```js
   function createHandlers({ downloadError = null } = {}) {
     const IPCHandlers = require(handlersModulePath);
     const WhisperManager = require(whisperModulePath);
     // The real manager, so the status reports the pack main has in use from the
     // same rule every server start uses. No server is ever started here.
     const whisperManager = Object.assign(new WhisperManager(), {
       stopServer: async () => {},
       restartServerWithGpuPreference: async () => ({ success: true, restarted: false }),
     });
     const { serverManager } = whisperManager;
     const download = async () => {
       if (downloadError) throw downloadError;
     };
     const whisperCudaManager = {
       isDownloaded: () => true,
       isDownloading: () => false,
       getCudaBinaryPath: () => null,
       download,
       delete: async () => ({ success: true }),
     };
     const whisperVulkanManager = {
       isDownloaded: () => true,
       isDownloading: () => false,
       download,
       delete: async () => ({ success: true, deletedCount: 1 }),
     };
     whisperManager.setGpuBinaryManagers({ cuda: whisperCudaManager, vulkan: whisperVulkanManager });
     // …envWrites unchanged…
     const target = Object.assign(Object.create(IPCHandlers.prototype), {
       environmentManager: { /* unchanged */ },
       whisperManager,
       whisperCudaManager,
       whisperVulkanManager,
     });
   ```
   The `downloadError` option is used in Task 3.
5. Append:
   ```js
   test("each pack's status says whether it is the pack main has in use", async () => {
     // Both packs installed
     const { serverManager, invoke } = createHandlers();
     const inUse = async () => [
       (await invoke("get-cuda-whisper-status")).inUse,
       (await invoke("get-vulkan-whisper-status")).inUse,
     ];
     assert.deepEqual(await inUse(), [true, false], "CUDA, as every server start picks");

     serverManager.emit("cuda-fallback", { reason: KERNEL_IMAGE });
     assert.deepEqual(await inUse(), [false, true], "the next start runs Vulkan");

     serverManager.emit("gpu-fallback", { reason: DEVICE_LOST });
     assert.deepEqual(await inUse(), [true, false], "both failed: CUDA first, with its reason");
   });
   ```

- [ ] **Step 3: Run the tests; expect RED.**
  - Run: `$T test/helpers/whisperGpuResolve.test.js test/helpers/whisperGpuFailureRecordIpc.test.js`.
  - Expected: the 13 new pick tests fail with `resolveGpuPackInUse is not a function`, and the status test fails with `[undefined, undefined]`. The pre-existing tests still pass: the real manager changes nothing they touch. This is dry-run verified.

- [ ] **Step 4: Implement.** In `src/helpers/whisper.js`, directly after `resolveGpuStartOptions()`:

```js
  // The pack the settings card describes, so the card never disagrees with the
  // server (#1736): the pack every server start picks now (a GPU server always
  // runs on it; while a pack change restarts the server, it names the target),
  // else the installed pack that fell back to CPU, CUDA first, so its reason
  // and Retry show. null when neither applies (no pack, or a pack opted out
  // with WHISPER_*_ENABLED=false): the card then chooses which pack to offer.
  resolveGpuPackInUse() {
    const { useCuda, useVulkan } = this.resolveGpuStartOptions();
    if (useCuda) return "cuda";
    if (useVulkan) return "vulkan";
    const failed = resolveFailedGpuBackends(process.env.WHISPER_GPU_FAILED);
    if (failed.includes("cuda") && this._cudaBinaryManager?.isDownloaded()) return "cuda";
    if (failed.includes("vulkan") && this._vulkanBinaryManager?.isDownloaded()) return "vulkan";
    return null;
  }
```

In `ipcHandlers.js`, append one line to each status object, after the `..._whisperGpuFailureStatus(...)` spread:
- `inUse: this.whisperManager.resolveGpuPackInUse() === "cuda",` in `get-cuda-whisper-status`;
- `inUse: this.whisperManager.resolveGpuPackInUse() === "vulkan",` in `get-vulkan-whisper-status`.

In `src/types/electron.ts`, add to **both** `CudaWhisperStatus` and `VulkanWhisperStatus`:

```ts
  /** The pack the GPU card describes: the one every whisper start picks, else
   * an installed pack that failed (#1736). At most one pack reports true. */
  inUse?: boolean;
```

- [ ] **Step 5: Run the tests; expect GREEN.** Same command as Step 3. Expected: all pass (dry run: 38/38 across the two files).
- [ ] **Step 6: Commit.** Message: `fix(whisper): report which GPU pack main has in use` (body: `Part of #1736.`). Files: `src/helpers/whisper.js`, `src/helpers/ipcHandlers.js`, `src/types/electron.ts`, and both test files.

---

### Task 2: The card follows main's pick (Item 1)

**Interfaces:** Consumes `inUse` from Task 1. Produces `readGpuStatus` (a `useCallback` with no dependencies) inside the picker, which Task 4 subscribes. Produces the harness helpers `fire(event, next)`, `click(label)`, `shows(pred)` and `listeners`.

- [ ] **Step 1: Extend the harness** in `test/components/gpuFailureReasonCard.test.js`. It covers both packs, logs pack IPC calls, and adds removable listeners, `click`, `shows` and `fire`.

Add constants and builders after `OUT_OF_DEVICE_MEMORY` and `hasText`:

```js
const KERNEL_IMAGE = "CUDA error: no kernel image is available for execution on the device";
const NVIDIA = { hasNvidiaGpu: true, cudaSupported: true };
// An NVIDIA GPU below the CUDA build's kernel floor (e.g. Maxwell)
const OLD_NVIDIA = { hasNvidiaGpu: true, cudaSupported: false };
const failedWith = (reason) => ({ gpuFailed: true, gpuFailReason: reason });
// Both packs on disk, as main reports them: `inUse` names main's pick (#1736)
const bothPacks = ({ gpuInfo = NVIDIA, inUse, cuda = {}, vulkan = {} }) => ({
  cuda: cudaPack({ downloaded: true, gpuInfo, inUse: inUse === "cuda", ...cuda }),
  vulkan: vulkanPack({
    hasNvidiaGpu: gpuInfo.hasNvidiaGpu,
    inUse: inUse === "vulkan",
    ...vulkan,
  }),
});
```

In `mountPicker`, replace the `pack`/`vulkanFallbackListeners`/`electronAPI` block with:

```js
  // `status` is the Vulkan pack's; `calls` lists the pack IPCs the card made
  const pack = { status: vulkanStatus, cuda: cudaStatus, statusReads: 0, failReads: false };
  const calls = [];
  const listeners = { cuda: [], vulkan: [], changed: [] };
  const listen = (list) => (callback) => {
    list.push(callback);
    return () => list.includes(callback) && list.splice(list.indexOf(callback), 1);
  };
  const record = (call, result) => async () => {
    calls.push(call);
    return result;
  };
  const read = (get) => async () => {
    if (pack.failReads) throw new Error("IPC failed");
    return get();
  };
  Object.assign(globalThis.window.electronAPI, {
    /* the five parakeet/whisper-model stubs, unchanged */
    getCudaWhisperStatus: read(() => pack.cuda),
    getVulkanWhisperStatus: read(() => {
      pack.statusReads += 1;
      return pack.status;
    }),
    whisperServerStatus: async () => ({ gpuAccelerated: false }),
    onCudaFallbackNotification: listen(listeners.cuda),
    onGpuFallbackNotification: listen(listeners.vulkan),
    onWhisperGpuStatusChanged: listen(listeners.changed),
    downloadCudaWhisperBinary: record("download-cuda", { success: true, willRestart: false }),
    downloadVulkanWhisperBinary: record("download-vulkan", { success: true, willRestart: false }),
    deleteCudaWhisperBinary: record("delete-cuda", { success: true }),
    deleteVulkanWhisperBinary: record("delete-vulkan", { success: true, deletedCount: 1 }),
  });
```

Replace the returned object with the following. Keep the `pack.statusReads` and `fireVulkanFallback` names, because test 4 uses them.

```js
  // Main has already saved the change when it sends any of these events.
  // `next` replaces what the status IPCs answer: { status, cuda }.
  const fire = async (event, next = {}) => {
    Object.assign(pack, next);
    await React.act(async () => {
      for (const listener of [...listeners[event]]) listener();
    });
    await settle();
  };
  return {
    pack,
    listeners,
    find: (predicate) => findElement(tree, predicate),
    // A boolean: a failing assert would print the element's whole fiber graph
    shows: (predicate) => !!findElement(tree, predicate),
    fire,
    fireVulkanFallback: (status) => fire("vulkan", { status }),
    // Clicks the card button with this label; returns the pack IPCs it made
    click: async (label) => {
      const button = findElement(tree, (node) => !!node.props?.onClick && hasText(label)(node));
      assert.ok(button, `a "${label}" button`);
      calls.length = 0;
      await React.act(async () => button.props.onClick());
      await settle();
      return [...calls];
    },
    unmount: () => React.act(async () => root.unmount()),
  };
```

The harness renders English strings: "GPU acceleration ready", "Remove" and "Enable GPU" are real labels (checked).

- [ ] **Step 2: Replace test 5 and add the pick tests.** Delete "a Vulkan fallback shows as failed even while the card shows the installed CUDA pack". Its premise, a card showing CUDA while main ran Vulkan, is the bug this task fixes, and its mocks describe a main that reports no pick; it fails after Step 4. Append:

```js
// One pack installed, as almost everyone has: main reports it in use (#1736)
const onlyCuda = (extra = {}) => ({
  cuda: cudaPack({ downloaded: true, gpuInfo: NVIDIA, inUse: true, ...extra }),
  vulkan: vulkanPack({ downloaded: false, hasNvidiaGpu: true }),
});
const onlyVulkan = (extra = {}) => ({
  cuda: cudaPack(),
  vulkan: vulkanPack({ inUse: true, ...extra }),
});
for (const [name, packs, reason, removes] of [
  ["CUDA", onlyCuda(), null, "delete-cuda"],
  ["CUDA, failed", onlyCuda(failedWith(KERNEL_IMAGE)), KERNEL_IMAGE, "delete-cuda"],
  ["Vulkan", onlyVulkan(), null, "delete-vulkan"],
  ["Vulkan, failed", onlyVulkan(failedWith(DEVICE_LOST)), DEVICE_LOST, "delete-vulkan"],
]) {
  test(`one pack (${name}): the card is unchanged and Remove deletes that pack`, async (t) => {
    const picker = await mountPicker(t, packs.vulkan, packs.cuda);
    try {
      assert.equal(picker.shows(isFailedCard), !!reason);
      assert.ok(picker.shows(hasText(reason ?? "GPU acceleration ready")));
      assert.deepEqual(await picker.click("Remove"), [removes]);
    } finally {
      await picker.unmount();
    }
  });
}

for (const [name, gpuInfo, downloads] of [
  ["an NVIDIA GPU", NVIDIA, "download-cuda"],
  ["another GPU", { hasNvidiaGpu: false }, "download-vulkan"],
]) {
  test(`no pack on ${name}: the card offers the pack that GPU can run`, async (t) => {
    const picker = await mountPicker(t, vulkanPack({ downloaded: false }), cudaPack({ gpuInfo }));
    try {
      assert.deepEqual(await picker.click("Enable GPU"), [downloads]);
    } finally {
      await picker.unmount();
    }
  });
}

// Before #1736 the card chose the pack itself, and could describe one the
// server was not using: the wrong reason showed, and Remove deleted that pack
for (const [name, packs, reason, removes] of [
  [
    "both packs, CUDA failed, Vulkan in use",
    bothPacks({ inUse: "vulkan", cuda: failedWith(KERNEL_IMAGE) }),
    null,
    "delete-vulkan",
  ],
  [
    "both packs on a GPU CUDA does not support, Vulkan failed, CUDA in use",
    bothPacks({ gpuInfo: OLD_NVIDIA, inUse: "cuda", vulkan: failedWith(DEVICE_LOST) }),
    null,
    "delete-cuda",
  ],
  [
    "both packs, CUDA opted out, Vulkan failed and in use",
    bothPacks({ inUse: "vulkan", vulkan: failedWith(DEVICE_LOST) }),
    DEVICE_LOST,
    "delete-vulkan",
  ],
  [
    "only CUDA on a GPU CUDA does not support, failed",
    onlyCuda({ gpuInfo: OLD_NVIDIA, ...failedWith(KERNEL_IMAGE) }),
    KERNEL_IMAGE,
    "delete-cuda",
  ],
]) {
  test(`${name}: the card shows the pack in use`, async (t) => {
    const picker = await mountPicker(t, packs.vulkan, packs.cuda);
    try {
      assert.equal(picker.shows(isFailedCard), !!reason);
      assert.ok(picker.shows(hasText(reason ?? "GPU acceleration ready")));
      for (const other of [KERNEL_IMAGE, DEVICE_LOST].filter((line) => line !== reason)) {
        assert.equal(picker.shows(hasText(other)), false, "no other pack's reason");
      }
      assert.deepEqual(await picker.click("Remove"), [removes]);
    } finally {
      await picker.unmount();
    }
  });
}

test("a live Vulkan fallback shows on the Vulkan card, and Remove deletes Vulkan", async (t) => {
  // Both packs; CUDA opted out by a hand-edited .env, so main runs Vulkan
  const before = bothPacks({ inUse: "vulkan" });
  const picker = await mountPicker(t, before.vulkan, before.cuda);
  try {
    assert.equal(picker.shows(isFailedCard), false);

    const after = bothPacks({ inUse: "vulkan", vulkan: failedWith(DEVICE_LOST) });
    await picker.fireVulkanFallback(after.vulkan);

    const card = picker.find(isFailedCard);
    assert.ok(!!card, "the fallback that just happened stays visible");
    assert.ok(!!findElement(card, hasText(DEVICE_LOST)), "with the failed pack's reason");
    assert.deepEqual(await picker.click("Remove"), ["delete-vulkan"]);
  } finally {
    await picker.unmount();
  }
});

test("both packs: after a CUDA fallback the card follows main to the Vulkan pack", async (t) => {
  const before = bothPacks({ inUse: "cuda" });
  const picker = await mountPicker(t, before.vulkan, before.cuda);
  try {
    // The next server start will run Vulkan, so main now reports Vulkan in use
    const after = bothPacks({ inUse: "vulkan", cuda: failedWith(KERNEL_IMAGE) });
    await picker.fire("cuda", { status: after.vulkan, cuda: after.cuda });

    assert.equal(picker.shows(isFailedCard), false);
    assert.ok(picker.shows(hasText("GPU acceleration ready")));
    assert.deepEqual(await picker.click("Remove"), ["delete-vulkan"]);
  } finally {
    await picker.unmount();
  }
});

test("a fallback whose status read fails still shows as failed, with no old reason", async (t) => {
  const picker = await mountPicker(t, vulkanPack({ inUse: true }));
  try {
    picker.pack.failReads = true;
    await picker.fireVulkanFallback(vulkanPack({ inUse: true, ...failedWith(DEVICE_LOST) }));

    const card = picker.find(isFailedCard);
    assert.ok(!!card, "the fallback still shows");
    const reasonLine = findElement(card, (node) => node.props?.dir === "ltr");
    assert.equal(!!reasonLine, false, "no reason line");
  } finally {
    await picker.unmount();
  }
});
```

- [ ] **Step 3: Run the tests; expect RED.**
  - Run: `$T test/components/gpuFailureReasonCard.test.js`.
  - Expected failures: the four "…: the card shows the pack in use" tests, "a live Vulkan fallback shows on the Vulkan card…" (Remove deletes CUDA), and "both packs: after a CUDA fallback…" (the card shows the CUDA failure).
  - Expected passes: the six single-pack/no-pack guards, the status-read-failure guard, and tests 1–4.
  - This is dry-run verified at HEAD. Around 90 s is normal: each test starts a Vite server.

- [ ] **Step 4: Implement** in `TranscriptionModelPicker.tsx`.

1. Change the type import to:
   ```ts
   import type { CudaWhisperStatus, ParakeetCheckResult, VulkanWhisperStatus } from "../types/electron";
   ```
   Let prettier wrap it.
2. Add a module-level helper directly above `export default function TranscriptionModelPicker`, with a blank line before the `export`:

```ts
// The pack the GPU card describes. Main reports the one it runs, would start
// with, or last failed on (#1736), so Remove and Retry act on the pack the
// server uses. With none in use, the card picks which pack to offer.
function pickGpuCardPack(
  cuda: CudaWhisperStatus | undefined,
  vulkan: VulkanWhisperStatus | undefined
): { backend: "cuda" | "vulkan"; status: CudaWhisperStatus | VulkanWhisperStatus } | null {
  if (cuda?.inUse) return { backend: "cuda", status: cuda };
  if (vulkan?.inUse) return { backend: "vulkan", status: vulkan };
  // Cards below the CUDA build's kernel floor (e.g. Maxwell) crash at the
  // first kernel launch, so they get the Vulkan pack like AMD/Intel GPUs.
  const cudaEligible = !!cuda?.gpuInfo.hasNvidiaGpu && !!cuda.gpuInfo.cudaSupported;
  // Prefer the installed pack: a working Vulkan setup must not be re-prompted
  // to download the CUDA pack
  if (cudaEligible && (cuda.downloaded || !vulkan?.downloaded)) {
    return { backend: "cuda", status: cuda };
  }
  if (vulkan?.vulkan.available) return { backend: "vulkan", status: vulkan };
  return null;
}
```

3. Replace the `detect` effect (`:712-741`) with the following. Task 4 adds the subscription to this effect.

```ts
  const readGpuStatus = useCallback(async () => {
    try {
      const [cuda, vulkan] = await Promise.all([
        window.electronAPI?.getCudaWhisperStatus?.(),
        window.electronAPI?.getVulkanWhisperStatus?.(),
      ]);
      const pack = pickGpuCardPack(cuda, vulkan);
      if (!pack) return;
      setGpuBackend(pack.backend);
      setGpuDownloaded(pack.status.downloaded);
      setGpuFailed(!!pack.status.gpuFailed);
      setGpuFailReason(pack.status.gpuFailReason ?? null);
    } catch {}
  }, []);

  useEffect(() => {
    if (!effectiveLocal || internalLocalProvider !== "whisper") return;
    if (getCachedPlatform() === "darwin") return;
    readGpuStatus();
  }, [effectiveLocal, internalLocalProvider, readGpuStatus]);
```

4. Replace the fallback effect (`:779-806`) with:

```ts
  // Main falls back to CPU (and remembers it) when a GPU server crashes. It
  // saves the failure before it notifies, so the re-read shows the pack main
  // now reports in use, exactly as reopening Settings would (#1736).
  useEffect(() => {
    const onFallback = () => {
      setGpuFailed(true);
      // Never show the previous failure's reason while the new one loads
      setGpuFailReason(null);
      setGpuActivating(false);
      setGpuActive(false);
      readGpuStatus();
    };
    const disposeCuda = window.electronAPI?.onCudaFallbackNotification?.(onFallback);
    const disposeVulkan = window.electronAPI?.onGpuFallbackNotification?.(onFallback);
    return () => {
      disposeCuda?.();
      disposeVulkan?.();
    };
  }, [readGpuStatus]);
```

The download, retry, delete and cancel handlers are unchanged. They already act on `gpuBackend`, which is now main's pick.

- [ ] **Step 5: Run the tests; expect GREEN.** Same command as Step 3. Expected: all pass (dry run: 17 before Task 4's two tests).
- [ ] **Step 6: Format and typecheck.**
  - `cd src && npx prettier --write components/TranscriptionModelPicker.tsx`.
  - `npm run typecheck`. Expected: only the known local-only `TS2307 remark-gfm`.
- [ ] **Step 7: Commit.** Message: `fix(whisper): show the GPU pack the app uses on the settings card` (body: `Part of #1736.`).

---

### Task 3: Main tells every window when GPU state changes (Item 2)

**Interfaces:** Produces the IPC channel `whisper-gpu-status-changed` (no payload), the preload method `onWhisperGpuStatusChanged(callback): () => void`, and the matching typing. Task 4 consumes all three.

- [ ] **Step 1: Two-window stub and tests** in `whisperGpuFailureRecordIpc.test.js`.

Replace `BrowserWindow.getAllWindows` in the stub:

```js
    // The dictation window (fallback pop-up) and the control panel (Settings).
    // Each send records what .env held at that moment.
    static getAllWindows() {
      return ["dictation", "control-panel"].map((window) => ({
        isDestroyed: () => false,
        webContents: {
          send: (channel, data) =>
            broadcasts.push({ window, channel, data, failed: process.env.WHISPER_GPU_FAILED }),
        },
      }));
    }
```

In the first test, replace the final `broadcasts` assertion. This also pins that a fallback sends no second event, and that the record is saved before the notice goes out:

```js
  // Announced once per window, by its own notification, after the save
  assert.deepEqual(
    broadcasts.map(({ window, channel, failed }) => [window, channel, failed]),
    [
      ["dictation", "gpu-fallback-notification", "vulkan"],
      ["control-panel", "gpu-fallback-notification", "vulkan"],
    ]
  );
```

Append:

```js
const STATUS_CHANGED = "whisper-gpu-status-changed";
// Which windows were told to re-read the GPU status, and what .env held then
const toldToReread = () =>
  broadcasts.filter((b) => b.channel === STATUS_CHANGED).map((b) => [b.window, b.failed]);

test("Retry on the fallback pop-up tells every open window, once it is cleared", async () => {
  const { serverManager, invoke } = createHandlers();
  serverManager.emit("gpu-fallback", { reason: DEVICE_LOST });
  broadcasts.length = 0;

  await invoke("whisper-gpu-retry");

  // Settings is another window, still showing the failure until it re-reads
  assert.deepEqual(toldToReread(), [
    ["dictation", undefined],
    ["control-panel", undefined],
  ]);
});

test("downloading or deleting either pack tells every open window, once saved", async () => {
  const { serverManager, invoke } = createHandlers();
  for (const [channel, stillFailed] of [
    ["download-cuda-whisper-binary", "vulkan"],
    ["delete-cuda-whisper-binary", "vulkan"],
    ["download-vulkan-whisper-binary", "cuda"],
    ["delete-vulkan-whisper-binary", "cuda"],
  ]) {
    serverManager.emit("cuda-fallback", { reason: KERNEL_IMAGE });
    serverManager.emit("gpu-fallback", { reason: DEVICE_LOST });
    broadcasts.length = 0;

    await invoke(channel);

    const told = [
      ["dictation", stillFailed],
      ["control-panel", stillFailed],
    ];
    assert.deepEqual(toldToReread(), told, channel);
  }
});

test("a pack download that fails changes nothing and announces nothing", async () => {
  const { invoke } = createHandlers({ downloadError: new Error("network down") });

  assert.equal((await invoke("download-vulkan-whisper-binary")).success, false);
  assert.deepEqual(toldToReread(), []);
});
```

- [ ] **Step 2: Run the tests; expect RED.**
  - Run: `$T test/helpers/whisperGpuFailureRecordIpc.test.js`.
  - Expected failures: "Retry on the fallback pop-up…" and "downloading or deleting…", because nothing is sent.
  - Expected passes: the failed-download guard, and the updated first test (it already passes at HEAD).
  - Dry-run verified.

- [ ] **Step 3: Implement.**

In `ipcHandlers.js` `_applyWhisperGpuPreference`, add between the `.catch(...)` call and `return !!modelName;`:

```js
    // Every pack download or delete and every Retry ends here, already saved.
    // Tell every window, not just the caller's: Retry on the fallback pop-up
    // runs in the dictation window, and Settings keeps up to three GPU cards
    // mounted (#1736). A fallback is announced by its own notification.
    broadcastToWindows("whisper-gpu-status-changed");
```

Extend the method's leading comment by one clause: "…and tells every window to re-read the GPU status."

In `preload.js`, after `onGpuFallbackNotification`:

```js
  // Main changed the installed packs or the remembered GPU failure (#1736)
  onWhisperGpuStatusChanged: registerListener(
    "whisper-gpu-status-changed",
    (callback) => () => callback()
  ),
```

In `src/types/electron.ts`, after `onGpuFallbackNotification`: `onWhisperGpuStatusChanged: (callback: () => void) => () => void;`.

- [ ] **Step 4: Run the tests; expect GREEN** (dry run: 11/11).
- [ ] **Step 5: Commit.** Message: `fix(whisper): tell every window when the GPU packs or failure change` (body: `Part of #1736.`).

---

### Task 4: Every card re-reads on the event (Item 2)

**Interfaces:** Consumes `onWhisperGpuStatusChanged` (Task 3) and `readGpuStatus` (Task 2).

- [ ] **Step 1: Tests.** Append to `gpuFailureReasonCard.test.js`:

```js
test("the card re-reads when main says the GPU state changed, without remounting", async (t) => {
  const failed = onlyVulkan(failedWith(DEVICE_LOST));
  const picker = await mountPicker(t, failed.vulkan, failed.cuda);
  try {
    assert.ok(picker.shows(hasText(DEVICE_LOST)));

    // Retry on the fallback pop-up, in the dictation window, cleared the failure
    await picker.fire("changed", { status: onlyVulkan().vulkan });

    assert.equal(picker.shows(isFailedCard), false);
    assert.equal(picker.shows(hasText(DEVICE_LOST)), false, "the old reason is gone");
    assert.ok(picker.shows(hasText("GPU acceleration ready")));
  } finally {
    await picker.unmount();
  }
});

test("the card stops listening for GPU changes when it unmounts", async (t) => {
  const packs = onlyVulkan();
  const picker = await mountPicker(t, packs.vulkan, packs.cuda);
  let whileMounted;
  try {
    whileMounted = picker.listeners.changed.length;
  } finally {
    // Always unmount: a picker left mounted keeps its 5 s poll alive
    await picker.unmount();
  }

  assert.equal(whileMounted, 1, "listening while mounted");
  const left = Object.values(picker.listeners).map((list) => list.length);
  assert.deepEqual(left, [0, 0, 0], "every listener removed");
});
```

- [ ] **Step 2: Run the tests; expect RED.** Both new tests fail: the card is still failed, and 0 listeners are registered.
- [ ] **Step 3: Implement.** In the mount effect from Task 2, replace `readGpuStatus();` with:

```ts
    readGpuStatus();
    // Retry on the fallback pop-up, or Remove on another card, changes the
    // packs or the saved failure while this card stays mounted (#1736)
    return window.electronAPI?.onWhisperGpuStatusChanged?.(readGpuStatus);
```

- [ ] **Step 4: Run the tests; expect GREEN** (dry run: 19/19 in the file).
- [ ] **Step 5: Commit.** Message: `fix(whisper): refresh every GPU card when the GPU state changes` (body: `Part of #1736.`).

---

### Task 5: Verification

- [ ] **Step 1: Targeted and neighbouring tests.**
  - Run: `$T test/helpers/whisperGpuResolve.test.js test/helpers/whisperGpuFailureRecordIpc.test.js test/components/gpuFailureReasonCard.test.js test/components/directionalContentPolicy.test.js test/components/orukeetOrganization.test.js test/components/fieldDirectionPolicy.test.js test/hooks/gpuBannerAvailability.test.js test/helpers/whisperServerGpuGuard.test.js test/helpers/whisperGpuUpgradeReset.test.js test/helpers/granolaImportIpc.test.js test/helpers/ipcPasteOutcome.test.js`.
  - Expected: all pass. The dry run gave 57/57 on the first three files and 70/70 on the rest.
- [ ] **Step 2: Gates.** Run each separately:
  - `npm run format:check`;
  - `npm run typecheck` (only the local-only `TS2307 remark-gfm`);
  - `npm run i18n:check`;
  - `$T "test/**/*.test.js"`. Only the known local-only failures are allowed: `markdownRenderer` ×11 (remark-gfm) and the ~10.5 GB disk-space download test.
- [ ] **Step 3: Diff sanity.** Run `git diff --stat 813104f9..HEAD`. Expect exactly the 8 files in the File map, plus this plan. Expect no locale, `whisperServer.js`, `useMainProcessNotifications.tsx` or `useGpuBannerAvailability.ts` change.
- [ ] **Step 4: Optional manual check** (Windows/Linux dev build, Vulkan pack only).
  1. Put `WHISPER_GPU_FAILED=vulkan` in `<userData>/.env` and start the same version.
  2. Open Settings → Speech Recognition → Local → Whisper. The card shows failed.
  3. Trigger the fallback toast's Retry from the dictation window. Easiest: dictate once, so that a failure recurs.
  4. Expected: the Settings card leaves the failed state within a moment, without reopening Settings.

## Acceptance criteria

**Item 2**
1. With Settings open on "GPU acceleration unavailable", pressing Retry on the fallback pop-up clears the card and its reason line in every Settings tab (Transcription, Meetings, Upload) without reopening Settings. The card then shows "GPU acceleration ready", and "GPU acceleration active" within 5 s once the GPU is up.
2. Remove, Enable GPU or Retry on one card updates the other cards in the same window, and in any other open window.
3. If the retried GPU fails again, the card returns to the failed state with the new reason, as today.

**Item 1**

4. With one pack installed on a GPU that pack supports, nothing changes: same card, same reason, and Remove deletes that pack.
5. With both packs installed, the card describes the pack main runs (or would start with), and Remove deletes that pack.
6. If the pack in use has failed and nothing else can run, the card shows that pack's failure and reason, and Retry/Remove act on it.
7. After a live failure of the pack in use, while the other pack is healthy, the card moves to the other pack as "ready". The pop-up still reports the fallback.
8. A CUDA pack on a GPU below the CUDA floor, left over from an older build, is now shown as the CUDA pack, with its reason when it has failed, instead of an offer to download Vulkan. After Remove, the card offers Vulkan.

**Both**

9. No new strings. macOS is unchanged: no packs exist there, and the card effect returns before subscribing.

## Out of scope

- The "GPU acceleration available" banner (`useGpuBannerAvailability.ts`, `ControlPanel`) does not listen to the new event.
- `cleanup-app` (erase device data) clears the record without the event.
- The llama/reasoning GPU card.
- A "latest read wins" guard for overlapping status reads. Replies are computed at reply time, detection is cached after the first probe, and an overlap needs an action in another window within the first detection's few hundred ms.

## Open risks

1. **One single-pack change (flag once to Josh):** a CUDA-only install on a GPU not eligible for CUDA now shows the CUDA pack, not a Vulkan offer (Acceptance 8). It follows "show the pack in use", and the server really runs or tried CUDA there. The alternative would reintroduce renderer-side eligibility into the pick.
2. **Both packs, both failed:** the card shows CUDA's reason even if Vulkan failed last. A consequence of "CUDA then Vulkan"; both packs are rare, both failed rarer.
3. **Both packs, CUDA fails live with Vulkan healthy:** the card shows "Vulkan ready" while this session stays on CPU (the existing pin) until the next launch. This is inside Josh's accepted cost.
4. **After an event, "active" can lag the server by up to 5 s** (the existing poll). The window that pressed the button shows "Activating" as today.
5. **Dry-run coverage:** every snippet here was applied to a scratch copy of 813104f9 and run. RED at HEAD and GREEN after was confirmed for every listed test; prettier and tsc were clean. The full-suite run in the scratch copy was interrupted by the session restart, so Task 5 Step 2 is the first full-suite run.
