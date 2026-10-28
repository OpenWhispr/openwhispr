# Shared Dictionary — Part 2: Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop app syncs the active workspace's shared dictionary lists and the member's hides, merges them into every dictionary consumer with personal words first, and gives the Dictionary page a list picker with sharing, multi-select, hide, delete-for-everyone, the blocked states and a one-time arrival toast.

**Architecture:**
- **Data:** shared words are mirrored into three SQLite tables in the main process. A new `SyncService.syncSharedDictionary` pass fills them through the Part 1 endpoints.
- **Dictation:** a pure selector turns local rows into `SharedHintWords { space, workspace }`, which the settings store persists to localStorage. This is the existing cross-window mirror, so the dictation window gets it too. `getDictionaryHintTiers` ranks personal + snippet triggers → space → workspace, and `formatDictionaryPrompt` keeps the highest tier at the prompt's tail.
- **Writes:** writes to shared lists go online through `src/services/sharedDictionaryActions.ts`, which applies the server's answer locally so any window can use them.
- **Moved words:** "Share" never deletes the personal word. Its row gets `shared_at`, locally and on the server. The Personal list hides it while its shared copy exists, and it keeps applying at personal priority, so the user never loses it.
- **Safety:** a pass only publishes hints if the account/workspace generation it started under is still current.

**Tech Stack:** Electron 41, React 19, TypeScript, Tailwind v4, better-sqlite3, react-i18next, `node --test` (+ Vite SSR / happy-dom harness for components).

**Spec:** `docs/superpowers/specs/2026-10-20-shared-dictionary-design.md`. **Depends on:** Part 1 (`docs/superpowers/plans/2026-10-20-shared-dictionary-1-api.md`). Its route table is the wire contract used here.

## Global Constraints

- Branch from `origin/main` (e.g. `feat/shared-dictionary`), not the current branch. Use Node 24 (`nvm exec 24`). Never regenerate `package-lock.json` with another major version.
- Sharing never deletes or tombstones a personal word. A moved word (`custom_dictionary.shared_at` set) stays in every hint consumer at personal priority. The Personal list hides it only while the active workspace's snapshot has a live shared entry with the same `lower(word)`; otherwise it shows as a normal personal word.
- Published hints always belong to the current account and active workspace: on any change of either, the hints are emptied at once, and a sync pass or load that started under an older generation never publishes.
- Plan gate: `plan` ∈ {`business`, `enterprise`}, `status` ∈ {`active`, `trialing`}. Never use `hasActiveWorkspaceSubscription` for this, since it counts Pro.
- Only the active workspace (`localStorage.activeWorkspaceId`, `workspaceStore.activeWorkspaceId`) contributes shared words. Space membership is whatever the server's `scopes` say; the client never infers it from `my_role`.
- Priority: personal words and snippet triggers, then space words, then workspace words. Dedupe is case-insensitive, and the first occurrence wins, so personal spelling wins. Hidden words and paused words never reach any consumer.
- Shared sync runs whenever the user is signed in and a workspace is active. It never depends on `canSync()` (cloud backup).
- Every new UI string is added to all 11 locale files (`src/locales/{ar,de,en,es,fr,it,ja,pt,ru,zh-CN,zh-TW}/translation.json`) under `dictionary.shared.*`. `test/locales/translationCoverage.test.js` must pass.
- Icons come from `src/components/icons`. `EyeOff` doesn't exist and the Nucleo sync can't run on this machine, so hand-draw it in `src/components/icons/primitives.tsx` (re-exported from `index.ts`), following the existing primitives.
- UI follows the approved mockups (`.superpowers/brainstorm/25375-1792486893/content/page-layout-v3b.html`, `share-and-join.html` parts 1–2, `multi-select.html`, `action-bar-position.html` option A, `new-member-moment-v2.html` toast only, `gated-states-v3.html`):
  - rows 38px tall
  - small radii
  - only Delete for everyone is red
- Commit only when the user has authorized commits for this execution, and never push. Use conventional commits.
- After each task, run `npm test`, `npm run typecheck` and `npm run lint`. DB tests skip locally when the native binding doesn't match. That's expected; CI runs them.

## Review Focus

1. **The same word in Personal and in a shared list, with different case** ("OpenWhispr" / "Openwhispr"). The prompt contains it once, in the personal spelling.
2. **A long team list on local Whisper or Groq.** Every personal word and snippet trigger survives in the sent prompt's tail, and shared words are dropped from the head.
3. **Removed from a space while the app is open.** After the next sync, that space's words are gone from the DB, the hints and the left column.
4. **The active workspace switches.** Hints and the page switch to the new workspace's lists at once, with no restart.
5. **The API doesn't have the endpoints yet** (plain 404). There are no error toasts, the Shared group is hidden, and personal dictionary behaviour is unchanged.
6. **A slow sync pass for workspace A finishes after the user switched to B** (or `workspaceStore.refresh()` re-selected or cleared the workspace). B's hints, or the empty hints, stay in place.
7. **Sharing 450 words where the second chunk fails.** The first 200 show as shared, the other 250 stay in Personal, and the toast says how many weren't shared.

---

### Task 1: API client and capability

**Files:**
- Create: `src/services/SharedDictionaryService.ts`
- Test: `test/services/sharedDictionaryService.test.js`

