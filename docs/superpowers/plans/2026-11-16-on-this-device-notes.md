# "On this device" notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a Mac other accounts have used, show ownerless Private notes in a view-only "On this device" sidebar section with an explicit "Move to my Private", and give backed-up ownerless notes to the account the cloud says owns them.

**Architecture:** Main gets a narrow, separate read/move path for eligible stand-in notes (never through `getSpaces`/`getNotes`/`_accountScopeCondition`), a proof-only sign-in claim, and a per-account ownership-check record. The renderer gets a small zustand store, a section rendered inside `SpacesTree.tsx`, a read-only `DeviceNoteView` in the notes pane, and a SyncService step that asks `GET /api/notes/:id/access`.

**Tech Stack:** Electron main (better-sqlite3, `src/helpers/database.js`, `ipcHandlers.js`, `preload.js`), React 19 + zustand + Tailwind, react-i18next, `node --test` (Node 24).

**Spec:** `docs/superpowers/specs/2026-11-16-on-this-device-notes-design.md`

## Global Constraints

- Work in `/Users/chadpiha/Development/openWhispr/openwhispr-on-this-device-notes`, branch `fix/on-this-device-notes`. Node 24: `source ~/.nvm/nvm.sh && nvm use 24`.
- Eligible note (all must hold): signed in; `hasOtherAccountRows()` true; `space_id` = `_standInPrivateSpaceId()`; `account_id IS NULL`; `deleted_at IS NULL`; `cloud_id IS NULL`; `owner_user_id IS NULL`; `cloud_create_attempted = 0`; `cloud_create_pending IS NULL`.
- Stand-in folder rows are never moved, renamed or deleted on a Mac other accounts have used. Moved notes join the target Private's live folder of that name (`_privateFolderNamed`) or a new folder with the stand-in folder's `name`, `is_default`, `sort_order`.
- A move or claim keeps `sync_status`, `updated_at`, `client_note_id`, `cloud_id`.
- Single-account Mac and signed-out behaviour unchanged; every existing test in `test/helpers/spacesDatabase.test.js` stays green unmodified.
- Popover copy, verbatim: "These notes have not been assigned to an account. Move a note to keep it and edit."
- Every new string under `notes.deviceNotes.*` in all 11 locales (ar, de, en, es, fr, it, ja, pt, ru, zh-CN, zh-TW), with each locale's plural categories; `npm run i18n:check` passes.
- The section's notes never go through `NoteEditor`, `activeNoteId`, `ensureNoteLoaded`, Ctrl+K, the assistant or the Markdown mirror before a move.
- No API change. Ownership check uses the existing `GET /api/notes/:cloudId/access` (`my_permission`).
- Local checks only: targeted test files, `npm run typecheck`, `npm run lint`, `npm run i18n:check`. Full suite is left to PR CI. DB tests run with this worktree's cloned `node_modules` (verified 122/122 on this base); if they ever report as skipped, say so — never run `npm rebuild better-sqlite3` (it breaks the dev app's binding).
- Commits per task with conventional-commit messages (`feat(notes): …`, `test(notes): …`); never push.

## Review Focus

1. **Account switch while a device note is open** — the view closes and the section reloads for the new account (Task 5 store test).
2. **A note moved from another window while open here** — on `device-notes-changed` the open view re-reads, gets null, and closes (Task 5 store test).
3. **Move from a workspace main doesn't know** — lands in the default's Private and no new private row is created (Task 1 test).
4. **A stand-in folder holding both an eligible note and a backed-up one** — a folder move moves only the eligible note; folder row and the other note stay (Task 1 test).
5. **Account switch during the ownership check** — no claim and no "not owned" record is written for the old or the new account (Task 4 test).

---

### Task 1: Main — eligible notes: list, get, move

**Files:**
- Modify: `src/helpers/database.js` (new methods next to `claimSignedOutPrivateNotes`, ~6550)
- Test: `test/helpers/spacesDatabase.test.js` (append; extend `seedNote` with `ownerUserId`, `cloudCreateAttempted`, `cloudCreatePending` options)

