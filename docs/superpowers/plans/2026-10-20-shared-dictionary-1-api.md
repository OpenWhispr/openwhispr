# Shared Dictionary — Part 1: API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side shared dictionary lists, one per workspace and one per space, with per-user hides, a Business/Enterprise gate, SSO enforcement, and an atomic "move personal word to shared" that can never make any client lose the word.

**Architecture:** Two new tables (`shared_dictionary_entries`, `shared_dictionary_hides`) plus a `shared_at` column on `dictionary_entries`. A new `lib/shared-dictionary-service.ts` holds all queries. Thin route files live under `api/shared-dictionary/`. Access requires workspace membership plus the workspace's company-SSO rule, checked once before any list is resolved. Space lists also require direct or team membership, never implied by an owner/admin role.

A "moved" personal word is **never tombstoned**. Its `dictionary_entries` row stays live with `shared_at` set, so every client, old or new, keeps applying it. New clients just hide it from the Personal list while its shared copy exists. Delta cursors older than the tombstone retention are refused, so a long-offline client re-snapshots instead of going stale.

**Tech Stack:** Vercel serverless TypeScript (ESM, `.js` import suffixes), Neon Postgres via `sql` templates, zod (`lib/schemas.ts`), `node:test` + PGlite.

**Spec:** `openwhispr/docs/superpowers/specs/2026-10-20-shared-dictionary-design.md`

**Repo:** `/Users/chadpiha/Development/openWhispr/openwhispr-api`. Branch from `origin/main` in a sibling worktree (`git worktree add ../openwhispr-api-shared-dictionary -b feat/shared-dictionary origin/main`); the main checkout is on another branch with WIP.

## Global Constraints

- Plan gate: workspace `plan` ∈ {`business`, `enterprise`} and `status` ∈ `ENTITLED_SUBSCRIPTION_STATUSES` (`active`, `trialing`). Pro does **not** qualify, so never use `hasActiveWorkspaceSubscription` for this.
- Space membership for shared lists = a `space_members` row, OR membership of a live team assigned through `space_teams`. In both cases the user must also have a `workspace_members` row and the space must have `deleted_at IS NULL`. Workspace owner/admin role alone grants **nothing** here.
- Any member of a list may add, edit, delete and restore its words. There is no approval step.
- Shared-dictionary writes are **exempt** from `enforceCloudBackup`; never call it in these routes.
- Words: trimmed, 1–100 characters (same as `dictionaryBatchCreateSchema`). Uniqueness is case-insensitive per list. A tombstone reserves its word and is revived on re-add.
- Per-list cap: `MAX_SHARED_DICTIONARY_PER_LIST = 2000` live words.
- SSO: `resolveSharedDictionaryAccess` calls `isWorkspaceSsoSessionAuthorized({ workspaceId, userId, sessionId, isOwner: role === "owner" })` (`lib/sso-enforcement.ts:144`) and refuses with 403 `SSO_REQUIRED` (the existing code string) before resolving any list. This covers reads, writes and hides alike.
- A personal entry is never tombstoned by sharing. Personal list responses carry `shared_at` for every client. The v1 API is unchanged: `toV1DictionaryEntry` already whitelists fields.
- Cursor retention: shared list and hides deltas whose `since` is older than `SHARED_DICTIONARY_CURSOR_MAX_AGE_DAYS = 29` are refused with 410 `SHARED_DICTIONARY_CURSOR_EXPIRED`. Tombstones are purged at 30 days.
- Capacity-changing writes (add, share, restore) take `pg_advisory_xact_lock(hashtextextended(workspace_id::text || ':' || COALESCE(space_id::text, 'workspace'), 0))` for each target list inside one `withDbTransaction`, count live rows **after** the lock, and count only real additions and revivals.
- The new migration is numbered **092** (091 is taken twice on other branches).
- Error codes: `SHARED_DICTIONARY_PLAN_REQUIRED` (403), `SSO_REQUIRED` (403), `SHARED_DICTIONARY_NOT_MEMBER` (404), `SHARED_DICTIONARY_ALREADY_IN_LIST` (409), `SHARED_DICTIONARY_PERSONAL_CHANGED` (409), `SHARED_DICTIONARY_LIST_FULL` (400), `SHARED_DICTIONARY_CURSOR_EXPIRED` (410).
- Follow the existing route pattern: `setCorsHeaders` → `handleCorsPreflightRequest` → `validateMethod` → `authenticateRequest` → `parseBody(schema)`. Map a `SharedDictionaryServiceError(message, status, code)` to `res.status(status).json({ error, code })`.
- Commit only when the user has authorized commits for this execution, and never push. Use conventional commit messages.
- Verify with `npm test`, `npm run lint` and `npm run test:schema:check` before calling a task done.