**Interfaces — Produces:**
```ts
export interface CloudSharedEntry { id: string; workspace_id: string; space_id: string | null; word: string; added_by_user_id: string | null; created_at: string; updated_at: string; deleted_at: string | null }
export interface SharedScope { space_id: string | null; name: string; member_count: number; word_count: number }
export interface SharedContributor { user_id: string; name: string | null; is_member: boolean }
export interface CloudSharedHide { entry_id: string; workspace_id: string; updated_at: string; deleted_at: string | null }
export const SharedDictionaryService: {
  list(workspaceId: string, page: { since?: string; sinceId?: string; cursor?: string; cursorId?: string; limit?: number }): Promise<{ entries: CloudSharedEntry[]; hasMore: boolean; scopes: SharedScope[]; contributors: SharedContributor[]; paused: boolean; server_time: string }>;
  hides(workspaceId: string, page: { since?: string; sinceId?: string; cursor?: string; cursorId?: string; limit?: number }): Promise<{ hides: CloudSharedHide[]; hasMore: boolean; server_time: string }>;
  create(workspaceId: string, spaceId: string | null, words: string[]): Promise<{ created: CloudSharedEntry[]; alreadyPresent: string[] }>;
  update(workspaceId: string, id: string, word: string): Promise<CloudSharedEntry>;
  remove(workspaceId: string, ids: string[]): Promise<{ deletedIds: string[] }>;
  restore(workspaceId: string, ids: string[]): Promise<{ restored: CloudSharedEntry[]; conflicts: string[] }>;
  share(workspaceId: string, input: { targets: Array<string | null>; personal: Array<{ id: string; word: string }>; words: string[] }): Promise<{ created: CloudSharedEntry[]; alreadyPresent: Array<{ space_id: string | null; word: string }>; movedPersonalIds: string[] }>;
  hide(workspaceId: string, ids: string[], hidden: boolean): Promise<{ hides: CloudSharedHide[] }>;
};
```
Paths, methods and bodies are exactly as in Part 1's route table, built on `cloudGet`, `cloudPost`, `cloudPatch` and `cloudDelete` (`src/services/cloudApi.ts`). Each method sends **one** request. More than 200 words or ids throws a `RangeError` before any request. Chunking and partial results belong to the actions (Task 6).

- [ ] **Step 1: Write the failing tests** (with `cloudApi` mocked):
  - `list` calls `GET /api/shared-dictionary/list?workspace_id=W&since=S&since_id=I&limit=200`.
  - `share` posts `{ workspace_id, targets, personal: [{id, word}], words }`.
  - `create` with 201 words throws `RangeError` and sends nothing.
- [ ] **Step 2:** Run `node --import tsx --test test/services/sharedDictionaryService.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): shared dictionary API client`.

### Task 2: Local tables, DB methods, IPC

**Files:**
- Modify: `src/helpers/database.js`. Add `CREATE TABLE IF NOT EXISTS` in `initDatabase()` (starts L328), with methods next to the dictionary methods (~L2430–2760).
- Modify: `src/helpers/ipcHandlers.js` (next to the `db-*-dictionary` handlers, ~L2111–2161), `preload.js` (~L198–205, ~L1276–1286), `src/types/electron.ts` (~L1663, ~L3717)
- Test: `test/helpers/sharedDictionaryDatabase.test.js`, using the `createDb(t)` skip pattern from `test/helpers/dictionaryDatabase.test.js:29-60`

**Interfaces — Produces:**
- Tables:
  - `shared_dictionary_entries(cloud_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, space_id TEXT, word TEXT NOT NULL, added_by_user_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`, indexed on `workspace_id`
  - `shared_dictionary_hides(entry_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, updated_at TEXT NOT NULL)`; a row = hidden
  - `shared_dictionary_meta(workspace_id TEXT PRIMARY KEY, scopes_json TEXT NOT NULL, contributors_json TEXT NOT NULL, paused INTEGER NOT NULL, synced_at TEXT NOT NULL)`
- `custom_dictionary` gains `shared_at TEXT`, using the `ALTER TABLE … ADD COLUMN` + duplicate-column catch pattern at L1200–1235:
  - `upsertDictionaryFromCloud` (L2656) stores the cloud `shared_at`
  - `getPendingDictionary` (L2591) returns it, so batch-create pushes it
  - a local re-add of the word (`_upsertDictionaryWord`) clears it
- `SharedDictionarySnapshot` (in `src/types/electron.ts`):
  ```ts
  { entries: Array<{ cloudId: string; spaceId: string | null; word: string; addedByUserId: string | null; createdAt: string; updatedAt: string }>;
    hiddenIds: string[];
    meta: { scopes: SharedScope[]; contributors: SharedContributor[]; paused: boolean; syncedAt: string } | null }
  ```
- DB methods, each with an IPC handler and preload name in parentheses:
  - `getSharedDictionary(workspaceId: string): SharedDictionarySnapshot` (`db-shared-dictionary-get` / `getSharedDictionary`)
  - `applySharedDictionaryPull(workspaceId: string, change: { upserts: CloudSharedEntry[]; deletedIds: string[]; meta?: { scopes; contributors; paused } }): { changed: number }` (`db-shared-dictionary-apply-pull` / `applySharedDictionaryPull`). When `meta` is present, it also deletes entries whose non-null `space_id` isn't in `meta.scopes`, and hides of entries that no longer exist.
  - `replaceSharedDictionary(workspaceId: string, full: { entries: CloudSharedEntry[]; meta: { scopes; contributors; paused } }): { changed: number }` (`db-shared-dictionary-replace`). In one transaction, the workspace's entries become exactly `full.entries`, the meta is replaced, and hides of entries that no longer exist are deleted. Used for snapshots.
  - `applySharedDictionaryHides(workspaceId: string, change: { hidden: Array<{ entryId: string; updatedAt: string }>; unhidden: string[] }): { changed: number }` (`db-shared-dictionary-apply-hides`)
  - `replaceSharedDictionaryHides(workspaceId: string, hidden: Array<{ entryId: string; updatedAt: string }>): void` (`db-shared-dictionary-replace-hides`)
  - `clearSharedDictionary(workspaceId?: string): void`; with no argument it clears everything (`db-shared-dictionary-clear`)
  - `getDictionaryEntriesByWords(words: string[]): Array<{ word: string; cloudId: string | null }>`, case-insensitive (`db-get-dictionary-entries-by-words`)
  - `markDictionaryWordsShared(words: string[], sharedAt: string): { marked: string[] }`, case-insensitive. Sets `shared_at` and nothing else; the row stays live and unchanged for sync (`db-mark-dictionary-words-shared`)
  - `getMovedDictionaryWords(): string[]`, live personal words with `shared_at` set (`db-get-moved-dictionary-words`)