**Interfaces:**
- Produces (on `DatabaseManager`):
  - `getDeviceNotes(): { folders: Array<{ id: number, name: string, is_default: number, noteCount: number }>, notes: Array<{ id, title, folder_id, created_at, updated_at, note_type }> }` — empty arrays when not applicable.
  - `getDeviceNote(id: number): object | null` — the full `notes` row when eligible.
  - `moveDeviceNotesToPrivate({ noteIds?: number[], folderId?: number, workspaceId?: string | null }): { moved: object[] /* full note rows after the move */, skipped: number }`
  - private `_deviceNoteEligibleSql(alias: string): string` and `_placeStandInNote(noteId: number, targetSpaceId: number, accountId: string): void` (reused by Task 2).

- [ ] **Step 1: Write failing tests** (shared-Mac recipe: `createFreshDeviceDb`, `signIn(db,"b")`, `signIn(db,null)`, seed, `signIn(db,"a",W1_ACTIVE)`):
  - `getDeviceNotes lists only eligible stand-in notes on a shared Mac` — seed in the stand-in: an eligible note in Meetings, an eligible root note, one each with `cloudId`, `ownerUserId:"b"`, `deletedAt`, `cloudCreateAttempted:1`, `cloudCreatePending:"x"`. Assert `notes.map(n=>n.id)` equals the two eligible ids; `folders` equals `[{ id: meetingsId, name: "Meetings", is_default: 1, noteCount: 1 }]` (seeded Personal/Videos absent).
  - `getDeviceNotes is empty signed out and on a single-account Mac` — signed out → `{folders:[],notes:[]}`; fresh device signed in as only "a" after `claimSignedOutPrivateNotes()` → empty.
  - `eligible notes stay out of the account's normal reads` — after seeding, `db.getNote(id) === null`, `db.getNotes()` excludes it, `db.getPendingNotes()` excludes it, `db.getSpaces()` has no stand-in row.
  - `moveDeviceNotesToPrivate joins the account's folder of that name` — "a" already has Meetings in its default Private; move `{noteIds:[meeting]}` → `moved[0]` has `account_id:"a"`, `space_id: db.getDefaultPrivateSpaceId()`, `folder_id: aMeetings`, unchanged `sync_status`/`updated_at`/`client_note_id`; `skipped:0`; stand-in Meetings row unchanged (`folderRow` space/account/name); `assertEveryRowInItsFolderSpace`.
  - `moveDeviceNotesToPrivate creates a missing folder and keeps root notes at the root` — custom stand-in folder "Ideas" (seedFolder) with one eligible note, plus a root note; "a" has no Ideas → a new folder `{ name:"Ideas", account_id:"a", space_id: home }` holds it; root note `folder_id === null`; stand-in "Ideas" still in the stand-in.
  - `moveDeviceNotesToPrivate by folder moves only eligible notes` (Review Focus 4) — stand-in "Ideas" holds an eligible note and one with `cloudId`; `{folderId: ideas}` → `moved.length===1`, the cloud note still `account_id:null` in the stand-in folder.
  - `moveDeviceNotesToPrivate skips notes that stopped being eligible` — `{noteIds:[eligible, alreadyMovedId]}` → `moved.length===1, skipped===1`.
  - `moveDeviceNotesToPrivate into a workspace main doesn't know uses the default's Private` (Review Focus 3) — count private rows before; `{noteIds:[n], workspaceId:"unknown-ws"}` → note in `getDefaultPrivateSpaceId()`, private row count unchanged. With `W2_ACTIVE` scope and `workspaceId:"w2"` → note in `db.getPrivateSpaceId("w2")`.
  - `moveDeviceNotesToPrivate does nothing signed out or on a single-account Mac` → `{moved:[], skipped: n}`.