## Review Focus

1. **Two members add the same word to a list at the same moment.** Expect one live row, both calls succeed, and no 409 or 500.
2. **An old client, or the v1 API, pulls the personal list right after a word was shared.** Expect the word to arrive live, carrying `shared_at` and no `deleted_at`.
3. **Someone removed from a space (or whose team was unassigned) calls the list endpoint.** Expect that space's words to be absent and its scope missing from `scopes`.
4. **A workspace owner who isn't a member of a space.** Expect that space absent from their `scopes`, and writes to it refused with 404.
5. **A member of a `require_sso` Enterprise workspace signed in without SSO.** Expect list, create and hide on the workspace list all refused with 403 `SSO_REQUIRED`, while the owner is allowed.
6. **A device returning after 31 days offline.** Expect its delta to be refused with 410, so it re-snapshots.

---

### Task 1: Migration 092 and test schema

**Files:**
- Create: `migrations/092_shared_dictionary.sql`
- Modify: `scripts/generate-test-schema.mjs` (add `029_dictionary.sql` and `092_shared_dictionary.sql` to `INCLUDED_MIGRATIONS`; remove 029 from `REVIEWED_OMISSIONS`)
- Regenerate: `lib/__tests__/helpers/test-schema.sql`
- Modify: `lib/__tests__/account-deletion-pglite.test.ts:~226` (drop its hand-made `dictionary_entries` stub now that the real table is in the schema)

**Interfaces — Produces:**
- `shared_dictionary_entries`:
  - `id UUID PK DEFAULT gen_random_uuid()`
  - `workspace_id UUID NOT NULL REFERENCES workspaces ON DELETE CASCADE`
  - `space_id UUID NULL REFERENCES spaces ON DELETE CASCADE` (NULL = workspace list)
  - `word TEXT NOT NULL`
  - `added_by_user_id TEXT REFERENCES "user" ON DELETE SET NULL`
  - `updated_by_user_id TEXT REFERENCES "user" ON DELETE SET NULL`
  - `created_at`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `deleted_at TIMESTAMPTZ`
  - Unique index `idx_shared_dict_list_word ON (workspace_id, COALESCE(space_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(word))`. It is non-partial, matching personal.
  - Index `idx_shared_dict_ws_updated ON (workspace_id, updated_at, id)`.
- `shared_dictionary_hides`:
  - `user_id TEXT NOT NULL REFERENCES "user" ON DELETE CASCADE`
  - `entry_id UUID NOT NULL REFERENCES shared_dictionary_entries ON DELETE CASCADE`
  - `workspace_id UUID NOT NULL`
  - `created_at`, `updated_at`, `deleted_at` (a tombstone = unhidden)
  - `PRIMARY KEY (user_id, entry_id)`
  - Index `(user_id, workspace_id, updated_at, entry_id)`.
- `ALTER TABLE dictionary_entries ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;`. NULL means an ordinary personal word; set means moved into a shared list. The row stays live either way.

- [ ] **Step 1:** Write the migration with the standard header block (`-- Migration: 092_shared_dictionary`, Description, Date `2026-10-20`) inside `BEGIN; … COMMIT;`.
- [ ] **Step 2:** Update `generate-test-schema.mjs`, then run `npm run test:schema:generate`. Expected: `test-schema.sql` contains both new tables and `dictionary_entries.shared_at`.
- [ ] **Step 3:** Remove the stub from `account-deletion-pglite.test.ts`, then run `npm run test:schema:check && npm test`. Expected: PASS.
- [ ] **Step 4:** Commit: `feat(dictionary): add shared dictionary tables (092)`.

### Task 2: Access helpers