- [ ] **Step 1: Write the failing tests:**
  - `apply pull upserts and deletes`.
  - `meta prunes words of spaces no longer in scopes`: upsert words in spaces A and B, then apply meta whose scopes are `[null, A]`. Expect B's word gone and A's kept.
  - `deleting an entry removes its hide`.
  - `markDictionaryWordsShared keeps the word live`: afterwards `getDictionary()` still has it, `getMovedDictionaryWords()` has it, and `getPendingDictionaryDeletes()` is empty.
  - `replaceSharedDictionary removes entries absent from the snapshot`.
  - `upsertDictionaryFromCloud stores shared_at, and a local re-add clears it`.
  - `getDictionaryEntriesByWords matches case-insensitively`.
  - `clearSharedDictionary() empties all three tables`.
- [ ] **Step 2:** Run `node --import tsx --test test/helpers/sharedDictionaryDatabase.test.js`. Expected: FAIL (or SKIP locally when the binding mismatches; then rely on CI).
- [ ] **Step 3:** Implement the tables, methods, IPC, preload and types.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): local shared dictionary tables`.

### Task 3: Hint selection, ranking and prompt formatting

**Files:**
- Create: `src/utils/sharedDictionaryHints.ts`
- Modify: `src/utils/snippets.ts:123` (`getDictionaryHintWords`), `src/utils/dictionaryPromptCap.js`
- Modify: `src/stores/settingsStore.ts`:
  - new field `sharedDictionaryHints` next to `customDictionary` (~L1131, ~L1546)
  - localStorage key `sharedDictionaryHints`
  - parsed in the `storage` handler (~L3769) as a JSON object, not an `ARRAY_SETTINGS` entry
- Test: `test/utils/sharedDictionaryHints.test.js`, `test/utils/dictionaryPromptCap.test.js` (extend), `test/utils/snippets.test.js` (extend or create)

**Interfaces — Produces:**
```ts
// src/utils/sharedDictionaryHints.ts
export interface SharedHintWords { space: string[]; workspace: string[] }
export const EMPTY_SHARED_HINTS: SharedHintWords;
export function selectSharedHintWords(snapshot: SharedDictionarySnapshot): SharedHintWords;
// space = live, non-hidden entries whose spaceId is in meta.scopes; workspace = spaceId null; both empty when meta is null or meta.paused.

// src/utils/snippets.ts
export function getDictionaryHintTiers(settings?: { customDictionary?: string[] | null; snippets?: Snippet[] | null; sharedDictionaryHints?: SharedHintWords | null } | null): string[][];
// [personal + snippet triggers, space, workspace]; case-insensitive dedupe across tiers, first occurrence wins.
export function getDictionaryHintWords(settings?): string[];            // = getDictionaryHintTiers(settings).flat()
export function getEffectiveDictionaryWords(settings?): string[];       // personal, space, workspace — no snippet triggers, deduped the same way

// src/utils/dictionaryPromptCap.js
export function formatDictionaryPrompt(tiers: string[][], maxChars: number): string;

// settingsStore
sharedDictionaryHints: SharedHintWords;
setSharedDictionaryHints(hints: SharedHintWords): void;
```
- `formatDictionaryPrompt` keeps whole words greedily, highest tier first, while `", "`-joined length ≤ `maxChars`. It emits the kept words lowest tier first, keeping each tier's own order, so the highest tier sits at the tail where Whisper decoders read. A personal-only list that fits produces exactly today's string.

- [ ] **Step 1: Write the failing tests:**
  - `selectSharedHintWords excludes hidden, paused and out-of-scope words`.
  - `tiers dedupe case-insensitively with personal spelling`: personal `["OpenWhispr"]` and workspace `["openwhispr","ARR"]` → `[["OpenWhispr"],[],["ARR"]]`.
  - `snippet triggers rank in the personal tier`.
  - `formatDictionaryPrompt personal-only is unchanged`: `formatDictionaryPrompt([["a","b"],[],[]], 900) === "a, b"`.
  - `formatDictionaryPrompt drops lowest tier first and ends with the personal tier`: with 300 workspace words of 10 characters plus personal `["Piha","Biscuit"]` at 900, the result ends with `"Piha, Biscuit"`, is ≤ 900 characters, and has no workspace word after a personal one.
  - `getEffectiveDictionaryWords omits triggers`.
- [ ] **Step 2:** Run the three files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): rank shared words below personal in dictionary hints`.

### Task 4: Wire every dictionary consumer

**Files (call sites from recon):**
- `src/helpers/audioManager.js`:
  - `getCustomDictionaryPrompt()` (~L830) becomes `formatDictionaryPrompt(getDictionaryHintTiers(settings), maxChars)`, with `maxChars` defaulting to `WHISPER_PROMPT_CHARS`
  - `processWithOpenAIAPI` (~L3999–4039) passes `dictionaryPromptLimit(...)` instead of `trimDictionaryPrompt`, and feeds `dictionaryKeywords` from `getDictionaryHintWords` (highest priority first)
  - `getCustomDictionaryArray()` (~L3816) returns `getEffectiveDictionaryWords(settings)` (keyterms, echo strip)
