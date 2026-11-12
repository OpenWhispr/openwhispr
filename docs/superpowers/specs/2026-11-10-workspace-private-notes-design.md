# Workspace Private notes: reconstructed current design

This document was reconstructed on 2026-11-12 from the current implementation and tests. The original document referenced by this filename was missing; this is not a recovered historical record. Existing D-number comments remain in code, but this document does not reconstruct undocumented decisions.

## Storage and account boundaries

Every workspace has a device-local Private section alongside shared teamspaces. SQLite `spaces` rows identify Private by `(account_id, workspace_id)`. A null workspace is the account's pending default; a null account and workspace identify the signed-out stand-in. The version-6 migration splits historical notes, folders and conversations by account transactionally. Main claims eligible signed-out notes when it accepts an account scope, through the internal `_claimSignedOutPrivateNotes`; there is no public renderer claim operation.

`src/helpers/database.js` binds pending Private to the account's own default, merging same-named default folders and keeping their notes and conversations. An entitled Enterprise workspace may stand in when the server does not create an own default. Scope publication and default binding validate the originating account. Persisted main-process scope supports tray/background creation before the main window opens; switching account clears the running session's scope.

## Discovery and navigation

`src/stores/workspaceStore.ts` discovers the default through workspace list/default APIs. `activeWorkspaceSource` distinguishes deliberate `user`, settled `auto`, and provisional app choices. Legacy saved ids without a valid source migrate once like provisional choices. Once an own default is known, `defaultActiveWorkspaceId` chooses an entitled Enterprise workspace first, otherwise the default. Explicit user and settled auto choices remain stable.

The note-store yield guard preserves user-opened notes and containers, pending opens whose data has not arrived, and tree-selected notes the user edited. Deliberate speaker corrections, participant changes and recording starts mark the note as user work before awaiting IPC. Such work adopts the current workspace as `user`. Untouched tree selections may yield. Storage is read when a list response arrives so a newer selection in another window wins. Private headings use the translated label; user-authored teamspace names are preserved.

## Import and sync

`src/services/privateNotesImport.ts` imports a snapshot of personal cloud folders and notes once per account into the default's Private, then acknowledges the exact server timestamp. Changed snapshots retry; parked rows, account changes, and failures do not mark the import complete. `private_note_import_history` retains account-scoped provenance when imported notes are edited, moved, or deleted, preventing a retry from restoring old content or undoing local intent. Cloud/client-id collisions use distinct local identities.

Private notes and folders do not upload. Existing shared Private notes with a cloud identity remain the compatibility exception so guests retain access. Teamspaces continue syncing. This local-storage boundary does not imply that assistant inference is local: supplied context still goes to the chosen provider.

Conversation privacy is durable and monotonic. A chat consuming Private note content or folder names, including its later turns and forks, becomes device-only before that content is exposed or persisted. The chosen upgrade policy keeps existing root history device-only. Newly restored cloud conversations have unknown provenance and also become device-only; new local chats can back up until they consume Private content. Remote changes cannot overwrite protected local history. Existing cloud copies remain; explicit deletion uses the existing delete queue. See [Private notes and conversation backup](../../private-note-conversations.md) for the complete policy and account/write guards.

## Moves and workspace loss

Team-to-Private uses Copy to Private; moving a synced team row to Private is rejected. Private-to-team sharing requires the same workspace and resets personal backup identity to a fresh client key, except legacy shared rows. Private-to-Private moves stay local. Imported-note provenance survives these changes.

A successful nonempty workspace list detects losses using both cached membership and main's Private rows. Explicit leave/delete forgets the workspace before relocation. Private content moves to the current default, preserving content and handling folder collisions. Account-session and refresh-epoch guards surround awaited work; membership and default status are checked immediately before every move. Superseded scans cannot bind or relocate a replacement account's data, and later scans retry failed moves.

## Assistant scope

`resolveAssistantScopeSpaceIds` restricts tools to current Private and accessible teamspaces. It never creates a named Private for an unknown workspace; unnamed `getPrivateSpaceId()` and `getSpaces()` can lazily create current Private. `create_note` without `space` files the note and its folder into Private. Explicit names first match in-scope teamspaces case-insensitively, even names such as Private, Personal, or the localized Private label; unmatched Private aliases use Private. Existing exact-match/first-match semantics remain.

Search tries local semantic, then local FTS, then team-only cloud. Every cloud request names one in-scope teamspace, in batches of at most ten concurrent requests. Successful responses merge by score and final limit; one failed teamspace does not discard others. Folder-pinned searches remain local. Note creation, edits and automatic folder creation carry account/credential write guards; privacy callbacks remain part of the tool result boundary.

## Evidence and limits

Behavior is covered by `test/helpers/spacesDatabase.test.js`, `accountScopedSyncIpc.test.js`, `syncServiceNotes.test.js`, `syncServiceConversations.test.js`, `test/services/privateNotesImport.test.js`, `noteTools.test.js`, `searchNotesToolScope.test.js`, `workspaceActions.test.js`, `test/stores/workspaceStore.test.js`, `noteWorkspaceScope.test.js`, and the container/workspace component suites.

SQLite integration requires Electron's matching native ABI. Renderer fixtures and fake-cloud tests do not prove live API authorization, provider behavior, or Windows/Linux desktop UX. Live service and Electron journeys must be reported separately from unit coverage. Downgrades are unsupported; the Markdown mirror still uses folder names across workspaces. Local checks do not constitute a GitHub CodeQL result.
