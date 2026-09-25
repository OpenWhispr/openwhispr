# Meeting Recording Live Activity (iOS) — Design

**Date:** 2026-09-25
**Status:** Approved design, awaiting spec review
**Area:** `openwhispr-mobile` (iOS only)

## Goal

While a meeting is recording, show an OpenWhispr Live Activity on the lock screen and in the
Dynamic Island: brand badge, status line, a self-counting timer, and an **End** button that stops
the recording without unlocking the phone. Parity with Granola's "Taking notes…" activity, in
OpenWhispr's existing Live Activity style.

### Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Which recordings | Meetings only (`MeetingRecordScreen`, local and cloud paths) |
| End button | Stops the mic immediately from the lock screen; processing finishes later |
| Coexistence with the dictation-mode activity | The meeting takes over the single activity, then hands it back |
| Architecture | Extend the existing `RecordingActivityAttributes` activity (not a second activity type) |
| Visual style | Same as the current activity: dark glass, blue-gradient `BrandBadge`, white text |

### Why one activity, not two

iOS allows `Activity.request` only while the app is in the foreground, but `activity.update` works
from the background. The lock-screen End tap runs in the background. With one activity, the
meeting takeover and the hand-back to the dictation card are both updates, so both work from the
lock screen. A separate meeting activity would need a new `request` to restore the dictation card,
and iOS would refuse it until the app next came to the foreground.

## Existing infrastructure

- `modules/live-activity`: Expo module. `LiveActivityController` owns the session activity for
  keyboard **dictation mode** (the warm-mic session, default ON), updated via Darwin notifications
  from the keyboard extension.
- `plugins/activity-extension`: widget extension target (deployment target 16.2) that renders
  `RecordingActivityAttributes`. It holds `BrandBadge`, `ElapsedText`, and `PowerButton`
  (`ToggleDictationModeIntent`, iOS 17+).
- `app.base.json` already sets `NSSupportsLiveActivities` and `UIBackgroundModes: ["audio"]`.
- `MeetingRecordScreen` phases: `prompt` → `recording` | `cloud-recording` → `processing` →
  `router.replace` to the note. Local stop runs `finish()` (`runMeetingPipeline`: on-device ASR +
  diarization, can take minutes); cloud stop runs `finishCloud()` (`finalizeCloudMeeting`, fast).
- The first-run "Allow Live Activities from OpenWhispr?" prompt is shown by iOS on the first
  activity. No work is needed for it.

## Visual design

Same style as the current dictation-mode activity: `activityBackgroundTint(Color.black.opacity(0.6))`,
`BrandBadge` (blue gradient rounded square with the white mark), white primary text, 60% white
secondary text. The red recording dot, the existing `Color(red: 1.0, green: 0.27, blue: 0.23)`,
is the only accent.

### Lock screen / banner

| Phase | Title | Subtitle | Trailing |
|---|---|---|---|
| Meeting recording | Calendar event title, else `Taking notes…` | red dot + `Recording · 12:08` (self-counting) | **End** pill |
| Meeting processing | `Processing notes…` | `Recorded 42:10` | none |

- **End pill:** `Color.white.opacity(0.16)` capsule with white semibold text, the same material as
  `PowerButton`. `Button(intent: EndMeetingIntent())` on iOS 17+. On iOS 16.2–16.x it is hidden.
- The timer uses `Text(timerInterval:countsDown: false)` from `startedAt`, like `ElapsedText`. No
  per-second updates.
- Processing shows static text only: indeterminate spinners do not animate reliably in Live
  Activities.
- Tapping the card opens the app with no `widgetURL`. The live `MeetingRecordScreen` is still on
  top, and after processing that screen navigates to the note itself.

### Dynamic Island

- **Compact leading:** `BrandBadge(size: 22)`. **Compact trailing:** red self-counting timer while
  recording; while processing, the SF Symbol `waveform` in 60% white.
- **Minimal:** `BrandBadge(size: 22)`.
- **Expanded:** leading badge + title + (red dot + timer | `Processing notes…`); trailing End pill
  while recording.
- `keylineTint` unchanged (brand blue).

Dictation-mode rendering (`mode == .dictation`) is unchanged.

## State model

### `RecordingActivityAttributes.ContentState`