- `src/stores/meetingRecordingStore.ts:176` uses `getEffectiveDictionaryWords(state)` for `keyterms`
- `src/stores/actionProcessingStore.ts:493` uses `getEffectiveDictionaryWords(settings)` for the meeting-note suffix
- `src/components/DictionaryView.tsx:52` (`promptChars`) uses `formatDictionaryPrompt(getDictionaryHintTiers(...), Infinity).length`
- Correction learner:
  - `settingsStore.setSharedDictionaryHints` also calls the new `window.electronAPI.setSharedDictionaryHints(hints)` (IPC `dictionary-set-shared-hints`, preload + types)
  - main caches the latest value in memory (empty until the first call; the renderer sends it on store init)
  - `_getDictionarySafe()` (`ipcHandlers.js` ~L1256) returns personal ∪ cached `space` ∪ cached `workspace`
  - so only the active workspace's applying words (non-hidden, non-paused) block learning
- Already covered through `getDictionaryHintWords`: `BaseReasoningService.ts:43`, `prompts/index.ts`, `useChatStreaming.ts:533`, `PromptStudio.tsx`
- Tests: `test/helpers/audioManagerDictionaryPrompt.test.js` (create, mocking `getSettings`), `test/stores/meetingRecordingStore*.test.js` (extend the existing keyterm test if present, else create `meetingKeyterms.test.js`), `test/helpers/correctionLearnerShared.test.js`

- [ ] **Step 1: Write the failing tests:**
  - `whisper prompt includes shared words after personal`: settings with personal `["Piha"]` and `sharedDictionaryHints.workspace` `["ARR"]` → `getCustomDictionaryPrompt()` returns `"ARR, Piha"`.
  - `meeting keyterms include shared words, exclude hidden` (hidden ones were never in the hints).
  - `correction learner skips a word that applies from the active workspace`: after `dictionary-set-shared-hints` with `workspace: ["Qdrant"]`, a correction to "Qdrant" calls no `applyDictionaryChanges` with it.
  - `correction learner still learns a word that is only hidden or from another workspace`: after hints without "Qdrant", it does learn.
  - `the OpenAI transcription request carries the formatted prompt`: mock the HTTP layer `processWithOpenAIAPI` uses and assert the request's `prompt` field ends with the personal words.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Make the call-site changes. Grep `customDictionary` under `src/` and confirm every remaining raw read is a personal-only use: the Dictionary UI's personal list, export, clear-all, `agentName.ts`, the CLI bridge and the voice tool. Those stay.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. Update any existing prompt-order assertion only where it now includes shared words.
- [ ] **Step 5:** Commit: `feat(dictionary): apply shared words to dictation, meetings and cleanup`.

### Task 5: Shared dictionary store, sync pass, account reset

**Files:**
- Create: `src/stores/sharedDictionaryStore.ts`
- Modify: `src/services/SyncService.ts`:
  - add `syncSharedDictionary(authGeneration)` and `syncSharedDictionaryNow()`
  - call it in `syncAll` (L494–583) right after `syncSpaces`, in **both** the full and team-only branches
  - clear in `clearTeamSpaceSessionState` (L408–420)
- Modify: `src/stores/sharedDictionaryStore.ts` **subscribes** to `useWorkspaceStore`'s `activeWorkspaceId` (`useWorkspaceStore.subscribe`) and calls `handleScopeChange` on every change. That covers `setActiveWorkspaceId`, the auto-select and clear in `refresh()` (L106–135), and `resetForAccountChange`. There is no call site in `workspaceStore.ts` itself.
- Test: `test/services/sharedDictionarySync.test.js`, `test/stores/sharedDictionaryStore.test.js`

**Interfaces — Produces:**
```ts
// sharedDictionaryStore (ListKey lives here; Task 7's view model imports it)
export type ListKey = "all" | "personal" | "allShared" | "workspace" | `space:${string}` | "hidden";
type SharedDictionaryStatus = "unavailable" | "ready";
interface SharedDictionaryState {
  workspaceId: string | null; status: SharedDictionaryStatus; snapshot: SharedDictionarySnapshot | null;
  syncing: boolean; lastSyncedAt: string | null;
  requestedList: ListKey | null;                       // set by the arrival toast's "View words"
  movedPersonal: string[];                             // getMovedDictionaryWords()
  generation: number;                                  // bumped on every account or active-workspace change
  load(workspaceId: string | null, generation: number): Promise<void>;   // reads DB; publishes only if generation and workspaceId are still current
  handleScopeChange(workspaceId: string | null): void; // generation++, hints = EMPTY_SHARED_HINTS at once, then load(workspaceId, generation)
  setRequestedList(list: ListKey | null): void;
}
export const useSharedDictionaryStore;
// SyncService
syncSharedDictionaryNow(): Promise<void>;              // toolbar Sync button
```
Sync pass behaviour:
- Read `activeWorkspaceId`. If none, `clearSharedDictionary()`, set hints to empty and stop.
- **Generation:** capture `generation` and `workspaceId` at the start. DB writes are keyed by workspace and always safe. Publishing (`load`) and the arrival event happen only if both are still current.
- **Entries:**
  - With no stored cursor, page the snapshot (`cursor`/`cursorId`) into memory, then write it once with `replaceSharedDictionary`. Otherwise page the delta (`since`/`sinceId`).
  - A 410 `SHARED_DICTIONARY_CURSOR_EXPIRED` resets both cursors and re-runs as a snapshot.
  - After the last page of a pass (`hasMore: false`), store the response's `server_time` as the cursor (API ruling 8), so a quiet list never ages into a 410.
  - Every delta pass, for entries **and** hides, starts from `since = storedCursor − 10 s` with no `since_id`, and re-applies those rows idempotently. Writers on different lists can commit out of `updated_at` order, so a strict cursor could skip a row or tombstone (API ruling 5). The stall guard compares against the stored cursor, not the overlapped one.
  - Cursors live in localStorage: `lastSyncedAt.sharedDictionary.<ws>` and `.id`, with the same stall guard as `pullDictionary` (L2646–2711).
  - Every page goes through `applySharedDictionaryPull`, and the last page carries `meta`. Tombstones become `deletedIds`.
