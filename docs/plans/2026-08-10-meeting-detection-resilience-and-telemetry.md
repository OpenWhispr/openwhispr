# Plan — Meeting detection stops silently, and consecutive calls merge

Date: 2026-08-10
Base: `main` @ `4ede9156` (version 1.13.2)
Branch: `fix/meeting-detection-resilience-and-telemetry`

---

## Symptoms

1. **Detection dies.** Meeting/call detection works, then stops. No errors. No
   clear trigger — not reliably after a meeting, after sleep, or after
   dismissing. User suspects "a background worker that's not running".
2. **Consecutive calls merge.** Leaving a Google Meet call and immediately
   joining another produces **one combined note** instead of two. User's
   instinct: "it should verify the unique id in those cases." That instinct is
   correct — see defect 8.

---

## Measured evidence (not inference)

Taken on the user's machine, on the running 1.13.2 build:

| measurement | result | consequence |
|---|---|---|
| `ioreg -l -w 0 \| grep -c IOAudioEngineState` | **0 occurrences of the key, at any value** (arm64, macOS 26.2) | `_checkDarwin()` can only ever return `false`. The macOS polling fallback is **dead code**. |
| Same, during output-only playback | 0 | Not a false-positive problem — the check simply never fires. |
| `pgrep macos-mic-listener` | **alive, PID 98827** | The listener spawns and works. |
| App / listener uptime | **4 d 21 h**, listener started 2 s after the app | **The child has not died in this session.** |
| `~/Library/.../open-whispr/logs/` | only `onnx-worker.log`; **no `debug-*.log`** | Nothing about detection has ever been recorded. |

**This overturned my initial ranking.** I first suspected the native listener
dying with no restart. Five days of continuous listener uptime contradicts that
for the current session, and promotes the **in-process latches** (defects 1, 2,
6) to primary: the child is emitting fine and the engine is dropping the events.

The listener-restart gap (defect 3) plus the dead fallback (defect 4) remain
real and worth fixing — they are unrecoverable *when* they trigger — but they are
no longer the leading explanation.

---

## Verified root causes

All read from source with `file:line`. Defect 0 is why none of the others were
ever visible.

### 0. Nothing is written to disk by default — this is why there are "no errors"

`src/helpers/debugLogger.js:42`

```js
this.fileLoggingPending = this.debugMode;
```

`debugMode` is `levelValue <= LOG_LEVELS.debug` (`:130-132`); the default level
is `"info"` (`:110`). So `fileLoggingPending` is false and
`initializeFileLogging()` is never reached. **File logging is gated on debug
mode, not on severity**, so `warn` and `error` are never persisted either. In a
packaged `.app` the console goes nowhere. Confirmed: no `debug-*.log` exists.

### 1. `_meetingModeActive` — latched after EVERY normal meeting — **ROOT CAUSE, deterministic**

**This needs no crash, no rejected promise, and no unusual conditions.** It
happens after every ordinary meeting.

Ending a meeting recording does **not** clear the latch. `meeting-transcription-stop`
(`src/helpers/ipcHandlers.js:5845-5846`) clears only `_userRecording`:

```js
ipcMain.handle("meeting-transcription-stop", async (_event, options = {}) => {
  this.meetingDetectionEngine?.setUserRecording(false);
```

The **only** clearing path in the entire renderer is a single call site —
`src/components/ControlPanel.tsx:385`, the `handleExitMeetingMode` handler behind
the **"Back to notes"** button, which is rendered at `:750` inside a block gated
on `isSidePanelLayout` (`:742`, defined `:88`).

So: finish a meeting → `_meetingModeActive` stays `true` → **every subsequent
detection is dropped** at `meetingDetectionEngine.js:245` → until the user
happens to click "Back to notes", which does not even exist in a wide-window
layout. That is the "dies at some point, no clear pattern": the pattern is
*after a meeting, unless you click one specific button.*

It also feeds symptom 2: `_handleCallActive` returns early at `:81-89` while
`_meetingModeActive` is true, so a second call cannot open its own note — its
audio lands in the still-open session from call A.

The additional crash paths below are real but secondary:

`src/helpers/meetingDetectionEngine.js:245-252` drops **every** detection:

```js
if (this._meetingModeActive) {
  debugLogger.info("Suppressing detection — meeting mode already active", { detectionId }, "meeting");
  return;
}
```

