# Meeting Recording Live Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a meeting records in the iOS app, show an OpenWhispr Live Activity on the lock screen and in the Dynamic Island with a live timer and an End button that stops the recording without unlocking.

**Architecture:** Extend the existing single `RecordingActivityAttributes` Live Activity (today it serves keyboard dictation mode only). A new pure Swift resolver decides what the one activity shows (a meeting beats a keyboard recording, which beats dictation idle), and `LiveActivityController` routes every trigger through it. An `EndMeetingIntent` (a `LiveActivityIntent`) posts a Darwin notification; the controller flips the card to "Processing…", holds a background task, and emits a JS event that `MeetingRecordScreen` answers with its existing `finish()` / `finishCloud()`. A cold-launch sweep recovers meeting notes orphaned mid-pipeline.

**Tech Stack:** Swift (ActivityKit, WidgetKit, AppIntents), Expo Modules API (SDK 55), React Native 0.8x + React 19, Zustand, Jest (`jest-expo`), `@testing-library/react-native`.

**Spec:** `docs/superpowers/specs/2026-09-25-meeting-live-activity-design.md`

## Global Constraints

- iOS only. Every JS entry point is a no-op when `Platform.OS !== 'ios'`.
- Widget extension deployment target stays `16.2`. The End button needs iOS 17 (`Button(intent:)`); on 16.2–16.x it is omitted.
- Visual style is the existing one: `activityBackgroundTint(Color.black.opacity(0.6))`, `BrandBadge`, white text, 60% white secondary text; the only accent is the red dot `Color(red: 1.0, green: 0.27, blue: 0.23)`.
- Copy (English, verbatim): `Taking notes…` (no calendar title), `Recording · ` + timer, `Processing notes…`, `Recorded <m:ss | h:mm:ss>`, `End`.
- Staleness: dictation states `now + 1h`; meeting states `startedAt + 8h`.
- Meetings only (`MeetingRecordScreen`). Voice notes and Home dictation do not start the meeting card.
- Node 24 (`nvm use 24`). All paths below are relative to `openwhispr-mobile/` unless they start with `docs/`.
- Run single Jest files with `npx jest --testPathPattern '<pattern>'`, never positional paths (they break inside `.claude/worktrees`).
- Commit only when the user has authorized commits for this execution; otherwise stage nothing and leave the changes in the working tree. Commit messages use conventional commits with the `(mobile)` scope.

## Review Focus

1. **Double stop.** An in-app Stop tap and a lock-screen End tap land close together, or iOS delivers the End event twice before React re-renders. `finish()` must run exactly once. → Task 4 test "End fired twice while recording calls onEndRequested once".
2. **Recording dies on an error path.** `useAudioRecording`'s `onError` or a failed `startCloudMeeting` sends the screen back to `prompt` mid-recording. The card must end, not stay "Recording" forever. → Task 4 test "recording → idle ends the meeting".
3. **Blank calendar titles.** A calendar event titled `"   "` must render `Taking notes…`, not an empty line. → Task 2 test "normalizes a blank title to null".
4. **Recovery resume fails or hangs.** `retryMeetingTranscription` rejects for one orphaned note. The sweep must report the error, clear that note's marker, and still recover the other notes. → Task 6 test "a failing resume is reported and the sweep continues".
5. **JS reload or background relaunch while a meeting card is up.** The native singleton must not keep a stale meeting after the JS runtime restarts. → Task 2 `resetForNewJSRuntime()` plus the Task 7 device check "reload JS mid-meeting".

---

## Task 0: Branch setup

**Files:** none (workspace only)

- [ ] **Step 1: Create a worktree off `main`**

```bash
cd /Users/chadpiha/Development/openWhispr/openwhispr
git fetch origin main
git worktree add -b feat/mobile-meeting-live-activity ../openwhispr-meeting-live-activity origin/main
```

- [ ] **Step 2: Bring the untracked spec and plan across**

```bash
mkdir -p ../openwhispr-meeting-live-activity/docs/superpowers/specs ../openwhispr-meeting-live-activity/docs/superpowers/plans
cp docs/superpowers/specs/2026-09-25-meeting-live-activity-design.md ../openwhispr-meeting-live-activity/docs/superpowers/specs/
cp docs/superpowers/plans/2026-09-25-meeting-live-activity.md ../openwhispr-meeting-live-activity/docs/superpowers/plans/
```

- [ ] **Step 3: Install dependencies under Node 24**

```bash
cd ../openwhispr-meeting-live-activity/openwhispr-mobile
nvm use 24
npm ci
```

Also copy the mobile `.env` from the main checkout if one exists (`cp ../../openwhispr/openwhispr-mobile/.env .env`). Never edit it.

- [ ] **Step 4: Confirm the baseline is green**

Run: `npm run typecheck && npx jest --testPathPattern 'src/hooks/__tests__'`
Expected: PASS. If anything fails on untouched `main`, stop and report it before continuing.

---

## Task 1: Content state and resolver (pure Swift, with tests)

**Files:**
- Create: `modules/live-activity/ios/RecordingActivityContentState.swift`
- Create: `modules/live-activity/ios/LiveActivityResolver.swift`
- Modify: `modules/live-activity/ios/RecordingActivityAttributes.swift` (whole file)
- Create: `modules/live-activity/tests/LiveActivityResolverTests.swift`
- Create: `modules/live-activity/tests/run-resolver-tests.sh`

**Interfaces:**
- Produces:
  - `RecordingActivityMode` (`.dictation`, `.meeting`)
  - `RecordingActivityPhase` (`.recording`, `.idle`, `.processing`)
  - `RecordingActivityContentState(mode:phase:startedAt:title:recordedSeconds:)`, with `mode` defaulting to `.dictation` and `title` / `recordedSeconds` defaulting to `nil`. Computed `displayTitle: String` and `recordedDurationLabel: String`.
  - `MeetingSnapshot(title: String?, startedAt: Date, phase: MeetingSnapshot.Phase)`, where `Phase` is `.recording` or `.processing(recordedSeconds: Int)`
  - `LiveActivityResolver.resolve(meeting:keyboardRecording:dictationMode:now:) -> RecordingActivityContentState?`
  - `LiveActivityResolver.staleDate(for:now:) -> Date`
  - `RecordingActivityAttributes.ContentState` / `.Phase` remain valid names (typealiases), so existing widget code compiles unchanged.

- [ ] **Step 1: Write the failing test executable**

Create `modules/live-activity/tests/LiveActivityResolverTests.swift`:

```swift
import Foundation

@main
struct LiveActivityResolverTests {
  static var failures = 0

  static func check(_ condition: Bool, _ message: String, line: Int = #line) {
    if !condition {
      failures += 1
      print("FAIL (line \(line)): \(message)")
    }
  }

  static func main() throws {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let start = Date(timeIntervalSince1970: 999_000)
    let recording = MeetingSnapshot(title: "Weekly sync", startedAt: start, phase: .recording)
    let processing = MeetingSnapshot(
      title: nil, startedAt: start, phase: .processing(recordedSeconds: 2530))

    // A meeting wins over every keyboard/dictation combination.
    for keyboard in [false, true] {
      for dictation in [false, true] {
        check(
          LiveActivityResolver.resolve(
            meeting: recording, keyboardRecording: keyboard, dictationMode: dictation, now: now)
            == RecordingActivityContentState(
              mode: .meeting, phase: .recording, startedAt: start, title: "Weekly sync"),
          "recording meeting wins (keyboard=\(keyboard), dictation=\(dictation))")
        check(
          LiveActivityResolver.resolve(
            meeting: processing, keyboardRecording: keyboard, dictationMode: dictation, now: now)
            == RecordingActivityContentState(
              mode: .meeting, phase: .processing, startedAt: start, recordedSeconds: 2530),
          "processing meeting wins (keyboard=\(keyboard), dictation=\(dictation))")
      }
    }

    // Without a meeting: keyboard recording > dictation idle > nothing.
    let keyboardOnly = RecordingActivityContentState(phase: .recording, startedAt: now)
    check(
      LiveActivityResolver.resolve(meeting: nil, keyboardRecording: true, dictationMode: false, now: now)
        == keyboardOnly, "keyboard recording without dictation mode")
    check(
      LiveActivityResolver.resolve(meeting: nil, keyboardRecording: true, dictationMode: true, now: now)
        == keyboardOnly, "keyboard recording with dictation mode")
    check(
      LiveActivityResolver.resolve(meeting: nil, keyboardRecording: false, dictationMode: true, now: now)
        == RecordingActivityContentState(phase: .idle, startedAt: now), "dictation idle")
    check(
      LiveActivityResolver.resolve(meeting: nil, keyboardRecording: false, dictationMode: false, now: now)
        == nil, "nothing to show ends the activity")

    // Stale dates.
    let meetingState = RecordingActivityContentState(
      mode: .meeting, phase: .recording, startedAt: start)
    check(
      LiveActivityResolver.staleDate(for: meetingState, now: now)
        == start.addingTimeInterval(8 * 60 * 60), "meeting stale date is startedAt + 8h")
    check(
      LiveActivityResolver.staleDate(for: keyboardOnly, now: now)
        == now.addingTimeInterval(60 * 60), "dictation stale date is now + 1h")

    // Display copy.
    check(
      RecordingActivityContentState(mode: .meeting, phase: .recording, startedAt: start).displayTitle
        == "Taking notes…", "untitled meeting")
    check(
      RecordingActivityContentState(
        mode: .meeting, phase: .recording, startedAt: start, title: "Weekly sync"
      ).displayTitle == "Weekly sync", "titled meeting")
    check(
      RecordingActivityContentState(
        mode: .meeting, phase: .processing, startedAt: start, title: "Weekly sync"
      ).displayTitle == "Processing notes…", "processing title")
    let label = { (seconds: Int?) in
      RecordingActivityContentState(
        mode: .meeting, phase: .processing, startedAt: start, recordedSeconds: seconds
      ).recordedDurationLabel
    }
    check(label(2530) == "42:10", "m:ss label")
    check(label(5) == "0:05", "sub-minute label")
    check(label(3723) == "1:02:03", "h:mm:ss label")
    check(label(nil) == "0:00", "missing duration label")
    check(label(-4) == "0:00", "negative duration clamps")

    // A legacy payload (pre-meeting build) still decodes as dictation.
    let legacy = Data(#"{"phase":"idle","startedAt":0}"#.utf8)
    let decoded = try JSONDecoder().decode(RecordingActivityContentState.self, from: legacy)
    check(
      decoded.mode == .dictation && decoded.phase == .idle && decoded.title == nil
        && decoded.recordedSeconds == nil, "legacy payload decodes as dictation")

    // Round trip keeps every field.
    let full = RecordingActivityContentState(
      mode: .meeting, phase: .processing, startedAt: start, title: "Sync", recordedSeconds: 61)
    let roundTripped = try JSONDecoder().decode(
      RecordingActivityContentState.self, from: JSONEncoder().encode(full))
    check(roundTripped == full, "round trip")

    if failures > 0 {
      print("\(failures) failure(s)")
      exit(1)
    }
    print("All live-activity resolver tests passed")
  }
}
```