- **Hides:** delta-paged the same way under `lastSyncedAt.sharedDictionaryHides.<ws>`. A snapshot, or a 410, pages `cursor` and writes with `replaceSharedDictionaryHides`.
- **Personal `shared_at` backfill (one time):** if localStorage `dictionarySharedAtBackfill` is unset, clear `lastSyncedAt.dictionary` / `.id` and set the flag. The next personal pull re-reads every live row with its `shared_at`, which a cursor that already passed a share would otherwise never replay.
- **Errors:**
  - A 404 with code `SHARED_DICTIONARY_NOT_MEMBER`, or a 403 `SSO_REQUIRED`: run `clearSharedDictionary(ws)`, reset that workspace's cursors, and publish empty hints (if current).
  - A 404 without that code (an older API): set `status = "unavailable"` (localStorage `sharedDictionaryCapability = false`) and stop quietly.
  - Anything else is logged and isolated, as the dictionary pass does now.
- **After a pass**, call `load(ws)`. If the number of applying words went from 0 to > 0 and `sharedDictionaryWelcomed.<ws>` is unset, set it and dispatch `window.dispatchEvent(new CustomEvent("shared-dictionary-arrived", { detail: { workspaceId, count } }))`.
- **Returning scopes:** when the last page's `meta.scopes` contains a `space_id` (or the workspace list) that the stored meta didn't have, for example a restored space or the member re-added, reset both cursors for that workspace and run the pass again as a snapshot (`replaceSharedDictionary`). Rows pruned earlier are unchanged on the server, so a delta would never resend them.
- **Account reset:** `clearTeamSpaceSessionState` clears the shared tables, `lastSyncedAt.sharedDictionary*` cursors, `sharedDictionaryWelcomed.*`, `sharedDictionaryCapability` and the hints.

- [ ] **Step 1: Write the failing tests** (mock `SharedDictionaryService` and `window.electronAPI`):
  - `first pass pages the snapshot then switches to delta cursors`.
  - `NOT_MEMBER clears the workspace and its cursors`.
  - `plain 404 marks unavailable without throwing`.
  - `arrival event fires once`: two passes that each bring words produce one event.
  - `runs when cloud backup is off`: `canSync()` returns false and the pass still runs.
  - `switching active workspace reloads hints`: `setActiveWorkspaceId("W2")` empties hints synchronously, then sets them from W2's snapshot.
  - `a stale pass does not publish`: start a pass for W1 with a deferred `list`, switch to W2, resolve the W1 pass. Hints equal W2's, and no arrival event fires for W1.
  - `refresh() auto-selecting the only workspace loads its hints`, and `refresh() dropping the active workspace empties hints`.
  - `expired cursor re-snapshots and replaces`: `list` rejects with 410, then snapshot pages arrive. `replaceSharedDictionary` is called, and a locally present entry missing from the snapshot is gone.
  - `the personal backfill resets the dictionary cursor exactly once`.
  - `delta passes overlap the stored cursor by 10 seconds`: with stored cursor T, the first delta request has `since = T − 10s` and no `since_id`, and re-applied rows don't change local state.
  - `a returning scope triggers a fresh snapshot`: a pass whose meta adds space B (absent from stored meta) clears both cursors and re-pages from `cursor`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): sync shared dictionary lists and hides`.

### Task 6: Write actions

**Files:**
- Create: `src/services/sharedDictionaryActions.ts`
- Test: `test/services/sharedDictionaryActions.test.js`

**Interfaces — Consumes:** Task 1 service, Task 2 IPC, Task 5 `load`. **Produces:**
```ts
export type ShareTarget = string | null;   // space id, null = workspace list
export async function addSharedWords(workspaceId: string, target: ShareTarget, words: string[]): Promise<{ added: string[]; alreadyPresent: string[]; failed: { words: string[]; reason: SharedDictionaryActionError["reason"] } | null }>;
export async function editSharedWord(workspaceId: string, entryId: string, word: string): Promise<void>;              // throws SharedDictionaryActionError("alreadyInList")
export async function deleteSharedWords(workspaceId: string, entryIds: string[]): Promise<{ undo: () => Promise<void> }>;
export async function setSharedWordsHidden(workspaceId: string, entryIds: string[], hidden: boolean): Promise<void>;
export async function sharePersonalWords(workspaceId: string, targets: ShareTarget[], words: string[]): Promise<{ moved: string[]; alreadyPresent: Array<{ target: ShareTarget; word: string }>; failed: { words: string[]; reason: SharedDictionaryActionError["reason"] } | null }>;
export class SharedDictionaryActionError extends Error { reason: "alreadyInList" | "personalChanged" | "planRequired" | "ssoRequired" | "notMember" | "listFull" | "network" }
```
- Each action applies the server's response locally (`applySharedDictionaryPull` / `applySharedDictionaryHides`), then runs `useSharedDictionaryStore.getState().load(workspaceId)` and fires `syncSharedDictionaryNow()` without awaiting it.
- **`addSharedWords` and `sharePersonalWords`** split their input into chunks of 200 and send them in order. Each chunk is atomic on the server. Every acknowledged chunk is applied locally at once. The first failing chunk stops the loop: its words and every later chunk's words are returned in `failed`, and nothing about them changes locally.
- **`sharePersonalWords`**, per chunk:
  1. Look up `{ word, cloudId }` with `getDictionaryEntriesByWords`. Synced words go in `personal: [{ id: cloudId, word }]`, unsynced words in `words`.
  2. Call `share`.
  3. On success, `markDictionaryWordsShared(chunkWords, now)`, apply `created` locally, and reload the store (`movedPersonal` + snapshot).
  4. On 409 `PERSONAL_CHANGED`, stop with `reason: "personalChanged"` and fire `syncDictionaryNow()` so the UI shows the renamed word.
  - It never removes a personal word.

- [ ] **Step 1: Write the failing tests:**
  - `share marks personal words only after the server accepts`: a rejected `share` leaves `markDictionaryWordsShared` uncalled.
  - `share sends {id, word} for synced words and plain words for unsynced ones`.
  - `second chunk failure`: for 450 words where the 2nd `share` call rejects with `LIST_FULL`:
    - `moved` has the first 200 and `failed.words` the other 250
    - `markDictionaryWordsShared` was called once, with the first 200
  - `PERSONAL_CHANGED maps to personalChanged and triggers a personal sync`.
  - `delete returns undo that calls restore`.
  - `409 maps to alreadyInList`, `403 PLAN_REQUIRED maps to planRequired`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): shared dictionary write actions`.

