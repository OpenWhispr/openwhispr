# Private notes release checks

## Requested behavior

Private notes and folders follow main’s Cloud Backup consent: subscription, sign-in, the Backup toggle and organization policy still apply. Existing cloud notes participate in normal sync. The one-time import, account-wide device-only cutoff, automatic deletion and archive-only recovery flow are removed. Team collaboration and existing personal shares continue independently of Backup. The separately approved chat privacy policy is unchanged.

Owner-only `private_workspace_id` preserves the workspace of each Private note and folder across devices without granting workspace members access. It records a stable UUID even for the default workspace; null means historical placement was never recorded. Existing local placement is backfilled only after a guarded cloud snapshot. The pre-pull candidate list survives interrupted pulls and delayed default binding, so a newly restored legacy row cannot publish its default fallback over the original device’s known placement.

Historical cloud notes need the original device to sync once with the updated app. Until then a new device shows them in default Private; it follows the original placement when that metadata arrives. Different workspaces can contain identically named folders. Lost-workspace recovery preserves content and cloud identities and renames collisions.

## Rollout order

1. Stop and drain any old automatic-purge deployment or invocation. Code changes cannot cancel an already-running old invocation.
2. Apply the forward migrations through API migration 112. Migration 111 retires the old mode/checkpoint metadata and write fences; it does not delete note/folder content.
3. Deploy the placement-aware API across all writers and drain old API requests before releasing the new clients or enabling placement backfill. Older clients are supported by the new API; mixed old API builds are not supported once nondefault placement exists, because their folder adoption selects by name alone.
4. Keep the placement-aware API on rollback. Do not restore the old cutoff, purge schedule or name-only folder adoption.

Retired cutover endpoints return authenticated 404s. The old purge endpoint remains authenticated and inert, with its schedule removed. Explicit user deletion continues normally.

## Verification

- API: 4,288 tests across 84 suites passed, with no failures or skips, using Node 24 and exact lockfile dependencies in an isolated temporary source copy. Focused validation passed 236 tests. Build, lint/type checks, generated-schema consistency, whitespace and source/snapshot equality passed. Existing warnings remain.
- PostgreSQL: 10 real concurrent folder-placement cases passed, covering both orderings of content edits, inserts, idempotent upserts, folder deletion and account cleanup. Parent and child placement remained consistent, with no deadlock in the exercised orderings.
- Cross-device Electron/API: the final frozen-source rerun passed 13 journey groups across 22 Electron phases, plus 140 native integration checks. Four isolated device profiles passed source backfill, same-name folders, fresh restore, stale-device moves, stable placement after default-workspace transfer and lost-workspace recovery. Restore-first journeys passed with normal completion, interruption before queue completion, and a failed later download page; restarting the same profile preserved the original-device placement. Backup consent, account-switch fences and the unchanged protected-chat behavior were also exercised.
- Mobile: 334 suites / 4,456 tests passed; TypeScript and the package lint command passed (existing warnings only). Tests reused installed dependencies: Better Auth/Expo patch versions differ from the lockfile. Native mobile acceptance remains separate.
- Desktop: the final full suite passed 14,359 tests with zero failures, 16 platform skips and one pre-existing TODO (14,376 total). TypeScript, lint, translation consistency, changed-file formatting, whitespace and the final renderer build passed; existing lint and bundle-size warnings remain. The first broad run exposed obsolete policy fixtures and an account-marker cleanup regression; these were corrected. The final receipt-fence changes also passed 186 targeted tests. Counts overlap and must not be summed.

Scratch evidence: `/tmp/pr385-api-restored-sync-report.md`, `/tmp/pr385-placement-full-tests.log`, `/tmp/pr385-folder-concurrency-final.log`, `/tmp/pr385-restored-e2e-xjafp6z8/`, `/tmp/pr385-placement-candidate-db.log`, `/tmp/pr385-pinning-candidates-final.log`, `/tmp/pr385-mobile-placement-full.log`, and `/tmp/pr385-restored-desktop-full-final.log`.

## Remaining release checks

Packaged startup, real sign-in, native mobile, Windows/Linux acceptance, pinned mobile release dependencies and a production migration rehearsal remain separate checks. Integration tests use disposable profiles, synthetic authentication, actual selected API routes and local PostgreSQL/PGlite; no real user profile or live cloud data was migrated. No dependency installation, `.env` edit, commit, push or deployment was performed.