Create `modules/live-activity/tests/run-resolver-tests.sh`:

```sh
#!/bin/sh
# Compiles the Foundation-only Live Activity sources with the test executable and runs it.
# ActivityKit is iOS-only, so only the pure files are compiled here.
set -eu
MODULE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT
swiftc -swift-version 5 -o "$OUT_DIR/tests" \
  "$MODULE_DIR/ios/RecordingActivityContentState.swift" \
  "$MODULE_DIR/ios/LiveActivityResolver.swift" \
  "$MODULE_DIR/tests/LiveActivityResolverTests.swift"
"$OUT_DIR/tests"
```

Run: `chmod +x modules/live-activity/tests/run-resolver-tests.sh`

- [ ] **Step 2: Run it and watch it fail**

Run: `sh modules/live-activity/tests/run-resolver-tests.sh`
Expected: compile error: `cannot find 'MeetingSnapshot' in scope` (and the other new names).

- [ ] **Step 3: Implement the content state**

Create `modules/live-activity/ios/RecordingActivityContentState.swift`:

```swift
import Foundation

/// Which recording owns the single Live Activity.
public enum RecordingActivityMode: String, Codable, Hashable {
  case dictation
  case meeting
}

/// `idle` is dictation-only (session up, not recording); `processing` is meeting-only.
public enum RecordingActivityPhase: String, Codable, Hashable {
  case recording
  case idle
  case processing
}

/// Foundation-only so the resolver tests can compile it with plain `swiftc` on macOS;
/// `RecordingActivityAttributes` (ActivityKit) aliases it as its `ContentState`.
public struct RecordingActivityContentState: Codable, Hashable {
  public var mode: RecordingActivityMode
  public var phase: RecordingActivityPhase
  public var startedAt: Date
  public var title: String?
  public var recordedSeconds: Int?

  public init(
    mode: RecordingActivityMode = .dictation,
    phase: RecordingActivityPhase,
    startedAt: Date,
    title: String? = nil,
    recordedSeconds: Int? = nil
  ) {
    self.mode = mode
    self.phase = phase
    self.startedAt = startedAt
    self.title = title
    self.recordedSeconds = recordedSeconds
  }

  private enum CodingKeys: String, CodingKey {
    case mode, phase, startedAt, title, recordedSeconds
  }

  // An activity started by a build that predates meetings carries only
  // `phase` + `startedAt`; it must keep decoding after an app update.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    mode = try container.decodeIfPresent(RecordingActivityMode.self, forKey: .mode) ?? .dictation
    phase = try container.decode(RecordingActivityPhase.self, forKey: .phase)
    startedAt = try container.decode(Date.self, forKey: .startedAt)
    title = try container.decodeIfPresent(String.self, forKey: .title)
    recordedSeconds = try container.decodeIfPresent(Int.self, forKey: .recordedSeconds)
  }

  /// Meeting card headline.
  public var displayTitle: String {
    if phase == .processing { return "Processing notes…" }
    return title ?? "Taking notes…"
  }

  /// "42:10" or "1:02:03".
  public var recordedDurationLabel: String {
    let total = max(0, recordedSeconds ?? 0)
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    let seconds = total % 60
    return hours > 0
      ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
      : String(format: "%d:%02d", minutes, seconds)
  }
}
```

- [ ] **Step 4: Implement the resolver**

Create `modules/live-activity/ios/LiveActivityResolver.swift`:

```swift
import Foundation

/// The in-app meeting as the controller tracks it.
public struct MeetingSnapshot: Equatable {
  public enum Phase: Equatable {
    case recording
    case processing(recordedSeconds: Int)
  }

  public var title: String?
  public var startedAt: Date
  public var phase: Phase

  public init(title: String?, startedAt: Date, phase: Phase) {
    self.title = title
    self.startedAt = startedAt
    self.phase = phase
  }
}

/// Decides what the single recording Live Activity shows. A meeting always wins so
/// keyboard/dictation-mode events can never overwrite or end it mid-meeting; when the
/// meeting clears, the activity falls back to the dictation session (or ends).
public enum LiveActivityResolver {
  public static func resolve(
    meeting: MeetingSnapshot?,
    keyboardRecording: Bool,
    dictationMode: Bool,
    now: Date
  ) -> RecordingActivityContentState? {
    if let meeting {
      switch meeting.phase {
      case .recording:
        return RecordingActivityContentState(
          mode: .meeting, phase: .recording, startedAt: meeting.startedAt, title: meeting.title)
      case .processing(let recordedSeconds):
        return RecordingActivityContentState(
          mode: .meeting, phase: .processing, startedAt: meeting.startedAt, title: meeting.title,
          recordedSeconds: recordedSeconds)
      }
    }
    if keyboardRecording {
      return RecordingActivityContentState(phase: .recording, startedAt: now)
    }
    if dictationMode {
      return RecordingActivityContentState(phase: .idle, startedAt: now)
    }
    return nil
  }

  /// Without push updates the stale date can never move later, and ActivityKit ends
  /// every activity at 8 hours, so a meeting is stale only at that cap.
  public static func staleDate(for state: RecordingActivityContentState, now: Date) -> Date {
    state.mode == .meeting
      ? state.startedAt.addingTimeInterval(8 * 60 * 60)
      : now.addingTimeInterval(60 * 60)
  }
}
```

- [ ] **Step 5: Point the attributes at the new state**

Replace the whole of `modules/live-activity/ios/RecordingActivityAttributes.swift` with:

```swift
#if canImport(ActivityKit)
import ActivityKit
import Foundation

/// Shared contract between the app (requests/updates the activity) and the widget
/// extension (renders it). The state lives in RecordingActivityContentState.swift
/// (Foundation-only, unit-tested); these aliases keep existing call sites compiling.
@available(iOS 16.1, *)
public struct RecordingActivityAttributes: ActivityAttributes {
  public typealias ContentState = RecordingActivityContentState
  public typealias Phase = RecordingActivityPhase

  public init() {}
}
#endif
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `sh modules/live-activity/tests/run-resolver-tests.sh`
Expected: `All live-activity resolver tests passed`, exit code 0.

- [ ] **Step 7: Commit (only if authorized)**

```bash
git add modules/live-activity/ios/RecordingActivityContentState.swift modules/live-activity/ios/LiveActivityResolver.swift modules/live-activity/ios/RecordingActivityAttributes.swift modules/live-activity/tests
git commit -m "feat(mobile): Add meeting state and resolver for the recording Live Activity"
```

---

## Task 2: Native controller, End intent, module API, and JS wrapper

**Files:**
- Modify: `modules/live-activity/ios/LiveActivityController.swift` (whole file)
- Create: `modules/live-activity/ios/EndMeetingIntent.swift`
- Modify: `modules/live-activity/ios/LiveActivityModule.swift` (whole file)
- Modify: `modules/live-activity/src/index.ts` (whole file)
- Test: `modules/live-activity/src/__tests__/index.test.ts`

**Interfaces:**
- Consumes (Task 1): `MeetingSnapshot`, `LiveActivityResolver.resolve(...)`, `LiveActivityResolver.staleDate(for:now:)`, `RecordingActivityAttributes`, `RecordingActivityMode`.
- Produces (JS, used by Task 4):
  ```ts
  LiveActivity.startMeeting(input: { title: string | null; startedAt: number }): void // startedAt = epoch ms
  LiveActivity.setMeetingProcessing(input: { recordedSeconds: number }): void
  LiveActivity.endMeeting(): void
  LiveActivity.addEndMeetingListener(listener: () => void): { remove(): void }
  normalizeMeetingTitle(title: string | null | undefined): string | null
  ```
- Produces (native, used by Task 3): `EndMeetingIntent` (iOS 17+ `LiveActivityIntent`), Darwin name `"\(bundleId).endMeetingRequested"`.

- [ ] **Step 1: Write the failing JS wrapper test**

Create `modules/live-activity/src/__tests__/index.test.ts`:

```ts
const mockNative = {
  startSession: jest.fn(),
  endSession: jest.fn(),
  setDictationMode: jest.fn(),
  isDictationModeEnabled: jest.fn(() => true),
  startMeeting: jest.fn(),
  setMeetingProcessing: jest.fn(),
  endMeeting: jest.fn(),
};
const mockRemove = jest.fn();
const mockAddListener = jest.fn((_event: string, _listener: () => void) => ({ remove: mockRemove }));
let mockPlatformOS = 'ios';

jest.mock('expo', () => ({
  requireNativeModule: jest.fn(() => mockNative),
  EventEmitter: jest.fn().mockImplementation(() => ({ addListener: mockAddListener })),
}));
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockPlatformOS;
    },
  },
}));