Set `true` at `:182`, `:380`, `:408`. Cleared outside `stop()` in exactly one
place — `src/helpers/ipcHandlers.js:710`, behind the renderer's
`restore-from-meeting-mode` IPC. Renderer crash, close, reload, or a UI path that
never performs that transition ⇒ latched for the process lifetime.

Three paths set it *before* an `await` that can reject:
- `_handleCallActive` (`:123-137`): `.catch` resets `_autoStarted` but **not**
  `_meetingModeActive`.
- `startManualMeeting` (`:380`) and `joinCalendarMeeting` (`:408`): set it, then
  `await queueMeetingNoteNavigation` (`:399`, `:443`) with **no try/catch**.

`handleNotificationResponse` (`:357-363`) *does* reset it — the hazard was known
in one path and missed in three.

### 2. `hasPrompted` latches when the mic never reports inactive

`src/helpers/audioActivityDetector.js:381-384`. Cleared only by
`_startResetTimer()` (60 s, armed **only** on a mic-inactive transition — `:407`,
`:460`), `resetPrompt()`, or `_reset()`. No absolute max age.

### 3. The native listener is never restarted

`src/helpers/audioActivityDetector.js:192-210` — on `exit` it degrades to polling
once and never retries the binary. No backoff, no cap, no record. Also
`_startPolling()` (`:415-418`) does not clear an existing `checkInterval`, so
repeated fallbacks leak intervals.

### 4. The macOS polling fallback cannot work at all — **measured**

`src/helpers/audioActivityDetector.js:480-490` greps `"IOAudioEngineState" = 1`.
That key **does not exist on modern macOS/Apple Silicon** (0 occurrences,
measured above). So once defect 3 degrades to polling, detection is not
degraded — it is **off**, silently and permanently.

### 5. Sleep/wake does not touch detection

`main.js:529-541` re-warms Calendar and Whisper on resume; the detection stack is
untouched. Nothing verifies the child survived.

### 6. `activeDetections` can strand the audio key permanently

`meetingDetectionEngine.js:240-243` skips any `detectionId` already present, and
the audio key is the **constant** `audio:sustained-audio` (`:68-70`).
`_flushNotificationQueue` (`:462-489`) shows only `queue[0]` and clears the
queue, but leaves the other entries in `activeDetections`. The map is fully
cleared only on response (`:367`), timeout (`:458`), or `stop()`.

### 7. No supervision anywhere

`grep -niE "respawn|restart|watchdog|heartbeat|health"` across the three
detection modules → **zero matches**.

### 8. Consecutive calls merge — no meeting identity — **the user's second report**

Two independent mechanisms in `src/helpers/callStateDetector.js`, both keyed on
"is *a* call active" rather than "*which* meeting":

**8a — not recording.** `DEACTIVATE_DEBOUNCE_MS = 8000` (`:20`). Leaving a call
arms an 8 s deactivate timer (`:132-138`). Rejoining within 8 s clears it
(`:117-120`), so **`call-ended` never fires**; `_callActive` stays `true`, and
`_fireActive()` returns early at `:143`. The engine never learns call B began.

**8b — while recording (this is the "combined note" case).** `_endPollTick`
(`:192-224`) runs every `END_POLL_MS = 12000` and needs `END_MISS_THRESHOLD = 2`
consecutive misses (~24 s) to end. For a video call `stillInCall = this.state.camera`
(`:197`). Rejoining within ~24 s brings the camera back, `_endMisses` resets to
0, the session never ends, and **one recording spans both meetings**.

The code already knows the URL is unreliable for *ending* — `:197-199`: "Meet's
'you left' screen keeps the meeting-code URL." But that is an argument for
identity, not against it: `MEETING_URL_PATTERNS`
(`src/helpers/browserMeetingUrlChecker.js:17-24`) deliberately match a meeting
**code** (`meet.google.com/abc-defg-hij`, `zoom.us/j/<id>`, Teams `meetup-join`),
and the checker returns `{ matched, url, browser }` (`:50`, `:77`). A code that
*changes* is unambiguous proof of a different meeting, even when both states
"have a URL".

---

## Proposed fix

Four phases, each independently green and revertable. Phase 1 changes no
detection behaviour — it ships the ability to diagnose, which is what "no clear
pattern" demands.

### Phase 1 — Observability (no behaviour change)