- [ ] **Step 2: Run** `node --test --test-name-pattern="DeviceNote|deviceNote|eligible notes stay out" test/helpers/spacesDatabase.test.js` — expect FAIL (methods undefined).
- [ ] **Step 3: Implement** the four methods. Applicability: `activeAccountId && hasOtherAccountRows() && standInId != null`. Target space: `this._forkPrivateSpaceId(workspaceId, this.activeAccountId)` (known-workspace guard; never inserts for an unknown id). Move runs in one `this.db.transaction`; eligibility re-checked per note in the `UPDATE … WHERE id = ? AND <eligible>`; folder lookup/creation through `_placeStandInNote`.
- [ ] **Step 4: Run** the same command plus the whole file `node --test test/helpers/spacesDatabase.test.js` — expect all pass.
- [ ] **Step 5: Commit** `feat(notes): Read and move ownerless notes on a shared Mac`

### Task 2: Main — proof-only sign-in claim and ownership-check record

**Files:**
- Modify: `src/helpers/database.js` (`claimSignedOutPrivateNotes` ~6550, new `_initStandInOwnershipChecks()` called beside `_initWorkspaceScopes()` ~2413, `deleteAccountData` per-account cleanup ~5732-5751)
- Test: `test/helpers/spacesDatabase.test.js` (append)

**Interfaces:**
- Consumes: `_placeStandInNote` (Task 1).
- Produces:
  - table `stand_in_ownership_checks (note_id INTEGER NOT NULL, account_id TEXT NOT NULL, checked_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (note_id, account_id))`
  - `getStandInOwnershipCandidates(): Array<{ id: number, cloud_id: string }>` — shared Mac only; stand-in, `account_id IS NULL`, `cloud_id IS NOT NULL`, `owner_user_id IS NULL`, tombstones included, minus rows checked by the active account.
  - `resolveStandInOwnership(noteId: number, cloudId: string, owned: boolean): { claimed: boolean }` — owned: in a transaction, if still a candidate with that `cloud_id`, place it in `getDefaultPrivateSpaceId()` via `_placeStandInNote` and set `owner_user_id` = active account; not owned: `INSERT OR IGNORE` a check row. Returns `{claimed:false}` when no longer a candidate.

- [ ] **Step 1: Write failing tests:**
  - `on a shared Mac the sign-in claim takes only notes the cloud says are the account's` — stand-in: note with `ownerUserId:"a"` in Meetings, a tombstone with `ownerUserId:"a"`, a note with `ownerUserId:"b"`, an ownerless eligible note, an ownerless `cloudId` note. Sign in "a": `claimSignedOutPrivateNotes()` returns `{ notes: 2, folders: 0 }`; the two "a" rows are in a's default Private and a's Meetings; the other three unchanged; every stand-in folder row unchanged; `assertEveryRowInItsFolderSpace`.
  - `getStandInOwnershipCandidates lists backed-up notes with no owner, once per account` — returns the ownerless `cloudId` note; after `resolveStandInOwnership(id, cloud, false)` it is gone for "a" but listed again after `signIn(db,"b")`.
  - `resolveStandInOwnership claims an owned note into the default Private` — returns `{claimed:true}`; row has `account_id:"a"`, `owner_user_id:"a"`, `cloud_id` unchanged, in a's Meetings; second call `{claimed:false}`.
  - `resolveStandInOwnership refuses a note whose cloud id changed` — pass a different `cloudId` → `{claimed:false}`, row unchanged.
  - `ownership checks are empty signed out and on a single-account Mac`.
  - `deleteAccountData drops the account's ownership checks` — after a "not owned" record for "a", `deleteAccountData("a")` → `SELECT COUNT(*) FROM stand_in_ownership_checks WHERE account_id='a'` is 0.
  - The existing single-account claim test (~3546) and every other existing test pass unchanged.