**Files:**
- Modify: `lib/workspaces.ts` (next to `hasActiveEnterpriseEntitlement`, L177)
- Modify: `lib/space-access.ts`
- Test: `lib/__tests__/shared-dictionary-access.test.ts`

**Interfaces — Produces:**
- `export const SHARED_DICTIONARY_PLANS = ["business", "enterprise"]`
- `export function hasSharedDictionaryEntitlement(workspace: Pick<Workspace, "plan" | "status"> | null | undefined): boolean`
- `export async function getMemberSpaceIds(userId: string, workspaceId: string): Promise<string[]>`. Returns spaces in the workspace where the user is a direct or team member (Global Constraints). It does no SSO check itself; Task 3's `resolveSharedDictionaryAccess` enforces SSO once for every list.

- [ ] **Step 1: Write the failing tests.**
  - Pure:
    - `hasSharedDictionaryEntitlement({plan:"business",status:"active"})` → true
    - `{plan:"enterprise",status:"trialing"}` → true
    - `{plan:"pro",status:"active"}` → false
    - `{plan:"business",status:"canceled"}` → false
    - `null` → false
  - PGlite (seed one workspace, spaces A and B, team T assigned to B; user U is direct in A and in T; owner O is in neither; a user R is in T but has no `workspace_members` row):
    - `getMemberSpaceIds(U, ws)` deep-equals `[A, B]` (sorted)
    - `getMemberSpaceIds(O, ws)` → `[]`
    - `getMemberSpaceIds(R, ws)` → `[]`
    - after soft-deleting team T, U gets `[A]`
    - after setting `spaces.deleted_at` on A, U gets `[]` (with T still deleted)
