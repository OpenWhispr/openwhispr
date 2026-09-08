# Meeting Detection Playback Regression Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementation was approved September 8, 2026; the amendment below supersedes the original fallback-preservation scope.

**Goal:** Prevent ordinary macOS playback from producing meeting notifications through the background CoreSpeech service, while preserving real meeting detection.

**Architecture:** Filter the confirmed background service in the native microphone listener before it emits PID transitions. Require a live PID-capable listener for macOS audio prompts while preserving calendar reminders, own-process exclusions, and the auto-end silence fallback.

**Tech Stack:** Swift, CoreAudio, Electron, CommonJS, Node's built-in test runner.

**Spec:** The user's request to investigate the recent playback-triggered meeting notification regression and plan a fix; the verified findings below define this fix's scope.

## Verified root cause

The regression was introduced by `bc306d27d40e2b12d036846f33bb758eaf987b56`, **August 18, 2026**, `feat(meetings): Auto-end forgotten meeting recordings (#1494)`.

That change added PID-scoped CoreAudio monitoring. In `resources/macos-mic-listener.swift`, `prepareProcessSnapshot()` currently adds every readable process with `kAudioProcessPropertyIsRunningInput > 0` to `activeInputPids`. It does not distinguish a meeting participant's microphone capture from a background system service's input activity.

On the affected Mac, playback activates **`corespeechd`**, whose CoreAudio bundle identity is **`com.apple.CoreSpeech`**. The helper emits `MIC_START` for that service. `src/helpers/audioActivityDetector.js` excludes OpenWhispr's processes, but this is an external OS process, so it arms the existing two-second sustained timer. `src/helpers/meetingDetectionEngine.js` then displays the notification; a running meeting app is not required.

### Reproduction evidence

The running development app uses the helper at `resources/bin/macos-mic-listener` in its development checkout. Its Swift source SHA-256 matched this investigation's source: `df766d662d1f9d28484fdb92c45e898d5cbcb1db5c44633988ce87faaa4e6255`.

The diagnostic played a generated silent WAV through `/usr/bin/afplay`; it did not open or record a microphone. Two helpers ran alongside one another: the current helper and a temporary build of `bc306d27^:resources/macos-mic-listener.swift`.

| Observation     | Before August 18  | Current helper   |
| --------------- | ----------------- | ---------------- |
| Initial state   | `MIC_INACTIVE`    | `CAPABILITY PID` |
| Silent playback | Remained inactive | `MIC_START 1211` |
| Playback ends   | Remained inactive | `MIC_STOP 1211`  |

`ps` identified PID 1211 as `/System/Library/PrivateFrameworks/CoreSpeech.framework/corespeechd`. A CoreAudio metadata probe independently read its bundle as `com.apple.CoreSpeech`; the device-level probe reported no running input devices during playback. PID 1211 is an observation, never a value to hardcode.

The running app's development log, `debug-2026-09-08T04-54-19-609Z.log`, corroborated the first controlled reproduction:

```text
05:34:51.502Z  Mic state changed: active=true, hasPrompted=false
05:34:53.503Z  Sustained audio activity detected: durationMs=2001
05:34:53.504Z  Meeting detection triggered: audio:sustained-audio
05:34:53.504Z  Showing notification: source=audio, variant=detected
05:34:56.501Z  Mic state changed: active=false
```

A second comparison tested the proposed exclusion in a temporary copy of the current Swift source. Both helpers announced `CAPABILITY PID`. During the same eight-second silent playback, the unchanged helper emitted `MIC_START 1211` and later `MIC_STOP 1211`; the filtered prototype emitted neither. This validates the targeted classification change for the reproduced playback case. It does not replace live-call and auto-end acceptance testing.

CoreAudio's input-running flag describes active input streams, not whether a process is in a meeting. Apple also documents that system-audio taps can be used as aggregate-device inputs: [Core Audio taps](https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps). The local SDK header `CoreAudio.framework/Headers/AudioHardware.h` documents the PID, bundle identity, and input-running properties used here.

### Existing coverage and limits

This command passed **91/91** tests before any source changes:

```sh
node --test test/helpers/audioActivityDetector.test.js test/helpers/meetingDetectionEngine.test.js test/helpers/meetingDetectionEngineAutoEnd.test.js
```

The macOS tests feed synthetic `MIC_START` and `MIC_ACTIVE` events to JavaScript; they do not test which native processes should produce those events. The existing Windows native-state test in `test/helpers/audioActivityDetector.test.js` provides a pattern for adding native coverage.

The aggregate-device fallback and the `ioreg` polling fallback also contain broad audio-activity heuristics. They were not active in the local reproduction. Issue #2067, supplied by the user during implementation, brought these unsafe paths into scope; see the amendment below.

## Global constraints