- [ ] **Step 2: Run** `node --test --test-name-pattern="ownership|cloud says" test/helpers/spacesDatabase.test.js` — expect FAIL.
- [ ] **Step 3: Implement.** In `claimSignedOutPrivateNotes`, keep the single-account branch exactly as is; when `hasOtherAccountRows()` is true, place each stand-in note with `owner_user_id = activeAccountId` (deleted or not) through `_placeStandInNote` into `getDefaultPrivateSpaceId()`; never call `_claimStandInNotes` there. Count moved notes in `notes`, `folders: 0`.
- [ ] **Step 4: Run** the whole file `node --test test/helpers/spacesDatabase.test.js` — all pass.
- [ ] **Step 5: Commit** `feat(notes): Claim ownerless notes only with cloud proof on a shared Mac`

### Task 3: IPC, preload, types

**Files:**
- Modify: `src/helpers/ipcHandlers.js` (`setupHandlers`, near `db-get-folders` ~3404; `_claimSignedOutPrivateNotes` ~1211), `preload.js` (~304 invokes, ~339 listeners), `src/types/electron.ts` (new types near `NoteItem` ~471; API members near `getFolders` ~2163 and `onDatabaseAccountScopeChanged` ~2262)
- Test: create `test/helpers/deviceNotesIpc.test.js` (template: `test/helpers/noteUndoIpc.test.js`)

**Interfaces:**
- Consumes: Task 1 and Task 2 database methods.
- Produces (channels → preload names on `window.electronAPI`):
  - `db-get-device-notes` → `getDeviceNotes(): Promise<DeviceNotesList>`
  - `db-get-device-note` (id) → `getDeviceNote(id: number): Promise<DeviceNote | null>`
  - `db-move-device-notes` ({ noteIds?, folderId?, workspaceId?, accountId }) → `moveDeviceNotes(request): Promise<{ success: true, moved: NoteItem[], skipped: number } | { success: false, code: string, error: string }>`; refuses with `ACCOUNT_CHANGED_RESULT` when `isForOtherAccount(request.accountId, active)`.
  - `db-get-stand-in-ownership-candidates` → `getStandInOwnershipCandidates(): Promise<Array<{ id: number, cloud_id: string }>>`
  - `db-resolve-stand-in-ownership` ({ noteId, cloudId, owned, accountId }) → `resolveStandInOwnership(request): Promise<{ claimed: boolean } | { success: false, code: string, error: string }>` (same account guard)
  - broadcast `device-notes-changed` (no payload) → `onDeviceNotesChanged(callback: () => void): () => void` via `registerListener`
  - types in `electron.ts`: `DeviceNoteFolder`, `DeviceNoteSummary`, `DeviceNotesList`, `DeviceNote` (subset of `NoteItem`: `id, title, content, enhanced_content, transcript, participants, note_type, created_at, updated_at, audio_duration_seconds, folder_id`).
- After a move with `moved.length > 0` or a claim with `claimed: true`: `notifyVectorChanges()`, `this.noteFiles.notesMoved()`, `broadcastToWindows("note-updated", note)` per moved note, `broadcastToWindows("device-notes-changed")`. `_claimSignedOutPrivateNotes` also calls `this.noteFiles.notesMoved()` and broadcasts `device-notes-changed` when it moved anything.

- [ ] **Step 1: Write failing tests** in `deviceNotesIpc.test.js` with a fake `databaseManager` and `noteFiles: { notesMoved(){ calls.push("notesMoved") } }`:
  - `db-move-device-notes refuses another account's request` → `{ success:false, code: ACCOUNT_CHANGED_RESULT.code }`, database not called.
  - `db-move-device-notes broadcasts after a move` → after `setImmediate`, `sent` contains `["note-updated", movedRow]` and `["device-notes-changed", undefined]`; `notesMoved` and `notifyVectorChanges` each called once.
  - `db-move-device-notes with nothing moved broadcasts nothing`.
  - `db-resolve-stand-in-ownership broadcasts only when claimed`.
  - `db-get-device-notes passes the database result through`.
