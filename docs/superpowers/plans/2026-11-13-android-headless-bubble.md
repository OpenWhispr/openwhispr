# Android Headless Bubble Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an app update or a phone restart, the floating bubble dictates on the first tap in another app without OpenWhispr ever being opened: the user taps, speaks, and the text is inserted, with no app flash.

**Architecture:** `DictationService` records natively as it does today, and on the tap also starts the app's shared ReactHost and a JS headless task (`HeadlessJsTaskContext`, no extra Service). Bubble events wait in a native queue until JS says the pipeline is listening (`pipelineReady`). The pipeline, today a React hook in `Root.tsx`, becomes an idempotent module singleton that both the headless task and `Root` start, and it boots the app data it needs (config, auth, transcripts, dictionary, snippets) through one shared once-only boot. The headless task is registered at the top of a new Android-only bundle entry, `index.android.ts`.

**Tech Stack:** Expo SDK 55, React Native 0.83.10 (bridgeless, new arch), Expo Modules API (Kotlin), zustand, jest; Kotlin unit tests with JUnit 4.

**Spec:** the brief that requested this plan (user outcome above) plus the research note `/Users/joshuadavidpadoa/Library/Application Support/Claude/side-session-notes/local_1a010335-4ece-4694-8199-d0afe1a1d8e6/android-headless-bubble-research.md`. Executors read both.

**Recorded choices:** deep_research: yes · codex_review: no (the final deep review runs in a NEW session with a fresh context window) · execution: the main agent implements; reviewers are read-only · plan_status: approved 2026-11-13 (D1–D3, D5 as recommended; D4 changed to the alternative, see below).