**1a.** `debugLogger`: gate file logging on **severity**, not `debugMode`.
`warn`/`error` always persist; `debug`/`info` stay gated.
**1b.** Add rotation — there is **none** today (`:65-68` writes
`debug-<timestamp>.log` per launch, nothing prunes). Keep the 10 most recent,
cap size, prune on init. Required before turning logging on by default.
**1c.** New `src/helpers/meetingDetectionHealth.js` — a passive registry:
per-detector `mode` (`event-driven`/`polling`/`failed`), `childPid`/`childAlive`/
`restartCount`/`lastExitCode`, `lastEventAt`, `lastSuppression {reason, id, at}`,
`suppressionCounts`, current latch values, `degradedReason`.
**1d.** Record a reason at every suppression and failure path — the `return`
sites in `_handleDetection`, the `hasPrompted` suppression, listener exit,
fallback. This makes the next failure name itself.

### Phase 2 — Self-healing

**2a.** Supervise the listener: restart with backoff (1→2→4→…→60 s), cap ~5
consecutive failures, record every transition. Fix the `_startPolling` interval leak.
**2b.** Make latches self-clearing:
- `_meetingModeActive` — **primary fix is a lifecycle clear, not the watchdog.**
  Clear it where the meeting session actually ends (`meeting-transcription-stop`,
  `ipcHandlers.js:5845`), so it no longer depends on a UI button that may never
  render. Keep `try`/`catch` on the three set-then-await paths, and add the
  watchdog only as a short backstop (~10–15 min after `_userRecording` drops) —
  a multi-hour watchdog would leave detection dead for hours after every meeting.
- `hasPrompted`: absolute max age in addition to the inactivity timer.
- `activeDetections`: TTL + sweep; also clear the entries
  `_flushNotificationQueue` abandons.
**2c.** `powerMonitor` resume → revalidate detectors, restart a dead child.
**2d.** Defect 4: the macOS polling fallback is dead code. Either replace
`_checkDarwin` with a real mic signal or make the fallback declare itself
**unavailable** so 2a keeps retrying the listener instead of silently pretending
to poll. See **Open questions #2**.

### Phase 3 — Meeting identity (defect 8) — **RE-PLAN REQUIRED, do not implement as written**

Adversarial review found this phase would **silently drop the second meeting
entirely** — worse than today's merged note. Recorded here for the redesign; it
is **not** scheduled. Blocking problems:

- **C1 — the identity fix is defeated by defect 1.** `_handleCallActive` returns
  early at `:81-89` while `_meetingModeActive || _userRecording`. At an id-change
  boundary both are still true, and `call-ended` only *broadcasts*
  `meeting-auto-stop-request` (`:145`) — teardown is asynchronous through the
  renderer. The immediately-following `call-active` is dropped, and it is
  **edge-triggered**: the detector latches `_callActive = true` for the new id and
  never re-fires. Meeting B gets no note at all. A correct design needs an
  engine-owned **stop → await confirmation → clear latch → start** handoff, and
  must sequence the renderer teardown (`stopRecording` leaves `recordingNoteId`
  set; the final transcript is persisted by an effect, so an unsequenced restart
  can misfile the tail of recording A).
- **C2 — the id check has nowhere to run.** `urlChecker` is invoked at only two
  sites: `_fireActive` (`:148`) and the **non-camera** branch of `_endPollTick`
  (`:200-208`). Defect 8b's video-call case takes the camera branch and never
  checks the URL; defect 8a skips `_fireActive` entirely. Adding polling means
  osascript across up to 5 browsers with a 4 s timeout each — worst case ~20 s,
  longer than `END_POLL_MS`, and `_endPollTick` has no reentrancy guard.
- **I4 — scope.** `callStateDetector` only runs when `autoStartRecording` is on
  (`:543-544`, `:556`), and `_handleCallEnded` acts only when
  `_autoStarted && _userRecording` (`:143`). Identity therefore helps **only
  opt-in auto-start users**; the manual test must say so.

**Encouraging:** fixing defect 1 (the lifecycle clear) removes the `_meetingModeActive`
half of symptom 2 on its own. Re-measure symptom 2 after Phases 1–2 before
designing identity — it may be substantially resolved, and any residual will be
easier to characterise with telemetry in place.

Original sketch, retained for the redesign:

Introduce a derived, stable **meeting id**:

- `meetingIdentity.js`: `deriveMeetingId(url)` → normalized id per provider
  (Meet code, Zoom meeting id, Teams meeting id), reusing
  `MEETING_URL_PATTERNS`. Pure function, trivially unit-testable.
- `CallStateDetector` tracks `_currentMeetingId`. When a URL check yields an id
  **different** from the current one while a call is considered active, treat it
  as an **end + start boundary**: emit `call-ended`, then `call-active` for the
  new id — bypassing both the 8 s debounce (8a) and the end-poll miss threshold (8b).
- `MeetingDetectionEngine` carries the id on the session so a new id starts a new
  note rather than extending the current one.

Identity is **corroborating, never sole** authority: when no URL is available
(Automation denied, native app rather than browser) behaviour is exactly as
today. This matters — the existing code already trusts the device signal when the
URL check can't run (`meetingDetectionEngine.js:110-116`), and that must not regress.

### Phase 4 — UX surface

**4a.** IPC `get-meeting-detection-health` + preload + `electron.ts` types.
**4b.** Settings → Meetings status row: **Healthy / Degraded / Unavailable**,
with reason and an **Open logs** button, reusing the existing `open-logs-folder`
IPC (`ipcHandlers.js:6461`, `preload.js:544`).
**4c.** A one-time notice when detection becomes unable to check, following the
existing `MicPermissionWarning.tsx` pattern.
**4d.** i18n keys in **all 10 locales** (mandatory; this repo has shipped a raw
key to users before — `meetingHotkey.clear`).

---

## Test plan

Baseline to preserve: **570 tests / 565 pass / 0 fail / 5 skipped**
(`npm rebuild better-sqlite3` first — ABI toggle). New tests are `node --test`
under `test/helpers/`.

Phase 1
- [ ] `warn`/`error` persist at default `info`; `debug` does not
- [ ] Rotation keeps N, prunes oldest, never throws on a missing dir
- [ ] Health registry records mode, restart count, suppression reason/counts

Phase 2 — each is **red against current code**
- [ ] `_handleCallActive` with a rejecting `queueMeetingNoteNavigation` leaves
      `_meetingModeActive === false` (regression test for defect 1)
- [ ] Same for `startManualMeeting` and `joinCalendarMeeting`
- [ ] Watchdog clears a `_meetingModeActive` stuck with no active recording
- [ ] `hasPrompted` clears after absolute max age with no inactive transition
- [ ] Stranded `audio:sustained-audio` is swept; detection resumes
- [ ] Listener `exit` → restart attempted, backoff grows, capped; health updated
- [ ] `_startPolling` twice does not leak a second interval
- [ ] Resume revalidates and restarts a dead child

Phase 3
- [ ] `deriveMeetingId` extracts stable ids for Meet / Zoom / Teams; returns null
      for landing pages; is stable across the same meeting's URL variations
- [ ] Rejoining a **different** Meet id within the 8 s debounce emits
      `call-ended` then `call-active` (defect 8a)
- [ ] While recording, a changed id ends the session before
      `END_MISS_THRESHOLD` (defect 8b) → two notes, not one
- [ ] The **same** id flapping does **not** split a session
- [ ] No URL available ⇒ behaviour identical to today (no regression)

Phase 4
- [ ] Health IPC shape; preload typed
- [ ] Status row renders each state
- [ ] Every new string resolves in all 10 locales (no raw keys)

Manual
- [ ] `kill` the listener by hand → restart in logs → health returns healthy
- [ ] Sleep/wake → detection still fires
- [ ] Leave a Meet call, join another within ~5 s → **two** notes

---

## Alternatives rejected

- **UX warning only.** Would report a state nothing maintains; without a health
  record it can only say "unknown".
- **Restart the child only.** Does not address 1, 2, 6, 8 — each alone is
  sufficient, which fits "no clear pattern".
- **Lower the debounce/threshold constants for defect 8.** Shortening
  `DEACTIVATE_DEBOUNCE_MS`/`END_MISS_THRESHOLD` would split calls faster but also
  re-break what they exist for (device flaps mid-call). Identity separates "the
  signal blipped" from "this is a different meeting" without that trade-off.
- **Move detection to a utility process** (as `onnxWorker` does). Real isolation,
  large refactor of a subsystem we cannot yet observe. Revisit if telemetry says
  the in-process design is the problem.

---

## Open questions