- [ ] **Step 2: Run** `node --test test/helpers/deviceNotesIpc.test.js` — expect FAIL.
- [ ] **Step 3: Implement** handlers, preload entries, types.
- [ ] **Step 4: Run** `node --test test/helpers/deviceNotesIpc.test.js test/helpers/accountScopeIpc.test.js test/helpers/accountScopedSyncIpc.test.js` and `npm run typecheck` — all pass.
- [ ] **Step 5: Commit** `feat(notes): Expose ownerless notes to the renderer over IPC`

### Task 4: Renderer — ownership check in sync

**Files:**
- Create: `src/services/standInOwnershipCheck.ts`
- Modify: `src/services/SyncService.ts` (in `syncAll`, right after `syncSpaces` and its `passIsCurrent()` check ~1236)
- Test: create `test/services/standInOwnershipCheck.test.js`

**Interfaces:**
- Consumes: `getStandInOwnershipCandidates`, `resolveStandInOwnership` (Task 3); `cloudGetForAuthGeneration`, `CloudApiError`, `isAuthContextError` from `src/services/cloudApi.ts`; `NoteAccessState` type.
- Produces: `checkStandInOwnership(options: { accountId: string, authGeneration: number, isCurrent: () => boolean, api?: Pick<ElectronAPI, "getStandInOwnershipCandidates" | "resolveStandInOwnership">, get?: typeof cloudGetForAuthGeneration }): Promise<{ claimed: number, notOwned: number }>`
- Rules: up to 3 requests at a time. `200 && my_permission === "owner"` → resolve owned; `200` with `editor`/`viewer`, `404`, `403` → resolve not owned; status 0 (network), 401, 5xx, `isAuthContextError` → nothing. Before each resolve, `isCurrent()` must be true or it stops. Called from `syncAll` when `this.consent().shared` and the pass is current, with `isCurrent: () => this.passIsCurrent() && getAuthRequestContextSnapshot().sessionUserId === accountId`. Errors are logged and never fail the pass.

- [ ] **Step 1: Write failing tests** (pure, with injected `api` and `get`):
  - `claims a note the cloud says the account owns` → `get` resolves `{ my_permission:"owner" }`; `resolveStandInOwnership` called with `{ noteId, cloudId, owned:true, accountId }`; result `{claimed:1, notOwned:0}`.
  - `records shared and missing notes as not owned` → `editor` and a `CloudApiError(…,404)` → two calls with `owned:false`.
  - `records nothing on network, 401 and 5xx errors` → statuses 0, 401, 503 → no resolve calls.
  - `stops when the account changes mid-check` (Review Focus 5) → `isCurrent` turns false after the first `get` → no resolve calls at all.
  - `asks at most three at a time` → 7 candidates with deferred `get` promises; max concurrent `get` calls observed is 3.