The state moves to a top-level, Foundation-only type in its own file,
`RecordingActivityContentState.swift`. `RecordingActivityAttributes` keeps
`public typealias ContentState = RecordingActivityContentState`. The attributes file is wrapped in
`#if canImport(ActivityKit)`, which is false for a macOS `swiftc` build, so this move is what lets
the test executable compile and exercise the decoding.

```swift
public enum Mode: String, Codable, Hashable { case dictation, meeting }
public enum Phase: String, Codable, Hashable { case recording, idle, processing }

public struct ContentState: Codable, Hashable {
  public var mode: Mode             // decodeIfPresent → .dictation
  public var phase: Phase
  public var startedAt: Date
  public var title: String?         // meeting only; nil renders "Taking notes…"
  public var recordedSeconds: Int?  // meeting processing only
}
```

A custom `init(from:)` decodes `mode`, `title`, and `recordedSeconds` with `decodeIfPresent`, so an
activity that is running when an app update lands still decodes. `idle` is dictation-only;
`processing` is meeting-only.

### Arbitration: `LiveActivityResolver.swift` (pure, Foundation-only)

```
struct MeetingSnapshot { title: String?, startedAt: Date, phase: .recording | .processing, recordedSeconds: Int? }

resolve(meeting: MeetingSnapshot?, keyboardRecording: Bool, dictationMode: Bool) -> ContentState?
  meeting != nil     → .meeting state from the snapshot     (meeting always wins)
  keyboardRecording  → .dictation / .recording, startedAt = now
  dictationMode      → .dictation / .idle
  else               → nil  (end the activity)
```

The resolver imports only Foundation and returns `RecordingActivityContentState?` directly, so the
test executable compiles `RecordingActivityContentState.swift` + `LiveActivityResolver.swift` with
no ActivityKit dependency. `now` is injected (`resolve(..., now: Date)`) for deterministic tests.

### Ownership: `LiveActivityController`

`LiveActivityController` stays the only code that touches ActivityKit. It holds `meeting:
MeetingSnapshot?` in memory (main queue). Every trigger calls `resolve(...)` and then a single
**apply** step:

- `nil` → end all activities (`dismissalPolicy: .immediate`).
- An activity exists → `update` it.
- No activity and the app is foreground → `request` (guarded by `areActivitiesEnabled`).

Triggers routed through resolve + apply:
- `startMeeting`, `setMeetingProcessing`, `endMeeting` (from JS)
- keyboard status Darwin notification (replaces the direct `updateOnMain` logic)
- dictation-mode Darwin notification (replaces the direct start/end in
  `handleDictationModeChanged`)
- `UIApplication.didBecomeActiveNotification` (existing cold-handoff safety net)
- `startSession` / `endSession` (existing JS API, kept for `useKeyboardHandoff`)

Routing everything through `resolve` fixes a latent bug: today, turning dictation mode off ends the
activity outright, and every keyboard status change overwrites its state. Either would destroy the
meeting card mid-meeting.

**Stale date.** Dictation states keep `staleDate = now + 1h`. Meeting states use `startedAt + 8h`:
ActivityKit ends every activity at 8 hours, and without push updates the stale date cannot be
extended later. Meetings over 8 hours lose the card; recording is unaffected.

### JS surface: `modules/live-activity/src/index.ts`

```ts
startMeeting(input: { title: string | null; startedAt: number /* epoch ms */ }): void
setMeetingProcessing(input: { recordedSeconds: number }): void
endMeeting(): void
addEndMeetingListener(listener: () => void): { remove(): void }
```

All are no-ops (listener: an inert subscription) when `Platform.OS !== 'ios'`.

### `useMeetingLiveActivity` (new hook, `src/hooks/useMeetingLiveActivity.ts`)

Input: `{ phase, title, startedAt, recordedSeconds, onEndRequested }`.

- Phase enters `recording` / `cloud-recording` → `startMeeting`.
- Phase enters `processing` → `setMeetingProcessing`.
- Phase returns to `prompt` or another non-meeting phase, or the screen unmounts →
  `endMeeting`.
- Subscribes with `addEndMeetingListener`, calls `onEndRequested` only while phase is `recording`
  or `cloud-recording`. This makes a lock-screen End and an in-app Stop mutually exclusive.