- [ ] **Step 2:** Run `node --import tsx --test lib/__tests__/shared-dictionary-access.test.ts`. Expected: FAIL (not exported).
- [ ] **Step 3:** Implement both functions.
- [ ] **Step 4:** Run the test again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): shared dictionary entitlement and membership helpers`.

### Task 3: Shared dictionary service: reads, writes, restore, cap

**Files:**
- Create: `lib/shared-dictionary-service.ts`
- Test: `lib/__tests__/shared-dictionary-service.test.ts` (PGlite)

**Interfaces — Consumes:** `hasSharedDictionaryEntitlement`, `getMemberSpaceIds` (Task 2), `getWorkspace`, `getUserWorkspaceRole` (`lib/workspaces.ts`), `withDbTransaction` (`lib/db.ts:46`), `isUniqueViolation` (`lib/pg-errors.js`).

**Interfaces — Produces:**
```ts
export class SharedDictionaryServiceError extends Error { constructor(message: string, status: number, code: string) }
export const MAX_SHARED_DICTIONARY_PER_LIST = 2000;
export interface SharedDictionaryEntry { id: string; workspace_id: string; space_id: string | null; word: string; added_by_user_id: string | null; created_at: string; updated_at: string; deleted_at: string | null }
export interface SharedDictionaryScope { space_id: string | null; name: string; member_count: number; word_count: number }
export interface SharedDictionaryContributor { user_id: string; name: string | null; is_member: boolean }
export interface SharedDictionaryAccess { workspaceId: string; entitled: boolean; memberSpaceIds: string[] }
export const SHARED_DICTIONARY_CURSOR_MAX_AGE_DAYS = 29;
export async function resolveSharedDictionaryAccess(userId: string, sessionId: string | null, workspaceId: string): Promise<SharedDictionaryAccess>   // 404 NOT_MEMBER when not a workspace member; 403 SSO_REQUIRED when the workspace's SSO rule rejects the session (owner exempt)
export function assertListWritable(access: SharedDictionaryAccess, spaceId: string | null): void                                                  // throws 403 PLAN_REQUIRED / 404 NOT_MEMBER
export async function listSharedDictionary(access: SharedDictionaryAccess, opts: { limit: number; since?: string; sinceId?: string; cursor?: string; cursorId?: string }): Promise<{ entries: SharedDictionaryEntry[]; hasMore: boolean; scopes: SharedDictionaryScope[]; contributors: SharedDictionaryContributor[]; paused: boolean }>
export async function addSharedWords(access: SharedDictionaryAccess, userId: string, spaceId: string | null, words: string[], sql?: Db): Promise<{ created: SharedDictionaryEntry[]; alreadyPresent: string[] }>
export async function updateSharedWord(access: SharedDictionaryAccess, userId: string, entryId: string, word: string): Promise<SharedDictionaryEntry>
export async function deleteSharedWords(access: SharedDictionaryAccess, userId: string, entryIds: string[]): Promise<{ deletedIds: string[] }>
export async function restoreSharedWords(access: SharedDictionaryAccess, userId: string, entryIds: string[]): Promise<{ restored: SharedDictionaryEntry[]; conflicts: string[] }>
async function lockLists(sql: Db, workspaceId: string, spaceIds: Array<string | null>): Promise<void>   // advisory xact lock per list, sorted to avoid deadlocks
```
Semantics the tests pin:
- `listSharedDictionary`:
  - Rows are limited to the workspace list (`space_id IS NULL`) plus `memberSpaceIds`.
  - Paging copies the `(updated_at, id)` delta (tombstones included) and `(created_at, id)` snapshot (live only) logic from `lib/dictionary-service.ts` (`toPage`, limit+1).
  - A `since` older than `SHARED_DICTIONARY_CURSOR_MAX_AGE_DAYS` throws 410 `CURSOR_EXPIRED`.
  - `scopes` is always the workspace list (name = workspace name, `member_count` = workspace member count) plus each member space (`name`, `SPACE_MEMBER_COUNT_SQL`), each with its live `word_count`.
  - `contributors` covers the distinct `added_by_user_id` of the returned page, with `is_member` = has a `workspace_members` row.
  - `paused` = `!access.entitled`.
- `addSharedWords`:
  - `INSERT … ON CONFLICT (workspace_id, COALESCE(space_id, zero_uuid), lower(word)) DO UPDATE` revives tombstones (`deleted_at = NULL`, `updated_at = now()`, `updated_by_user_id`) and keeps the existing spelling for live rows.
  - A live word that was already present goes to `alreadyPresent` and isn't counted as created.
  - Runs in a transaction behind `lockLists`. After the lock, live rows + real additions (new rows + revived tombstones) must stay ≤ the cap, else it throws 400 `LIST_FULL` and writes nothing.
- `updateSharedWord` throws 409 `ALREADY_IN_LIST` when the new word collides (case-insensitive, tombstones included), and 404 for an entry outside the access.
- `deleteSharedWords`, in one transaction, soft-deletes the entries and tombstones every live hide of them.
- `restoreSharedWords` clears `deleted_at` behind `lockLists`, and returns ids whose word is now live in another row as `conflicts`. If restoring would push a list over the cap, it throws `LIST_FULL` and restores nothing.
- Every write calls `assertListWritable` for each target list first.

- [ ] **Step 1: Write the failing tests** (seed as in Task 2, with the workspace on `business`/`active`):
  - `list returns workspace list plus member spaces only`: U sees words in the workspace list, A and B. O sees only the workspace list. `scopes.map(s => s.space_id)` for O deep-equals `[null]`.
  - `concurrent adds of the same word create one row`: `Promise.all([addSharedWords(..., ["Qdrant"]), addSharedWords(..., ["qdrant"])])` gives exactly one live row, spelled `Qdrant` or `qdrant`, and neither call throws.
  - `re-adding a deleted word revives it`: after add → delete → add, the same `id` is live again.
  - `update to an existing word throws ALREADY_IN_LIST`: assert `code === "SHARED_DICTIONARY_ALREADY_IN_LIST"` and `status === 409`.
  - `delete tombstones hides`: after hiding as U and deleting as another member, U's hide row has `deleted_at` set.
  - `downgraded workspace is paused and read-only`:
    - set `plan = 'pro'`
    - list returns the words with `paused === true`
    - `addSharedWords` throws `code === "SHARED_DICTIONARY_PLAN_REQUIRED"`
  - `owner cannot write to a space they are not in`: `addSharedWords(accessOf(O), O, A, ["x"])` throws `SHARED_DICTIONARY_NOT_MEMBER`.
  - `cap`: with `MAX_SHARED_DICTIONARY_PER_LIST` live rows seeded via SQL, one more add throws `SHARED_DICTIONARY_LIST_FULL`.
  - `two writers compete for the last slot`:
    - seed cap − 1 live rows
    - `Promise.allSettled([add(["a"]), add(["b"])])` → exactly one fulfilled, one rejected with `LIST_FULL`
    - live count === cap
  - `restore into a full list throws LIST_FULL and restores nothing`.
  - `alreadyPresent words don't use capacity`: at cap, adding an existing word succeeds with it in `alreadyPresent`.
  - `expired cursor`: a delta with `since` 30 days ago throws `code === "SHARED_DICTIONARY_CURSOR_EXPIRED"`, `status === 410`.
  - `SSO`:
    - On an enterprise `require_sso` workspace, a member with no `workspace_sso_sessions` provenance gets `resolveSharedDictionaryAccess` throwing `SSO_REQUIRED`.
    - The owner without provenance resolves.
    - A member with provenance resolves.
  - `contributors flag former members`: a word added by a user later deleted from `workspace_members` has `is_member === false` in `contributors`.
  - `delta includes tombstones; snapshot excludes them`.