- [ ] **Step 2: Run** `node --import tsx --test test/services/standInOwnershipCheck.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the module and the `syncAll` call.
- [ ] **Step 4: Run** the new test, `node --import tsx --test test/helpers/syncServiceNotes.test.js test/services/privateNotesBackup.test.js`, and `npm run typecheck` — all pass.
- [ ] **Step 5: Commit** `feat(sync): Ask the cloud who owns backed-up ownerless notes`

### Task 5: Renderer — store, sidebar section, strings

**Files:**
- Create: `src/stores/deviceNotesStore.ts`
- Modify: `src/components/notes/SpacesTree.tsx` (new in-file `DeviceNotesSection` after the Private section, ~2391; reuse `SectionHeader`, `TreeChildren`, `ROW_BASE_CLASS`, `KEBAB_TRIGGER_CLASS`, `MENU_ITEM_CLASS`, `HOVER_REVEAL_BUTTON_CLASS`)
- Modify: `src/locales/{ar,de,en,es,fr,it,ja,pt,ru,zh-CN,zh-TW}/translation.json` (block `notes.deviceNotes` beside `notes.spaces`)
- Modify (mocks only): `test/components/spacesTreePrivateSection.test.js`, `spacesTreeTransfers.test.js`, `spacesTreeDirection.test.js`, `spacesTreeNoteActionClearance.test.js` — add a `/stores/deviceNotesStore` mock
- Test: create `test/stores/deviceNotesStore.test.js`; extend `test/components/spacesTreePrivateSection.test.js`

**Interfaces:**
- Consumes: Task 3 preload API; `useNoteStore` (`openNote`, `setActiveNoteId`, `activeNoteId`, `activeContext`, `loadFolders`); `useAuth`/workspace hooks already in SpacesTree for `accountId` and the on-screen Private's `workspace_id` (`privateSpace.workspace_id`).
- Produces (`useDeviceNotesStore`): state `{ folders: DeviceNoteFolder[], notes: DeviceNoteSummary[], viewNoteId: number | null }`; actions `load(): Promise<void>`, `openView(id: number): void`, `closeView(): void`, `move(request: { noteIds?: number[], folderId?: number }, context: { accountId: string, workspaceId: string | null }): Promise<{ moved: NoteItem[] } | { error: string }>`, `startListening(): () => void` (subscribes `onDeviceNotesChanged` and `onDatabaseAccountScopeChanged` → `load()`; on scope change also `closeView()`; on `device-notes-changed` with `viewNoteId` set, re-reads `getDeviceNote` and closes on null; subscribes to `useNoteStore` and closes the view when `activeNoteId` becomes non-null or `activeContext` changes). After a successful move: `useNoteStore.getState().loadFolders()` and `load()`.
- Strings (en; translate the rest, plurals per locale): `notes.deviceNotes.title` "On this device"; `.info` "These notes have not been assigned to an account. Move a note to keep it and edit."; `.infoLabel` "About notes on this device"; `.moveNote` "Move to my Private"; `.moveFolder` "Move folder to my Private"; `.moved` "Moved to your Private"; `.movedCount_one` "Moved {{count}} note to your Private"; `.movedCount_other` "Moved {{count}} notes to your Private"; `.moveFailed` "Couldn't move this note"; `.banner` "This note isn't assigned to an account yet."; `.notesHeading` "Notes"; `.summaryHeading` "AI summary"; `.transcriptHeading` "Transcript".
- Section: hidden when `folders` and `notes` are both empty; heading `SectionHeader` with `label={t("notes.deviceNotes.title")}`, `className="mt-4"`, `action` = ⓘ `Popover` (pattern: `VADLabelWithInfo`, SettingsPage.tsx ~929) showing `.info`; folder rows (level 1, `Folder` icon, `noteCount`) expand to note rows (level 2), root notes at level 1; each row has the hover kebab with one item (`.moveNote` / `.moveFolder`); clicking a note calls `setActiveNoteId(null)` then `openView(id)`. Toasts: single → `.moved`; folder → `.movedCount`; failure → `.moveFailed` destructive. Rows are Tab-focusable buttons; they are not added to the tree's arrow-key `visibleRows` (my call: keeps the tree's key model untouched).

- [ ] **Step 1: Write failing tests:**
  - store: `load() fills folders and notes`; `account-scope change reloads and closes the view` (Review Focus 1); `device-notes-changed closes a view whose note is gone` (Review Focus 2); `opening a normal note closes the view`; `move() refreshes folders and the list`.
  - SpacesTree (static render with a mocked store): `the section is hidden when there are no device notes`; `the section shows its title, folder rows with counts and root notes`.
- [ ] **Step 2: Run** `node --import tsx --test test/stores/deviceNotesStore.test.js test/components/spacesTreePrivateSection.test.js` — expect FAIL.
- [ ] **Step 3: Implement** store, section, all 11 locale blocks, and the four SpacesTree test mocks. Call `startListening()` once from `SpacesTree`'s mount effect (dispose on unmount) and `load()` on mount.
- [ ] **Step 4: Run** both tests, the other three SpacesTree tests, `npm run i18n:check`, `npm run typecheck`, `npm run lint` — all pass.
- [ ] **Step 5: Commit** `feat(notes): Show ownerless notes in an On this device section`

### Task 6: Renderer — read-only note view

**Files:**
- Create: `src/components/notes/DeviceNoteView.tsx`
- Modify: `src/components/notes/PersonalNotesView.tsx` (render branch ~967: `viewNoteId != null ? <DeviceNoteView id={viewNoteId}/> : editorNote ? …`)
- Modify (mocks only): `test/components/personalNotesUndoDiscard.test.js`, `notesStructureIntroHandOff.test.js`, `notesStructureIntroInvitation.test.js`, `meetingRecordingSurvivesViewSwitch.test.js` — add the `/stores/deviceNotesStore` mock
- Test: create `test/components/deviceNoteView.test.js` (pattern: `test/components/conversationListEmptyState.test.js` with `installInteractiveDom`)

**Interfaces:**
- Consumes: `getDeviceNote`, `useDeviceNotesStore` (`move`, `closeView`), `useNoteStore().openNote`, `MarkdownRenderer` (`src/components/ui/MarkdownRenderer.tsx`), `parseTranscriptSegments` + `MeetingTranscriptChat` with no write callbacks (plain-text fallback when segments are `[]` and `transcript` is non-empty), `useToast`, strings from Task 5.
- Produces: `DeviceNoteView({ id }: { id: number }): JSX.Element | null` — loads with `getDeviceNote(id)`; null → `closeView()`. Shows title, `created_at` date, banner `.banner` + button `.moveNote`; sections `.notesHeading` (content), `.summaryHeading` (`enhanced_content`, when present), `.transcriptHeading` (when present). Move → `move({ noteIds:[id] }, context)`; on success `closeView()` then `openNote(moved[0])` and toast `.moved`; on error toast `.moveFailed`.

- [ ] **Step 1: Write failing tests:**
  - `renders the note read-only with the banner` — content and summary text present; no element with `contenteditable="true"`.
  - `Move to my Private opens the moved note` — clicking the button calls `move` with `{ noteIds:[id] }`, then `openNote` with `moved[0]`.
  - `never calls a note write IPC` — `window.electronAPI` stubs for `updateNote`, `saveNote`, `deleteNote` record calls; after render and move, they were never called.
  - `closes when the note is no longer available` — `getDeviceNote` resolves null → `closeView` called.
- [ ] **Step 2: Run** `node --import tsx --test test/components/deviceNoteView.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the component, the PersonalNotesView branch and the four test mocks.
- [ ] **Step 4: Run** the new test, the four PersonalNotesView tests, `npm run typecheck`, `npm run lint` — all pass.
- [ ] **Step 5: Commit** `feat(notes): View an ownerless note read-only with Move to my Private`