type Wrapper = typeof import('../index');

function load(os: 'ios' | 'android'): Wrapper {
  mockPlatformOS = os;
  let loaded: Wrapper | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<Wrapper>('../index');
  });
  return loaded as Wrapper;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('LiveActivity meeting API on iOS', () => {
  it('passes the trimmed title and epoch-ms start to the native module', () => {
    const { LiveActivity } = load('ios');
    LiveActivity.startMeeting({ title: '  Weekly sync ', startedAt: 1_700_000_000_000 });
    expect(mockNative.startMeeting).toHaveBeenCalledWith('Weekly sync', 1_700_000_000_000);
  });

  it('normalizes a blank title to null', () => {
    const { LiveActivity, normalizeMeetingTitle } = load('ios');
    expect(normalizeMeetingTitle('   ')).toBeNull();
    expect(normalizeMeetingTitle(undefined)).toBeNull();
    LiveActivity.startMeeting({ title: '   ', startedAt: 5 });
    expect(mockNative.startMeeting).toHaveBeenCalledWith(null, 5);
  });

  it('floors and clamps recorded seconds', () => {
    const { LiveActivity } = load('ios');
    LiveActivity.setMeetingProcessing({ recordedSeconds: 42.9 });
    LiveActivity.setMeetingProcessing({ recordedSeconds: -3 });
    expect(mockNative.setMeetingProcessing).toHaveBeenNthCalledWith(1, 42);
    expect(mockNative.setMeetingProcessing).toHaveBeenNthCalledWith(2, 0);
  });

  it('forwards endMeeting', () => {
    const { LiveActivity } = load('ios');
    LiveActivity.endMeeting();
    expect(mockNative.endMeeting).toHaveBeenCalledTimes(1);
  });

  it('subscribes to onEndMeetingRequested', () => {
    const { LiveActivity } = load('ios');
    const listener = jest.fn();
    const subscription = LiveActivity.addEndMeetingListener(listener);
    expect(mockAddListener).toHaveBeenCalledWith('onEndMeetingRequested', listener);
    subscription.remove();
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});

describe('LiveActivity meeting API off iOS', () => {
  it('is a no-op and returns an inert subscription', () => {
    const { LiveActivity } = load('android');
    LiveActivity.startMeeting({ title: 'x', startedAt: 1 });
    LiveActivity.setMeetingProcessing({ recordedSeconds: 1 });
    LiveActivity.endMeeting();
    const subscription = LiveActivity.addEndMeetingListener(jest.fn());
    expect(() => subscription.remove()).not.toThrow();
    expect(mockNative.startMeeting).not.toHaveBeenCalled();
    expect(mockAddListener).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest --testPathPattern 'modules/live-activity/src/__tests__/index'`
Expected: FAIL: `LiveActivity.startMeeting is not a function` (and `normalizeMeetingTitle` undefined).

- [ ] **Step 3: Implement the JS wrapper**

Replace the whole of `modules/live-activity/src/index.ts` with:

```ts
import { EventEmitter, requireNativeModule } from 'expo';
import { Platform } from 'react-native';

type EventSubscription = {
  remove(): void;
};

interface LiveActivityNativeModule {
  startSession(): void;
  endSession(): void;
  setDictationMode(enabled: boolean): void;
  isDictationModeEnabled(): boolean;
  startMeeting(title: string | null, startedAtMs: number): void;
  setMeetingProcessing(recordedSeconds: number): void;
  endMeeting(): void;
}

type LiveActivityEvents = {
  onEndMeetingRequested: () => void;
};

const NativeModule: LiveActivityNativeModule | null =
  Platform.OS === 'ios' ? requireNativeModule('LiveActivity') : null;

const NativeModuleEvents = NativeModule
  ? new EventEmitter<LiveActivityEvents>(NativeModule as any)
  : null;

const INERT_SUBSCRIPTION: EventSubscription = { remove: () => {} };

/** A blank calendar title renders the default "Taking notes…" headline. */
export function normalizeMeetingTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim();
  return trimmed ? trimmed : null;
}

export const LiveActivity = {
  /** Start the session Live Activity (no-op unless dictation mode is on, app is
   *  foreground, iOS 16.2+, and none is already running). */
  startSession(): void {
    NativeModule?.startSession();
  },
  /** End the session Live Activity immediately. Ignored while a meeting owns it. */
  endSession(): void {
    NativeModule?.endSession();
  },
  /** Enable/disable dictation mode. Enabling (while foreground) starts the
   *  activity; disabling ends it. Persisted in the app group. */
  setDictationMode(enabled: boolean): void {
    NativeModule?.setDictationMode(enabled);
  },
  /** Current dictation-mode flag (false off iOS). */
  isDictationModeEnabled(): boolean {
    return NativeModule?.isDictationModeEnabled() ?? false;
  },
  /** Show the meeting card. Must be called while the app is foreground (the
   *  meeting screen), since iOS only starts Live Activities from the foreground. */
  startMeeting({ title, startedAt }: { title: string | null; startedAt: number }): void {
    NativeModule?.startMeeting(normalizeMeetingTitle(title), startedAt);
  },
  /** Switch the meeting card to "Processing notes…". */
  setMeetingProcessing({ recordedSeconds }: { recordedSeconds: number }): void {
    NativeModule?.setMeetingProcessing(Math.max(0, Math.floor(recordedSeconds)));
  },
  /** Release the card back to the dictation session, or end it. */
  endMeeting(): void {
    NativeModule?.endMeeting();
  },
  /** Fires when the user taps End on the lock screen / Dynamic Island. */
  addEndMeetingListener(listener: () => void): EventSubscription {
    return NativeModuleEvents?.addListener('onEndMeetingRequested', listener) ?? INERT_SUBSCRIPTION;
  },
};
```

- [ ] **Step 4: Run the JS test and watch it pass**

Run: `npx jest --testPathPattern 'modules/live-activity/src/__tests__/index'`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the End intent**

Create `modules/live-activity/ios/EndMeetingIntent.swift`:

```swift
import AppIntents
import Foundation

/// End button on the meeting Live Activity. Runs in the app's process
/// (LiveActivityIntent), which background audio keeps alive while a meeting records.
/// Compiled into both the app and the widget target, so it only posts the Darwin
/// notification; LiveActivityController does the work.
@available(iOS 17.0, *)
struct EndMeetingIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "End meeting recording"
  static var description = IntentDescription("Stops the OpenWhispr meeting recording.")

  func perform() async throws -> some IntentResult {
    let bundleId = Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr"
    let name = "\(bundleId).endMeetingRequested" as CFString
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(name), nil, nil, true)
    return .result()
  }
}
```

- [ ] **Step 6: Rewrite the controller**

Replace the whole of `modules/live-activity/ios/LiveActivityController.swift` with:

```swift
import Foundation
import UIKit
import os.log

#if canImport(ActivityKit)
import ActivityKit
#endif

/// Owns the single recording Live Activity. Two sources share it: keyboard
/// "dictation mode" (updated from the background via Darwin notifications) and an
/// in-app meeting (driven from JS). Every trigger goes through LiveActivityResolver,
/// so a meeting always wins and hands the activity back when it ends. One activity
/// instead of two because `Activity.request` only succeeds in the foreground while
/// `update` works from the background, which is where a lock-screen End tap lands.
/// All state is main-queue only.
final class LiveActivityController {
  static let shared = LiveActivityController()

  private let log = Logger(subsystem: "com.gizmolabs.openwhispr", category: "LiveActivity")

  private init() {}

  private var bundleId: String { Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr" }
  private var statusNotificationName: String { "\(bundleId).keyboardStatusChanged" }
  private var dictationModeNotificationName: String { "\(bundleId).dictationModeChanged" }
  private var endMeetingNotificationName: String { "\(bundleId).endMeetingRequested" }
  private var sharedDefaults: UserDefaults? { UserDefaults(suiteName: "group.\(bundleId)") }
  private var isObserving = false
  private var foregroundObserverToken: NSObjectProtocol?

  /// Non-nil while MeetingRecordScreen has a meeting recording or processing.
  private var meeting: MeetingSnapshot?
  /// Held from a lock-screen End until the meeting clears, since background audio
  /// stops keeping the app alive once the mic stops.
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
  private var endMeetingHandler: (() -> Void)?

  // MARK: - Dictation mode (the user-controlled gate)

  func isDictationModeEnabled() -> Bool {
    // Default ON: enabled unless the user has explicitly turned it off.
    sharedDefaults?.string(forKey: "dictation_mode_enabled") != "0"
  }

  func setDictationMode(_ enabled: Bool) {
    sharedDefaults?.set(enabled ? "1" : "0", forKey: "dictation_mode_enabled")
    // Badge (this controller) and warm mic (AppGroupStorageModule) both observe this.
    postDictationModeChanged()
  }

  private func postDictationModeChanged() {
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    CFNotificationCenterPostNotification(
      center, CFNotificationName(dictationModeNotificationName as CFString), nil, nil, true)
  }

  // True while a keyboard dictation is actively recording. Lets the pill appear
  // for a one-off dictation even when dictation mode (the persistent warm-mic
  // session) is off — e.g. a cross-app handoff from a user who never enabled it.
  private func isRecordingActive() -> Bool {
    sharedDefaults?.string(forKey: "keyboard_recording_active") == "1"
  }

  // MARK: - Observation

  func startObserving() {
    guard !isObserving else { return }
    isObserving = true

    addDarwinObserver(statusNotificationName) { $0.reconcile() }
    addDarwinObserver(dictationModeNotificationName) { $0.reconcile() }
    addDarwinObserver(endMeetingNotificationName) { $0.handleEndMeetingRequested() }
    // Cold-handoff safety net: the URL handler can call startSession() while the
    // scene is still .inactive, so Activity.request fails. Re-attempt the start
    // the moment the app is genuinely foreground-active. Request-only: an existing
    // activity is left untouched so a running keyboard timer isn't reset.
    foregroundObserverToken = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.reconcile(requestOnly: true)
    }
    log.info("Observing keyboard, dictation-mode, and end-meeting notifications")
  }

  private func addDarwinObserver(
    _ name: String, handler: @escaping (LiveActivityController) -> Void
  ) {
    let box = Unmanaged.passRetained(DarwinHandlerBox(controller: self, handler: handler))
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      box.toOpaque(),
      { (_, observer, _, _, _) in
        guard let observer else { return }
        let box = Unmanaged<DarwinHandlerBox>.fromOpaque(observer).takeUnretainedValue()
        DispatchQueue.main.async { box.handler(box.controller) }
      },
      name as CFString,
      nil,
      .deliverImmediately
    )
  }

  // MARK: - JS runtime lifecycle

  func setEndMeetingHandler(_ handler: @escaping () -> Void) {
    onMain { self.endMeetingHandler = handler }
  }

  /// The JS runtime just (re)started, so no meeting can exist yet. Anything left
  /// from before (dev reload, crash, background relaunch) is an orphan.
  func resetForNewJSRuntime() {
    onMain {
      self.meeting = nil
      self.endBackgroundWork()
      if self.isShowingMeeting() { self.reconcile() }
    }
  }

  // MARK: - Meeting (driven from MeetingRecordScreen)

  func startMeeting(title: String?, startedAt: Date) {
    onMain {
      self.meeting = MeetingSnapshot(title: title, startedAt: startedAt, phase: .recording)
      self.reconcile()
    }
  }

  func setMeetingProcessing(recordedSeconds: Int) {
    onMain {
      guard let current = self.meeting else { return }
      self.meeting = MeetingSnapshot(
        title: current.title, startedAt: current.startedAt,
        phase: .processing(recordedSeconds: max(0, recordedSeconds)))
      self.reconcile()
    }
  }

  func endMeeting() {
    onMain {
      self.meeting = nil
      // Release the background task only once the hand-back has landed.
      self.reconcile { self.endBackgroundWork() }
    }
  }

  private func handleEndMeetingRequested() {
    guard let current = meeting else {
      // Orphaned card (its meeting's process is gone): clear it.
      reconcile()
      return
    }
    guard case .recording = current.phase else { return }
    beginBackgroundWork()
    let recordedSeconds = max(0, Int(Date().timeIntervalSince(current.startedAt)))
    meeting = MeetingSnapshot(
      title: current.title, startedAt: current.startedAt,
      phase: .processing(recordedSeconds: recordedSeconds))
    reconcile()
    endMeetingHandler?()
  }

  // MARK: - Session (keyboard handoff API)

  /// Start the session activity if the resolver says one should show and none is
  /// running. Must be called while the app is foreground.
  func startSession() {
    onMain { self.reconcile(requestOnly: true) }
  }

  /// Ends the dictation session card. A meeting owns the card while it runs, so
  /// this is ignored until the meeting ends.
  func endSession() {
    onMain {
      guard self.meeting == nil else { return }
      self.endAll(completion: nil)
    }
  }

  // MARK: - Background work

  private func beginBackgroundWork() {
    guard backgroundTask == .invalid else { return }
    backgroundTask = UIApplication.shared.beginBackgroundTask(
      withName: "OpenWhisprMeetingFinish"
    ) { [weak self] in
      self?.endBackgroundWork()
    }
  }

  private func endBackgroundWork() {
    guard backgroundTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(backgroundTask)
    backgroundTask = .invalid
  }

  // MARK: - Resolve + apply

  private func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
  }

  private func reconcile(requestOnly: Bool = false, completion: (() -> Void)? = nil) {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      reconcileActivity(requestOnly: requestOnly, completion: completion)
      return
    }
    #endif
    completion?()
  }

  private func endAll(completion: (() -> Void)?) {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      endAllActivities(completion: completion)
      return
    }
    #endif
    completion?()
  }

  private func isShowingMeeting() -> Bool {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      return Activity<RecordingActivityAttributes>.activities.contains {
        $0.content.state.mode == .meeting
      }
    }
    #endif
    return false
  }

  #if canImport(ActivityKit)
  @available(iOS 16.2, *)
  private func reconcileActivity(requestOnly: Bool, completion: (() -> Void)?) {
    let now = Date()
    guard
      let state = LiveActivityResolver.resolve(
        meeting: meeting,
        keyboardRecording: isRecordingActive(),
        dictationMode: isDictationModeEnabled(),
        now: now)
    else {
      endAllActivities(completion: completion)
      return
    }
    let content = ActivityContent(
      state: state, staleDate: LiveActivityResolver.staleDate(for: state, now: now))

    if let activity = Activity<RecordingActivityAttributes>.activities.first {
      guard !requestOnly else {
        completion?()
        return
      }
      Task {
        await activity.update(content)
        DispatchQueue.main.async { completion?() }
      }
      return
    }

    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      log.info("Live Activities disabled by the user; skipping")
      completion?()
      return
    }
    do {
      _ = try Activity.request(
        attributes: RecordingActivityAttributes(), content: content, pushType: nil)
      log.info("Live Activity started (\(state.mode.rawValue, privacy: .public))")
    } catch {
      // Expected when called from the background; the foreground observer retries.
      log.error("Failed to start Live Activity: \(error.localizedDescription, privacy: .public)")
    }
    completion?()
  }

  @available(iOS 16.2, *)
  private func endAllActivities(completion: (() -> Void)?) {
    Task {
      for activity in Activity<RecordingActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      DispatchQueue.main.async { completion?() }
    }
  }
  #endif
}

