# Manual Meeting Transcription Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Steps use checkboxes for tracking. This document authorizes no implementation, commits, pushes, deployments, or new branches.

**Goal:** Let workspace admins prevent automatic meeting transcription while members can still join meetings, open and edit notes, and explicitly start recording.

**Architecture:** Add `meetings.transcriptionStart` to the canonical API policy and console mirror. Enforce automatic-start eligibility in the desktop at each automatic entry point, preserving explicit recording actions and existing recording restrictions. Give meeting notes opened without recording a bounded detection lifecycle that does not restore the window layout.

**Tech stack:** TypeScript, Zod 3 on API/admin, React, Zustand, Electron main/preload/renderer IPC, Node test runner, and existing Playwright admin tests.

**Spec:** [API #257](https://github.com/OpenWhispr/openwhispr-api/issues/257), [Admin #23](https://github.com/OpenWhispr/openwhispr-admin/issues/23), [Desktop #2636](https://github.com/OpenWhispr/openwhispr/issues/2636). The desktop issue's explicit 2026-10-30 **no desktop UI changes** decision takes precedence over the older comments requesting a hint and different labels. The user confirmed there is no additional product scope.

## Verified starting point

Inspected on 2026-11-02. These local source revisions match GitHub `main` at verification time:

| Repository | Commit                                     | Source                                                                                                                                                           |
| ---------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API        | `11121f11a82388f990543347eb7b6223ecdeb8e2` | [Canonical schema](https://github.com/OpenWhispr/openwhispr-api/blob/11121f11a82388f990543347eb7b6223ecdeb8e2/lib/policy-schema.ts)                              |
| Admin      | `b06de60423e8508a874bbcd3969cd9b5a2dbc7f1` | [Policy cards](https://github.com/OpenWhispr/openwhispr-admin/blob/b06de60423e8508a874bbcd3969cd9b5a2dbc7f1/components/console/policy/provider-policy-cards.tsx) |
| Desktop    | `7155b905dddd593e4577cf254eefb64ec7cc55d0` | [Meeting detection engine](https://github.com/OpenWhispr/openwhispr/blob/7155b905dddd593e4577cf254eefb64ec7cc55d0/src/helpers/meetingDetectionEngine.js)         |

API/admin were inspected from clean exports of their `origin/main` revisions because their existing working checkouts contain other work. The desktop checkout is detached at the revision above. Before implementation, use the intended existing branch in each repository; the user must identify it if it is not already established. Do not create a branch or worktree implicitly.

### Findings that change or sharpen the issue specs

1. **The four automatic routes still exist.** `useCreateNote.ts` records after `saveNote`; `ControlPanel.tsx` records after confirmed notification navigation; calendar joins and existing-event-note resumes go through `PersonalNotesView.tsx`. ControlPanel still drops `trigger` when creating `meetingRecordingRequest`. Manual hotkey, tray and pill commands arrive as `"hotkey"`.
2. **Navigation is asynchronous.** Notification navigation loads the editor/tree/container and confirms the live note before recording. Checking only the policy captured when navigation began would permit a stale automatic start. New-note creation has the same issue across `await saveNote`.
3. **The recording store also has asynchronous startup.** `startRecording` waits for the previous stop and checks `isCurrentStart` before capture operations. Automatic intent needs to survive into this startup boundary if a policy change during preparation is to prevent capture. Once capture is running, changing this setting must not stop it.
4. **The engine still assumes opening a meeting note leads to recording.** `_meetingModeActive` suppresses detection; recording teardown normally clears it. `restoreFromMeetingMode` also changes window layout and therefore is the wrong cleanup for a policy-suppressed automatic start. Calendar notification navigation does not currently carry its event in the same way as the calendar-join path.
5. **The API has evolved.** Policy PUT now uses `policySaveSchema`, and preserves omitted audio-feature fields through `withStoredAudioFeatures`. Realtime routes now receive/infer audio purposes and enforce meeting/upload restrictions. They still cannot establish whether a meeting was started automatically. No token-route enforcement or `policyForClient` implementation change is needed for this feature.
6. **Recommended correction to “no route changes.”** Extend the policy PUT compatibility merge to preserve a stored `meetings.transcriptionStart` when an older writer omits it. Otherwise the new default can silently turn a saved `manual` restriction back to `automatic`. This is a narrow write-compatibility change, not a new endpoint or server-side automatic-start enforcement. Task 2 makes the deviation explicit for review.
7. **Some requested cleanup is already done.** The desktop `memoryEnabled` comment already correctly describes retirement; leave it alone. Admin `main` has Playwright tests and a `test:e2e` script, but no unit-test script. Reuse that harness instead of proposing a new test framework.
8. **The release version is not yet determined.** The inspected desktop package says `1.11.0`, but does not implement this setting. Do not use that number as proof of support. The console's warning must name the first public release containing the completed desktop work.

## Global constraints

- Accepted write values: exactly `"automatic"` and `"manual"`; default `"automatic"` at both the `meetings` and `transcriptionStart` levels. Keep policy version `1`.
- Strictest workspace wins: one `manual` workspace makes the resolved policy manual, regardless of the active workspace.
- No desktop labels, banners, settings copy or translation changes. Detection preferences, dictation, upload and recording auto-end retain their existing behavior.
- Explicit Record, empty-transcript Start recording, and hotkey/tray/pill Start meeting recording remain available **subject to existing** feature, provider, auth and minimum-version restrictions. Manual-only must never override `features.meetingRecordingEnabled: false`.
- Existing recordings continue when this setting changes. Switching to automatic does not replay a previously suppressed request or start an open note.
- Mobile has explicit meeting-start actions in `openwhispr-mobile/src/screens/MeetingRecordScreen.tsx`; no mobile implementation is required for automatic-start suppression.
- Reuse existing components and test infrastructure. No new dependencies, database migration, `.env` changes, or speculative policy framework.
- Use Node 24 for desktop validation. Follow each repository's existing formatting and explicit TypeScript return types for new functions; do not introduce `any`.
- No commits or pushes unless separately authorized. The tasks below are reviewable units, not instructions to commit.

## Review focus

These cases must be covered by the owning tasks, not left to final manual testing:

- Stored policies and older writers omit the new block; reading defaults safely, while editing another setting must not lift an existing restriction. Tasks 1–2.
- Policy/auth changes while a note saves, a navigation confirms, or capture prepares; no stale automatic start and no replay when policy later allows it. Tasks 3–4.
- A reused event note retains manual hotkey intent; missing or unknown triggers never gain a manual exception. Task 4.
- A delayed note-close or event-end callback belongs to an older meeting; it cannot release a newer note session or disturb a live recording. Task 5.
- Separate console cards, stale admin tabs, failed saves and workspace changes; saved policy and dirty state stay consistent. Task 6.

## Behavior contract

| Entry or state                                                 | Automatic policy             | Manual policy                                             |
| -------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------- |
| New note                                                       | Existing auto-start behavior | Save and open note, no capture                            |
| Prompt Take notes / Join and transcribe                        | Existing auto-start behavior | Open selected note and preserve join behavior, no capture |
| Calendar join or rejoin                                        | Existing auto-start behavior | Open/reuse event note, no capture                         |
| Record / empty-transcript Start recording                      | Existing recording checks    | Same checks; manual-only adds no denial                   |
| Hotkey / tray / pill, with or without an active calendar event | Existing recording checks    | Same checks; preserve `hotkey` through reuse/navigation   |
| Policy changes during an established recording                 | Continue recording           | Continue recording                                        |
| Previously suppressed request, then policy becomes automatic   | No replay                    | No replay                                                 |

`isMeetingAutoTranscriptionAllowed(state, isSignedIn)` is deliberately narrower than permission to record:

| Policy snapshot                                                          | Result  |
| ------------------------------------------------------------------------ | ------- |
| `unmanaged`                                                              | `true`  |
| `idle`, signed out                                                       | `true`  |
| `idle`, signed in                                                        | `false` |
| `loading` or `error`                                                     | `false` |
| `managed` with missing policy                                            | `false` |
| Below minimum version, or version unavailable when a minimum is required | `false` |
| Managed, no block / empty block / explicit `automatic`                   | `true`  |
| Managed, `manual` or unknown string value                                | `false` |

Auth still loading is not evidence that a user is signed out: the hook/callers should require auth to have settled before allowing an automatic action. Use `useAuth().isLoaded` and `isSignedIn`, including the current offline-account behavior; do not substitute the legacy settings-store sign-in flag.

## Task 1 API schema and desktop compatibility contract

For each implementation task, run the new focused tests before changing production code and confirm they fail for the missing behavior, not missing dependencies. Then implement and rerun them. Broader verification belongs at the completed repository-change boundary; do not rerun an unchanged full suite after every small step.

**Files in openwhispr-api**

- Modify `lib/policy-schema.ts`.
- Extend `lib/__tests__/policy-schema.test.ts`, `lib/__tests__/policy.test.ts`, `lib/__tests__/policy-desktop-contract.test.ts`, and `lib/__tests__/policy-client-compat.test.ts`.
- Inspect `lib/policy.ts`; its existing strict-read flow should need no production change.

**Produces:** exported `MEETING_TRANSCRIPTION_START_MODES`, `MeetingTranscriptionStart`, and `Policy.meetings: { transcriptionStart: MeetingTranscriptionStart }`; existing `resolvePolicies(policies: Policy[]): Policy` returns the strictest start mode.

- [ ] Add failing schema cases: an absent block and `{}` parse to `{ transcriptionStart: "automatic" }`; both enum values round-trip; `null`, arrays, nonobjects, nonstring values and unsupported strings fail writes. Cover both `policyWriteSchema` and the actual PUT schema, `policySaveSchema`.
- [ ] Add resolver cases for zero, one and multiple workspaces, both input orders, all automatic and mixed manual/automatic. Insert a pre-field row into the existing policy test harness and assert strict resolution remains managed with the automatic default, rather than `POLICY_UNRESOLVABLE`.
- [ ] Add the enum/type, doubly defaulted block, `DEFAULT_POLICY.meetings`, and the strictest merge in `lib/policy-schema.ts`. No version bump or data backfill.
- [ ] Update the ported desktop validator and its last-synced note. Keep an explicitly named pre-feature validator fixture so the test independently proves that an older desktop accepts an emitted `meetings` block. The updated validator accepts unknown strings but rejects invalid shapes. Test `policyForClient` preserves the block while continuing its existing provider filtering.
- [ ] Run the focused policy tests using the repository's test environment, then `npm test` and `npm run build`. Expected: all existing tests plus the new parsing, strict-read and compatibility cases pass.

## Task 2 Preserve restrictions across older policy writers

**Recommended spec correction:** API #257 currently says no route changes. Include this small compatibility fix with the schema change so omission cannot relax a previously saved restriction.

**Files in openwhispr-api**

- Modify `api/workspaces/[id]/policy.ts`.
- Extend `lib/__tests__/workspace-policy-put-audio.test.ts`, which already exercises omitted fields, persistence, concurrency and audit metadata.

**Consumes:** the canonical field from Task 1. **Produces:** unchanged PUT/GET API shapes and optimistic concurrency, with safe omitted-field handling.

- [ ] Add failing route tests: save `manual`, submit a current-revision document without `meetings`, and verify the stored/read-back value remains `manual`; repeat with `meetings: {}`. Explicit `automatic` must reset it. Creating a policy with no prior row still defaults to automatic.
- [ ] Test invalid explicit values remain validation errors, stale `updated_at` returns `409` without changing policy, and unrelated feature flags retain their values.
- [ ] Extend the existing pre-parse preservation helper, naming it `withStoredPolicyControls(stored: Policy | null | undefined, body: unknown): unknown`. Carry forward only omitted fields; do not replace malformed explicit input with a valid stored value. Preserve the existing audio-feature behavior and compare-and-write boundary.
- [ ] Add `meetings.transcriptionStart` to the existing before/after policy audit metadata. Test a real change records the string values and an unrelated save does not invent a start-mode change.
- [ ] Run the route regression file with the standard test environment, followed by `npm test` and `npm run build`. No token route, enforcement-floor or `policyForClient` production change is part of this task.

## Task 3 Desktop policy types and eligibility rule

**Files in openwhispr**

- Modify `src/types/policy.ts`, `src/helpers/policyValidation.js`, `src/stores/policyRules.ts`, `src/hooks/usePolicy.ts`.
- Extend `test/helpers/policyValidation.test.js` and `test/helpers/policyRules.test.js`.
- Create `test/hooks/meetingAutoTranscriptionPolicy.test.js` using the existing renderer test harness for auth-aware hook behavior.

**Produces:** `isMeetingAutoTranscriptionAllowed(state: PolicyDecisionSnapshot, isSignedIn: boolean): boolean` and `useMeetingAutoTranscriptionAllowed(): boolean`.

- [ ] Add failing tests for every row of the eligibility table, including a malformed managed snapshot, missing app version with a required floor, empty meetings block and an unknown future mode.
- [ ] Add shape tests accepting absence, `{}`, automatic, manual and unknown strings; reject `null`, arrays, primitives and nonstring `transcriptionStart` values.
- [ ] Add optional `meetings?: { transcriptionStart?: string }` to `OrgPolicy` and shape-only validation. Reuse `isPolicyActionAllowed` and the current minimum-version comparison in the new pure rule.
- [ ] Implement the hook with `usePolicySnapshot` and settled auth from `useAuth`. Return false while auth is unresolved; once settled, apply the rule. Test signed-out, signed-in-idle, and offline managed-account hydration without treating a temporary lack of a validated session as guest consent.
- [ ] Run `node --import tsx --test test/helpers/policyRules.test.js test/helpers/policyValidation.test.js test/hooks/meetingAutoTranscriptionPolicy.test.js`. Expected: the table and shape contract pass without changing other policy rules.

## Task 4 Gate automatic starts and retain explicit intent

**Files in openwhispr**

- Modify `src/hooks/useCreateNote.ts`, `src/components/ControlPanel.tsx`, `src/components/notes/PersonalNotesView.tsx`, `src/helpers/meetingRecordingRequest.ts`, `src/stores/meetingRecordingStore.ts`.
- Update `src/types/electron.ts` for shared request types where needed; retain existing IPC compatibility.
- Extend `test/helpers/meetingPolicyStartRecovery.test.js`, `test/components/meetingNotificationDestinationNavigation.test.js`, `test/stores/meetingRecordingStoreStartupAudio.test.js`.
- Create `test/hooks/useCreateNotePolicy.test.js` and `test/components/meetingAutoTranscription.test.js` for actual hook/component behavior, using `test/lib/rendererTestHarness.js`.

**Consumes:** Task 3's rule/hook and Task 5's note-only lifecycle bridge. **Produces:** each request is classified once as automatic or explicit; suppression consumes the request without changing navigation or layout.

- [ ] Add failing behavior tests for all four automatic paths, asserting zero recording/capture calls under manual policy while notes are saved, selected and editable. Test normal automatic behavior as the control case.
- [ ] Carry `trigger` from `getPendingMeetingNoteNavigation` into the ControlPanel request and PersonalNotesView prop. Preserve the existing union `"hotkey" | "manual" | "calendar-join"`; **only `"hotkey"` grants the explicit-start exception**. Missing, `"manual"` legacy metadata, and unrecognized triggers receive automatic checks. Do not infer intent from note type or calendar presence.
- [ ] Gate New note after `saveNote`, and notification start inside the callback after `navigateMeetingNotification` has confirmed and opened the note. Use the live policy store and latest settled auth, not a boolean captured before the await. Keep confirmed note/folder ownership checks intact.
- [ ] In the calendar/rejoin request handler, consume a denied automatic request exactly once, preserve the open note and notify Task 5's lifecycle bridge. Do not call `restoreFromMeetingMode` for this suppression. Keep the existing restoration behavior for ordinary recording refusal. Preserve request identity across rerenders/StrictMode so a subsequent policy refresh cannot replay it.
- [ ] Preserve manual Record and Start recording call sites. Test hotkey/tray/pill with and without a calendar event, including an existing event note. Verify manual-only permits the start but meeting-recording-disabled and provider/minimum-version restrictions still refuse it.
- [ ] Close the preparation race with an optional `canAutoStart?: () => boolean` on `StartRecordingArgs`, passed only by automatic callers. Add the same optional third parameter to `startRecordingForNote(note, recorderName?, canAutoStart?)`. Its callback reads current policy/auth. Check before starting and after pending-stop/preparation waits, before the first capture begins. Latch the automatic-start decision when the first capture is initiated; do not use later start-mode changes to stop established capture or disrupt audio recovery. Existing recording permission checks remain active as they are today.
- [ ] A start suppressed at that final boundary returns `false` without a policy-error toast. The automatic caller distinguishes this from ordinary refusal by re-reading automatic eligibility, registers the note-only lifecycle and leaves layout alone. Test this path with controlled promises, plus a manual start with no callback and an already-live recording during a policy change.
- [ ] Test policy changes during save/navigation/preparation, sign-in/account transitions, and manual→automatic after suppression. Assert no deferred capture or transcription preparation is triggered by policy refresh alone.
- [ ] Run the affected hook/component/store tests with Node 24 and the existing harness. Expected: automatic calls are suppressed at both the action and capture boundaries; manual and existing-refusal regression cases pass.

## Task 5 End note-only meeting mode without changing layout

**Files in openwhispr**

- Modify `src/helpers/meetingDetectionEngine.js`, `src/helpers/windowManager.js`, `src/helpers/ipcHandlers.js`, `preload.js`, `src/types/electron.ts`, and `src/components/ControlPanel.tsx`.
- Extend `test/helpers/meetingDetectionEngine.test.js`, `test/helpers/meetingDetectionEngineAutoEnd.test.js`, `test/helpers/meetingPolicyStartRecovery.test.js`.
- Create `test/helpers/meetingNoteOnlyLifecycle.test.js` for session-scoped cleanup and IPC ownership tests.

**Produces:** a small main-owned note-session record and renderer bridge. Keep this separate from window snapping and the actual audio recording session.

> **Changed in review (2026-11-03):** holding `_meetingModeActive` until note close or event end silently dropped later prompts, indefinitely for a note with no calendar event. A note-only session now releases it as soon as the note opens without recording, with no deadline timer. Until the event ends, only that event's reminder and the first mic detection after joining stay quiet. The steps below describe the original design.

- [ ] Add failing tests showing a second meeting prompts after leaving a nonrecording meeting note and after its real calendar event ends, without calling window restoration. Add a note opened by microphone detection with no calendar event; leaving that note must release its hold.
- [ ] At each meeting-note navigation, assign an opaque `noteSessionId` and keep its `noteId` and real calendar end time in the engine. Thread the optional ID through notification, calendar and reused-note payloads; normal New note needs no engine session. Retain the event metadata in main even where the current notification payload has no `event`.
- [ ] Add preload methods `meetingNoteOpenedWithoutRecording(noteSessionId: string): Promise<void>` and `meetingNoteClosed(noteSessionId: string): Promise<void>`, backed by IPC handlers that accept only the owning control-panel sender and matching current session. Suppression marks this session as note-only; closing releases only that session. Unknown/stale IDs are no-ops. Failed/cancelled navigation must release its own pending session as well, even if no renderer ever acknowledges suppression.
- [ ] In ControlPanel, release the note-only session when its active note is closed/replaced or the user leaves the note view. Release it on renderer/window teardown in main too. Merely hiding/minimizing a window is not a note close. Delayed effects from one session must not clear a newer session.
- [ ] For a real calendar event, schedule a session-scoped deadline from its end time; handle already-ended events and clear the timer when the session is superseded or the engine stops. Do not rely solely on the reminder scheduler's one active-event timer, because direct calendar joins need the same behavior. No fabricated one-hour expiration for microphone-only notes.
- [ ] When actual recording takes ownership, cancel the note-only deadline/ownership. Cleanup must not clear `_meetingModeActive` for a live recording. For a completed note-only session, use the engine's flag/reset and queue machinery without `restoreFromMeetingMode`, without adding a dismissal cooldown, and without reissuing the same prompt.
- [ ] Run fake-timer tests for note close, calendar end, out-of-order close/end messages, manual recording after opening the note, a newer meeting replacing the old one, engine shutdown, and a queued second meeting. Run existing auto-end tests to prove actual recording teardown remains unchanged.

Tasks 4 and 5 should ship together in the desktop change: suppressing starts without completing the note lifecycle is incomplete.

## Task 6 Admin schema and meeting transcription card

**Files in openwhispr-admin**

- Modify `lib/policy-schema.ts`, `app/(console)/policies/providers/page.tsx`, and `components/console/policy/enforcement-disclosure.tsx`.
- Create `components/console/policy/meeting-transcription-policy-card.tsx` and `e2e/meeting-transcription-policy.spec.ts`.
- Reuse `lib/hooks/use-policy-section.ts`, `lib/hooks/use-policy.ts`, `lib/semver.ts`, `components/console/policy/policy-card.tsx`, and `components/ui/radio-group.tsx`.

**Consumes:** API `Policy.meetings` and the first public enforcing desktop version. **Produces:** `MeetingTranscriptionPolicyCard({ workspaceId }: { workspaceId: string }): React.JSX.Element`.

- [ ] Add Playwright cases using the existing mocked API/auth pattern in `e2e/audio-feature-controls.spec.ts`. Missing `meetings` and `{}` render automatic and clean; changing to manual makes only this card dirty; cancel resets; save/reload round-trips; failures retain the draft; workspace changes reset to that workspace's saved value.
- [ ] Mirror the API enum/type and doubly defaulted schema/default policy. Do not introduce the API's server resolver or copy unrelated schema differences into this change.
- [ ] Build the card with `usePolicySection`, selector `policy.meetings?.transcriptionStart ?? "automatic"`, and apply function `{ ...base, meetings: { ...base.meetings, transcriptionStart: value } }`. Use `guardKey="meetings"`; preserve other sections and additive fields. Insert it immediately after `TranscriptionPolicyCard`.
- [ ] Use the issue's exact copy:
  - Title: **Meeting transcription**
  - Description: “Choose whether OpenWhispr can start transcribing a meeting on its own.”
  - **Start automatically (default)**: “Transcription starts when a member takes notes from a meeting prompt, joins a meeting from their calendar in OpenWhispr, or creates a new note.”
  - **Members start it manually**: “Members can still open meeting notes, join meetings and write notes. Transcription only begins when they press Record in that note or choose Start meeting recording.”
  - Label: **App-enforced**
- [ ] Define `MEETING_TRANSCRIPTION_START_MIN_VERSION` in the console schema module once the release version is assigned. Render the amber warning when the **draft** is manual and the **saved** `minAppVersion` is unset or below that version, using `compareSemver`. Copy: “Requires OpenWhispr {version} or later. Older versions ignore this setting and keep starting transcription automatically. Set Minimum app version to {version} to make it effective.” Never ship a placeholder or infer support from the existing audio-feature constant.
- [ ] Keep the floor warning advisory, as specified. Do not automatically raise the minimum or add a server save-time requirement for this field. An unsaved Minimum app version draft must not hide the warning; saving an adequate floor must hide it immediately.
- [ ] Add “how meeting transcription starts” to the App-enforced disclosure, phrased so it applies to Cloud meetings too. Do not imply that all audio settings are only app-enforced; existing Cloud meeting/upload restrictions remain server-enforced.
- [ ] Test warning cases: automatic with any floor, manual with missing/lower/equal/higher floor, and saved floor changes. Test saving every sibling card leaves manual intact, saving this card leaves sibling drafts unsaved, and stale `updated_at` returns a visible conflict without an overwrite. Confirm keyboard radio behavior and save/cancel controls.
- [ ] Run `npm run test:e2e -- e2e/meeting-transcription-policy.spec.ts`, then `npm run test:e2e`, `npm run check:full`, and `npm run build`. Expected: new and existing policy flows pass. No new test dependency is required.

## Task 7 Integration and release acceptance

- [ ] **Deploy API first.** Confirm old policy rows resolve, an admin save persists manual, and `/api/workspace-policy` returns manual to a member of any restricted workspace. Use a test account in two workspaces to verify strictest wins. Confirm current older desktop validators accept the expanded document.
- [ ] **Complete desktop validation.** Run affected tests, `npm test`, `npm run typecheck`, and `npm run lint` on Node 24 with the normal dependencies available. A helper-only pass is not sufficient for capture or IPC behavior.
- [ ] **Package and exercise the desktop.** On macOS, Windows and Linux, test the entry-point table with a managed workspace. Observe OS mic/system-audio indicators and the app's capture/provider calls: no meeting capture before explicit Record under manual. With other dictation or warm-hold activity present, assert the new meeting adds no capture/stream rather than interpreting an already-lit OS indicator as failure.
- [ ] Cover at least Cloud and local/BYOK paths, plus an enterprise realtime configuration when available. Check note content/editing, event reuse, join-link opening, hotkey/tray/pill, auth loading/error/offline cached policy, policy flips, second-meeting prompts and unchanged auto-end. Existing feature-off policy still blocks all starts.
- [ ] **Publish the enforcing desktop release.** Record its actual stable version. This is the release dependency for the console constant and warning, not a reason to hold the additive API change.
- [ ] **Deploy the console after that release is public.** Save manual with the enforcing minimum version in a test workspace and verify the emitted policy and packaged desktop behavior end to end. Also verify an older build requires upgrade under the minimum-version gate; do not claim that manual alone constrains older builds.
- [ ] Record a short acceptance checklist with API revision, desktop version/platforms, console revision, provider modes tested and test results. Only then mark all three issues complete.

### Rollback and compatibility

An API-only deployment is behavior-preserving because the new field defaults to automatic. A new desktop against an older API retains automatic behavior once policy resolves. An older desktop ignores the new field, so admins need the minimum version. Policy refresh remains subject to the existing fetch/cache lifecycle; this feature does not add instant cross-device delivery.

After manual policies exist, keep the additive API schema on rollback. Rolling it back to a parser that strips the field can erase the restriction on subsequent saves. If the console needs rollback, leave the API and compatible desktop in place. If a desktop release must be rolled back below the required version, affected members remain blocked until a compatible build is available or the admin explicitly changes the floor; do not silently relax their policy.

## Verification performed for this plan

Read the live issues and comments and traced the code at the three pinned `main` revisions. Confirmed test harnesses and script names directly in each repository. No application code or dependencies were changed.

Ran with Node 24.16.0:

```text
node --test --test-reporter=spec \
  test/helpers/policyValidation.test.js \
  test/helpers/meetingDetectionEngine.test.js \
  test/helpers/meetingDetectionEngineAutoEnd.test.js
```

Result: **62 passed, 7 failed to load the required `better-sqlite3` dependency** in database-backed notification tests. This is an incomplete baseline, not a demonstrated application regression. Those seven tests and the renderer/API/admin suites must be run in a prepared implementation checkout. No dependencies were installed for this planning task.

## Implementation record — 2026-11-02

The user subsequently authorized implementation on `feat/manual-meeting-transcription` in all three repositories, using this desktop checkout and separate API/admin worktrees. The selected first enforcing desktop release is **1.11.1**. No release, commit, push or deployment is part of this implementation.

Tasks 1–6 are implemented. The API defaults and resolves the new mode, preserves restrictions omitted by older writers, and audits changes. Desktop automatic callers check settled auth and current policy, including immediately before the first display, native or microphone capture begins. Explicit starts retain their existing checks. Main-owned note sessions release detection without restoring layout. The console uses the existing per-card save flow and warns against the saved minimum version.

One independent review identified four defects, each reproduced by a failing regression and fixed:

- Preparation can finish after automatic consent changes: the shared latch now sits at actual capture initiation.
- A pristine admin draft can become stale on external refresh: it now follows saved changes while retaining genuine edits.
- Closing a note-only meeting can repeat the same live-call prompt: the detector retains that call's prompt identity until natural rearming.
- Delayed suppression IPC can leave a request available after a view remount: suppression consumes the parent request before awaiting IPC.

The cross-repository contract was checked using the actual API resolver, console schema and desktop validator/rule. Both workspace orders resolve manual, survive console parsing, and suppress automatic desktop starts; automatic defaults remain allowed.

Implementation decisions and verification constraints:

- Preserve omitted meeting restrictions on API PUT, despite the issue's original “no route changes” wording. Otherwise older writers could silently lift a saved restriction.
- Reuse existing lifecycle test harnesses instead of duplicating their setup in a separate file. Relevant coverage is spread across the engine, IPC, window and renderer tests.
- Retain the capture decision after the first actual capture begins. Changing start mode does not end a recording already underway.
- Preserve the ongoing external call's prompt identity for note-only cleanup; normal recording teardown retains its existing reset behavior.
- Reuse installed dependencies without installing packages or modifying `.env` files. Electron's installed Node runtime provides the compatible SQLite ABI for feature tests.
- Use temporary test/build options for this machine's shared dependency symlinks: a separate browser-test port, installed Chrome, Webpack, and Vite's runner config loader. Normal CI must still exercise its standard dependency checkout and bundled browser.
- Keep working-tree changes and the local verification ledger. Commits, pushes and deployment remain the user's responsibility.

Task 7's packaged macOS, Windows and Linux capture checks and the API → desktop 1.11.1 → admin rollout remain release acceptance work. Automated capture-boundary tests do not establish OS indicator behavior in a packaged application.

### Final automated verification

| Area                | Result                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                 | Full suite: 2,846 passed and one sandbox-blocked HTTP test; that test passed with local-server permission. TypeScript, changed-file lint and formatting passed.                                                                                                                                                                                                                                                                         |
| Desktop feature     | 188 focused cases passed across the final feature run and established-capture continuation regression. The 187-case combined run used Electron's compatible SQLite runtime with zero skips.                                                                                                                                                                                                                                             |
| Desktop broad suite | 10,217 tests reported: 9,448 passed, 227 failed and 541 skipped in the initial sandbox/Node run. All observed failures passed on retries after correcting the onboarding translation mock or using local-server permissions and the compatible Electron runtime. The last retry batch passed all 197 cases. This is combined-run evidence, not a clean full-suite run; broad skipped cases remain unverified unless covered by a retry. |
| Admin               | Full browser suite reported 64 passed, one skipped and one incorrect new test selector. After correcting the selector, all 15 feature browser tests passed. `check:full` and the production Webpack build passed.                                                                                                                                                                                                                       |
| Cross-repository    | Actual API resolution → admin parsing → desktop validation and automatic-start decision passed for automatic defaults and manual in both workspace orders.                                                                                                                                                                                                                                                                              |
| Static/build checks | Desktop typecheck, lint and renderer build passed; lint retains seven warnings in unchanged files. All three working-tree diffs passed whitespace checks.                                                                                                                                                                                                                                                                               |

### Independent pre-commit review and fixes

A subsequent independent review found two additional issues. The user authorized fixing both and committing the completed feature in all three repositories:

- Ordinary renderer reloads and ControlPanel unmounts could orphan a note-only session. Main now releases ownership when an already-loaded main document is replaced; initial navigation, subframes and same-document changes retain it. The renderer's session hook releases scoped ownership on unmount as well as note/view changes. Existing engine checks protect newer sessions and live recordings.
- Editing the meeting radio selection during a pending save could lose that newer edit when the response refreshed the saved mode. The radio group is now disabled until the save settles, including failed saves.

Both regressions were observed failing before their fixes. Final desktop regression coverage passed **202 tests with zero skips**; all **17 admin meeting-policy browser tests** passed, including delayed successful and failed saves. The API's unchanged final diff passed **79 focused tests** during the independent review. The reviewer checked the fixes and found no further actionable issues.

Local commits are authorized on the requested branch in each repository. Pushes and deployments remain outside this task. No dependency installations or environment-file edits were performed; packaged cross-platform acceptance remains pending.