### Task 7: Docs and end-to-end check

**Files:**
- Modify: `CLAUDE.md` §22 (bullet after "Rows", ~890)
- Scratch only: scripts under the session scratchpad

- [ ] **Step 1:** Add the §22 bullet: the "On this device" section, the eligibility rule, the proof-only sign-in claim on a shared Mac, the ownership check (`GET /api/notes/:id/access`, `stand_in_ownership_checks`), and that nothing else reads these notes.
- [ ] **Step 2:** Scripted journey on a copy of the affected database (`/private/tmp/claude-501/-Users-chadpiha--claude-spares-spare-B2vYLL/6de71854-aadb-4467-8034-f27110a85506/scratchpad/db/`, copied first): sign in as the restored account → claim takes note 49 (owner proof) → `getDeviceNotes()` lists notes 42, 46, 51, 52 under Meetings (count 4) → `moveDeviceNotesToPrivate({ folderId })` → Meetings holds 30, `getDeviceNotes()` empty. Sign in as the other account first instead → it sees the same 4 in the section and cannot open them through `getNote`.
- [ ] **Step 3:** Run every test file touched in Tasks 1-6, `npm run typecheck`, `npm run lint`, `npm run i18n:check` — all pass.
- [ ] **Step 4: Commit** `docs: Describe the On this device notes section`
