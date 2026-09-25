# iPad Hardware-Keyboard Dictation — Design

Date: 2026-09-25 · Branch: `feat/ipad-hardware-keyboard-dictation` (off `main`) · App: `openwhispr-mobile` (iOS)

## Goal

An iPad user with a hardware keyboard (the request came from an iPad Pro 11 + Magic Keyboard user) can dictate into any app without bringing up the on-screen keyboard: **press a key combo → speak → press again → ⌘V**.

Success: the flow works from any app with no on-screen keyboard, never takes focus from the user's text field, never needs a dialog dismissed, and says clearly what happened (listening, copied, failed).

## Constraints (verified)

- iPadOS hides third-party keyboards while a hardware keyboard is attached, and keyboard extensions receive no hardware key events. The OpenWhispr keyboard cannot be the entry point.
- Only a keyboard extension can insert text into another app. The transcript is delivered on the **clipboard**.
- The only system-wide key combo on iPadOS is Accessibility → Full Keyboard Access (FKA) → Commands → *Shortcuts*, which lists the user's library shortcuts. The combo fires once per press, so the feature is **tap-to-toggle only** (no push-to-talk).
- FKA lets a user record a combo while FKA itself is **off**; the combo then silently does nothing.
- Live Activities on iPad show only on the Lock Screen and in Notification Center (no Dynamic Island), so they are not a status surface while dictating.
- An intent's result dialog (Shortcuts card) needs a manual *Done*, and pressing the combo again re-runs the intent instead of dismissing it.

## Spike results (simulator, iPad Pro 11 M5, iOS 26.5)

- FKA ⌃⌥D → `Toggle OpenWhispr Dictation` ran with OpenWhispr in the background. Start took 102–107 ms via the dictation-mode warm mic; text reached the clipboard 1.8 s after stop; ⌘V pasted it into Reminders with the on-screen keyboard hidden.
- An App Intent launched the app process in the background and React Native booted (`AppDelegate` starts RN unconditionally; `useKeyboardHandoff` mounts at the root of `app/_layout.tsx`).
- Cold background mic start through an intent conforming to `AudioRecordingIntent` (iOS 18+) captured audio in the simulator. **Unconfirmed on a device.**
- **`AudioRecordingIntent` crashes the app** (found in simulator testing): App Intents calls `fatalError` when `perform()` returns with an active audio session and no Live Activity. A background launch can't start a Live Activity ("Target is not foreground"), and the dictation-mode warm mic keeps the session active. So the intent does **not** conform to it. Without it, a background cold start still recorded in the simulator; on a device it may be refused, which falls back to *Explain*.
- A start pressed while the previous stop was still transcribing wiped the pending-transcript keys (`requestStart` clears them).
- Simulator builds are ad-hoc signed, and `linkd` rejects intents from an app without a team ID. For simulator testing, re-sign the `.app` (appex first) with the team certificate.

## User experience

1. **Setup:** Preferences → Keyboard → *Hardware keyboard shortcut* opens a step-by-step guide (below). The first time a hardware keyboard is detected, a one-time card on the Record tab points to it.
2. **Use:** in any app, press the combo. A begin chime plays and recording starts. Speak. Press the combo again. An end chime plays; shortly after, a banner says **"Copied — press ⌘V to paste"**. Press ⌘V.
3. **Failures** are one banner each, never a dialog:

| Situation | Banner |
| --- | --- |
| Mic can't be started (cold start refused, or JS not ready in time) | "Open OpenWhispr to turn on dictation mode" |
| Pressed while the previous dictation is still transcribing | "Still transcribing…" |
| No speech detected | "No speech detected" |
| Transcription error, setup required, or no result after the delivery timeout | "Couldn't transcribe — open OpenWhispr" |

Banners never contain transcript text, since they can appear on the Lock Screen and persist in Notification Center. Tapping a banner opens OpenWhispr.

## Architecture

