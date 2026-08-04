# Plan: all open issues

Date: 2026-08-04
Status: DRAFT — for review before any implementation

Everything currently outstanding, in the order I propose doing it. Nothing here
is implemented yet except where marked SHIPPED.

## Already shipped (context, not work)

- `1.12.1` built and verified: live diarization speaker runaway fixed, local
  model support added to `MainProcessInference`, pipeline errors now show a
  reason, native-ABI build guard (`rebuild:native` + `afterPack` assertion).
- **Not pushed. No PR. Not tagged.** Branch `fix/live-diarization-and-local-inference`.
- Migrations work is parked on `feature/graceful-db-migrations` (commit
  `c0bd1042`, marked WIP) with a known unfixed defect.

---

## P0 — get shipped work landed

### 1. Push, PR and tag 1.12.1
Branch `fix/live-diarization-and-local-inference` has 4 commits and exists only
locally. `v1.12.1` is not tagged.

- Push branch, open PR (pull-request-description skill).
- After merge, tag `v1.12.1` on main.
- Note: the Release workflow currently fails on this fork (Apple signing secrets
  unset, plus a flaky whisper.cpp download). Tagging will fail the workflow
  again unless that is accepted or the secrets are added. **Decision needed.**

### 2. Verify the diarization fix on a real call
The 0.80 confident-match threshold is a judgement call verified only under unit
test. A 3-person call must report 3 speakers. If it now *under*-counts (two
people merged into one), the threshold is too low. This gates whether 1.12.1 is
actually good.

---

## P1 — the bugs the user reported that are still open

### 3. Title is overwritten unconditionally
`postCallPipelineManager` step 2 writes `updateNote(noteId, { title })` for any
note. `src/helpers/regenerableNoteTitle.js` exists for exactly this decision
(placeholders, empty, unedited calendar summary) and the pipeline never calls
it. Two defects in one:
- a title the user typed by hand is clobbered
- the rule the user asked for ("regenerate only if still 'New note'") is not
  expressed anywhere in the pipeline

Fix: consult `isRegenerableNoteTitle(note.title, placeholders, calendarEventName)`
before generating; emit `title:skipped` when the user owns the title.

Complication: `regenerableNoteTitle.js` uses ESM `export function` while the
manager is CJS. Needs `await import()` (the step is already async) or the module
converted. **Confirm which during review.**

Tests: manual title preserved; "New note" regenerated; empty regenerated;
unedited calendar summary regenerated; localized placeholder regenerated.

### 4. "Generate Notes" produces notes with no structure
The pipeline's `GENERIC_NOTES_PROMPT` mandates TL;DR, Meeting Overview
(attendees + tone), Topics Covered, Decisions & Open Items, Action Items, Key
Takeaways. The notes produced by the **Generate Notes** button had none of
those headings, so that button uses a different, thinner prompt.

**I have not yet located that second prompt.** Investigation required before
this can be scoped — I do not know if it is a renderer prompt, a different IPC
path, or a stale copy. Do not implement until found.

Fix intent: one prompt, used by both paths. Whichever is better wins; they must
not diverge again.

### 5. Chat defaults to groq, not local
`chatAgentProvider` defaults to `"groq"` (settingsStore.ts:1171), which needs a
BYOK key. For a local-first app whose onboarding auto-configures a local Gemma
model, the chat agent silently defaulting to a cloud provider is wrong.

Fix intent: default the chat scope to `local` when a local model is present,
otherwise leave unset so the UI prompts. **Product decision — confirm.**

### 6. Root cause of `NOTE_FORMATTING_PROVIDER=gemma`
1.12.1 *recovers* from a model family in the provider field, but does not fix
whatever wrote it. The value comes from the settings store's provider field via
`saveAllKeysToEnvFile()`. Until the writer is found, other scopes can carry the
same corruption.

Investigation: find where a model family is assigned to a provider field in the
settings UI/store. Then fix at the source and keep the recovery as a safety net.

---

## P2 — the migrations work (currently WIP, do not ship as-is)

### 7. Progress window cannot paint
`DatabaseManager`'s constructor is synchronous and runs on the main process, so
the BrowserWindow created inside `onMigrationProgress` cannot render — the
event loop it needs is blocked until migrations finish, at which point the
window is destroyed. The user would see a blank rectangle. This defeats the
entire feature.

Fix: read `user_version` cheaply first; if work is pending, create the window,
await `did-finish-load`, then run migrations. `startApp()` is already async, so
making `initializeCoreManagers` async is a small change — **but every caller
must be checked.**

### 8. Fresh installs flash the window and write a useless backup
The Videos seed sets `user_version = 1` on a brand-new database, so the runner
sees `1 < 3`, backs up a near-empty file and reports two migration steps during
first-run onboarding. Fix: when `initDatabase` creates the file fresh, stamp
`user_version = SCHEMA_VERSION` and skip the runner.

### 9. Migration failure policy
`critical: false` (drop cloud columns) records the version even when the body
failed; `critical: true` (purge) rolls back and retries. This was added after
review but the *bodies* still swallow per-statement errors, so "failed" is
mostly unreachable for the non-critical one. Confirm the split is coherent, or
make the bodies strict now that a backup exists.

### 10. `verify:binaries` ABI check placement
The plan-review flagged that adding an ABI assert to `verify:binaries` would run
*before* `install-app-deps` (npm `pre` hook ordering) and abort every legitimate
build. Currently not added. Either insert it into the script body after the
rebuild, or leave the `afterPack` guard as the only check. **Recommend: leave
it; afterPack already covers every path.**

### 11. `node-abi` is undeclared
`afterPack` requires it transitively via `prebuild-install`. Declaring it in
`devDependencies` requires regenerating `package-lock.json`, which on a
mismatched Node major strips `libc` fields (observed). Must be done with Node 24
(`nvm exec 24`) or not at all. **Recommend: defer, document the dependency.**

---

## Sequencing

1. #1 push/PR/tag → gets verified work out of a local-only branch
2. #2 real-call verification → confirms 1.12.1 before more is stacked on it
3. #3 title guard (small, self-contained)
4. #4 investigate the second notes prompt, then unify
5. #5 / #6 chat default + provider-field root cause
6. #7–#9 finish migrations, re-review, then ship
7. #10 / #11 accept the recommendations above unless review disagrees

Each numbered item gets its own branch, its own version bump per the new
CLAUDE.md rule, and its own PR.

---

## Open questions for review

1. Is the 0.80 confident-match threshold defensible, or does it risk merging two
   genuinely similar voices? What evidence would settle it short of a live call?
2. #3: `await import()` of an ESM module from the CJS main process — does that
   work in the packaged app under asar, or does the module need converting?
3. #5: should chat default to local, or stay unset and force an explicit choice?
4. #7: is making `initializeCoreManagers` async safe given everything it
   constructs and the `whenReady` chain?
5. Is this sequencing right, or should the migrations work be dropped entirely
   rather than finished — is a gated splash worth the complexity versus simply
   making migrations fast and silent?