/// Carries a Darwin observer's handler through the C callback's context pointer.
/// Retained for the process lifetime, like the controller singleton itself.
private final class DarwinHandlerBox {
  let controller: LiveActivityController
  let handler: (LiveActivityController) -> Void

  init(controller: LiveActivityController, handler: @escaping (LiveActivityController) -> Void) {
    self.controller = controller
    self.handler = handler
  }
}
```

- [ ] **Step 7: Rewrite the module**

Replace the whole of `modules/live-activity/ios/LiveActivityModule.swift` with:

```swift
import ExpoModulesCore
import Foundation

public class LiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiveActivity")

    Events("onEndMeetingRequested")

    OnCreate {
      let controller = LiveActivityController.shared
      controller.setEndMeetingHandler { [weak self] in
        self?.sendEvent("onEndMeetingRequested", [:])
      }
      controller.startObserving()
      controller.resetForNewJSRuntime()
    }

    Function("startSession") {
      LiveActivityController.shared.startSession()
    }

    Function("endSession") {
      LiveActivityController.shared.endSession()
    }

    Function("setDictationMode") { (enabled: Bool) in
      LiveActivityController.shared.setDictationMode(enabled)
    }

    Function("isDictationModeEnabled") { () -> Bool in
      LiveActivityController.shared.isDictationModeEnabled()
    }

    Function("startMeeting") { (title: String?, startedAtMs: Double) in
      LiveActivityController.shared.startMeeting(
        title: title, startedAt: Date(timeIntervalSince1970: startedAtMs / 1000))
    }

    Function("setMeetingProcessing") { (recordedSeconds: Int) in
      LiveActivityController.shared.setMeetingProcessing(recordedSeconds: recordedSeconds)
    }

    Function("endMeeting") {
      LiveActivityController.shared.endMeeting()
    }
  }
}
```

- [ ] **Step 8: Build the app for the simulator**

`ios/` is git-ignored and generated. Regenerate it, then compile:

```bash
npm run prebuild:dev
xcodebuild -workspace ios/OpenWhispr.xcworkspace -scheme OpenWhispr -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -25
```

Expected: `** BUILD SUCCEEDED **`. The widget still uses only the old views at this point, but it must compile against the aliased `ContentState`.

If `pod install` inside prebuild loops forever, that's the known speaker-diarization UUID-patch bug on `main`. Apply the one-line fix from commit `94905db2` (branch `fix/mobile-pod-install-uuid-hang`) to `plugins/speaker-diarization/withSpeakerDiarization.js` **uncommitted**, and rerun. Do not include it in this branch's commits.

- [ ] **Step 9: Rerun the Swift and JS tests**

Run: `sh modules/live-activity/tests/run-resolver-tests.sh && npx jest --testPathPattern 'modules/live-activity'`
Expected: both PASS.

- [ ] **Step 10: Commit (only if authorized)**

```bash
git add modules/live-activity
git commit -m "feat(mobile): Route the recording Live Activity through the meeting resolver"
```

---

## Task 3: Widget meeting views and extension wiring

**Files:**
- Modify: `plugins/activity-extension/ios/OpenWhisprActivity.swift` (whole file)
- Modify: `plugins/activity-extension/withActivityExtension.js:18-42` (source lists) and `:72-80` (`writeExtensionSupportFiles`)

**Interfaces:**
- Consumes: `RecordingActivityAttributes.ContentState` with `mode`, `phase`, `displayTitle`, and `recordedDurationLabel` (Task 1); `EndMeetingIntent` (Task 2).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Copy the new shared sources into the widget target**

In `plugins/activity-extension/withActivityExtension.js`, replace the `TARGET_SOURCES`, `ATTRIBUTES_SOURCE`, and `INTENT_SOURCE` block (lines 18–42) with:

```js
// Swift sources compiled into the widget target. Everything except
// OpenWhisprActivity.swift is copied from the live-activity module so there is a
// single source of truth.
const TARGET_SOURCES = [
  'OpenWhisprActivity.swift',
  'RecordingActivityAttributes.swift',
  'RecordingActivityContentState.swift',
  'ToggleDictationModeIntent.swift',
  'EndMeetingIntent.swift',
];
const MODULE_IOS_DIR = path.join(__dirname, '..', '..', 'modules', 'live-activity', 'ios');
const SHARED_MODULE_SOURCES = [
  'RecordingActivityAttributes.swift',
  'RecordingActivityContentState.swift',
  'ToggleDictationModeIntent.swift',
  'EndMeetingIntent.swift',
];
```

In `writeExtensionSupportFiles`, replace the two single-file copies:

```js
  // Single source of truth: copy the attributes file from the module.
  fs.copyFileSync(ATTRIBUTES_SOURCE, path.join(extensionDir, 'RecordingActivityAttributes.swift'));
  // Single source of truth: copy the LiveActivityIntent from the module.
  fs.copyFileSync(INTENT_SOURCE, path.join(extensionDir, 'ToggleDictationModeIntent.swift'));
