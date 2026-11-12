# Private notes review fixes

> Historical review record: the later restoration of ordinary Private-note Backup and cross-device placement supersedes the import-history and device-only-note behavior below. See [current release checks](../../private-notes-release-checklist.md).

**Goal:** Resolve PR 3167's confirmed review defects on `feat/workspace-private-notes`, preserve main's fixes, and verify the affected journeys without committing or pushing.

**Architecture:** Preserve account/workspace scoped storage and enforce privacy at the database and sync boundaries. Mark conversations that consume Private content as device-only before persisting that content; keep that classification through future turns and forks. Preserve import provenance independently of a note's new team identity.

**Constraints:** Use existing branch and dependencies. Do not change `.env`, commit, push, or delete remote user data. Use strict TypeScript and existing patterns. Test real behavior before changing it. User explicitly selected device-only storage for entire root conversations that read Private notes, including later turns.

## Tasks

1. Merge current main without committing; resolve all conflicts preserving newer sync push-race/server-clock guards and workspace UI changes. Run relevant sync and type checks.
2. Repair database/sync boundaries: import provenance for moved notes/folders; same-workspace Private-to-team enforcement; private-note conversation inbound protection; eliminate redundant already-synced note pushes. Add real SQLite/sync regressions.
3. Mark root conversations that consume Private content as device-only across tool reads, RAG, persistence, later turns, forks, upload retries, and cloud pulls. Preserve prior cloud copies without deleting remote content. Test before/after sync and account changes.
4. Repair renderer journeys: stale workspace relocation; guide upgraded users to existing private notes without overriding explicit current choices; translated Private overview; unambiguous teamspace names in create_note; correctly scoped cloud search beyond ten spaces. Add race and component/tool regressions.
5. Resolve CodeQL's test parser issue and remove unused claim IPC, fix misplaced CLI comment and stale search documentation. Supply the missing referenced design/plan as current behavior documents rather than pretending to recover lost historical text.
6. Review all changes independently, run affected integration journeys and full test/quality checks, inspect results and remaining merge state. Leave all changes uncommitted.

## Verification focus

- An upgraded multi-account database retains notes, folders, chat history and account isolation.
- Moving private content before delayed import neither duplicates nor deletes it.
- Private-derived chat content never enters backup, including a push already queued or subsequent turns.
- A stale workspace refresh cannot relocate a workspace restored by a newer refresh or belonging to a new account.
- Team sync, copy-to-Private, sharing, background note destinations and main's newer sync guards continue to work.

## Completed work

- Resolved all 15 merge conflicts against main `377ec98da`, preserving its note push locks, synced-row guards and server-clock cursors. Branch HEAD remains `45d6db269`; the merge is intentionally uncommitted.
- Preserved historical client/cloud note identities before Private-to-team moves. Delayed imports cannot duplicate moved notes or resurrect deleted notes, including folder moves, missing create receipts and database restart. Main enforces same-workspace note/folder moves, including CLI calls.
- Added durable, monotonic conversation privacy before Private context reaches the model or persistence. Reads, automatic context, tool data, later turns and forks remain local. Upload retries and inbound cloud writes/deletions respect the flag. Assistant writes and searches retain their originating account/generation across cancellation and asynchronous work.
- Fixed stale workspace relocation and upgrade discovery without overriding explicit selections, pending opened notes or edited work. Translated Private overview titles; explicit teamspace names take precedence over Private aliases. Large-workspace cloud search stays server-scoped with bounded concurrency.
- Replaced the CodeQL-flagged test parser, removed the unused public claim bridge while retaining internal sign-in claiming, corrected comments/docs and supplied explicitly reconstructed design/plan documents.

## Confirmed privacy decisions

The user explicitly chose to keep all affected conversations, existing root history and restored chats device-only. New locally created chats remain Backup eligible until they use Private content. Old cloud copies are retained; explicit user deletion still works. Device-only concerns Backup/storage, not the user-selected inference provider. See `docs/private-note-conversations.md` for the full policy and provenance limits.

## Review comment coverage