### Task 7: Dictionary view model and access state

**Files:**
- Create: `src/components/dictionary/dictionaryViewModel.ts`
- Modify: `src/lib/workspaceBilling.ts` (add `hasSharedDictionaryPlan`)
- Test: `test/components/dictionaryViewModel.test.js`, `test/lib/workspaceBilling.test.js` (extend)

**Interfaces — Produces:**
```ts
// ListKey is imported from src/stores/sharedDictionaryStore.ts (Task 5)
export type SortKey = "az" | "za" | "newest" | "oldest";
export type SharedAccessState = "unavailable" | "noWorkspace" | "upgradeAdmin" | "upgradeMember" | "paused" | "available";
export interface PickerEntry { key: ListKey; label: string; count: number | null; locked: boolean; group: "top" | "shared" | "bottom" }
export interface DictionaryRow { key: string; word: string; kind: "personal" | "shared"; entryId: string | null; badge: string | null; attribution: "you" | "former" | { name: string } | null; createdAt: string | null }
export function hasSharedDictionaryPlan(workspace: Pick<Workspace, "plan" | "status"> | null | undefined): boolean;   // in workspaceBilling.ts
export function resolveSharedAccessState(input: { capabilityAvailable: boolean; workspace: Workspace | null; serverPaused: boolean | null }): SharedAccessState;
export function buildPicker(input: { personal: string[]; movedPersonal: string[]; snapshot: SharedDictionarySnapshot | null; workspaceName: string; access: SharedAccessState; t: TFunction }): PickerEntry[];
export function visiblePersonalWords(personal: string[], movedPersonal: string[], snapshot: SharedDictionarySnapshot | null): string[];   // drops a moved word only while a live shared entry with the same lower(word) exists
export function rowsForList(list: ListKey, input: { personal: string[]; movedPersonal: string[]; snapshot: SharedDictionarySnapshot | null; workspaceName: string; currentUserId: string | null; search: string; sort: SortKey }): DictionaryRow[];
export function defaultAddTarget(list: ListKey, lastUsed: ShareTarget | "personal" | null): ShareTarget | "personal";
export function shareTargetsFor(words: string[], snapshot: SharedDictionarySnapshot, workspaceName: string): Array<{ target: ShareTarget; label: string; memberCount: number; alreadyShared: boolean }>;
```
Rules the tests pin:
- **`resolveSharedAccessState`:**
  - `!capabilityAvailable` → `unavailable`
  - no workspace → `noWorkspace`
  - a non-Business plan (or `serverPaused === true` when words exist) → `paused` if the snapshot has words, otherwise `upgradeAdmin` for owner/admin and `upgradeMember` for member
  - otherwise `available`
- **Picker:** the order and groups are All words, Personal | Shared: All shared, Everyone at {workspace}, each scope space | Hidden. Counts:
  - All words = applying words (personal ∪ non-hidden shared, deduped)
  - Hidden = hidden count
  - `locked` is true for the shared entries unless `available`
- **Rows:**
  - In `all` and `allShared`, shared rows get `badge` (workspace name or space name).
  - `all` shows each word once, case-insensitively, using the same order as the hints:
    - a visible personal row beats any shared row
    - a space row beats a workspace row
    - a moved personal word that's hidden from Personal is represented by its shared row
  - `allShared` shows one row per list entry: the same word in Engineering and Sales is two rows, each with its own badge, because they are two lists.
  - In single lists, `attribution` is `"you"` for the current user, `{name}` for members and `"former"` when the contributor has `is_member === false` or `added_by_user_id === null`.
  - `hidden` lists hidden entries only; `allShared` and `all` exclude them.
  - Search is case-insensitive substring. Sort: `az`/`za` by `localeCompare` with `sensitivity: "base"`, `newest`/`oldest` by `createdAt` (personal rows without a date sort last).
