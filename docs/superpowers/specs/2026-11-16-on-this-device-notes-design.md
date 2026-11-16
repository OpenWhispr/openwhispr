# "On this device" notes: design

Date: 2026-11-16. Branch: `fix/on-this-device-notes` (from `origin/main` e6834b20d). Supersedes PR OpenWhispr/openwhispr#3263.

## Intent

The `user_version` 6 split (#3167) leaves Private notes with no account in the signed-out stand-in space (`kind = 'private'`, `account_id IS NULL`, `workspace_id IS NULL`). Those are notes written before notes recorded an account (#1812, 2026-08-26) and notes written signed out. Signed in, nothing shows the stand-in, and on a Mac more than one account has used the sign-in claim (`claimSignedOutPrivateNotes`) skips them, so they vanish for everyone signed in. Seen on a real device: Private → Meetings went from 30 notes to 25.

PR #3263 gave them to whoever signed in first. Review showed that guesses ownership wrongly, locks real owners out of backed-up notes, and can upload one account's notes to another's cloud. This design makes ownership an explicit act instead: the notes show in their own sidebar section, view-only, until someone moves one into their own Private.

## Goals

- On a Mac other accounts have used, a signed-in user sees the ownerless notes in an "On this device" section and can read them.
- Taking ownership is one deliberate action: "Move to my Private". After it the note is that account's, leaves the section for everyone, and backs up like any of that account's notes.
- Nothing in the section is uploaded, searched by the assistant, mirrored to Markdown, or sent to any AI provider before someone moves it.
- Notes whose ownership the cloud can prove go to their owner automatically: a recorded `owner_user_id` at sign-in, and for backed-up notes with no recorded owner, the server's answer to "is this account the owner?".

## Non-goals

- Signed-out behaviour: unchanged. The stand-in stays the signed-out user's editable Private.
- Single-account Macs: unchanged. `claimSignedOutPrivateNotes` still claims everything there.
- Ownerless notes that have a cloud copy (`cloud_id` set) or whose upload may have landed (`cloud_create_attempted = 1` or `cloud_create_pending` set): never shown in the section. The first kind goes to its owner through the ownership check below; the second is adopted by its owner's pull through `client_note_id`, as on main. *(Builder-check calls.)*
- Signing in while a signed-out stand-in note is open in the editor or a signed-out meeting is recording into it: the note stops saving, as it already does on main. Out of scope here; follow-up. *(Builder-check call.)*
- Folder-name "(2)" duplicates after an upgrade, and `getOwnNoteByCalendarEventId` treating ownerless notes as the user's (review findings 8 and 10): separate work.

## Anti-goals (a failure even if it works)

- Any path other than the explicit move stamps one of these notes with an account (edit autosave, AI action, recording, assistant tool, share, sync).
- The section's notes appear anywhere that reads the normal list of spaces or notes (sync queues, assistant scope and search, `create_note`, meeting folder picker, move menus, Ctrl+K, Markdown mirror).
- A move takes a note whose ownership could be proven to be someone else's (a cloud copy, or another account's `owner_user_id`).

## Constraints

- The stand-in can be the signed-out user's live working space, and its folders can carry a `cloud_id` (synced before attribution). Folder rows in it are never moved or renamed by this feature.
- `_accountScopeCondition` and `_visiblePrivateSpaceCondition` (database.js) keep excluding the stand-in while signed in. This feature adds its own narrow read path instead of widening them.
- Every user-facing string goes through i18n in all 11 locales under `src/locales/` (ar, de, en, es, fr, it, ja, pt, ru, zh-CN, zh-TW).
- Node 24 for tests; targeted tests plus typecheck, lint and i18n checks locally, full suite in PR CI.

## Approaches considered