- Modify the native classification, macOS audio-attribution gates, their tests, and the relevant detection documentation.
- Match exactly `com.apple.CoreSpeech`; do not exclude every Apple process, require a meeting-app allowlist, or hardcode PIDs.
- Preserve unknown/unreadable bundle identities as eligible, so metadata lookup failure does not silently disable real calls.
- Keep CoreSpeech's readable process object in the snapshot's `pids` map. Exclude it only from the active set; otherwise a CoreSpeech-only snapshot could incorrectly trigger aggregate fallback.
- Preserve `CAPABILITY PID`, `MIC_START <pid>`, and `MIC_STOP <pid>` protocol spelling and existing consumers.
- Preserve attributed browser meetings, virtual microphones, process churn, own-process exclusions, and Windows/Linux fallback behavior. Unattributed macOS device activity must not prompt.
- Check auto-end with the filtered external-mic state, because it shares these PID events with notification detection.
- No new packages, `.env` edits, commits, or pushes. Reuse installed dependencies and build/test within this worktree.
- Implementation must use a `fix/` branch if a branch is created; follow the user's worktree terminal instructions if creating a worktree.

## Task 1: Add native coverage and filter CoreSpeech activity

**Files:**

- Modify: `resources/macos-mic-listener.swift` — `prepareProcessSnapshot()` and a compile-time native test entry point.
- Modify: `test/helpers/audioActivityDetector.test.js` — a macOS-only native compilation/execution test beside the Windows native-state test.

**Interfaces:**

- Preserve the result `(pids: [AudioObjectID: pid_t], active: Set<pid_t>)?` from `prepareProcessSnapshot()`.
- Add defaulted readers to this existing function for deterministic tests; existing callers continue passing only the process-object array.
- Compile native test mode with `-D MIC_LISTENER_STATE_TEST`. That branch executes fixtures and exits before signal setup or `CFRunLoopRun()`; normal builds retain the existing entry point.

- [x] **Add a behavior-preserving test seam.** Use these defaulted readers; initially retain the current `if isRunningInput` classification so the regression test can fail on behavior.

```swift
func prepareProcessSnapshot(
    _ processObjects: [AudioObjectID],
    readPid: (AudioObjectID) -> pid_t? = getProcessPid,
    readInputRunning: (AudioObjectID) -> Bool? = isProcessRunningInput,
    readBundleID: (AudioObjectID) -> String? = {
        stringProperty($0, selector: kAudioProcessPropertyBundleID)
    }
) -> (pids: [AudioObjectID: pid_t], active: Set<pid_t>)?
```

- [x] **Add native snapshot regression fixtures.** At minimum, use this mixed snapshot. The expected active set excludes the background service while retaining both the browser and the process with unavailable bundle metadata.

```swift
let snapshot = prepareProcessSnapshot(
    [1, 2, 3],
    readPid: { pid_t($0 + 100) },
    readInputRunning: { _ in true },
    readBundleID: { object in
        switch object {
        case 1: return "com.apple.CoreSpeech"
        case 2: return "com.google.Chrome"
        default: return nil
        }
    }
)
precondition(snapshot != nil)
precondition(snapshot!.pids.count == 3)
precondition(snapshot!.active == Set<pid_t>([102, 103]))
```

Also assert these independent cases in the same test executable:

| Fixture                                         | Expected result                                      |
| ----------------------------------------------- | ---------------------------------------------------- |
| Only CoreSpeech, input active                   | Non-nil snapshot, one readable PID, empty active set |
| CoreSpeech plus active Zoom                     | Only Zoom active                                     |
| Active Safari                                   | Safari remains active; no blanket Apple exclusion    |
| Browser input inactive                          | Empty active set                                     |
| Active process with nil bundle identity         | Process remains active                               |
| One vanished object plus an active browser      | Browser remains active, vanished object skipped      |
| Empty process list                              | Non-nil empty snapshot                               |
| Non-empty list with no readable PID/input state | Nil, preserving existing systemic-failure behavior   |

- [x] **Wire the Node native test.** Guard by `process.platform === "darwin"`. Create a temporary executable and module-cache directory. Invoke `swiftc` on `resources/macos-mic-listener.swift` with `-D MIC_LISTENER_STATE_TEST`, `-framework CoreAudio`, and `-framework Foundation`; assert compilation and execution succeed. Report an explicit skip when Swift is unavailable, and ensure the native test runs on a macOS validation machine before accepting the fix.

- [x] **Run the focused tests and observe the behavioral failure.**

```sh
node --test test/helpers/audioActivityDetector.test.js
```

Expected failure: the mixed snapshot still includes the CoreSpeech PID, so its active-set assertion fails. Compilation failures are not evidence that the regression was reproduced.

- [x] **Apply the minimal classification change.** Reuse `stringProperty` through the default bundle reader. Retain the readable PID before filtering.

```swift
pids[processObject] = processId
if isRunningInput && readBundleID(processObject) != "com.apple.CoreSpeech" {
    active.insert(processId)
}
```

Add one concise comment explaining that CoreSpeech activates input processing during ordinary playback and must not be treated as a meeting participant. Do not alter notification timers or require meeting-app presence.

- [x] **Run the focused tests again.** The new native cases and existing detector cases must pass.

## Task 2: Validate the user-visible behavior and shared auto-end path

**Files:** No additional production files are expected. Rebuild the helper through the existing build script.

- [x] **Build the native helper and run existing affected suites.**