```

with:

```js
  // Single source of truth: the shared state, attributes, and intents live in the module.
  for (const fileName of SHARED_MODULE_SOURCES) {
    fs.copyFileSync(path.join(MODULE_IOS_DIR, fileName), path.join(extensionDir, fileName));
  }
```

Run: `grep -n "ATTRIBUTES_SOURCE\|INTENT_SOURCE" plugins/activity-extension/withActivityExtension.js`
Expected: no output. The existing loops over `TARGET_SOURCES` in both the `withXcodeProject` and `withDangerousMod` phases add the new files to the target unchanged.

- [ ] **Step 2: Add the meeting views**

Replace the whole of `plugins/activity-extension/ios/OpenWhisprActivity.swift` with:

```swift
import ActivityKit
import AppIntents
import WidgetKit
import SwiftUI

private let recordingRed = Color(red: 1.0, green: 0.27, blue: 0.23)
private let brandBlue = Color(red: 0.141, green: 0.341, blue: 0.839)

// MARK: - Brand mark

struct BrandMark: View {
  var color: Color = .white

  var body: some View {
    GeometryReader { geo in
      let s = min(geo.size.width, geo.size.height)
      ZStack {
        Circle()
          .stroke(color, lineWidth: s * 0.075)
          .padding(s * 0.0375)
        HStack(spacing: s * 0.108) {
          Capsule().fill(color).frame(width: s * 0.092, height: s * 0.29)
          Capsule().fill(color).frame(width: s * 0.092, height: s * 0.46)
          Capsule().fill(color).frame(width: s * 0.092, height: s * 0.29)
        }
      }
      .frame(width: s, height: s)
    }
  }
}

struct BrandBadge: View {
  var size: CGFloat

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
        .fill(
          LinearGradient(
            colors: [
              Color(red: 0.141, green: 0.341, blue: 0.839),
              Color(red: 0.055, green: 0.212, blue: 0.565),
            ],
            startPoint: .top,
            endPoint: .bottom
          )
        )
      BrandMark()
        .frame(width: size * 0.66, height: size * 0.66)
    }
    .frame(width: size, height: size)
  }
}

struct ElapsedText: View {
  let startedAt: Date
  var color: Color = .white
  var size: CGFloat = 15

  var body: some View {
    Text(timerInterval: startedAt...startedAt.addingTimeInterval(60 * 60 * 24), countsDown: false)
      .monospacedDigit()
      .font(.system(size: size, weight: .semibold))
      .foregroundColor(color)
  }
}

struct RecordingDot: View {
  var size: CGFloat = 7

  var body: some View {
    Circle().fill(recordingRed).frame(width: size, height: size)
  }
}

// MARK: - Power button (turn dictation mode off)

struct PowerButton: View {
  var size: CGFloat = 30

  var body: some View {
    if #available(iOS 17.0, *) {
      Button(intent: ToggleDictationModeIntent()) {
        glyph
      }
      .buttonStyle(.plain)
    } else {
      glyph
    }
  }

  private var glyph: some View {
    Image(systemName: "power")
      .font(.system(size: size * 0.62, weight: .semibold))
      .foregroundColor(.white)
      .frame(width: size, height: size)
      .background(Circle().fill(Color.white.opacity(0.16)))
  }
}

// MARK: - End button (stop the meeting recording)

/// Same translucent material as PowerButton. Omitted before iOS 17, where
/// `Button(intent:)` doesn't exist; tapping the card still opens the app.
struct EndButton: View {
  var body: some View {
    if #available(iOS 17.0, *) {
      Button(intent: EndMeetingIntent()) {
        Text("End")
          .font(.system(size: 15, weight: .semibold))
          .foregroundColor(.white)
          .padding(.horizontal, 18)
          .padding(.vertical, 8)
          .background(Capsule().fill(Color.white.opacity(0.16)))
      }
      .buttonStyle(.plain)
    }
  }
}

// MARK: - Lock screen / banner

struct RecordingLockScreenView: View {
  let state: RecordingActivityAttributes.ContentState

  var body: some View {
    HStack(spacing: 12) {
      BrandBadge(size: 40)
      VStack(alignment: .leading, spacing: 2) {
        Text("OpenWhispr")
          .font(.system(size: 15, weight: .semibold))
          .foregroundColor(.white)
        if state.phase == .recording {
          HStack(spacing: 5) {
            RecordingDot()
            Text("Recording")
              .font(.system(size: 13))
              .foregroundColor(.white.opacity(0.6))
          }
        } else {
          Text("Dictation mode is active")
            .font(.system(size: 13))
            .foregroundColor(.white.opacity(0.6))
        }
      }
      Spacer()
      if state.phase == .recording {
        ElapsedText(startedAt: state.startedAt, color: .white.opacity(0.85))
      }
      PowerButton(size: 34)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
  }
}

struct MeetingLockScreenView: View {
  let state: RecordingActivityAttributes.ContentState

  var body: some View {
    HStack(spacing: 12) {
      BrandBadge(size: 40)
      VStack(alignment: .leading, spacing: 2) {
        Text(state.displayTitle)
          .font(.system(size: 15, weight: .semibold))
          .foregroundColor(.white)
          .lineLimit(1)
        MeetingSubtitle(state: state, size: 13)
      }
      Spacer(minLength: 8)
      if state.phase == .recording {
        EndButton()
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
  }
}

struct MeetingSubtitle: View {
  let state: RecordingActivityAttributes.ContentState
  var size: CGFloat

  var body: some View {
    if state.phase == .processing {
      Text("Recorded \(state.recordedDurationLabel)")
        .font(.system(size: size))
        .foregroundColor(.white.opacity(0.6))
    } else {
      HStack(spacing: 5) {
        RecordingDot(size: size * 0.54)
        (Text("Recording · ")
          + Text(
            timerInterval: state.startedAt...state.startedAt.addingTimeInterval(60 * 60 * 24),
            countsDown: false))
          .monospacedDigit()
          .font(.system(size: size))
          .foregroundColor(.white.opacity(0.6))
      }
    }
  }
}

// MARK: - Widget

@main
struct OpenWhisprActivityBundle: WidgetBundle {
  var body: some Widget {
    RecordingLiveActivity()
  }
}

struct RecordingLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
      Group {
        if context.state.mode == .meeting {
          MeetingLockScreenView(state: context.state)
        } else {
          RecordingLockScreenView(state: context.state)
        }
      }
      .activityBackgroundTint(Color.black.opacity(0.6))
      .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      if context.state.mode == .meeting {
        return meetingIsland(context.state)
      }
      return dictationIsland(context.state)
    }
  }

  private func dictationIsland(_ state: RecordingActivityAttributes.ContentState) -> DynamicIsland {
    DynamicIsland {
      DynamicIslandExpandedRegion(.leading) {
        HStack(spacing: 10) {
          BrandBadge(size: 34)
          VStack(alignment: .leading, spacing: 1) {
            Text("OpenWhispr")
              .font(.system(size: 14, weight: .semibold))
              .foregroundColor(.white)
              .lineLimit(1)
              .minimumScaleFactor(0.7)
            Text(state.phase == .recording ? "Recording" : "Active")
              .font(.system(size: 12))
              .foregroundColor(.white.opacity(0.6))
              .lineLimit(1)
              .minimumScaleFactor(0.7)
          }
        }
      }
      DynamicIslandExpandedRegion(.trailing) {
        HStack(spacing: 8) {
          if state.phase == .recording {
            ElapsedText(startedAt: state.startedAt, color: .white.opacity(0.7))
          }
          PowerButton(size: 30)
        }
      }
    } compactLeading: {
      BrandBadge(size: 22)
    } compactTrailing: {
      if state.phase == .recording {
        ElapsedText(startedAt: state.startedAt)
          .frame(maxWidth: 44)
      }
    } minimal: {
      BrandBadge(size: 22)
    }
    .keylineTint(brandBlue)
  }

  private func meetingIsland(_ state: RecordingActivityAttributes.ContentState) -> DynamicIsland {
    DynamicIsland {
      DynamicIslandExpandedRegion(.leading) {
        HStack(spacing: 10) {
          BrandBadge(size: 34)
          VStack(alignment: .leading, spacing: 1) {
            Text(state.displayTitle)
              .font(.system(size: 14, weight: .semibold))
              .foregroundColor(.white)
              .lineLimit(1)
              .minimumScaleFactor(0.7)
            MeetingSubtitle(state: state, size: 12)
          }
        }
      }
      DynamicIslandExpandedRegion(.trailing) {
        if state.phase == .recording {
          EndButton()
        }
      }
    } compactLeading: {
      BrandBadge(size: 22)
    } compactTrailing: {
      if state.phase == .recording {
        ElapsedText(startedAt: state.startedAt, color: recordingRed)
          .frame(maxWidth: 44)
      } else {
        Image(systemName: "waveform")
          .font(.system(size: 12, weight: .semibold))
          .foregroundColor(.white.opacity(0.6))
      }
    } minimal: {
      BrandBadge(size: 22)
    }
    .keylineTint(brandBlue)
  }
}
```

The dictation island and `RecordingLockScreenView` render exactly what they did before. The only change there is that the inline red `Circle` became `RecordingDot()`.

- [ ] **Step 3: Regenerate and build**

```bash
npm run prebuild:dev
ls ios/OpenWhisprActivity/
xcodebuild -workspace ios/OpenWhispr.xcworkspace -scheme OpenWhispr -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -25
```

Expected: `ls` lists `EndMeetingIntent.swift`, `RecordingActivityContentState.swift`, `RecordingActivityAttributes.swift`, `ToggleDictationModeIntent.swift`, and `OpenWhisprActivity.swift`; the build ends with `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Lint the plugin**