- [ ] **Step 2:** Run the test file. Expected: FAIL.
- [ ] **Step 3:** Implement the service.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): shared dictionary service`.

### Task 4: Hides and the move-to-shared operation

**Files:**
- Modify: `lib/shared-dictionary-service.ts`
- Test: `lib/__tests__/shared-dictionary-service.test.ts` (extend)

**Interfaces — Produces:**
```ts
export interface SharedDictionaryHide { entry_id: string; workspace_id: string; updated_at: string; deleted_at: string | null }
export async function setHidden(access: SharedDictionaryAccess, userId: string, entryIds: string[], hidden: boolean): Promise<SharedDictionaryHide[]>
export async function listHides(userId: string, workspaceId: string, opts: { limit: number; since?: string; sinceId?: string; cursor?: string; cursorId?: string }): Promise<{ hides: SharedDictionaryHide[]; hasMore: boolean }>   // snapshot mode = live hides only; expired since → 410
export interface SharePersonalRef { id: string; word: string }
export async function shareWords(access: SharedDictionaryAccess, userId: string, input: { targets: Array<string | null>; personal: SharePersonalRef[]; words: string[] }): Promise<{ created: SharedDictionaryEntry[]; alreadyPresent: Array<{ space_id: string | null; word: string }>; movedPersonalIds: string[] }>
// `personal` = synced personal rows being moved (id + the word the client saw); `words` = extra words with no cloud row (local-only personal words).
```
- `setHidden(..., true)` upserts the hide row with `deleted_at = NULL`, and `false` tombstones it. Paused access throws `PLAN_REQUIRED`. Hiding an entry outside the access throws `NOT_MEMBER`.
- Hiding (`true`), and `deleteSharedWords` called by a user, also tombstone **that user's own** live personal rows with `shared_at IS NOT NULL` and the same `lower(word)`. This happens in the same transaction, so a word the user moved and then hid or deleted doesn't come back as their personal fallback.
- `shareWords`, in **one** `withDbTransaction` behind `lockLists(targets)`:
  1. `SELECT … FOR UPDATE` the user's `dictionary_entries` rows for `personal[].id`.
  2. If any row is missing, tombstoned, or its `lower(word)` ≠ `lower(ref.word)`, throw 409 `PERSONAL_CHANGED` with `details.conflicts: SharePersonalRef[]`. Nothing is written.
  3. `addSharedWords` every word (personal + `words`) into every target.
  4. Set `shared_at = now(), updated_at = now()` on the locked personal rows, and return them as `movedPersonalIds`.
  - It **never** sets `deleted_at` on personal rows. An id belonging to another user counts as missing, giving `PERSONAL_CHANGED`.

- [ ] **Step 1: Write the failing tests:**
  - `hide and unhide round-trip via listHides delta`, plus `listHides snapshot returns live hides only`.
  - `shareWords is atomic`: with target B at its cap, `shareWords` into `[null, B]` throws `LIST_FULL`, the workspace list has no new row, and the personal row's `shared_at` is still null.
  - `shareWords marks personal rows shared without tombstoning`: afterwards the personal row has `deleted_at === null` and `shared_at !== null`.
  - `shareWords refuses a renamed personal entry`:
    - rename personal X from "Qdrant" to "Postgres" via `updateEntry`
    - `shareWords({ personal: [{ id: X, word: "Qdrant" }] })` throws `PERSONAL_CHANGED` with `conflicts[0].id === X`
    - no shared row exists and X's `shared_at` is null
  - `shareWords treats another user's personal id as changed`.
  - `hiding a word I moved tombstones my moved personal row`: after a share and then `setHidden(true)`, the row has `deleted_at` set. Another member's moved row with the same word is untouched.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): shared word hides and move-to-shared`.

