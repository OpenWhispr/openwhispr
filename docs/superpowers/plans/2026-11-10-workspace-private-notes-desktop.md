# Workspace Private notes: reconstructed desktop implementation map

Reconstructed on 2026-11-12 from current code and tests because the original referenced plan was missing. This is a current implementation and verification map, not a recovered historical plan or an assertion that every platform has been exercised. The companion [design](../specs/2026-11-10-workspace-private-notes-design.md) defines the behavior.

## Implemented boundaries

1. SQLite migration, default binding and account scoping live in `src/helpers/database.js` and `src/helpers/ipcHandlers.js`. Account adoption internally claims eligible signed-out notes. Private rows, folders and chat references move transactionally; assistant writes validate account/credential generation in main.
2. `src/stores/workspaceStore.ts`, `workspaceScopeBridge.ts`, `noteStore.ts`, and `src/lib/workspaceSelection.ts` coordinate default discovery, scope publication and navigation. Legacy sourceless ids migrate once, guarded by deliberate selections and open/edited work, including pending opens. Enterprise precedence is retained.
3. `src/services/privateNotesImport.ts` and `SyncService.ts` import personal snapshots once and keep ordinary Private data out of uploads. Durable import provenance protects local edits, moves and deletions against retry resurrection. Legacy shared Private notes retain guest-compatible sync.
4. Database conversation privacy, `src/components/chat/chatTurnEngine.ts`, and `src/services/tools/noteScope.ts` protect conversations before Private content is returned or checkpointed. Existing root history and unknown restored history stay device-only; new local chats can back up until Private use. The full policy is in [private-note-conversations.md](../../private-note-conversations.md).
5. Explicit leave/delete in `src/services/workspaceActionsCore.ts` captures account identity before the server request. Store refreshes capture account/session and refresh epoch through publication, binding, orphan discovery and relocation. Each move rechecks current membership and default status. Same-workspace sharing and team-to-Private copy rules are enforced by the database.
6. `src/services/tools/createNoteTool.ts` resolves explicit scoped teamspace names before Private aliases; omission stays Private, including folder lookup. `searchNotesTool.ts` follows semantic → FTS → team-only cloud, using bounded server-scoped requests and retaining partial results. `ContainerOverview.tsx` translates Private headings while retaining user names.
7. The unused public claim bridge and unused settings picker prop are removed. The CLI blank-clear comment accompanies its helper. Workspace switcher tests parse markup through happy-dom rather than stripping HTML with a regular expression.

## Verification map

- Database/account: `test/helpers/spacesDatabase.test.js`, `accountScopeIpc.test.js`, `accountScopedSyncIpc.test.js`, `preloadAuthBridge.test.js`, and `cliBridgeNotes.test.js` cover ownership, main IPC, sign-in claiming, moves/copies and CLI edits.
- Import/sync/privacy: `test/services/privateNotesImport.test.js`, `test/helpers/syncServiceNotes.test.js`, `syncServiceConversations.test.js`, `containerConversationsDatabase.test.js`, and `chatTurnEngine.test.js` cover retry provenance, ordinary Private exclusion, legacy shared exceptions, protected history and turn guards.
- Renderer races: `test/stores/workspaceStore.test.js`, `noteWorkspaceScope.test.js`, `test/services/workspaceActions.test.js`, and `test/lib/workspaceSelection.test.js` cover stale lists, account changes, restored membership, failed relocation retries, default discovery, Enterprise behavior, explicit choices and open/edited work.
- Tools/UI: `test/services/noteTools.test.js`, `toolUtils.test.js`, `searchNotesToolScope.test.js`, `test/components/containerOverviewDefaultFolder.test.js`, `workspaceSwitcherPlacement.test.js`, `settingsWorkspaceFrame.test.js`, and locale coverage verify scope, aliases, headings and surviving settings behavior.

Use Node 24 for renderer checks and TypeScript/i18n/lint/format validation. Database suites must run with `ELECTRON_RUN_AS_NODE=1 REQUIRE_DB_TESTS=1` and the installed Electron binary through `--import tsx --test`; an ABI-skipped database suite is not validation. Run the full repository suite after focused checks.

Separately exercise real workspace list/default/list responses with Electron IPC/SQLite, upgrade/default discovery, and create → move → upload → copy journeys. Keep scratch accounts and test databases isolated. macOS fixture success does not establish Windows/Linux native behavior, live service production behavior, or GitHub CodeQL status; report those limits explicitly.