All native code lives in the **main app target**, so App Intents metadata is extracted and the intent runs in the app's process. It is added by the existing config plugin, renamed from the spike: `plugins/hardware-keyboard-intents/` → `plugins/hotkey-dictation/withHotkeyDictation.js`, which copies each Swift file from `plugins/hotkey-dictation/ios/` into `ios/OpenWhispr/` and adds it to the app target's Sources, stripping the xcode lib's `"undefined"` fields.

The recording path is **unchanged**: the hotkey drives the same App Group keys and Darwin start/stop notifications the keyboard extension uses (`KeyboardHandoffProvider.requestStart/requestStop`), which `AppGroupStorageModule` and `useKeyboardHandoff` already serve.

### Files

- **`HotkeyDictationIntent.swift`**
  - `ToggleHotkeyDictationIntent`: `openAppWhenRun = false`; deliberately does **not** conform to `AudioRecordingIntent` (see *Spike results*); returns `.result()` with **no dialog**.
  - `OpenWhisprAppShortcuts: AppShortcutsProvider`: auto-registers the action (phrase "Toggle \(.applicationName) dictation").
  - The spike's `ProbeBackgroundMicIntent` is deleted.
- **`HotkeyDictationSession.swift`**
  - A pure `decidePress(snapshot) -> PressAction` and a thin executor over App Group defaults and Darwin posts.
  - Holds the shared key and notification names used by the hotkey (one place in the app target).
- **`HotkeyDeliveryWatcher.swift`**
  - A process-lifetime singleton that watches a hotkey recording from its start until its transcript is copied and consumed, then posts the banner. Its `isWatching` state is what "delivery pending" means.
- **`HotkeyFeedback.swift`**
  - Chimes and banners.

### Press decision (`decidePress`)

Snapshot inputs: App Group defaults, `now`, and two **in-process** flags (the intent and the watcher share the app process, so no shared key can leave them stuck):

- `recording`: `keyboard_recording_active == "1"` and heartbeat age ≤ 5 s.
- `warm`: `background_session_ready == "1"` and heartbeat age ≤ 5 s.
- `startInProgress`: a hotkey start is in flight (cold JS wait, or waiting for the recording flag). Held by a `@MainActor` coordinator that decides a press and claims the start slot in one step, so two concurrent presses can never both start.
- `busy`: status ∈ {`transcribing`, `cleaning`, `agent_generating`} and status age ≤ 5 min, or the delivery watcher is still watching a hotkey recording (`deliveryPending`).
- `jsReady`: this process's pid-scoped JS-ready stamp is present. The shared `recording`/`warm`/`busy` flags are trusted only when it is, because a killed process leaves them (with a fresh heartbeat) for up to 5 s.
- `canColdStart`: always true (a cold start is attempted on every supported iOS version; a refusal falls back to *Explain*).

Checked in this order:

| Snapshot | Action |
| --- | --- |
| `startInProgress` | **Ignore**, silently (even if the recording flag is already up: a stop here would end the recording before the starting press sees it) |
| `jsReady` and `recording` | **Stop** |
| `deliveryPending`, or `jsReady` and a fresh busy status | **Ignore** + "Still transcribing…" |
| `jsReady` and `warm` | **Start (warm)** |
| `canColdStart` | **Start (cold)** |
| otherwise | **Explain** + "Open OpenWhispr to turn on dictation mode" |

### Execution

- **Start (warm):**
  1. Write the same keys `requestStart` writes.
  2. `synchronize()`, then post `.startRecording`.
  3. Poll ≤ 2 s for `recording`. Success: hand the job to `HotkeyDeliveryWatcher`, release the start slot, begin chime. Failure: release the start slot and show the *Explain* banner.
- **Start (cold):** the recording must not begin before JS is listening, the same guarantee the keyboard flow has (see *JS readiness* below). In order:
  1. Wait up to 8 s, polling every 100 ms, for `hotkey_js_ready_at_ms` to carry **this process's pid** (see *JS readiness*).
  2. Run *Start (warm)*'s steps, with a 2 s wait for `recording`.

  The begin chime plays only once recording has begun, so the user knows when to speak. Timeout at step 1 or 2: release the start slot, show the *Explain* banner.