Run: `npx eslint plugins/activity-extension/withActivityExtension.js modules/live-activity/src`
Expected: no errors.

- [ ] **Step 5: Commit (only if authorized)**

```bash
git add plugins/activity-extension
git commit -m "feat(mobile): Render the meeting recording Live Activity"
```

---

## Task 4: `useMeetingLiveActivity` hook

**Files:**
- Create: `src/hooks/useMeetingLiveActivity.ts`
- Test: `src/hooks/__tests__/useMeetingLiveActivity.test.ts`

**Interfaces:**
- Consumes (Task 2): `LiveActivity.startMeeting`, `setMeetingProcessing`, `endMeeting`, `addEndMeetingListener` from `modules/live-activity/src`.
- Produces (Task 5):
  ```ts
  export type MeetingActivityPhase = 'idle' | 'recording' | 'processing';
  export function useMeetingLiveActivity(options: {
    phase: MeetingActivityPhase;
    title: string | null;
    startedAt: number | null; // epoch ms; read only when phase enters 'recording'
    onEndRequested: () => void;
  }): void;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/hooks/__tests__/useMeetingLiveActivity.test.ts`:

```ts
import { renderHook } from '@testing-library/react-native';
import {
  useMeetingLiveActivity,
  type MeetingActivityPhase,
} from '@/hooks/useMeetingLiveActivity';

const mockStartMeeting = jest.fn();
const mockSetMeetingProcessing = jest.fn();
const mockEndMeeting = jest.fn();
const mockRemove = jest.fn();
let mockEndListener: (() => void) | undefined;

jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: {
    startMeeting: (input: unknown) => mockStartMeeting(input),
    setMeetingProcessing: (input: unknown) => mockSetMeetingProcessing(input),
    endMeeting: () => mockEndMeeting(),
    addEndMeetingListener: (listener: () => void) => {
      mockEndListener = listener;
      return { remove: mockRemove };
    },
  },
}));

type Props = {
  phase: MeetingActivityPhase;
  title: string | null;
  startedAt: number | null;
  onEndRequested: () => void;
};

function setup(initial: Partial<Props> = {}) {
  const onEndRequested = jest.fn();
  const props: Props = {
    phase: 'idle',
    title: null,
    startedAt: null,
    onEndRequested,
    ...initial,
  };
  const hook = renderHook((p: Props) => useMeetingLiveActivity(p), { initialProps: props });
  return {
    ...hook,
    onEndRequested,
    update: (next: Partial<Props>) => hook.rerender({ ...props, ...next }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEndListener = undefined;
  jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useMeetingLiveActivity', () => {
  it('starts the meeting card when recording begins', () => {
    const { update } = setup();
    update({ phase: 'recording', title: 'Weekly sync', startedAt: 990_000 });
    expect(mockStartMeeting).toHaveBeenCalledWith({ title: 'Weekly sync', startedAt: 990_000 });
  });

  it('falls back to now when no start time is known', () => {
    const { update } = setup();
    update({ phase: 'recording' });
    expect(mockStartMeeting).toHaveBeenCalledWith({ title: null, startedAt: 1_000_000 });
  });

  it('does not restart the card when the title changes mid-recording', () => {
    const { update } = setup();
    update({ phase: 'recording', title: 'A', startedAt: 990_000 });
    update({ phase: 'recording', title: 'B', startedAt: 990_000 });
    expect(mockStartMeeting).toHaveBeenCalledTimes(1);
  });

  it('reports the recorded duration when processing starts', () => {
    const { update } = setup();
    update({ phase: 'recording', startedAt: 958_000 });
    update({ phase: 'processing' });
    expect(mockSetMeetingProcessing).toHaveBeenCalledWith({ recordedSeconds: 42 });
  });

  it('ignores processing that was never preceded by a recording', () => {
    const { update } = setup();
    update({ phase: 'processing' });
    expect(mockSetMeetingProcessing).not.toHaveBeenCalled();
  });

  it('ends the meeting when processing finishes back to idle', () => {
    const { update } = setup();
    update({ phase: 'recording', startedAt: 990_000 });
    update({ phase: 'processing' });
    update({ phase: 'idle' });
    expect(mockEndMeeting).toHaveBeenCalledTimes(1);
  });

  it('recording → idle ends the meeting', () => {
    const { update } = setup();
    update({ phase: 'recording', startedAt: 990_000 });
    update({ phase: 'idle' });
    expect(mockEndMeeting).toHaveBeenCalledTimes(1);
  });

  it('ends the meeting on unmount mid-meeting', () => {
    const { update, unmount } = setup();
    update({ phase: 'recording', startedAt: 990_000 });
    unmount();
    expect(mockEndMeeting).toHaveBeenCalledTimes(1);
  });

  it('does not end anything on unmount when no meeting ran', () => {
    const { unmount } = setup();
    unmount();
    expect(mockEndMeeting).not.toHaveBeenCalled();
  });

  it('forwards a lock-screen End while recording', () => {
    const { update, onEndRequested } = setup();
    update({ phase: 'recording', startedAt: 990_000 });
    mockEndListener?.();
    expect(onEndRequested).toHaveBeenCalledTimes(1);
  });

  it('End fired twice while recording calls onEndRequested once', () => {
    const { update, onEndRequested } = setup();
    update({ phase: 'recording', startedAt: 990_000 });
    mockEndListener?.();
    mockEndListener?.();
    expect(onEndRequested).toHaveBeenCalledTimes(1);
  });

  it('allows End again for the next meeting', () => {
    const { update, onEndRequested } = setup();
    update({ phase: 'recording', startedAt: 990_000 });
    mockEndListener?.();
    update({ phase: 'idle' });
    update({ phase: 'recording', startedAt: 995_000 });
    mockEndListener?.();
    expect(onEndRequested).toHaveBeenCalledTimes(2);
  });

  it('ignores End while processing or idle', () => {
    const { update, onEndRequested } = setup();
    mockEndListener?.();
    update({ phase: 'recording', startedAt: 990_000 });
    update({ phase: 'processing' });
    mockEndListener?.();
    expect(onEndRequested).not.toHaveBeenCalled();
  });

  it('calls the latest onEndRequested callback', () => {
    const { update } = setup();
    const latest = jest.fn();
    update({ phase: 'recording', startedAt: 990_000, onEndRequested: latest });
    mockEndListener?.();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('removes the End listener on unmount', () => {
    const { unmount } = setup();
    unmount();
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest --testPathPattern 'useMeetingLiveActivity'`
Expected: FAIL: `Cannot find module '@/hooks/useMeetingLiveActivity'`.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useMeetingLiveActivity.ts`:

```ts
import { useEffect, useRef } from 'react';
import { LiveActivity } from '../../modules/live-activity/src';

export type MeetingActivityPhase = 'idle' | 'recording' | 'processing';

interface UseMeetingLiveActivityOptions {
  phase: MeetingActivityPhase;
  title: string | null;
  /** Epoch ms. Read only when `phase` enters 'recording'. */
  startedAt: number | null;
  /** Called when the user taps End on the lock screen while recording. */
  onEndRequested: () => void;
}

/**
 * Mirrors a meeting's phase into the iOS Live Activity and forwards the
 * lock-screen End button. A no-op off iOS (the module is inert there).
 */
