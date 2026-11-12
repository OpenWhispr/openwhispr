# Private notes release checks

## Requested behavior

Private notes and folders follow main’s Cloud Backup consent: subscription, sign-in, the Backup toggle and organization policy still apply. Existing cloud notes participate in normal sync. The one-time import, account-wide device-only cutoff, automatic deletion and archive-only recovery flow are removed. Team collaboration and shared personal notes continue independently of Backup. Private notes can be shared directly without moving: existing cloud copies are reused, and an explicit Sync and share action uploads only the selected unsynced note when Backup is off. Sharing preserves its workspace and folder. The separately approved chat privacy policy is unchanged.

Owner-only `private_workspace_id` preserves the workspace of each Private note and folder across devices without granting workspace members access. It records a stable UUID even for the default workspace; null means historical placement was never recorded. Existing local placement is backfilled only after a guarded cloud snapshot. The pre-pull candidate list survives interrupted pulls and delayed default binding, so a newly restored legacy row cannot publish its default fallback over the original device’s known placement.

Historical cloud notes need the original device to sync once with the updated app. Until then a new device shows them in default Private; it follows the original placement when that metadata arrives. Different workspaces can contain identically named folders. Lost-workspace recovery preserves content and cloud identities and renames collisions.

Assistant search follows main’s sign-in/Backup gate and cloud → local semantic → keyword order. One cloud request includes the active workspace’s owner-only Private notes and authorized teamspaces; filtering precedes ranking. Cloud-only Private content protects the conversation before exposure. Folder-pinned searches remain local.

## Rollout order

1. Stop and drain any old automatic-purge deployment or invocation. Code changes cannot cancel an already-running old invocation.
2. Apply the forward migrations through API migration 112. Migration 111 retires the old mode/checkpoint metadata and write fences; it does not delete note/folder content.
3. Deploy the placement-aware API, including the scoped search endpoint, across all writers and drain old API requests before releasing the new clients or enabling placement backfill. Older clients are supported by the new API; mixed old API builds are not supported once nondefault placement exists, because their folder adoption selects by name alone.
4. Keep the placement-aware API on rollback. Do not restore the old cutoff, purge schedule or name-only folder adoption.

Retired cutover endpoints return authenticated 404s. The old purge endpoint remains authenticated and inert, with its schedule removed. Explicit user deletion continues normally.

## Sharing and search verification (2026-11-12)

- Seven combined Electron/API journeys passed using the mounted production sharing dialog, real preload/IPC and SQLite, selected API routes and isolated data. They cover explicit sharing with Backup off, existing-cloud identity reuse, recipient access without placement disclosure, later edits, pull preserving local filing, revoke/reinvite, and stopping sharing. Search covers one ranked cloud request, workspace/owner exclusion, cloud empty/error fallback, semantic-to-keyword fallback, and durable chat privacy before exposing cloud-only Private content.
- API: the full exact-dependency suite passed 4,298 tests across 84 suites, with no failures or skips. Focused route/SQL/schema/access/v1 checks passed 99 tests. Lint/type checks and independent review passed. Both search ranking arms filter before their limits; existing callers retain their behavior.
- Desktop: the broad run exercised 14,377 tests: 14,357 passed, 16 platform skips and one pre-existing TODO. Its three failures were two obsolete forced-move/share-audience expectations and the missing restored sync-error translation. The expectations were updated and the exact main translations restored across all 11 locales. The entire NoteEditor file then passed 42 tests, and translation coverage passed 11 tests. The full suite was not repeated after those test/translation-only changes.
- Focused sharing UI, search/auth and native sync checks passed, including account/client/space/cloud identity changes, stale receipts, explicit single-note consent, unchanged ordinary Backup gating, and failed privacy checkpoints. Counts overlap with the broad run. Independent code-quality reviews found no actionable issues.
- TypeScript, lint, i18n key/placeholder checks, formatting, whitespace and renderer build passed. Existing lint/bundle warnings remain. No commit, push or deployment was performed for this revision.

Evidence: `/tmp/pr385-sharing-search-verification-report.md`, `/tmp/pr3167-sharing-search-full.log`, `/tmp/pr385-direct-share-noteeditor-final.log`, `/tmp/pr385-direct-share-translations-final.log`, `/tmp/pr385-search-api-report.md`, `/tmp/pr385-search-scope-full.log`, and `/tmp/pr3167-sharing-search-source.json`.

## Placement and backup verification before this revision

- API: 4,288 tests across 84 suites passed, with no failures or skips, using Node 24 and exact lockfile dependencies in an isolated temporary source copy. Focused validation passed 236 tests. Build, lint/type checks, generated-schema consistency, whitespace and source/snapshot equality passed. Existing warnings remain.
- PostgreSQL: 10 real concurrent folder-placement cases passed, covering both orderings of content edits, inserts, idempotent upserts, folder deletion and account cleanup. Parent and child placement remained consistent, with no deadlock in the exercised orderings.
- Cross-device Electron/API: the final frozen-source rerun passed 13 journey groups across 22 Electron phases, plus 140 native integration checks. Four isolated device profiles passed source backfill, same-name folders, fresh restore, stale-device moves, stable placement after default-workspace transfer and lost-workspace recovery. Restore-first journeys passed with normal completion, interruption before queue completion, and a failed later download page; restarting the same profile preserved the original-device placement. Backup consent, account-switch fences and the unchanged protected-chat behavior were also exercised.
- Mobile: 334 suites / 4,456 tests passed; TypeScript and the package lint command passed (existing warnings only). Tests reused installed dependencies: Better Auth/Expo patch versions differ from the lockfile. Native mobile acceptance remains separate.
- Desktop: the final full suite passed 14,359 tests with zero failures, 16 platform skips and one pre-existing TODO (14,376 total). TypeScript, lint, translation consistency, changed-file formatting, whitespace and the final renderer build passed; existing lint and bundle-size warnings remain. The first broad run exposed obsolete policy fixtures and an account-marker cleanup regression; these were corrected. The final receipt-fence changes also passed 186 targeted tests. Counts overlap and must not be summed.

Scratch evidence: `/tmp/pr385-api-restored-sync-report.md`, `/tmp/pr385-placement-full-tests.log`, `/tmp/pr385-folder-concurrency-final.log`, `/tmp/pr385-restored-e2e-xjafp6z8/`, `/tmp/pr385-placement-candidate-db.log`, `/tmp/pr385-pinning-candidates-final.log`, `/tmp/pr385-mobile-placement-full.log`, and `/tmp/pr385-restored-desktop-full-final.log`.

## Remaining release checks

Packaged startup, real sign-in, native mobile, Windows/Linux acceptance, pinned mobile release dependencies and a production migration rehearsal remain separate checks. Integration tests use disposable profiles, synthetic authentication, actual selected API routes and local PostgreSQL/PGlite; no real user profile or live cloud data was migrated. No dependency installation, `.env` edit, commit, push or deployment was performed.