- **Stop:** write the `requestStop` keys, post `.stopRecording`, play the end chime, and **return immediately**. No awaiting inside `perform`. A hotkey recording is already being watched; a keyboard dictation the press stops is left to the keyboard to deliver.
- **Delivery watcher:**
  - Watches a hotkey recording **from its start**, so it is delivered however the recording ends: a second press, an audio interruption, or a stop from the app.
  - Observes the `.transcriptReady` / `.keyboardStatusChanged` Darwin notifications and polls every 500 ms as a fallback.
  - Timeout: 5 minutes, counted from when the recording ends (the clock is paused while status is `recording`), covering long cloud transcriptions.
  - On `keyboard_pending_transcript` with `keyboard_pending_transcript_job_id == jobId`:
    1. Set `UIPasteboard.general.string`.
    2. Remove the pending keys and set status `idle`, so the keyboard never re-inserts it.
    3. Post `.keyboardStatusChanged`.
    4. Stop watching (frees the hotkey).
    5. Show the "Copied" banner.
  - Terminal statuses (`no_speech`, `error`, `setup_required`) or timeout: stop watching, then the matching banner.
- **Feedback:**
  - Chimes: `AudioServicesPlaySystemSound(1113)` (begin) and `(1114)` (end). If they are inaudible while the `playAndRecord` session is active, bundle two short generated tones (no third-party audio) and play them with `AVAudioPlayer` on the active session.
  - Banners: `UNUserNotificationCenter` local notifications with a fixed identifier (each replaces the previous), delivered immediately, removed from Notification Center after 4 s while the process is alive. Only the newest banner's timer may remove it (a generation counter), so an older banner's timer never clears the one that replaced it.
  - Without notification permission, banners are skipped and the chimes still play.
- **Logging:** `Logger(subsystem: bundleId, category: "HotkeyDictation")`. Decisions, latencies and character counts only; never transcript text.

### JS changes

- **JS readiness** (`src/hooks/useKeyboardHandoff.ts`): after its effect has subscribed `onBackgroundRecordingStarted` and `onRecordingStopped`, the hook calls `AppGroupStorage.markHotkeyJsReady()`, and the native module writes `hotkey_js_ready_at_ms = "<pid>:<ms>"`. Its cleanup removes the key.
  - The intent trusts only a stamp carrying its own `getpid()`. A crash skips the hook's cleanup, and on the next launch the intent can read the key before `OnCreate` runs; the pid check makes such a stamp ineffective. `AppGroupStorageModule` also clears the key in `initializeSharedState()` on every launch.
  - Only the cold path waits on this. A warm mic implies the app ran in the foreground with JS loaded, which is the keyboard's existing guarantee.
  - Why: on a cold background launch, native code could otherwise start and stop a recording before JS subscribes. The route snapshot would then be skipped (failing as `setup_required`), and a very short recording's audio would be dropped. Nothing recovers either today, since the orphan cleanup only covers raw transcripts.
- **Hardware keyboard detection:** add to `AppGroupStorageModule`:
  - `isHardwareKeyboardConnected(): boolean` via `GCKeyboard.coalesced != nil`.
  - An `onHardwareKeyboardChanged { connected }` event from `GCKeyboardDidConnect` / `GCKeyboardDidDisconnect`.
  - Exposed in `modules/app-group-storage/src/index.ts`.

### Setup guide

`src/screens/HardwareKeyboardShortcutScreen.tsx` at route `/(account)/hardware-keyboard` (re-export in `app/(account)/hardware-keyboard.tsx`, `Stack.Screen` title "Hardware Keyboard" in `app/(account)/_layout.tsx`). A `SettingsRow` "Hardware keyboard shortcut" in the Keyboard section of `src/screens/PreferencesScreen.tsx` (iOS only). Built from `SettingsScreen` / `SettingsSection` / `SettingsRow`. Steps:

1. **Dictation mode**: status plus a switch bound to `LiveActivity.setDictationMode`. Copy: keeping it on makes the shortcut start instantly.
2. **Add the shortcut**: "Open Shortcuts" (`Linking.openURL('shortcuts://create-shortcut')`). Text: add the *Toggle OpenWhispr Dictation* action and save.
3. **Turn on Full Keyboard Access**: written path (Settings → Accessibility → Keyboards & Typing → Full Keyboard Access). Apple doesn't allow deep links into Accessibility. The copy stresses that the switch must be **on**.
4. **Assign a key combo**: Full Keyboard Access → Commands → *Shortcuts* → *Toggle OpenWhispr Dictation*, then press the combo. Suggest ⌃⌥D.
5. **Allow notifications**, shown only when not granted: `requestNotifications()` from `src/lib/notifications.ts`, or `Linking.openSettings()` if denied. Explains that the "Copied" banner needs it.
6. **Try it**: a `TextInput`. When text appears after the user presses the combo, speaks, presses again and pastes, the step shows a check.

Copy is plain English, matching the rest of the mobile app (no i18n library in `openwhispr-mobile`).

### Nudge

- On the Record tab: a dismissible card, "Using a keyboard? Dictate into any app with a shortcut", which opens the guide.
- Shown once, when `isHardwareKeyboardConnected()` is true or `onHardwareKeyboardChanged` reports a connection.
- Dismissing it or opening the guide sets `hardwareKeyboardNudgeDismissedAt` (an ISO timestamp string) on `UserConfig` through `useConfigStore().updateConfig`. This follows the existing `parakeet…NudgeDismissedAt` one-time Home nudges.
- iOS only.

## Testing

- **Native unit tests**: `decidePress` covers every table row, heartbeat staleness at the 5 s edge, and the busy status-age edge. Plus the cold-start sequence (no start is posted before `hotkey_js_ready_at_ms` exists; the 8 s wait times out to *Explain*), and the delivery watcher's job-id matching and terminal-status mapping, with injected defaults and a fake clock. Run with a Python runner modelled on `modules/background-uploader/tests/run-provider-transport-tests.py`, added to the `native-transport` job in `.github/workflows/mobile-ci.yml`.
- **Jest**:
  - `useKeyboardHandoff` writes `hotkey_js_ready_at_ms` only after both recording listeners are subscribed, and removes it on unmount.
  - `HardwareKeyboardShortcutScreen` (dictation-mode switch, notification-permission branches, try-it check).
  - The nudge (shows once, hidden after dismiss, hidden without a keyboard).
  - The Preferences row (iOS only).
- **Simulator verification** (DeviceHub window, re-signed build, Reminders as the text field):
  - Warm start/stop → paste.
  - Cold start after the 10-minute idle timeout (record the press-to-chime latency).
  - A press while transcribing.
  - No speech.
  - Chimes audible, banners replace each other and clear.
  - The OpenWhispr keyboard doesn't re-insert a copied transcript.
  - Try-it step completes.
- **Device verification**: a TestFlight build to the requesting iPad user. Confirm that the cold start works on hardware, that chimes and banners are noticeable, and that FKA doesn't disrupt their typing. If the cold start is refused on a device, the *Explain* banner is the designed fallback and nothing else changes.

## Out of scope

Push-to-talk, typing into the other app directly, a Control Center control, in-app `UIKeyCommand`s, Android, and a hosted iCloud shortcut link.

## Risks

- **Cold start on devices** is proven only in the simulator. It has a fallback.
- **Cold-start latency** includes a JS boot, estimated at 1–2 s in release builds but not yet measured. Measure it in simulator and device verification. The begin chime marks the real start, so no speech is lost.
- **System sound IDs 1113/1114** may be muted during capture. The fallback is bundled tones.
- **FKA side effects** (focus rings, Tab navigation) may bother some users. The guide says what FKA does; users who dislike it can bind nothing and use Siri ("Toggle OpenWhispr dictation") instead.