export function useMeetingLiveActivity({
  phase,
  title,
  startedAt,
  onEndRequested,
}: UseMeetingLiveActivityOptions): void {
  const latestRef = useRef({ phase, title, startedAt, onEndRequested });
  // Non-null while this hook has a meeting card up.
  const activeStartedAtRef = useRef<number | null>(null);
  // One End per meeting: iOS or a racing in-app Stop can deliver it twice before
  // the screen re-renders into 'processing'.
  const endRequestedRef = useRef(false);

  // Declared first so later effects in the same commit read fresh values.
  useEffect(() => {
    latestRef.current = { phase, title, startedAt, onEndRequested };
  });

  useEffect(() => {
    if (phase === 'recording') {
      if (activeStartedAtRef.current != null) return;
      const start = latestRef.current.startedAt ?? Date.now();
      activeStartedAtRef.current = start;
      endRequestedRef.current = false;
      LiveActivity.startMeeting({ title: latestRef.current.title, startedAt: start });
      return;
    }
    if (activeStartedAtRef.current == null) return;
    if (phase === 'processing') {
      LiveActivity.setMeetingProcessing({
        recordedSeconds: (Date.now() - activeStartedAtRef.current) / 1000,
      });
      return;
    }
    activeStartedAtRef.current = null;
    LiveActivity.endMeeting();
  }, [phase]);

  useEffect(() => {
    const subscription = LiveActivity.addEndMeetingListener(() => {
      if (latestRef.current.phase !== 'recording' || endRequestedRef.current) return;
      endRequestedRef.current = true;
      latestRef.current.onEndRequested();
    });
    return () => {
      subscription.remove();
      if (activeStartedAtRef.current != null) {
        activeStartedAtRef.current = null;
        LiveActivity.endMeeting();
      }
    };
  }, []);
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx jest --testPathPattern 'useMeetingLiveActivity'`
Expected: PASS (15 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/hooks/useMeetingLiveActivity.ts src/hooks/__tests__/useMeetingLiveActivity.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit (only if authorized)**

```bash
git add src/hooks/useMeetingLiveActivity.ts src/hooks/__tests__/useMeetingLiveActivity.test.ts
git commit -m "feat(mobile): Mirror meeting phases into the Live Activity"
```

---

## Task 5: Wire `MeetingRecordScreen`

**Files:**
- Modify: `src/screens/MeetingRecordScreen.tsx` (imports; state near line 50; `startRecording` near line 208; `startCloudMeeting` near line 312; add the hook call after `finishCloud`)

**Interfaces:**
- Consumes (Task 4): `useMeetingLiveActivity`, `MeetingActivityPhase`.
- Produces: nothing.

There is no screen test harness for `MeetingRecordScreen`. The hook's behavior is covered by Task 4; this task is verified by typecheck and on-device in Task 7.

- [ ] **Step 1: Import the hook**

After `import { useCloudMeeting } from '@/hooks/useCloudMeeting';`, add:

```ts
import { useMeetingLiveActivity, type MeetingActivityPhase } from '@/hooks/useMeetingLiveActivity';
```

- [ ] **Step 2: Track the meeting start for both paths**

After `const [elapsedSeconds, setElapsedSeconds] = useState(0);`, add:

```ts
  // Wall-clock start of the current meeting (local or cloud), for the Live Activity timer.
  // recordingStartedAtRef is local-only and is cleared as soon as processing starts.
  const [meetingStartedAt, setMeetingStartedAt] = useState<number | null>(null);
```

In `startRecording`, replace

```ts
    recordingStartedAtRef.current = Date.now();
    setPhase('recording');
```

with

```ts
    const startedAt = Date.now();
    recordingStartedAtRef.current = startedAt;
    setMeetingStartedAt(startedAt);
    setPhase('recording');
```

In `startCloudMeeting`, replace

```ts
    setNoteId(note.id);
    setPhase('cloud-recording');
```

with

```ts
    setNoteId(note.id);
    setMeetingStartedAt(Date.now());
    setPhase('cloud-recording');
```

- [ ] **Step 3: Call the hook**

Directly after the `finishCloud` function's closing `};` and before `if (phase === 'prompt') {` (hooks must run before the screen's first early return), add:

```ts
  const meetingActivityPhase: MeetingActivityPhase =
    phase === 'recording' || phase === 'cloud-recording'
      ? 'recording'
      : phase === 'processing'
        ? 'processing'
        : 'idle';
  useMeetingLiveActivity({
    phase: meetingActivityPhase,
    title: selectedMeetingContext?.title ?? null,
    startedAt: meetingStartedAt,
    onEndRequested: () => {
      const stop = phase === 'cloud-recording' ? finishCloud : finish;
      stop().catch(Sentry.captureException);
    },
  });
```

Both `finish` and `finishCloud` are declared above this point. The hook keeps the latest `onEndRequested` in a ref, so the inline arrow always sees the current `phase` and handlers.

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/screens/MeetingRecordScreen.tsx`
Expected: no errors.

- [ ] **Step 5: Run the related suites**

Run: `npx jest --testPathPattern 'useMeetingLiveActivity|useNotesStore.meeting|modules/live-activity'`
Expected: PASS.

- [ ] **Step 6: Commit (only if authorized)**

```bash
git add src/screens/MeetingRecordScreen.tsx
git commit -m "feat(mobile): Show the meeting Live Activity while recording"
```

---

## Task 6: Cold-launch recovery for orphaned meeting notes

**Files:**
- Create: `src/lib/meetingRecovery.ts`
- Modify: `src/hooks/useAppInit.ts`
- Test: `src/lib/__tests__/meetingRecovery.test.ts`

**Interfaces:**
- Consumes: `notesRepository.getAllNotes()` (non-deleted notes) from `@/data`; `useNotesStore.getState().transitionStatus(id, 'failed')`; `useNotesStore.getState().retryMeetingTranscription(id)`; `canTransition` from `@/lib/diarization/transcriptionStatus`; `isManagedMeetingAudioUri` from `@/lib/transcriptAudio`; the global `localStorage` (the `expo-sqlite/localStorage/install` polyfill that `StorageService` already uses).
- Produces:
  ```ts
  export const MEETING_RESUME_MARKER_PREFIX = 'meetingResumeAttempted:';
  export interface MeetingRecoveryDeps { ... } // see code
  export function recoverOrphanedMeetings(deps: MeetingRecoveryDeps): Promise<void>;
  export function startMeetingRecoveryOnce(): void;
  ```

**Design notes (these refine the spec after checking the code):**
- `processMeeting` begins with `advance('transcribing')` from the note's real status, and `transcribing → transcribing` is illegal. The sweep therefore **marks every orphan `failed` first**, then resumes from `failed` (`failed → transcribing` is legal). As a side effect, a note is never left stuck mid-pipeline even if the resume never starts.
- The marker lives in `localStorage` (the app's synchronous key-value store), not AsyncStorage, which the app doesn't use.
- `getAllNotes()` already excludes deleted notes, so deleted orphans are skipped (they're invisible anyway).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/meetingRecovery.test.ts`:

```ts
jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('@/data', () => ({ notesRepository: { getAllNotes: jest.fn(() => []) } }));
jest.mock('@/store/useNotesStore', () => ({ useNotesStore: { getState: jest.fn() } }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/lib/transcriptAudio', () => ({
  isManagedMeetingAudioUri: (noteId: number, uri?: string | null) =>
    uri === `file:///docs/meeting-${noteId}.wav`,
}));

import type { Note } from '@/data';
import {
  MEETING_RESUME_MARKER_PREFIX,
  recoverOrphanedMeetings,
  type MeetingRecoveryDeps,
} from '@/lib/meetingRecovery';

function note(overrides: Partial<Note> & { id: number }): Note {
  return {
    noteType: 'meeting',
    transcriptionStatus: 'transcribing',
    sourceFile: `file:///docs/meeting-${overrides.id}.wav`,
    ...overrides,
  } as Note;
}

function makeDeps(notes: Note[], initialStorage: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialStorage));
  const calls: string[] = [];
  const deps: MeetingRecoveryDeps = {
    listNotes: jest.fn(() => notes),
    markFailed: jest.fn((id: number) => {
      calls.push(`failed:${id}`);
    }),
    resume: jest.fn(async (id: number) => {
      calls.push(`resume:${id}`);
    }),
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        calls.push(`set:${key}`);
        store.set(key, value);
      },
      removeItem: (key: string) => {
        calls.push(`remove:${key}`);
        store.delete(key);
      },
    },
    reportError: jest.fn(),
  };
  return { deps, store, calls };
}

const marker = (id: number) => `${MEETING_RESUME_MARKER_PREFIX}${id}`;