`MeetingRecordScreen` wires `onEndRequested` to `finish` (local) or `finishCloud` (cloud). It
records `startedAt` for the cloud path as well; today only the local path sets
`recordingStartedAtRef`. The title is `selectedMeetingContext?.title ?? null`.

## End button flow

1. `EndMeetingIntent: LiveActivityIntent` (iOS 17+) runs in the **app process**; background audio
   keeps it alive during recording. `perform()` only posts the Darwin notification
   `<bundleId>.endMeetingRequested`, the same pattern as `ToggleDictationModeIntent`, so the file
   compiles into both the app and widget targets without app-only symbols.
2. `LiveActivityController` observes the notification:
   - If `meeting == nil` (orphan card, e.g. iOS relaunched the app in the background) →
     resolve + apply, which clears the card. Done.
   - Otherwise it sets the meeting phase to `processing`, with
     `recordedSeconds = now - startedAt`, and applies it, so feedback is instant before JS reacts.
     It then starts `UIApplication.beginBackgroundTask` (about 30 s once the mic stops and
     background audio no longer holds the app) and emits `onEndMeetingRequested` to JS.
3. The JS listener calls `finish()` / `finishCloud()`, the same code as the in-app Stop button.
4. The background task ends on `endMeeting()` or in its expiration handler.

**Expected outcomes:**
- **Cloud meetings** normally finish within the background window.
- **Local meetings** usually will not. iOS suspends the app (frozen, nothing lost), the pipeline
  promise resumes when the user reopens the app, and the card shows `Processing notes…` until then.

## Recovery

### Orphaned activities

In `LiveActivityModule` `OnCreate`, before JS can call `startMeeting`, any existing activity with
`mode == .meeting` is orphaned: the process that owned it died. The controller runs resolve +
apply with `meeting == nil`, which returns the card to dictation idle or ends it.

### Orphaned meeting notes: `src/lib/meetingRecovery.ts`

Today, a note whose process dies mid-pipeline stays `transcribing` / `diarizing` forever, and Retry
(`NoteEditorScreen`) only appears for `failed`. A one-time sweep runs from `useAppInit` after the
database is ready and before any meeting can start. In a fresh process no pipeline is running, so
every non-terminal meeting note is orphaned:

**Each orphan is marked `failed` before its own resume**, via `transitionStatus` (the status machine allows
`recording|transcribing|diarizing → failed`). This is required, not just defensive:
`processMeeting` starts with `advance('transcribing')` from the note's real status, and
`transcribing → transcribing` is illegal, so a resume must start from `failed`. Orphans are
handled one at a time (fail, then resume), not in two passes: failing every orphan up front would
show Retry on notes still queued for an automatic resume, and a manual Retry could then race the
sweep into two pipelines on one note. A queued orphan therefore keeps its mid-pipeline status until
the sweep reaches it. Resumes wait until the app is foreground-active (a background launch, such
as a finished background upload or a Live Activity button, must not spend the one-shot resume
where iOS will suspend it), and notes created during the current JS runtime are never orphans.

| Note state (after marking `failed`) | Action |
|---|---|
| Was `transcribing` / `diarizing`, `sourceFile` is a managed meeting WAV (`isManagedMeetingAudioUri`), no resume marker | Set marker `meetingResumeAttempted:<noteId>` in `localStorage` (the `expo-sqlite/localStorage/install` polyfill the app already uses), `await retryMeetingTranscription(noteId)`, then clear the marker; errors go to Sentry |
| Same, marker already set | No resume; clear the marker. Guards against a crash loop if the pipeline itself kills the app, e.g. running out of memory. Retry stays available in the note |
| Was `recording` | No resume. A cloud session's utterances lived in memory; a local temp recording may be incomplete |
| No qualifying `sourceFile` | No resume |

Deleted notes are skipped (`notesRepository.getAllNotes()` excludes them). The note list is read
once, before any resume. Resumes run one at a time, not in parallel, to bound memory. A failing
resume is reported and the sweep moves on to the next note.

## Files