- **`defaultAddTarget`:** the open list's target for `personal`, `workspace` or `space:*`; otherwise `lastUsed ?? "personal"`.
- **`shareTargetsFor`:** `alreadyShared` is true when every given word already exists, case-insensitively, in that list.

- [ ] **Step 1: Write the failing tests** for each rule above, including:
  - `paused workspace with words is paused, without words is upgradeAdmin`
  - `owner not in a space gets no space entry` (scopes drive it)
  - `former member attribution`
  - `a moved word leaves Personal only while its shared copy exists`: with the shared copy deleted from the snapshot, it's back in Personal.
  - `All words never lists a word twice`:
    - a moved personal "Qdrant" + a shared "Qdrant" → one row, with the shared badge
    - a personal "OpenWhispr" + a shared "openwhispr" → one row, the personal one
  - `Already shared when the list has the word in another case`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): dictionary view model`.

### Task 8: Page layout — list picker, toolbar, add field, rows

**Files:**
- Create in `src/components/dictionary/`:
  - `DictionaryListPicker.tsx`
  - `DictionaryToolbar.tsx`
  - `DictionaryAddField.tsx`
  - `DictionaryWordList.tsx`
- Modify: `src/components/DictionaryView.tsx` becomes the orchestrator inside the existing "dictionary" `TabsContent`. Keep the Dictionary/Snippets pill tabs, the agent-name row, bulk import, export/clear-all (Personal only) and the prompt-limit notice.
- Modify: `src/components/icons/primitives.tsx` + `index.ts` (`EyeOff`)
- Locales: all 11
- Test: `test/components/dictionaryView.test.js` (Vite SSR + `installInteractiveDom`, as in `test/components/connectorsSection.test.js`)

**Behaviour:**
- **Picker** renders `buildPicker`. The selected list is local state, initialised from `requestedList` when set (then cleared).
- **Toolbar** (top right):
  - Search toggles an inline field that filters the open list.
  - Sort is a `DropdownMenu` with A–Z / Z–A / Newest first / Oldest first, persisted to localStorage `dictionarySort`.
  - Sync calls `syncSharedDictionaryNow()` (plus `syncDictionaryNow()`), spins while `syncing`, and shows a tooltip "Synced {{time}} ago" from `lastSyncedAt`.
- **Add field:** the placeholder is "Add a word…", with a target chip "to {{list}} ▾" (a `DropdownMenu` of Personal + writable lists, default `defaultAddTarget`). Enter adds through `updateCustomDictionary` (Personal) or `addSharedWords`. A word already in the target shows the existing inline "already added" treatment.
- **Rows:** `h-[38px]`, word left, badge/attribution right. Hover icons, each with a tooltip, are listed below. A shared row's Pencil edits inline like today; an `alreadyInList` error shows "Already in {{list}}".

| Row type | Hover icons (left to right) | Tooltips |
|---|---|---|
| Personal | Users (share), Pencil, Trash2 | Share, Edit, Delete |
| Shared | Pencil, EyeOff, Trash2 (red) | Edit, Hide for me, Delete for everyone |
| Hidden | Eye | Unhide |

- [ ] **Step 1: Write the failing tests:**
  - `renders picker entries with counts`.
  - `mixed view shows list badges`.
  - `shared row hover exposes Edit, Hide for me and Delete for everyone by aria-label`.
  - `add target defaults to the open list`.
  - `sort choice persists to localStorage`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and add the locale keys.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): list picker, toolbar and shared rows`.

### Task 9: Multi-select, floating action bar, share popover

**Files:**
- Create in `src/components/dictionary/`:
  - `useDictionarySelection.ts`: pure reducer plus hook
  - `RowCheckbox.tsx`: `role="checkbox"`, following `onboarding/UseCaseStep.tsx:50`
  - `SelectionActionBar.tsx`
  - `ShareWordsPopover.tsx`: Radix `Popover` from `ui/popover.tsx`
- Modify: `DictionaryWordList.tsx`, `DictionaryView.tsx`
- Test: `test/components/dictionarySelection.test.js` (reducer), `test/components/shareWordsPopover.test.js`

**Interfaces — Produces:**
```ts
export interface SelectionState { selected: ReadonlySet<string>; anchor: string | null }
export type SelectionAction = { type: "toggle"; key: string } | { type: "range"; key: string; orderedKeys: string[] } | { type: "selectAll"; orderedKeys: string[] } | { type: "clear" };
export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState;
```
**Behaviour:**
- **Checkbox column:** a fixed column that is invisible at rest and fades in on hover. Once anything is selected, every row shows its checkbox and the hover icons hide.
- **Keys:** Shift-click dispatches `range`, ⌘A `selectAll` (when the list has focus), Esc `clear`. Changing the open list clears the selection.
- **Action bar:**
  - `sticky bottom-3`, centred, floating over the list's scroll area; the list gets bottom padding equal to the bar's height.
  - Personal: "{{count}} selected · Select all {{total}} · Delete · Share with… ▾ · ✕".
  - Shared lists: "Hide for me · Delete for everyone".
  - Delete for everyone opens `ConfirmDialog` ("Delete {{count}} words for everyone in {{list}}?", `variant="destructive"`), then a toast with **Undo** (`useToast`, `actions: [{ label, onClick }]`) that calls the returned `undo`.
- **Share popover:**
  - Title: `Share "{{word}}" with` (one word) / `Share {{count}} words with`.
  - Checkbox rows come from `shareTargetsFor`. "Everyone at {{workspace}}" and each space show `memberCount`, and an already-shared target is disabled with "Already shared".
  - The footer reads "Moves it out of Personal", with a Share button disabled until a target is ticked. It calls `sharePersonalWords` and clears the selection on success.
  - When `failed` is non-null, a toast says "Shared {{moved}} of {{total}} words. {{failed}} weren't shared." plus the reason ("A word changed on another device. Try again." for `personalChanged`, "{{list}} is full" for `listFull`, a generic network line otherwise). The unshared words stay selected.