### Task 5: Personal dictionary exposes `shared_at`

**Files:**
- Modify: `lib/dictionary-service.ts` (`DictionaryEntry` L6–15, `upsertEntry` L135), `lib/schemas.ts` (`dictionaryBatchCreateSchema`)
- Test: `lib/__tests__/dictionary-shared-compat.test.ts` (PGlite), `lib/__tests__/v1-vocabulary-handlers.test.ts` (extend)

**Interfaces — Produces:**
- `DictionaryEntry` gains `shared_at: string | null`, returned by `listDictionary` in delta and snapshot alike. Moved rows are ordinary live rows.
- `upsertEntry` that revives or re-adds a live word **from a plain add** clears `shared_at`. The word is personal again.
- `dictionaryBatchCreateSchema` entries accept an optional `shared_at` (ISO string). It's used when a word that was moved locally, without a cloud row, is first pushed.
- `MAX_DICTIONARY_PER_USER` counting is unchanged (moved rows are live personal rows).

- [ ] **Step 1: Write the failing tests:**
  - `a moved word stays live in delta and snapshot with shared_at`
  - `re-adding a moved word clears shared_at`
  - `batch-create accepts shared_at`
  - `v1 list response has no shared_at field and still lists the moved word` (v1 is unchanged)
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the new file and `v1-vocabulary-handlers.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): expose shared_at on personal entries`.

### Task 6: Routes

**Files:**
- Create in `api/shared-dictionary/`:
  - `list.ts` (GET)
  - `create.ts` (POST)
  - `update.ts` (PATCH)
  - `delete.ts` (DELETE)
  - `restore.ts` (POST)
  - `share.ts` (POST)
  - `hide.ts` (POST)
  - `hides.ts` (GET)
- Modify: `lib/schemas.ts` (next to `dictionaryBatchCreateSchema`, L498–528)
- Test: `lib/__tests__/shared-dictionary-handlers.test.ts` (handler tests in the style of `v1-vocabulary-handlers.test.ts`)

**Interfaces — Produces (wire contract used by desktop and mobile):**

| Route | Request | 2xx response |
|---|---|---|
| `GET /api/shared-dictionary/list` | query `workspace_id` (uuid, required), `since`/`since_id` or `cursor`/`cursor_id`, `limit` (default 200, max 500) | 200 `{ entries, hasMore, scopes, contributors, paused }` |
| `POST /api/shared-dictionary/create` | `{ workspace_id, space_id: uuid \| null, words: string[1..200] }` | 201 `{ created, alreadyPresent }` |
| `PATCH /api/shared-dictionary/update` | `{ workspace_id, id, word }` | 200 entry |
| `DELETE /api/shared-dictionary/delete` | `{ workspace_id, ids: uuid[1..200] }` | 200 `{ deletedIds }` |
| `POST /api/shared-dictionary/restore` | `{ workspace_id, ids: uuid[1..200] }` | 200 `{ restored, conflicts }` |
| `POST /api/shared-dictionary/share` | `{ workspace_id, targets: (uuid \| null)[1..20], personal: {id: uuid, word}[0..200], words: string[0..200] }` (personal + words between 1 and 200 in total) | 200 `{ created, alreadyPresent, movedPersonalIds }`; 409 `SHARED_DICTIONARY_PERSONAL_CHANGED` `{ error, code, conflicts }` |
| `POST /api/shared-dictionary/hide` | `{ workspace_id, ids: uuid[1..200], hidden: boolean }` | 200 `{ hides }` |
| `GET /api/shared-dictionary/hides` | query `workspace_id`, `since`/`since_id` or `cursor`/`cursor_id`, `limit` | 200 `{ hides, hasMore }` |