| File | Change |
|---|---|
| `modules/live-activity/ios/RecordingActivityContentState.swift` | **New.** Foundation-only state: `Mode`, `Phase` (+ `processing`), `title`, `recordedSeconds`, backward-compatible decoding |
| `modules/live-activity/ios/RecordingActivityAttributes.swift` | `typealias ContentState = RecordingActivityContentState` |
| `modules/live-activity/ios/LiveActivityResolver.swift` | **New.** Pure arbitration |
| `modules/live-activity/ios/LiveActivityController.swift` | Meeting snapshot, resolve + apply for all triggers, end-request handling, background task, orphan sweep |
| `modules/live-activity/ios/EndMeetingIntent.swift` | **New.** `LiveActivityIntent` posting `endMeetingRequested` |
| `modules/live-activity/ios/LiveActivityModule.swift` | `startMeeting`, `setMeetingProcessing`, `endMeeting`, `Events("onEndMeetingRequested")`, orphan sweep in `OnCreate` |
| `modules/live-activity/src/index.ts` | Typed wrappers + `addEndMeetingListener` |
| `plugins/activity-extension/ios/OpenWhisprActivity.swift` | Meeting lock-screen + Dynamic Island views, `EndButton` |
| `plugins/activity-extension/withActivityExtension.js` | Add `RecordingActivityContentState.swift` and `EndMeetingIntent.swift` to the widget source lists (the widget does not need the resolver) |
| `src/hooks/useMeetingLiveActivity.ts` | **New.** Phase → activity calls, End forwarding |
| `src/screens/MeetingRecordScreen.tsx` | Use the hook; track cloud `startedAt` |
| `src/lib/meetingRecovery.ts` | **New.** Cold-launch sweep |
| `src/hooks/useAppInit.ts` | Invoke the sweep once |

## Testing

**Swift:** standalone executable in `modules/live-activity/tests/` (pattern:
`modules/background-uploader/tests/`, `swiftc` + runner script), compiling
`RecordingActivityContentState.swift` + `LiveActivityResolver.swift`:
- the resolve priority table, all 8 combinations of `(meeting?, keyboardRecording, dictationMode)`,
  both meeting phases
- dictation mode off mid-meeting → still the meeting state
- keyboard recording mid-meeting → still the meeting state
- `ContentState` decodes a legacy payload (`{phase, startedAt}` only) as `.dictation`

**Jest:**
- `useMeetingLiveActivity.test.ts`, with the `LiveActivity` module mocked:
  - each phase transition makes the right call
  - unmount calls `endMeeting`
  - End while `processing` is ignored
  - End while recording calls `onEndRequested` once
  - off-iOS no-ops
- `meetingRecovery.test.ts`:
  - `failed` then resume once behind a marker
  - no second resume on the next launch
  - `recording` becomes `failed`
  - notes without a managed WAV become `failed` without a resume
  - `done`, `failed`, `idle`, and non-meeting notes are untouched
  - a failing resume is reported and the sweep continues
  - resumes run one at a time

**On-device checklist** (ActivityKit is not unit-testable):
- [ ] First meeting shows the iOS "Allow Live Activities" prompt; allowing shows the card
- [ ] Lock screen: title / `Taking notes…`, the timer counts, End visible (iOS 17+)
- [ ] End from the lock screen, cloud: mic stops, `Processing notes…`, card clears, note is done on open
- [ ] End from the lock screen, local: mic stops, card stays `Processing notes…`; opening the app completes the pipeline
- [ ] With dictation mode ON: the dictation card becomes the meeting card and returns to `Dictation mode is active` after
- [ ] With dictation mode OFF: the card ends after the meeting
- [ ] Turning dictation mode off mid-meeting leaves the meeting card
- [ ] A keyboard dictation mid-meeting leaves the meeting card
- [ ] Force-quit mid-recording → relaunch: the card clears; the note is `failed` with Retry
- [ ] Force-quit mid-local-processing → relaunch: the pipeline resumes once
- [ ] Dynamic Island compact / minimal / expanded; End works from expanded
- [ ] iOS 16.x: the card shows, no End button
- [ ] Live Activities disabled in Settings: the meeting records normally, no errors

## Out of scope

- Android (no Live Activity equivalent; a foreground-service notification is a separate project)
- Voice notes (`NoteEditorScreen`) and Home dictation
- Server push-token updates
- Pause / resume (the recorder does not support it)
- Localized widget strings (the widget is English-only today)
- Meetings over 8 hours keeping the card (ActivityKit cap)