**Branch:** `feat/android-headless-bubble`, cut from `fix/android-bubble-restore` (PR OpenWhispr/openwhispr#3211, base `feat/android-dictation-bubble`).

## Decisions needing approval

| # | Decision | Recommendation | Why / alternatives |
|---|---|---|---|
| D1 | How the headless task is registered at bundle top level | Add `openwhispr-mobile/index.android.ts` (Android-only) and change `package.json` `"main"` from `"expo-router/entry"` to `"./index"`. | `resolveEntryPoint` (`@expo/config/paths`) resolves `main` with platform extensions, so Android gets `index.android.ts` and iOS gets the existing `index.ts` (`import 'expo-router/entry';`, unchanged): iOS behaviour is identical. Routes (`app/…`) are only evaluated when the root renders, never headless, so nothing under `app/` can register the task. `package.json` is a **shared file**: it is not in the iOS source map, so `check-android-ui-isolation.mjs` will not flag it, but the hard rule lists only Android paths, so this needs explicit approval. Alternatives: delete `"main"` (same fallback to `./index`, less explicit); a config plugin rewriting the Android `entryFile` and `getJSMainModuleName` (still needs registering in shared `app.base.json`, and diverges dev from release). |
| D2 | When to warm the JS runtime | On the tap that starts a dictation (and on Retry of a recording the native queue still holds). | Recording is native and starts at once, so the runtime boots while the user speaks; a cold Hermes boot is measured on the A73 in Task 6. Warming on service start would load the whole runtime after every reboot even for people who never dictate; warming when the bubble first shows would boot it on the first focused text field anywhere. Once booted, the runtime lives until process death either way. |
| D3 | Queue timeout | `PIPELINE_READY_TIMEOUT_MS = 20_000`, counted from the moment the finished recording is queued. On timeout the bubble shows Retry, the recording stays held natively ("parked"), and nothing is delivered until the user taps Retry (which re-captures the target) or Dismiss (which deletes the file). As with any Retry, it dismisses itself after 15 s (deleting the file), and opening the app dismisses it too. | Never auto-deliver late: a late runtime would otherwise insert into whatever field is focused minutes later. 20 s on top of the speaking time is far above a cold boot. |
| D4 | Startup side effects in a headless runtime | **Approved: the alternative.** The task does not load `app/_layout.tsx`. It calls `initSentry()` (already once-only) and `runMigrations()` through an Android-only once-guard in `src/android/headlessStartup.ts`; AppsFlyer is never set up headless. | Migrations run on every launch and are idempotent (`CREATE TABLE IF NOT EXISTS`, count checks, `INSERT OR IGNORE`), so if the UI later loads `_layout.tsx` in the same runtime they run once more harmlessly. `src/db/migrate.ts` and `src/lib/sentry.ts` are shared and stay unchanged. |
| D5 | `DictationService.appVisible` default | Default `false`, plus an `Application.ActivityLifecycleCallbacks` in the service that sets it on resume/pause of OpenWhispr's activities. Module hooks stay as they are. | Today it defaults to `true` and only the Expo module sets it. In a restarted process with no activity it stays `true`, so `BubblePolicy.visible` hides the bubble: the outcome is impossible. Task 0 confirms this on the device. The callbacks cover a cold launch before the JS module exists (no bubble over the splash); the module hook still covers a service started from inside the app. |

Also decided (no approval needed, deviates from the research note): the JS task returns a never-resolving promise as recommended, but **native finishes the task** (`finishTask`) once the bubble settles (READY, RETRY or RECOVER and not stopping). That keeps JS timers running exactly while a dictation is in flight and never leaves a task active in the background. `HeadlessJsTaskContext` takes no wake lock (only `HeadlessJsTaskService` does).

## Scope

**In:** first-tap dictation from a restored bubble with no app UI; event queue + timeout; idempotent pipeline singleton; shared app-data boot; headless task + Android entry; `appVisible` fix; opening the app over a headless runtime without double handling.

**Out:** meeting capture, practice screen, sync triggers / notes init / meeting recovery headless (they stay in `Root`; transcripts saved headless sync the next time the app opens); surviving process death mid-dictation; any iOS change; new UI strings (the bubble already shows "failed"/Retry; detailed errors stay in `useBubbleResult`, shown on Home).

## Global Constraints

- Only `*.android.*`, `src/android/`, `modules/android-*`, `app/android-*` may change, plus `package.json` `main` if D1 is approved. Verified by `node scripts/check-android-ui-isolation.mjs`.
- iOS must not change: `node node_modules/expo/scripts/resolveAppEntry.js . ios relative` prints `index.ts`; `index.ts` stays byte-identical.
- Headless task key: `OpenWhisprBubblePipeline` (Kotlin `HeadlessPipeline.TASK`, literal in `index.android.ts`).
- Task config: `HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true)` — timeout 0, allowed in foreground.
- `PIPELINE_READY_TIMEOUT_MS = 20_000L` in `BubblePolicy`.
- `HeadlessJsTaskContext.startTask` must run on the main thread; readiness is `currentReactContext?.hasActiveReactInstance() == true`, else wait for `ReactInstanceEventListener.onReactContextInitialized`.
- Never `router` or hooks in code the headless task reaches.
- Branch `feat/android-headless-bubble`; commits `feat(android): …`/`fix(android): …`; no AI attribution lines, no `claude/` branch names.
- JDK 17: `export JAVA_HOME=~/.gradle/jdks/eclipse_adoptium-17-aarch64-os_x.2/jdk-17.0.20.1+1/Contents/Home`.
- JS tests from `openwhispr-mobile`: `npx jest --testPathIgnorePatterns /node_modules/ -- <pattern>`.

## Review Focus

1. **App opened while a headless runtime is running** — Root's start is a no-op; each bubble event is handled once (one insertion, one history row). Test: `starts once` (Task 4); device step 7.
2. **Runtime not ready in time / never ready** — the recording is parked, Retry shows within 20 s of the recording ending, nothing is inserted later on its own, Retry re-delivers, Dismiss deletes the file. Tests: queue park/retry/dismiss (Task 1); device step 9.
3. **Signed out or account data blocked headless** — the bubble settles on Retry with the recording kept and the account error stored, never stays on "Writing". Test: `a blocked account keeps the recording for Retry` (Task 4); device step 8.
4. **Cancel or app opened while events wait** — queued events are dropped and a held recording file is deleted; JS never sees a half dictation. Test: `cancel drops waiting events and returns the held recording` (Task 1).
5. **Root's Retry after a boot or account error** — still re-runs config/auth/data loading even though boot is now memoized. Test: `forgetAppData makes the next call boot again` (Task 3), plus the existing `Root.recovery` tests.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `openwhispr-mobile/modules/android-dictation/android/src/main/java/com/openwhispr/dictation/BubbleEventQueue.kt` | Create | Pure queue of bubble events waiting for JS (order, replace, drop, park) |
| `…/dictation/BubblePolicy.kt` | Modify | `PIPELINE_READY_TIMEOUT_MS`, `keepsPipelineAwake` |
| `…/dictation/HeadlessPipeline.kt` | Create | Starts ReactHost + headless task, finishes it, holds `ready` |
| `…/dictation/DictationService.kt` | Modify | Deliver through the queue, timeout, Retry of parked audio, lifecycle-driven `appVisible` |
| `…/dictation/AndroidDictationModule.kt` | Modify | `pipelineReady()` function; reset `ready` in `OnDestroy` |
| `openwhispr-mobile/modules/android-dictation/android/build.gradle` | Modify | `implementation 'com.facebook.react:react-android'` |
| `…/android/src/test/java/com/openwhispr/dictation/BubbleEventQueueTest.kt` | Create | Queue tests |
| `…/android/src/test/java/com/openwhispr/dictation/BubblePolicyTest.kt` | Modify | `keepsPipelineAwake` test |
| `openwhispr-mobile/modules/android-dictation/src/index.ts` | Modify | `pipelineReady(): Promise<void>` on `NativeDictation` |
| `openwhispr-mobile/src/android/appData.ts` | Create | `bootAppData`, `forgetAppData` |
| `openwhispr-mobile/src/android/bubblePipeline.ts` | Create (from `useBubblePipeline.ts`) | Singleton pipeline + headless task function |
| `openwhispr-mobile/src/android/useBubblePipeline.ts` | Delete | Replaced |
| `openwhispr-mobile/src/android/Root.tsx` | Modify | Use `bootAppData`, `startBubblePipeline`, own `onOpenResult` navigation |
| `openwhispr-mobile/src/android/__tests__/bubblePipeline.test.ts` | Create (git mv of `useBubblePipeline.test.ts`) | Pipeline tests |
| `openwhispr-mobile/src/android/__tests__/appData.test.ts` | Create | Boot tests |
| `openwhispr-mobile/src/android/__tests__/Root.recovery.test.tsx` | Modify | Mock path update |
| `openwhispr-mobile/index.android.ts` | Create | Android entry: expo-router + headless task |
| `openwhispr-mobile/package.json` | Modify (D1) | `"main": "./index"` |

---

### Task 0: Branch and device baseline (no code)

- [ ] **Step 1:** `git switch -c feat/android-headless-bubble` from `fix/android-bubble-restore`.
- [ ] **Step 2:** Build and install the current branch as a release APK (commands in Task 6, Step 3), bubble on, all permissions granted, signed in. `adb reboot`; after boot, do not open OpenWhispr; focus a text field in Chrome.
- [ ] **Step 3:** Record two facts in the PR notes: (a) is the bubble visible at all (expected: no, D5); (b) if visible, a tap gives "Open OpenWhispr before dictating." (`adb logcat | grep -i openwhispr`). If (a) is "visible", tell the user before Task 2 — D5's default change is then not the cause and needs rethinking.

### Task 1: Pure queue and policy (Kotlin)

**Files:** Create `BubbleEventQueue.kt`, `BubbleEventQueueTest.kt`; modify `BubblePolicy.kt`, `BubblePolicyTest.kt`.

**Interfaces — Produces:**
```kotlin
typealias BubbleEvent = Pair<String, Map<String, Any>>
data class Accepted(val emit: List<BubbleEvent>, val dropped: List<String>) // dropped = recording URIs to delete
class BubbleEventQueue {
  val holdsRecording: Boolean        // an "onRecording" is waiting
  val parked: Boolean
  fun accept(event: String, data: Map<String, Any>, ready: Boolean): Accepted
  fun ready(): List<BubbleEvent>     // drain on readiness; empty while parked
  fun park()                         // only meaningful while holdsRecording
  fun retryHeld(selection: String): Boolean // unpark, waiting "onStart" gets the new selection; false if nothing held
}
object BubblePolicy {
  const val PIPELINE_READY_TIMEOUT_MS = 20_000L
  fun keepsPipelineAwake(state: BubbleState, stopping: Boolean): Boolean // true for LISTENING, PROCESSING, or stopping
}
```
Rules for `accept`: `onCancel`/`onDismiss` → clear the queue, `dropped` = waiting recordings' `uri`, `emit` = `[event]` only if `ready`. `onStart`/`onRetry` → clear (dropping held recordings), then emit if `ready` else queue. Anything else → emit if `ready && !parked`, else queue.

- [ ] **Step 1: Write failing tests** in `BubbleEventQueueTest.kt`:
  - `events wait in order until ready` — accept onStart, onRecording(uri=a) with `ready=false` → `emit` empty; `ready()` returns `[onStart, onRecording]`; second `ready()` is empty.
  - `ready events pass straight through` — `accept("onStart", …, true).emit == listOf(onStart)`.
  - `a new start replaces whatever waited before it` — waiting onStart+onRecording(a); `accept("onStart", sel2, false).dropped == listOf("a")`; `ready()` == `[onStart(sel2)]`.
  - `cancel drops waiting events and returns the held recording` — same for `onCancel` and `onDismiss` with `ready=false` (emit empty) and `ready=true` (emit `[event]`); queue empty after.
  - `a parked queue releases nothing until Retry` — waiting onStart(old)+onRecording(a); `park()`; `ready()` empty; `accept("onError", …, true).emit` empty; `retryHeld("new")` true; `ready()` == `[onStart(selection="new"), onRecording(a)]`.
  - `retryHeld without a held recording` returns false.
  - In `BubblePolicyTest`: `keeps the pipeline awake only while a dictation is in flight` — LISTENING→true, PROCESSING→true, READY/RETRY/RECOVER with `stopping=false`→false, READY with `stopping=true`→true.
- [ ] **Step 2: Run, expect FAIL** (unresolved references). Command in Task 6, Step 2 with `--tests '*BubbleEventQueueTest*' --tests '*BubblePolicyTest*'`.
- [ ] **Step 3: Implement** the interfaces above. No Android imports in either file.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(android): add the bubble's pending-event queue`.

### Task 2: Native runtime start, delivery and visibility

**Files:** Create `HeadlessPipeline.kt`; modify `DictationService.kt`, `AndroidDictationModule.kt`, `modules/android-dictation/android/build.gradle`, `modules/android-dictation/src/index.ts`.

**Interfaces:**
- Consumes: Task 1 (`BubbleEventQueue`, `BubblePolicy.keepsPipelineAwake`, `PIPELINE_READY_TIMEOUT_MS`).
- Produces:
```kotlin
object HeadlessPipeline {
  const val TASK = "OpenWhisprBubblePipeline"
  @Volatile var ready: Boolean            // set by pipelineReady(), cleared on module OnDestroy
  fun start(context: Context)             // main thread; idempotent
  fun stop(context: Context)              // main thread; finishes the running task, cancels a pending start
}
// DictationService
fun pipelineReady()                       // main thread; drains the queue to emit
// JS (NativeDictation)
pipelineReady(): Promise<void>
```

- [ ] **Step 1: `build.gradle`** — add `implementation 'com.facebook.react:react-android'` (versionless, as the existing `androidTestImplementation` line).
- [ ] **Step 2: `HeadlessPipeline`** — `start`: set `wanted = true`; `val host = (context.applicationContext as? ReactApplication)?.reactHost ?: return` (log once with `Log.w("OpenWhisprBubble", …)`); if `host.currentReactContext?.hasActiveReactInstance() == true` start the task now, else add a one-shot `ReactInstanceEventListener` (removes itself, posts to the main looper, starts the task only if still `wanted`) and call `host.start()`. Starting the task: skip when `taskId` is running (`HeadlessJsTaskContext.getInstance(ctx).isTaskRunning(taskId)`), else `taskId = startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true))`; log `"pipeline task started"`. `stop`: `wanted = false`; `finishTask(taskId)` when running. Never add the listener twice.
- [ ] **Step 3: `DictationService`**
  - `companion`: `var appVisible = false` (D5).
  - `onCreate`: register an `Application.ActivityLifecycleCallbacks` whose `onActivityResumed` sets `appVisible = true` and `onActivityPaused` sets `false`, each followed by `updateVisibility()`; unregister in `onDestroy`.
  - Add `private val pending = BubbleEventQueue()` and `private fun deliver(event: String, data: Map<String, Any> = emptyMap())`: `pending.accept(event, data, HeadlessPipeline.ready && emit != null)`; emit each `emit` entry through `emit`; delete each `dropped` URI's file (`File(Uri.parse(uri).path!!).delete()`); when `event == "onRecording"` and it was queued, `postDelayed(pipelineTimeout, PIPELINE_READY_TIMEOUT_MS)`.
  - `fun pipelineReady()`: remove `pipelineTimeout`; emit `pending.ready()`.
  - `pipelineTimeout`: if `!HeadlessPipeline.ready && pending.holdsRecording` → `pending.park()`, `retryKept = true`, `setState(BubbleState.RETRY)`.
  - `begin()`: delete the `check(emit != null)` line; call `HeadlessPipeline.start(this)` before recording; route `onStart`/`onError` through `deliver`.
  - `finish()`, `updateVisibility()`, `leavePractice()`, `dismiss()`, `onDestroy()`: replace every `emit?.invoke("onCancel"|"onRecording"|"onError"|"onDismiss", …)` with `deliver(…)`. `onStatusChange` and `onOpenResult` keep calling `emit` directly (UI-only).
  - `retry()`: if `pending.parked` → `pending.retryHeld(captured selection)`, `setState(PROCESSING)`, `HeadlessPipeline.start(this)`, then emit `pending.ready()` when ready, else re-post `pipelineTimeout`. Otherwise keep today's branches with `retryKept` deciding, and send `onRetry` through `deliver`.
  - End of `updateVisibility()`: `if (!BubblePolicy.keepsPipelineAwake(state, stopping)) HeadlessPipeline.stop(this)`. `onDestroy` also calls `HeadlessPipeline.stop(this)`.
- [ ] **Step 4: `AndroidDictationModule`** — `AsyncFunction("pipelineReady") { HeadlessPipeline.ready = true; Log.i(…, "pipeline ready"); DictationService.instance?.pipelineReady() }.runOnQueue(Queues.MAIN)`; in `OnDestroy` set `HeadlessPipeline.ready = false` before `DictationService.emit = null`. Leave the `OnActivityEntersForeground/Background` hooks unchanged.
- [ ] **Step 5: `src/index.ts`** — add to `NativeDictation`: `/** The bubble pipeline is listening; native delivers events it held. */ pipelineReady(): Promise<void>;`
- [ ] **Step 6: Verify** Kotlin compiles and unit tests pass (Task 6, Step 2, all tests); `npx tsc --noEmit`.
- [ ] **Step 7: Commit** `feat(android): start the JS runtime from the bubble and hold events until it listens`.

### Task 3: Shared app-data boot (JS)

**Files:** Create `src/android/appData.ts`, `src/android/__tests__/appData.test.ts`; modify `src/android/Root.tsx`.

**Interfaces — Produces:**
```ts
/** Loads config, then auth, then transcripts, dictionary and snippets. Shared by every caller; a failure lets the next call run again. */
export function bootAppData(): Promise<void>;
/** Root's Retry: the next bootAppData() runs from scratch. */
export function forgetAppData(): void;
```

- [ ] **Step 1: Failing tests** (mock the five stores' `getState()` with `jest.fn` loaders):
  - `loads config before auth and auth before the data stores` (call-order assertions).
  - `boots once for concurrent callers` — two calls before resolution → each loader called once, same promise.
  - `a failed boot runs again on the next call` — auth rejects once → first call rejects, second call re-runs all steps.
  - `forgetAppData makes the next call boot again` — after a successful boot.
- [ ] **Step 2: Run** `npx jest --testPathIgnorePatterns /node_modules/ -- appData` → FAIL.
- [ ] **Step 3: Implement** with a module-level `let booting: Promise<void> | null`; clear it in a `.catch` that rethrows, and in `forgetAppData`.
- [ ] **Step 4: `Root.tsx`** — `initialize()` replaces its first three statements with `await bootAppData();` (the rest unchanged); the Retry button's `onPress` calls `forgetAppData()` before `setBootError('')`.
- [ ] **Step 5: Run** `-- appData Root.recovery` → PASS.
- [ ] **Step 6: Commit** `refactor(android): share the app-data boot between Root and the bubble`.

### Task 4: Pipeline singleton and headless task (JS)

**Files:** `git mv src/android/useBubblePipeline.ts src/android/bubblePipeline.ts` and `…/__tests__/useBubblePipeline.test.ts → …/__tests__/bubblePipeline.test.ts`; modify `Root.tsx`, `__tests__/Root.recovery.test.tsx`.

**Interfaces:**
- Consumes: `bootAppData` (Task 3); `AndroidDictation.pipelineReady` (Task 2); `useAccountData` (`./accountData`).
- Produces:
```ts
/** Wires the bubble's events once per JS runtime, then tells native it is listening. Safe to call again. */
export function startBubblePipeline(): void;
/** The headless task: runs the app's startup module, starts the pipeline, never settles (native finishes it). */
export function bubblePipelineTask(): Promise<void>;
```

- [ ] **Step 1: Convert the test file** — replace `renderHook(() => useBubblePipeline())` with, in `beforeEach`, `jest.resetModules()` then `require('../bubblePipeline').startBubblePipeline()` (fresh singleton per test; re-require the mocked modules after the reset). Remove the `expo-router` mock. Mock `../appData` (`bootAppData: jest.fn(async () => {})`) and `../accountData` (`useAccountData.getState` → `{ error: null, blocked: false }`); add `pipelineReady: jest.fn(async () => {})` to the `AndroidDictation` mock. Existing five tests must keep passing unchanged in their assertions (add one `await flush()` after `onStart` where the job is now created asynchronously).
- [ ] **Step 2: New failing tests:**
  - `starts once` — calling `startBubblePipeline()` again adds no listener (count `addListener` calls per event = 1) and `pipelineReady` was called once.
  - `waits for app data before creating the job` — `bootAppData` returns a deferred; `onStart` + `onRecording` → `createAndroidJob` not called; resolve → called with `('dictate', 'Spanish', '')` and `insert` follows.
  - `a blocked account keeps the recording for Retry` — `useAccountData.getState()` → `{ error: 'Local account data could not be loaded. Please retry.', blocked: true }` → `setStatus` last `'retry-kept'`, `useBubbleResult.getState().error` equals that message, `deleteAsync` not called.
  - `a failed boot keeps the recording for Retry` — `bootAppData` rejects `new Error('offline')` → `'retry-kept'`, error `'offline'`.
  - `the headless task starts the pipeline and does not settle` — mock `'../headlessStartup'`; `const settled = jest.fn(); bubblePipelineTask().then(settled)`; flush → `pipelineReady` called, `settled` not called.
  - `the pipeline no longer handles onOpenResult` — no `onOpenResult` listener registered.
- [ ] **Step 3: Run** `-- bubblePipeline` → FAIL.
- [ ] **Step 4: Implement `bubblePipeline.ts`** — move the hook body to module scope behind `let started = false`; drop `useEffect`, the returned cleanup and the `router`/`onOpenResult` listener. `prepare(selection)` stores `job: Promise<AndroidJob>` = `bootAppData().then(() => { const { error, blocked } = useAccountData.getState(); if (error || blocked) throw new Error(error ?? i18n.t('bootError')); return dictationJob(selection); })`, with a no-op `.catch` attached so an unused rejection is not reported; `run` does `const current = await job` inside its `try` (the existing catch turns failures into `'retry-kept'`, since a boot error is not silence). Call `void native.pipelineReady()` last in `startBubblePipeline`. `bubblePipelineTask`: `runHeadlessStartup()` (from `./headlessStartup`), `startBubblePipeline()`, `return new Promise<void>(() => undefined)`. Use the codebase's `require(...) as typeof import(...)` form where a value is read.
- [ ] **Step 5: `Root.tsx`** — replace `useBubblePipeline()` with `useEffect(() => startBubblePipeline(), []);` and add `useEffect(() => { const sub = dictationEvents?.addListener('onOpenResult', () => router.navigate('/(tabs)/(record)')); return () => sub?.remove(); }, []);` (import `router` from `expo-router`, `dictationEvents` from the module). A cold launch from `openResult` needs no listener: `app/index.android.tsx` already redirects to `/(tabs)/(record)`, where Home shows the kept result.
- [ ] **Step 6: `Root.recovery.test.tsx`** — mock `'@/android/bubblePipeline'` (`startBubblePipeline: () => {}`) instead of `useBubblePipeline`, and add `dictationEvents: null` to its module mock if it mocks the module.
- [ ] **Step 7: Run** `-- bubblePipeline appData Root.recovery` → PASS; `npx tsc --noEmit`.
- [ ] **Step 8: Commit** `feat(android): run the bubble pipeline as a once-only singleton`.

### Task 5: Android entry with the headless task (D1)

**Files:** Create `openwhispr-mobile/index.android.ts`; modify `openwhispr-mobile/package.json`.

- [ ] **Step 1: `index.android.ts`**
```ts
import 'expo-router/entry';
import { AppRegistry } from 'react-native';

// Registered at the top of the bundle: the floating bubble starts this without the app on screen.
AppRegistry.registerHeadlessTask('OpenWhisprBubblePipeline', () => () =>
  (require('./src/android/bubblePipeline') as typeof import('./src/android/bubblePipeline')).bubblePipelineTask(),
);
```
The `require` stays lazy so a normal launch evaluates modules in today's order.
- [ ] **Step 2: `package.json`** — `"main": "./index"`.
- [ ] **Step 3: Verify resolution**
  - `node node_modules/expo/scripts/resolveAppEntry.js . android relative` → `index.android.ts`
  - `node node_modules/expo/scripts/resolveAppEntry.js . ios relative` → `index.ts`
  - `git diff --quiet origin/feat/android-dictation-bubble -- index.ts` → exit 0.
- [ ] **Step 4: Commit** `feat(android): register the bubble pipeline as a headless task`.

### Task 6: Validation and device acceptance

- [ ] **Step 1: JS** (from `openwhispr-mobile`): `npx jest --testPathIgnorePatterns /node_modules/ -- src/android` → all pass; `npx tsc --noEmit` → no errors; `npx prettier --check index.android.ts package.json src/android modules/android-dictation/src` and `npx eslint index.android.ts src/android modules/android-dictation/src` → clean; `npm run test:android-ui-isolation` → pass.
- [ ] **Step 2: Kotlin unit tests:** `OPENWHISPR_APP_ENV=development npx expo prebuild --platform android --no-install` (once; `android/` is generated and ignored), then `cd android && JAVA_HOME=… ./gradlew :android-dictation:testDebugUnitTest` → BUILD SUCCESSFUL (`BubbleEventQueueTest`, `BubblePolicyTest` green). If the project path differs, read it from `./gradlew projects`.
- [ ] **Step 3: Release build:** `cd android && JAVA_HOME=… ./gradlew :app:assembleRelease` → APK at `app/build/outputs/apk/release/`.
- [ ] **Step 4: iOS isolation:** `npx expo export --platform ios --source-maps --output-dir "$TMPDIR/ow-ios-export"` then `node scripts/check-android-ui-isolation.mjs --base origin/feat/android-dictation-bubble --export-dir "$TMPDIR/ow-ios-export"` → "Android change touches no file the iOS app loads."
- [ ] **Step 5: Device acceptance** on the Galaxy A73 (`PKG` = the installed package from `adb shell pm list packages | grep -i openwhispr`; test in Chrome, not Samsung Notes; humans grant overlay/accessibility). Temporarily (never committed) add `setTimeout(() => console.log('[bubble] timer ok'), 1000)` at the start of `bubblePipelineTask` for step 4.
  1. Install the release APK, open the app once, turn the bubble on, grant overlay, microphone and accessibility, sign in. Force-stop: `adb shell am force-stop $PKG`.
  2. **Update:** `adb install -r <apk>`. Do not open OpenWhispr. `adb shell dumpsys activity services $PKG | grep DictationService` → running. Re-enable the bubble only if Android turned it off (memory: the bubble can be off after `install -r`; note it).
  3. In Chrome, focus a text field → bubble shows. Tap, speak a sentence, tap stop → text inserted. `adb shell dumpsys activity activities | grep -i "$PKG"` → no resumed OpenWhispr activity; nothing flashed on screen.
  4. `adb logcat -d | grep -E "OpenWhisprBubble|ReactNativeJS"` → "pipeline task started", "pipeline ready", "[bubble] timer ok"; record tap→ready time (input for D2).
  5. **Wake lock:** after the bubble settles, `adb shell dumpsys power | grep -i -E "$PKG|headless|ReactNative"` → no wake lock held by the app.
  6. **Reboot:** `adb reboot`, unlock, wait ~1 min, repeat 3–5.
  7. **App over headless runtime:** open OpenWhispr (same pid: `adb shell pidof $PKG` before/after), go to Home, background it, dictate once more in Chrome → exactly one insertion and one new history row; logcat shows one "pipeline ready" for the process.
  8. **Signed out:** sign out, reboot, dictate → bubble shows Retry (not stuck on "Writing"); open the app → Home shows the error.
  9. **Timeout:** with a debug build and Metro stopped (`npx expo run:android`, then stop Metro, reboot), dictate → Retry appears ≤20 s after stop; nothing is inserted later on its own; start Metro, tap Retry → inserted; repeat and tap Dismiss → the `dictation-*.wav` file is gone (`adb shell run-as $PKG ls cache`).
  10. **Offline:** airplane mode with a cloud route → Retry; network back, tap Retry → inserted.
  11. **No splash flash:** accessibility off, force-stop, launch the app → no bubble over the splash; background the app → bubble shows.
  12. **Analytics (D4):** during steps 3–6, `adb logcat -d | grep -i appsflyer` → nothing from the headless process (AppsFlyer is not set up headless).
- [ ] **Step 6:** Remove the temporary timer log; commit any fixes found; push and open a draft PR into `fix/android-bubble-restore` with the device results. The deep review runs afterwards in a new session.

---

## Self-check against the brief

- First tap after update/reboot inserts text with no app flash → Tasks 2, 4, 5; device 2–6.
- Headless task via `HeadlessJsTaskContext`, timeout 0, allowed in foreground, guarded by `isTaskRunning`, readiness via `hasActiveReactInstance`/`onReactContextInitialized` → Task 2 Step 2.
- Task registered at bundle top level; Android-only entry; shared-file decision explicit → Task 5, D1.
- Pipeline idempotent singleton; `pipelineReady` handshake; no double subscription when the app opens → Task 4 (`starts once`), device 7.
- `router` removed from the headless path; navigation kept for the UI → Task 4 Step 5.
- Shared once-only boot used by Root and headless; Root Retry preserved → Task 3.
- `OnDestroy` stopping the service: only on runtime invalidation (dev reload, host destroy), not on headless use; `ready` reset there → Task 2 Step 4.
- `appVisible` in a process with no activity → D5, Task 2 Step 3, Task 0, device 11.
- Recording starts at once; events queue; timeout falls back to Retry with audio kept → Tasks 1–2, D3, device 9.
- Warm-up timing justified → D2, measured in device 4.
- Signed-out / offline / permission states → Task 4 tests, device 8, 10; a revoked microphone or overlay keeps the bubble from being restored (`BubblePolicy.shouldRestore`, existing).
- Tests: JS singleton/boot/queue-facing behaviour (Tasks 3–4); Kotlin pure queue/policy (Task 1).
- Validation: jest, tsc, prettier, eslint, gradle unit tests, isolation check, release build (Task 6). Wake lock via `dumpsys power` (device 5).