- `list` and `hides` also return `server_time` (an ISO timestamp taken before the query). After a complete pass (`hasMore: false`), clients store it as their next `since`, and still apply the 10-second read overlap. A quiet list therefore never ages into a 410.
- `list` and `hides` answer 410 `SHARED_DICTIONARY_CURSOR_EXPIRED` for a `since` older than 29 days.

**Contract notes for clients (as built):**
- `create` requires `space_id` to be present: send `null` explicitly for the workspace list.
- An unparseable `since`, `cursor` or `*_id` gives 400 `SHARED_DICTIONARY_INVALID_CURSOR`.
- Query and body validation 400s carry `{ error }` only, with no `code`.
- Paging cursors:
  - entries' snapshot pages on `(created_at, id)`
  - `hides` snapshot pages on `(updated_at, entry_id)`; use the last row's values as `cursor`/`cursor_id`
- `delete`, `restore` and `hide` silently skip ids outside the caller's lists, and ids already deleted.
- `share.alreadyPresent` is `{ space_id, word }[]`; `create.alreadyPresent` is `string[]`.
- Entries carry `added_by_user_id`; a revived word is re-attributed to the member who revived it.
- There is no per-list snapshot: when `scopes` gains a list (a member added to a space, a restored space, a team assigned), the client re-snapshots the workspace and replaces its local copy.
- `DELETE` takes a JSON body. Every route answers 403 `SSO_REQUIRED` when the workspace's SSO rule rejects the session.

- Each route does `resolveSharedDictionaryAccess(auth.userId, auth.sessionId, workspace_id)`, then calls the service. It never calls `enforceCloudBackup`. Errors go out as `{ error, code }` with the service status.

- [ ] **Step 1: Write the failing handler tests:**
  - `list without workspace_id is 400`
  - `list for a non-member is 404 SHARED_DICTIONARY_NOT_MEMBER`
  - `create on a pro workspace is 403 SHARED_DICTIONARY_PLAN_REQUIRED`
  - `create succeeds for a member whose org policy blocks cloud backup` (seed a policy with `cloudBackupAllowed: false`)
  - `share returns movedPersonalIds`
  - `share with a stale personal word is 409 with conflicts`
  - `hides without SSO provenance on a require_sso workspace is 403 SSO_REQUIRED`
  - `list with a 30-day-old since is 410`
  - `update collision is 409 with code SHARED_DICTIONARY_ALREADY_IN_LIST`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Add the zod schemas `sharedDictionaryCreateSchema`, `…UpdateSchema`, `…DeleteSchema`, `…RestoreSchema`, `…ShareSchema` and `…HideSchema`, and the eight routes.
- [ ] **Step 4:** Run `npm test && npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): shared dictionary endpoints`.

### Task 7: Tombstone purge and account deletion

**Files:**
- Modify: `api/cron/purge-tombstones.ts` (next to the `dictionary_entries` delete at L33; add both tables to the log at L45 and the JSON at L49)
- Test: `lib/__tests__/account-deletion-pglite.test.ts` (extend)

- [ ] **Step 1: Write the failing test** `deleting an account keeps its shared words and clears attribution`. Seed a shared word added by U and a hide by U, then run `deleteAccountData(sql, U)`. Assert the word is live with `added_by_user_id === null`, and U's hide rows are gone.
- [ ] **Step 2:** Run. Expected: PASS already if the Task 1 FKs are right. If it fails, fix the FKs in 092; don't add manual deletes.
- [ ] **Step 3:** Add purge statements for `shared_dictionary_entries` and `shared_dictionary_hides` where `deleted_at < NOW() - INTERVAL '30 days'`.
- [ ] **Step 4:** Run `npm test && npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit: `chore(dictionary): purge shared dictionary tombstones`.

**Tombstone purge vs. cursors:** the 30-day purge is safe only because Task 3 refuses deltas older than 29 days, which forces a snapshot. Keep the two numbers in step.

**Deploy note:** apply `092` with `node scripts/run-migration.mjs <branch> migrations/092_shared_dictionary.sql` before deploying the routes. Desktop and mobile treat a 404 from `/api/shared-dictionary/list` as "feature unavailable", so either order is safe.
