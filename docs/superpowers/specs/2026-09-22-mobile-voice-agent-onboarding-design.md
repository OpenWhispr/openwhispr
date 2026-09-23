# Mobile onboarding: live voice-agent try, and restored practice/mode screens

Date: 2026-09-22
Branches: `feat/mobile-onboarding-tone-preview` (mobile), a new branch off `origin/main` in `openwhispr-api`

## Goal

New users should try the voice agent for real during onboarding instead of reading an example:
dictate a request through the keyboard's agent button, refine it with a spoken follow-up, and insert
the result. Two other onboarding screens go back to the lighter layouts they had before this branch.

## Background

- The keyboard already supports the whole interaction. Its agent button records a request, a review
  panel shows the draft, **Ask for changes** records a spoken follow-up that adds a new version, and
  the ✓ button (**Insert**) types the chosen version into the focused field.
- The app runs keyboard agent jobs through `useKeyboardHandoff`, which `app/_layout.tsx` mounts, so
  they are processed while onboarding is on screen. It reports progress to the keyboard as
  `agent_generating`, `agent_ready` and `agent_error`, and the onboarding step can listen to the same
  events through `addKeyboardStatusChangedListener`, as the practice-email step already does.
- The agent calls `/api/agent/stream`, which refuses anonymous sessions (`requireAccount`, 403
  `ACCOUNT_REQUIRED`). On mobile the account step comes near the end of onboarding, so almost every
  user is anonymous at the voice-agent step. The app already maps 403 `ACCOUNT_REQUIRED` from the agent
  to `account_required`.
- Desktop does not have this problem: sign-in is its first step, and only account users see its
  assistant demo.

## 1. API: anonymous trial allowance (`openwhispr-api`)

- In `api/agent/stream.ts`, an anonymous caller is no longer refused outright. Each request from an
  anonymous user consumes one unit of a **lifetime allowance of 5**. Once it is used up, the route
  returns the same 403 `ACCOUNT_REQUIRED` as today.
- The count must be durable. `rate_limit_hits` is not suitable: `api/cron/cleanup-rate-limits`
  deletes rows older than 2 days, which would reset the allowance. Add a table in a new migration
  (`migrations/076_anonymous_agent_trials.sql`, mirrored in `schema.sql` and the test schema):
  `anonymous_agent_trials (user_id TEXT PRIMARY KEY, requests INTEGER NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`.
  No foreign key, because an anonymous user may not have a `users` row.
- Consuming is one atomic statement: insert with `requests = 1`, or on conflict increment only while
  `requests < 5`, returning the new count. No returned row means the allowance is used up.
- The allowance is consumed after the cheaper refusals (minimum app version, org `agent` feature,
  word quota), so a request refused for those reasons does not use up a try.
- Anonymous requests skip mem0: no `retrieveMemories` and no `saveMemory`. Linking an anonymous
  account to a real one does not move memories, so they would be stranded.
- Signed-in users are unchanged. `/api/reason` stays account-only.
- Update the policy comment above `requireAccount` in `lib/auth.ts` to describe the allowance.
- Tests: an anonymous user's requests 1–5 stream and the 6th gets 403 `ACCOUNT_REQUIRED`; a request
  refused for a version, policy or quota reason consumes nothing; anonymous requests never call
  mem0; signed-in users never touch the table.
- Rollout: the API deploys before the mobile release. Until then the new step still works through
  its fallback (section 2).

## 2. Mobile: interactive "Meet your voice agent" step

The step keeps its place in the flow (after the practice email, before tone) and its Back and Skip.

**Layout.** An email-style field like the practice step's, and a short instruction card above it
that changes as keyboard events arrive.

**Instruction sequence**

| Phase | Advances when | Card says |
| --- | --- | --- |
| Start | — | Tap the field, then the ✨ agent button on your keyboard. |
| Asking | status `recording` | Say: *"Write a message inviting Sam to lunch tomorrow at noon."* |
| First draft | first `agent_ready` | Now tap **Ask for changes** and say: *"Make this more concise."* |
| Refined | second `agent_ready` | Tap ✓ to insert it. |
| Done | non-empty text lands in the field | Checkmark and "That's your voice agent." Continue is the next action. |

- The phase only moves forward. After an error, Retry returns to Start and clears the `agent_ready`
  count.
- Continue and Skip are always available.

**Mode.** Like the practice step, the step uses Cloud until the user has chosen a mode. If Local is
chosen (reachable through Back) or saved (a replayed onboarding), the step shows the static example
instead of the live try.

**Fallback to the static example**, with Skip still available:
- `agent_error` with detail `account_required`: "You've used the free tries. Sign in at the end to
  keep using the agent."
- any other `agent_error`, or no connection: a short error with Retry, and the example.
- no session (the anonymous session could not be created): the example.

**Tests**: each phase transition in order, the Done state on insert, each fallback, and Local
showing the example without overriding the mode.

## 3. Restored layouts

**Step 4, practice email (`DictationEmailStep`)**
- Bring back main's email card: a To: Tim chip, Subject: Quick sync, "Read this aloud" with the
  sample email as the field's placeholder, and the "works in any email app" icon row
  (`assets/onboarding/app-icons/outlook.png` is used again).
- Keep the branch's behavior: the status line, error with Retry, dismissing the keyboard once per
  dictation, and the Cloud override.
- Remove the "Show an example" link and the example card. For Local, the field stays read-only
  with its placeholder and a one-line note that practice uses Cloud.

**Step 7, "How should we transcribe?" (`PrivacyModeStep`)**
- Bring back main's two cards and their short copy:
  - Private mode: one-line description, "Works fully offline", the no-cleanup note and the
    download size.
  - OpenWhispr Cloud: Faster transcription, Higher quality, Automatic cleanup & formatting.
- Remove the paragraphs about tones, the voice agent, the Pro offer and the saved tone choice.
- Keep the branch's behavior: the two buttons commit the choice immediately, and Cloud goes
  straight to the optional Pro offer.

## Out of scope

- Moving the account step earlier.
- Changing desktop onboarding.
- The keyboard extension's Swift code: the step only reads its events.