```sh
node scripts/build-macos-mic-listener.js
node --test test/helpers/audioActivityDetector.test.js test/helpers/electronProcessIds.test.js test/helpers/meetingDetectionEngine.test.js test/helpers/meetingDetectionEngineAutoEnd.test.js test/helpers/meetingAutoEndController.test.js
```

- [x] **Repeat the controlled playback comparison.** The rebuilt helper and real detector emitted zero events during eight seconds of silent `afplay` output, while the unchanged helper emitted CoreSpeech transitions. A fresh detector avoided cooldown and `hasPrompted` masking. The installed application was not replaced for a visual notification test.

- [x] **Verify real microphone capture.** An actual Chromium/Electron microphone stream produced one detection after the sustained threshold and released ownership when closed. Native fixtures preserve Zoom/Safari/Chrome and unknown identities; existing tests cover own-PID and capture-helper exclusion. Full live calls and USB/virtual microphone hardware remain manual follow-up checks.

- [x] **Verify auto-end.** Existing engine/controller tests pass for ownership, remote speech, silence fallback, recording gates, and restart recovery. Native fixtures and actual microphone closure verify the input ownership signal. A full live meeting auto-end was not exercised.

- [x] **Run the repository checks after implementation.** The worktree reuses the existing dependency environment through an ignored `node_modules` symlink. Tests ran under Node 24 with localhost networking enabled for their temporary servers.

```sh
npm test
npm run lint
npm run typecheck
git diff --check
```

- [x] **Review the final diff with code-quality and verification-before-completion.** The reviewed diff contains the Swift filter/test seam, macOS attribution guards, regression tests, and detection documentation. Live-call limits are reported separately. Nothing was committed or pushed.

## Implementation amendment — September 8, 2026

The user supplied [issue #2067](https://github.com/OpenWhispr/openwhispr/issues/2067) during implementation. The report describes charger chimes and autoplay video producing prompts on macOS 27 Beta. The reporter explicitly infers aggregate mode; its logs do not establish the capability. This does not invalidate the separately reproduced CoreSpeech/PID regression.

Code inspection and new failing tests confirmed a second unsafe path: aggregate `MIC_ACTIVE` signals and the `ioreg` fallback can treat output activity as microphone capture. The implementation adds these changes to the approved native fix:

- macOS accepts microphone PID transitions only after `CAPABILITY PID` from its live listener. Aggregate and legacy unattributed events cannot arm or preserve a prompt.
- Capability downgrade clears old PID ownership and cancels pending detection. A later PID-capable listener can detect real capture again.
- Missing or crashed macOS helpers pause automatic audio prompts instead of polling device-wide IO. Calendar reminders remain available; auto-end retains its existing audio-silence fallback.
- Capability announcements and unavailable-listener state are logged at info level. The microphone-detection documentation in `CLAUDE.md` now describes the actual modes and own-PID filtering.
- Independent review reproduced a related stale-output race. Line handling now checks both child identity and generation so trailing stdout after exit or replacement cannot revive obsolete microphone state. Regression tests failed before this guard and passed afterward.

The native fixture executable reads JSON scenarios from the Node test and emits the production snapshot result. Its fixture parser is compiled only with `MIC_LISTENER_STATE_TEST`. This keeps assertions and scenario data in the existing JavaScript test suite, rather than embedding them in release code.

## Implementation verification

- Baseline: 91 existing tests passed before edits.
- Red: three native CoreSpeech scenarios failed on the original classification. The added macOS attribution/fallback tests also failed before their corresponding changes.
- Red: trailing stdout after exit and aggregate output from an old listener after restart each reproduced a stale-state failure before the child/generation guard.
- Green: all 131 focused native, detector, engine, exclusion, and auto-end tests pass, with no skips.
- Native build: the normal arm64 helper compiled successfully through the repository build script.
- Real playback: the rebuilt helper plus real `AudioActivityDetector` produced zero detections during eight seconds of silent playback. The unchanged development helper running alongside it emitted `MIC_START 1211` and `MIC_STOP 1211`. Ownership remained reliable and inactive afterward.
- Real microphone: a temporary Chromium/Electron window opened an eight-second microphone stream using already-granted permission. The real detector emitted exactly one sustained event; ownership became inactive after the stream closed. No audio was saved or transmitted.
- Native fixtures cover Chrome, Zoom, Safari, unavailable bundle metadata, inactivity, CoreSpeech-only snapshots, and disappearing process objects. Full live Zoom/Google Meet sessions and USB/virtual microphone hardware were not exercised.
- Independent review found no remaining issues after the stale-output fix.
- Final full suite: 3,571 tests total, 3,374 passed, zero failures, 196 skipped, one todo. The first sandboxed run could not bind localhost test servers; the final run passed with local networking enabled.
- Lint, typecheck, changed-file Prettier checks, and `git diff --check` passed. Lint prints the existing module-type configuration warning; no lint errors.

Temporary diagnostic programs and WAV fixtures remain under `/tmp`. The rebuilt helper is an ignored build artifact in this worktree. The installed/running development app was not replaced, and no changes were committed or pushed.