Both [boseq's initial review](https://github.com/OpenWhispr/openwhispr/pull/3167#pullrequestreview-5858079950) and [signed-in follow-up](https://github.com/OpenWhispr/openwhispr/pull/3167#pullrequestreview-5863500549) were checked against the implementation:

| Finding                                                      | Resolution and verification                                                                                                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conflicts and upload gates                                   | Resolved and independently reviewed; push-race, reconciliation and private/team sync regressions pass.                                                                |
| Duplicate after move before import                           | Durable import history; real SQLite and API retry/move/restart journeys pass.                                                                                         |
| Private text in root-chat backups                            | Entire affected chat stays device-only, including tool arguments/results and future turns; inbound/outbound and previously-backed-up positive/negative controls pass. |
| Cross-workspace note/folder moves                            | Main mutation boundary rejects both; same-workspace upload still passes.                                                                                              |
| Upgrade hides notes                                          | Legacy automatic selection discovers the default; real API-backed upgrade and preserved-open-note scenarios pass.                                                     |
| Untranslated Private title and alias collision               | Translated overview and explicit team names, with component/tool regressions.                                                                                         |
| Extra post-create PATCH                                      | Main's merged synced guard already fixes it; queued-push and share-metadata regressions confirm it.                                                                   |
| CodeQL, unused IPC, misplaced comment and missing/stale docs | Parser replaced, bridge removed, comments/docs corrected and missing references supplied. CodeQL itself was not rerun remotely.                                       |

The reported Linux SQLite qemu failure also occurs on main and was left outside this fix. No Linux success is claimed.

## Verification record

- Every production task received an independent subagent review using `/code-quality`. Review-discovered event resurrection, cancelled account-switch writes and later-batch search credential adoption were reproduced, fixed and independently rereviewed. Final review found no remaining actionable issue.
- Covering task runs passed: merge 387, data 395, privacy 418, renderer 383 plus 164 final race/tool cases, and the complete 2,911-test component suite. These counts overlap and must not be summed.
- The final search/account repair passed 240 covering tests, including 14 real tool/service/main-transport auth regressions; zero failures or skips. The sync cursor fixture retains its deletion/cursor assertions using a known locally created, Backup-eligible chat.
- All 16 isolated Electron/SQLite/actual API385/PGlite scenarios passed: default/upgrade, private/import/retry, upload/rejection/legacy share, private/team/root/restored chat, scope/navigation/relocation/relaunch, and production notes UI create/move/upload/copy. The UI surface and protected linked-chat scenarios passed again after the final search change.
- TypeScript, i18n, lint, formatting, whitespace checks and renderer build passed. Existing lint and bundle-size warnings remain. Offline model registry verification passed (signed publication 4).
- The first complete repository run found 22 stale-fixture failures: missing schema/IPC guards, invalid workspace setup and outdated restored-chat deletion expectations. Test-only repairs preserve original assertions and add historical Private-chat deletion and grounding-cancellation coverage. Independent review accepted all repairs; data, cursor and chat covering runs passed 79, 39 and 158 tests respectively. No additional production change was needed.
- Final full repository suite passed: **14,362 passed, 0 failed, 0 cancelled, 16 platform skips, 1 pre-existing TODO** (14,379 total; exit 0, 379.3 seconds). The before/after source fingerprint matched `5b0f3e51af0cc2aec2d23db1b63d3718c7739c1e573be7e2ec2ff943e6aac868` across 2,775 source/test files. It uses the installed Electron SQLite ABI, `REQUIRE_DB_TESTS=1`, `COPYFILE_DISABLE=1` and an external process-only resourcesPath compatibility preload. These address existing host-fixture differences without changing production code or weakening assertions. The full suite also needs permission to bind its loopback test servers; a sandboxed attempt failed with `listen EPERM` and was stopped before restarting with that permission. The interrupted pre-search-fix run is not counted as a pass.

## Verification limits

The integration harness uses synthetic authentication, selected actual API handlers and disposable local profiles. It does not establish live API385 deployment, actual login, complete packaged-app startup, native microphone/hotkeys, Windows/Linux behavior or a full native Postgres migration. No real user profile was migrated. No packages were installed, `.env` files changed, commits made or pushes performed.

## Final handoff

All confirmed issues and review findings are addressed. Changes, including the resolved merge, remain staged on `feat/workspace-private-notes`; no commit or push was performed. HEAD is still `45d6db269f7610950406c6aff2c3820b8a02f193`; merge parent is `377ec98dace2399b5992384089e8669341c172ae`. No unresolved index entries remain.

The final full-suite log is `/tmp/pr3167-final-full-tests.log`. Independent review and isolated journey records are `/tmp/pr3167-final-review.md` and `/tmp/pr3167-e2e-report.md`. Full suite command (with local socket permissions):

```sh
COPYFILE_DISABLE=1 ELECTRON_RUN_AS_NODE=1 REQUIRE_DB_TESTS=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --require /tmp/pr3167-fixes/electron-node-test-compat.cjs --import tsx --test --test-concurrency=8 --test-reporter=tap 'test/**/*.test.js'
```