- **Row Share icon:** opens the same popover for that one word.

- [ ] **Step 1: Write the failing tests:**
  - Reducer: `toggle`, `range from anchor`, `selectAll`, `clear`.
  - `popover disables a list that already has the word`.
  - `Share button disabled with no target`.
  - `shift-click selects a range in the list` (interactive DOM).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and add the locale keys.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): multi-select and sharing to lists`.

### Task 10: Blocked states, empty list, upgrade wiring

**Files:**
- Create: `src/components/dictionary/SharedDictionaryLocked.tsx`
- Modify:
  - `DictionaryView.tsx`, which gains the prop `onUpgrade: () => void`
  - `src/components/ControlPanel.tsx:1280`, which passes `onUpgrade={() => { setSettingsSection("plansBilling"); setShowSettings(true); }}`, as at L1302
- Test: `test/components/sharedDictionaryLocked.test.js` (SSR)

**Behaviour:**
- Shown when a Shared list is open and the access state isn't `available`. It reuses `UpsellBar` (`integrations/IntegrationsPane.tsx:62`) above a `SettingsPanel` of `opacity-60` rows, each with an icon tile, title, subtitle and a `Lock` icon (as in `ConnectorsSection.tsx:61-127`). The copy below is exact, in en, with all locales.
- **`noWorkspace`:**
  - Bar: "Shared dictionaries are included with Business. Share your team's jargon, product names and acronyms with everyone." with a View plans button.
  - Rows: "Everyone in your workspace" / "Words for the whole company"; "A list per space" / "Words only one team needs".
- **`upgradeAdmin`:**
  - Bar: "Shared dictionaries are included with Business. Upgrade {{workspace}} so everyone gets the same words." with View plans.
  - Rows: the workspace list and each scope, with "{{count}} members".
- **`upgradeMember`:** the bar reads "Shared dictionaries are included with Business. Ask an admin to upgrade {{workspace}}." with **no** button, and the same rows.
- **`paused`:**
  - Bar: "{{workspace}}'s {{count}} shared words are paused. Upgrade to Business to use them in dictation again." with View plans.
  - Rows show "{{count}} words".
  - Opening a single list shows its words dimmed and read-only: no hover icons, the add field disabled.
- **`unavailable`:** the Shared group isn't rendered at all.
- **Available but empty list:**
  - Title "No words in {{list}} yet".
  - Body "Add the terms this team uses, or share some from your personal list. Everyone in {{list}} ({{count}}) will get them."
  - **Import a list** opens the existing bulk import aimed at this list.
  - **Share from Personal** switches to Personal.

- [ ] **Step 1: Write the failing tests:**
  - one per state, asserting the exact en copy
  - presence or absence of the View plans button
  - `opacity-60` on the rows
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and add the locale keys.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): shared dictionary blocked and empty states`.

### Task 11: Arrival toast

**Files:**
- Create: `src/components/SharedDictionaryArrivalToastListener.tsx`, mounted in `ControlPanel.tsx` next to the other toast listeners (e.g. `GpuPackMigrationToastListener`)
- Test: `test/components/sharedDictionaryArrivalToast.test.js`

**Behaviour:**
- Listens for the `shared-dictionary-arrived` event, then shows `toast` with:
  - title "{{count}} team words added"
  - description "{{workspace}}'s shared words now apply to your dictation and meeting notes."
  - actions **View words**, which calls `setRequestedList("allShared")` and switches the control panel to the dictionary view, and **Dismiss**
- The event fires only once per workspace (Task 5), so the listener holds no state.

- [ ] **Step 1: Write the failing test** `dispatching the event shows the toast with both actions, and View words sets requestedList to allShared`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and add the locale keys.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): tell new members when team words arrive`.

### Task 12: Voice assistant `update_dictionary`

**Files:**
- Modify: `src/services/tools/dictionaryTool.ts`, `src/services/tools/index.ts:53-57`, `src/components/chat/useChatStreaming.ts:456`
- Test: `test/services/dictionaryTool.test.js` (extend)

**Interfaces — Produces:**
- `DictionaryActions` gains `getSharedWords(): Array<{ id: string; word: string }>` and `hideSharedWords(ids: string[]): Promise<void>`.
- The result adds `data.hidden: string[]`.

**Behaviour:**
- Add always goes to Personal (unchanged), but a word already in a shared list counts as `alreadyPresent`.
- Remove of a word found only in a shared list calls `hideSharedWords`, never a delete. That word is reported in `hidden`, and `displayText` says it was hidden for you.
- In `useChatStreaming`, `getSharedWords` reads the active workspace's live, non-hidden entries via `getSharedDictionary`, and `hideSharedWords` calls `setSharedWordsHidden(ws, ids, true)`. Both work in the dictation window, since they only use DB IPC and `cloudApiRequest`.

- [ ] **Step 1: Write the failing tests:**
  - `removing a shared word hides it and never deletes`: assert `hideSharedWords` is called with the id and `updateDictionary` doesn't receive the word.
  - `adding a word that is shared reports alreadyPresent`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dictionary): voice assistant hides shared words instead of deleting`.

**Final check:** manual run against a Business workspace on a local API:
- share a word
- hide a word
- delete for everyone, then Undo
- switch workspace
- downgrade the workspace in the DB
- remove yourself from a space

Then confirm the dictation prompt in debug logs (`--log-level=debug`) ends with personal words.