- **A. Add the stand-in to `getSpaces()`** flagged as device-shared, and draw it as its own section with the existing tree. Reuses the tree, but `getSpaces` has about 15 consumers (SyncService, `assistantNoteScope`, `searchNotesTool`, `createNoteTool`, `listFoldersTool`, `meetingNotificationDestination`, `spaceActions`, CommandSearch, workspace settings, ...). Each would need to skip the row; one miss reintroduces the ownership leak.
- **B. A separate, narrow read path** (chosen). Three main-process calls limited to eligible notes, and a small self-contained sidebar section plus a read-only viewer. Nothing else in the app learns the row exists, so sync, the assistant and filing are untouched by construction. Trade-off: no drag and drop into or out of the section.
- **C. Claim at sign-in on any device** (PR #3263). Rejected after review: wrong-owner claims, owners locked out of backed-up notes, cross-account uploads.

Chad picked B.

## Design

### Which notes are "on this device" (main)

A note is in the section when all hold:
- the database has an active account (signed in), and `hasOtherAccountRows()` is true;
- `notes.space_id` is the stand-in (`_standInPrivateSpaceId()`), `notes.account_id IS NULL`, `notes.deleted_at IS NULL`;
- `notes.cloud_id IS NULL`, `notes.owner_user_id IS NULL`, `notes.cloud_create_attempted = 0` and `notes.cloud_create_pending IS NULL`.

Folders shown are the stand-in folders (live, `deleted_at IS NULL`) that hold at least one such note; empty stand-in folders (the seeded Personal/Meetings/Videos) never show. Eligible notes with `folder_id IS NULL` show at the section's root. The section is the same in every workspace.

### Sign-in claim (main)

`claimSignedOutPrivateNotes` keeps main's behaviour on a single-account Mac. On a Mac other accounts have used it now also claims stand-in notes whose `owner_user_id` equals the signing-in account (cloud proof), tombstones included, into the account's default Private, joining same-named folders. It never moves or renames stand-in folder rows on such a Mac; claimed notes go into the account's folder of that name (created if missing, named with `_uniqueFolderName` rules). Everything else stays where it is.

### Ownership check for backed-up notes with no recorded owner (renderer + main)

Chad's pick ("ask the cloud"). On a Mac other accounts have used, stand-in notes with `account_id IS NULL`, `cloud_id` set and `owner_user_id IS NULL` are asked about once per account:
- After sign-in, once the account's sync can make authenticated requests, the renderer asks main for the candidate cloud ids it hasn't asked about for this account, then calls `GET /api/notes/:cloud_id/access` (existing, editor-gated; returns `my_permission`) through the existing authenticated cloud request path. No API change.
- `200` with `my_permission === "owner"`: main claims that note for the account (same placement as the sign-in proof claim: the account's default Private, its folder of that name), sets `owner_user_id` to the account, re-checking in the transaction that it is still an unclaimed candidate.
- `404`/`403`, or `200` with `editor`/`viewer` (shared with, not owned by, this account): recorded as "not this account's" so it isn't asked again for this account; the note stays where it is.
- Network error, 401, 5xx, or a sign-out/account switch mid-check: nothing recorded; asked again on a later pass.
- The record is per `(note, account)` in SQLite (a small table; the builder names it), cleared for an account by account deletion.
- Requests run a few at a time, not all at once; a Mac rarely has more than a handful of these notes.
- After claims: the same follow-ups as a move (vector notify, `notesMoved()`, broadcasts).

### IPC (main ↔ renderer)

Names are the builder's call; shape:
- **list**: `{ folders: [{ id, name, noteCount }], notes: [{ id, title, folder_id, created_at, updated_at, note_type }] }` for eligible notes only; empty lists when not applicable (signed out, single-account Mac).
- **get(id)**: the full eligible note (title, content, enhanced content, transcript, participants, created_at, audio duration) or null if it is not eligible (anymore).
- **move({ noteIds } | { folderId }, workspaceId)**: the renderer passes the workspace whose Private is on screen *(builder-check call: main's active workspace can lag the screen while the pick is provisional or right after an account change)*. Main resolves the target with `getPrivateSpaceId(workspaceId)` when it knows that workspace, else the default's Private, never creating a row for an unknown workspace (D37). In one transaction, re-check eligibility for each note, then move it into that Private: a note in a stand-in folder goes into the account's live folder of that name in that Private (`_privateFolderNamed`, or a new folder created with the stand-in folder's name and `is_default`), a root note to the root. Sets `account_id` and `space_id`/`folder_id`; leaves `sync_status`, `updated_at`, `client_note_id` as they are (a pending note then uploads through the account's normal Backup flow). A folder move moves every eligible note in that folder; the stand-in folder row itself stays. Returns `{ moved, skipped }`; notes that stopped being eligible are skipped, not an error.
- After a move with `moved > 0`: `notifyVectorChanges()`, `noteFiles.notesMoved()`, broadcast `note-updated` for each moved note, and broadcast a section-changed event so every window re-reads the section.
- The section re-reads on that event and on every account-scope change (`database-account-scope-changed`).

### Sidebar section (renderer)

- Rendered by `SpacesTree.tsx` directly below the Private section, only while the list is non-empty. Heading "On this device" with an ⓘ that opens a popover: "These notes have not been assigned to an account. Move a note to keep it and edit." (Chad's wording.)
- Folder rows and note rows look like the Private section's rows (reuse the row components and styles), with note counts. No drag and drop in or out.
- Note row menu: "Move to my Private". Folder row menu: "Move folder to my Private".
- After a move: a toast "Moved to your Private" (folder: count-aware "Moved {{count}} notes to your Private"); failure: "Couldn't move this note". No Undo.

### Viewing a note (renderer)

- Clicking a note opens a dedicated read-only view in the notes pane (not `NoteEditor`, whose autosave, sharing and sync side effects are what this feature must avoid). It shows the title, date, the note's content and AI summary rendered read-only (the existing `RichTextEditor` with editing off, or the Markdown renderer the app already uses), and the transcript as text when present.
- A banner at the top: "This note isn't assigned to an account yet." with a "Move to my Private" button. After the move the view opens the moved note in the normal editor (it is now the account's).
- No note chat, AI actions, recording, sharing, delete or Ctrl+K entry for these notes.
- If the note stops being eligible while open (moved from another window, account switch), the view closes.

### Strings

New keys under `notes.deviceNotes.*` (section title, info popover, banner, move actions, toasts), in all 11 locales.

### Docs

CLAUDE.md §22 gains a bullet describing the section, the eligibility rule and the sign-in proof claim.

## Tests

- **database**: eligibility (each excluded case: cloud copy, another owner, tombstone, create attempted or pending, signed out, single-account Mac); ownership-check candidates, claim on "owner", the "not this account's" record, and no claim when the candidate changed; list counts and empty seeded folders hidden; move into an existing namesake, into a created folder, to the root, folder move, re-check skips a note that became ineligible; sign-in claim of an owner-proven note on a shared Mac, stand-in folder rows untouched; single-account behaviour unchanged (existing tests stay green); invariant `assertEveryRowInItsFolderSpace`.
- **Isolation**: `getSpaces`, `getNotes`, `getPendingNotes`, `getNote` still exclude eligible notes while signed in.
- **IPC**: the handlers return empty when signed out, broadcast after a move. **Ownership check**: owner / editor / 404 / network-error outcomes, and an account switch mid-check records nothing.
- **Renderer**: the section hides when the list is empty; the viewer never calls a note write IPC.
- Live check in the dev app with two accounts if feasible; otherwise the scripted journeys used in the #3263 review (copy of an affected database).

## Left to the builder

IPC channel names, component and file names, how rows reuse the tree's components, which read-only renderer to use, exact toast/banner key names, and test file layout.