1. **Still no live reproduction of symptom 1.** The measurements narrowed it
   (child alive 5 days ⇒ latches, not child death) but did not catch it in the
   act. Phase 2's tests are genuinely red against current code, which is real
   evidence, but not proof this is the failure the user hit. **Should Phase 1
   ship alone first** so the next real failure is captured, or all phases
   together? Defect 8, by contrast, is fully explained by code and needs no
   further evidence.
2. **Defect 4 — replace or disable?** I know the current check is dead
   (measured), but I do **not** yet know a reliable mic-only signal on modern
   macOS that needs no extra permission. Options: (a) find a real signal,
   (b) mark the fallback `unavailable` and lean on listener restart, (c) leave
   it. Leaning **(b)** — honest about capability, and it makes 2a the recovery
   path rather than pretending to poll.
3. **Watchdog bound for `_meetingModeActive`.** `MAX_AUTO_RECORD_MS` is already
   4 h (`meetingDetectionEngine.js:6`). Reuse it, or shorter given the watchdog
   also requires no active recording?
4. **Telemetry stays local.** Assuming **no** remote reporting — this fork is
   explicitly no-phone-home (README). Health is local-only: Settings + log file.
   Confirm.
5. **Version bump.** New UX surface ⇒ user-visible ⇒ **minor**, 1.13.2 → 1.14.0.
6. **Scope.** Phases 1–4 are a lot for one branch. Split into two PRs
   (1+2 resilience/telemetry, 3+4 identity/UX), or land as one?

---

## Review outcomes (adversarial review, 2026-08-10)

Verdict: **re-plan Phase 3; implement Phases 1, 2, 4 with specific changes.**
Every finding below was independently re-verified before acceptance.

| # | Finding | Resolution |
|---|---|---|
| C1 | Phase 3's end→start boundary is defeated by defect 1's latch and by `call-active` being edge-triggered ⇒ meeting B gets **no** note | Phase 3 **unscheduled**; redesign needs an engine-owned stop→confirm→start handoff. Verified `:81-89`, `:145` |
| C2 | The id check has no place to run — camera branch never consults the URL; osascript across 5 browsers is too slow for a 12 s poll | Folded into the Phase 3 redesign as a required, costed design decision |
| C3 | **Root cause of symptom 1**: `meeting-transcription-stop` clears only `_userRecording`; the sole `_meetingModeActive` clear is the "Back to notes" button, gated on `isSidePanelLayout` | Promoted to defect 1. Verified `ipcHandlers.js:5845-5846`, `ControlPanel.tsx:385/742/750`. Primary fix is now a lifecycle clear; watchdog demoted to a short backstop |
| I4 | Identity helps only opt-in auto-start users | Scoped explicitly in Phase 3 |
| I5 | `macos-call-detector` also has no restart (`callStateDetector.js:70-77`) and its state isn't reset; `automationDenied` is a process-lifetime latch | Added to Phase 2a: supervise **both** children, reset state on death; make `automationDenied` re-checkable |
| I6 | Phase 1a would crash tests — under plain `node`, `require("electron")` is a **string** and `app` is `undefined` (verified), making `debugLogger.js:54` reachable | Guard with `app?.isReady?.()` |
| I7 | Real flood path: `deepgramStreaming.js:731-739` warns per audio chunk (~30/s) when `ws` is null; renderer logs forward to the same file | **1a and 1b must ship in the same commit**; add per-site throttling |
| M8 | The `_startPolling` interval leak is not currently reachable | Keep as defensive; claim softened |
| M9 | Watchdog cannot double-record — `_meetingModeActive`'s only consumers are three suppression gates | Confirmed safe as a backstop |
| M10 | `browserMeetingUrlChecker.js:71-74` splits osascript output on `,` | `deriveMeetingId` must tolerate truncated tails |

Also confirmed by the review: all measurements reproduced independently; no
existing tests cover the four detection modules, so nothing breaks; **10** locale
dirs exist (CLAUDE.md's "9 languages" omits `ja`).

## Unverified claims to flag

- The claim that defect 1 is *the* cause of the user's symptom 1 remains
  **unproven**. It is the best-supported hypothesis after the uptime
  measurement, not a confirmed diagnosis.
- Defect 8's mechanism is read from code and fully consistent with the reported
  behaviour, but I have not reproduced a merged note.
- `deriveMeetingId` for Zoom/Teams is designed from the existing regexes only; I
  have not validated against real Zoom/Teams URLs in the wild. Meet is the
  reported case and the best understood.