describe('recoverOrphanedMeetings', () => {
  it.each(['transcribing', 'diarizing'])(
    'marks a %s orphan failed, then resumes it once behind a marker',
    async (status) => {
      const { deps, store, calls } = makeDeps([note({ id: 1, transcriptionStatus: status })]);
      await recoverOrphanedMeetings(deps);
      expect(calls).toEqual([
        'failed:1',
        `set:${marker(1)}`,
        'resume:1',
        `remove:${marker(1)}`,
      ]);
      expect(store.has(marker(1))).toBe(false);
    },
  );

  it('does not resume a second time when the marker survived a crash', async () => {
    const { deps, store } = makeDeps([note({ id: 2 })], { [marker(2)]: '1' });
    await recoverOrphanedMeetings(deps);
    expect(deps.markFailed).toHaveBeenCalledWith(2);
    expect(deps.resume).not.toHaveBeenCalled();
    expect(store.has(marker(2))).toBe(false);
  });

  it('fails a note left in recording without resuming', async () => {
    const { deps } = makeDeps([note({ id: 3, transcriptionStatus: 'recording' })]);
    await recoverOrphanedMeetings(deps);
    expect(deps.markFailed).toHaveBeenCalledWith(3);
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it('fails without resuming when there is no managed meeting WAV', async () => {
    const { deps } = makeDeps([
      note({ id: 4, sourceFile: null }),
      note({ id: 5, sourceFile: 'file:///elsewhere/meeting-5.wav' }),
    ]);
    await recoverOrphanedMeetings(deps);
    expect(deps.markFailed).toHaveBeenCalledWith(4);
    expect(deps.markFailed).toHaveBeenCalledWith(5);
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it('leaves settled and non-meeting notes alone', async () => {
    const { deps } = makeDeps([
      note({ id: 6, transcriptionStatus: 'done' }),
      note({ id: 7, transcriptionStatus: 'failed' }),
      note({ id: 8, transcriptionStatus: 'idle' }),
      note({ id: 9, transcriptionStatus: null }),
      note({ id: 10, noteType: 'personal', transcriptionStatus: 'transcribing' }),
    ]);
    await recoverOrphanedMeetings(deps);
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it('a failing resume is reported and the sweep continues', async () => {
    const { deps, store } = makeDeps([note({ id: 11 }), note({ id: 12 })]);
    const boom = new Error('pipeline crashed');
    (deps.resume as jest.Mock).mockImplementationOnce(async () => {
      throw boom;
    });
    await recoverOrphanedMeetings(deps);
    expect(deps.reportError).toHaveBeenCalledWith(boom, 11);
    expect(deps.resume).toHaveBeenCalledWith(12);
    expect(store.has(marker(11))).toBe(false);
    expect(store.has(marker(12))).toBe(false);
  });

  it('skips the resume when marking failed throws', async () => {
    const { deps } = makeDeps([note({ id: 13 })]);
    const illegal = new Error('Illegal transcription status transition');
    (deps.markFailed as jest.Mock).mockImplementationOnce(() => {
      throw illegal;
    });
    await recoverOrphanedMeetings(deps);
    expect(deps.reportError).toHaveBeenCalledWith(illegal, 13);
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it('resumes one note at a time', async () => {
    const { deps } = makeDeps([note({ id: 14 }), note({ id: 15 })]);
    let releaseFirst: () => void = () => {};
    (deps.resume as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseFirst = resolve)),
    );
    const sweep = recoverOrphanedMeetings(deps);
    await Promise.resolve();
    expect(deps.resume).toHaveBeenCalledTimes(1);
    releaseFirst();
    await sweep;
    expect(deps.resume).toHaveBeenCalledTimes(2);
  });

  it('reads the note list once, before any resume', async () => {
    const { deps } = makeDeps([note({ id: 16 })]);
    await recoverOrphanedMeetings(deps);
    expect(deps.listNotes).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest --testPathPattern 'lib/__tests__/meetingRecovery'`
Expected: FAIL: `Cannot find module '@/lib/meetingRecovery'`.

- [ ] **Step 3: Implement the sweep**

Create `src/lib/meetingRecovery.ts`:

```ts
import 'expo-sqlite/localStorage/install';
import type { Note } from '@/data';
import { notesRepository } from '@/data';
import { canTransition } from '@/lib/diarization/transcriptionStatus';
import { Sentry } from '@/lib/sentry';
import { isManagedMeetingAudioUri } from '@/lib/transcriptAudio';
import { useNotesStore } from '@/store/useNotesStore';
import type { TranscriptionStatus } from '@/types';

export const MEETING_RESUME_MARKER_PREFIX = 'meetingResumeAttempted:';

// In a fresh process nothing is running a meeting pipeline, so a meeting note in
// any of these states was orphaned when its previous process died.
const ORPHANED_STATUSES: ReadonlySet<string> = new Set(['recording', 'transcribing', 'diarizing']);

export interface MeetingRecoveryDeps {
  listNotes(): Note[];
  markFailed(noteId: number): void;
  resume(noteId: number): Promise<void>;
  storage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  reportError(error: unknown, noteId: number): void;
}

/**
 * Recovers meeting notes whose process died mid-recording or mid-pipeline (e.g. iOS
 * terminated the app after a lock-screen End). Each orphan is marked failed, which
 * surfaces the note's Retry button; one with its recording still on disk is also
 * resumed, once. The marker is set before the resume and cleared when it settles,
 * so a resume that itself kills the app is not retried on the next launch.
 */
export async function recoverOrphanedMeetings(deps: MeetingRecoveryDeps): Promise<void> {
  const orphans = deps
    .listNotes()
    .filter(
      (note) =>
        note.noteType === 'meeting' &&
        note.transcriptionStatus != null &&
        ORPHANED_STATUSES.has(note.transcriptionStatus),
    );

  for (const note of orphans) {
    const markerKey = `${MEETING_RESUME_MARKER_PREFIX}${note.id}`;
    const alreadyAttempted = deps.storage.getItem(markerKey) != null;
    const resumable =
      note.transcriptionStatus !== 'recording' &&
      isManagedMeetingAudioUri(note.id, note.sourceFile) &&
      !alreadyAttempted;

    try {
      if (canTransition(note.transcriptionStatus as TranscriptionStatus, 'failed')) {
        deps.markFailed(note.id);
      }
    } catch (error) {
      deps.reportError(error, note.id);
      deps.storage.removeItem(markerKey);
      continue;
    }

    if (!resumable) {
      if (alreadyAttempted) deps.storage.removeItem(markerKey);
      continue;
    }

    deps.storage.setItem(markerKey, '1');
    try {
      // Sequential on purpose: each resume runs on-device ASR + diarization.
      await deps.resume(note.id);
    } catch (error) {
      deps.reportError(error, note.id);
    }
    deps.storage.removeItem(markerKey);
  }
}

let hasStarted = false;

/** Runs the sweep once per JS runtime. Call after the notes store is initialized. */
export function startMeetingRecoveryOnce(): void {
  if (hasStarted) return;
  hasStarted = true;
  const store = useNotesStore.getState();
  recoverOrphanedMeetings({
    listNotes: () => notesRepository.getAllNotes(),
    markFailed: (noteId) => store.transitionStatus(noteId, 'failed'),
    resume: (noteId) => useNotesStore.getState().retryMeetingTranscription(noteId),
    storage: localStorage,
    reportError: (error, noteId) =>
      Sentry.captureException(error, {
        tags: { feature: 'meeting-recovery' },
        extra: { noteId },
      }),
  }).catch((error) => {
    Sentry.captureException(error, { tags: { feature: 'meeting-recovery' } });
  });
}
```

If `Note['transcriptionStatus']` is typed differently from `string | null` (check `src/data/types.ts` / the Drizzle schema), adjust the `!= null` guard and cast accordingly, and keep the tests unchanged. If `Sentry.captureException` from `@/lib/sentry` doesn't accept `extra`, fold `noteId` into `tags` as a string.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx jest --testPathPattern 'lib/__tests__/meetingRecovery'`
Expected: PASS (10 tests).

- [ ] **Step 5: Wire it into app init**

In `src/hooks/useAppInit.ts`, add the import:

```ts
import { startMeetingRecoveryOnce } from '@/lib/meetingRecovery';
```

and after the existing `useEffect(...)` block inside `useAppInit`, add:

```ts
  // After notes load and before any meeting can start: recover meeting notes whose
  // process died mid-recording or mid-pipeline.
  useEffect(() => {
    if (isNotesInitialized) startMeetingRecoveryOnce();
  }, [isNotesInitialized]);
```

- [ ] **Step 6: Typecheck, lint, and run the related suites**

Run: `npm run typecheck && npx eslint src/lib/meetingRecovery.ts src/hooks/useAppInit.ts src/lib/__tests__/meetingRecovery.test.ts && npx jest --testPathPattern 'meetingRecovery|useNotesStore'`
Expected: no errors; PASS.

- [ ] **Step 7: Commit (only if authorized)**

```bash
git add src/lib/meetingRecovery.ts src/lib/__tests__/meetingRecovery.test.ts src/hooks/useAppInit.ts
git commit -m "fix(mobile): Recover meeting notes orphaned mid-pipeline on launch"
```

---

## Task 7: Full verification and device checklist

**Files:** none (verification only; commits the spec and plan)

- [ ] **Step 1: Run the full automated checks**

```bash
npm run format:write
npm run lint
npm run typecheck
npm test
sh modules/live-activity/tests/run-resolver-tests.sh
```

Expected: everything passes. Report any pre-existing failures separately, with their output; don't fix unrelated code.

- [ ] **Step 2: Install on an iOS 17+ device and run the checklist**

Build with `npm run ios` (device selected) or through Xcode. Record pass or fail for each item:

- [ ] First meeting shows the iOS "Allow Live Activities from OpenWhispr?" prompt; Allow shows the card
- [ ] Lock screen: calendar title (or `Taking notes…`), red dot, `Recording · ` with a counting timer, End pill; dark-glass background matches the dictation card
- [ ] End from the lock screen, cloud meeting: mic stops right away, card shows `Processing notes…` / `Recorded m:ss`, card clears, note is done when opened
- [ ] End from the lock screen, local meeting: mic stops right away; card stays `Processing notes…` while locked; opening the app finishes the pipeline and lands on the note
- [ ] In-app Stop: card goes to processing, then clears on the note screen
- [ ] Dictation mode ON: the dictation card turns into the meeting card, and returns to `Dictation mode is active` after
- [ ] Dictation mode OFF: the card ends after the meeting
- [ ] Turning dictation mode off in Settings mid-meeting leaves the meeting card
- [ ] A keyboard dictation in another app mid-meeting leaves the meeting card
- [ ] Recording error path (e.g. deny mic on a fresh install, or kill network for cloud) sends the screen back to the prompt and the card ends
- [ ] Reload JS mid-meeting (dev menu): the orphaned meeting card clears or reverts to the dictation card
- [ ] Force-quit mid-recording, then relaunch: the card clears; the note shows `failed` with Retry
- [ ] Force-quit mid-local-processing, then relaunch: the pipeline resumes once and completes; force-quit again during that resume, relaunch: the note is `failed` (no second resume)
- [ ] Dynamic Island: compact shows badge + red timer (`waveform` glyph when processing), minimal shows badge, expanded shows title + subtitle + End; End works from expanded
- [ ] Live Activities disabled in Settings → OpenWhispr: meetings record normally, no card, no errors
- [ ] iOS 16.x device or simulator (if available): the card shows without an End button
- [ ] Meeting over one hour: compact Dynamic Island timer and expanded subtitle are not clipped
- [ ] Very long calendar title: truncates cleanly on the lock screen and in the expanded island
- [ ] End with the phone passcode-locked for >10 s: cloud finalize and AI title/summary still succeed (Keychain-protected tokens)
- [ ] Local End on a 30+ min meeting with each engine (Whisper CPU, Parakeet CoreML) + diarizer: no background CPU/GPU/ANE kills in crash logs
- [ ] Cloud End with the network cut first: card returns to the dictation card or ends, never stuck on `Processing notes…`
- [ ] Power button on the dictation card while a keyboard dictation is recording: the card ends
- [ ] End tapped twice quickly: one finish, one note
- [ ] Dictation mode ON + local End while locked: card returns to `Dictation mode is active` once the pipeline finishes
- [ ] Dictation card older than 8 h (system-ended, still on the lock screen), then start a meeting: the meeting card appears
- [ ] Background launch (e.g. a background upload finishing) with an orphaned meeting note: the note is marked `failed` immediately and resumes only once the app is opened; if the background process dies first, the note stays `failed` with Retry
- [ ] Meeting under one hour: the compact Dynamic Island timer is not shrunk unnecessarily (timer text measures against its 24 h range)

- [ ] **Step 3: Commit (only if authorized)**

```bash
git add docs/superpowers/specs/2026-09-25-meeting-live-activity-design.md docs/superpowers/plans/2026-09-25-meeting-live-activity.md
git commit -m "docs(mobile): Add the meeting Live Activity spec and plan"
```

Do not push; the user handles pushes and the PR.
