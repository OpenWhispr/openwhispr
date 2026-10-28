# Shared Dictionary — Part 3: Mobile (Apply-Only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mobile app pulls the active workspace's shared words and the member's hides and applies them wherever personal dictionary words apply today: in-app dictation, keyboard dictation, cleanup and note actions. Personal words come first. The Dictionary screen gets one read-only line. Nothing about shared words is editable on mobile.

**Architecture:**
- A new sync step `pullSharedDictionary` stores the workspace's entries, hides and scopes as one JSON blob in the existing `sync_state` table. No new SQLite table: apply-only data is small and read whole.
- `useSharedDictionaryStore` derives `SharedHintWords`.
- `buildDictationHintTiers` (`src/lib/dictationHints.ts`) ranks the tiers and keeps them separate until a prompt string is built. Every string-prompt path (cloud, local and BYOK) formats with `formatDictionaryPrompt`, so personal words sit at the tail. Keyboard dictation goes through the same paths.
- A personal word moved into a shared list on desktop stays a live personal row (`shared_at` set), so mobile keeps applying it even when no workspace resolves.

**Tech Stack:** Expo / React Native, TypeScript, Zustand, Drizzle + expo-sqlite, Jest (`jest-expo`).

**Spec:** `docs/superpowers/specs/2026-10-20-shared-dictionary-design.md` (section "Mobile (apply-only)"). **Depends on:** Part 1 API (`docs/superpowers/plans/2026-10-20-shared-dictionary-1-api.md`, route table). It mirrors Part 2's hint rules (`getDictionaryHintTiers`, `formatDictionaryPrompt`). Mobile keeps its own copies by convention.

**Repo:** `openwhispr-mobile/` inside the desktop repo. Branch from `origin/main`.

## Global Constraints

- Apply-only: no list picker, no sharing, no editing or hiding of shared words on mobile.
- Personal entries are never deleted by sharing. The personal pull stores `shared_at`, and the Dictionary screen leaves a moved word out of the personal list only while the stored shared state has a live entry with the same `lower(word)`. It always stays in the hints at personal priority.
- Active workspace (mobile has no picker):
  - the only workspace when the user has exactly one
  - otherwise the only workspace in `usage.entitlementSources.workspaceIds` when exactly one is listed
  - otherwise none, and no shared words apply
- Priority and dedupe are the same as desktop: personal words and snippet triggers, then space words, then workspace words. Dedupe is case-insensitive and the first occurrence wins. Hidden words and paused words never apply. Space membership comes from the server's `scopes` only.
- Sync gating: shared pull runs whenever the user is signed in and not a guest, in both the personal-sync and team-only branches of `runSyncNow`. It never depends on `cloudBackupEnabled` or a personal subscription.
- Mobile has no i18n. The new line is hard-coded English, like the rest of the app.
- Commit only when the user has authorized commits for this execution, and never push. Use conventional commits. Run `npm test && npm run typecheck && npm run lint` in `openwhispr-mobile/` after each task.

## Review Focus

1. **A user with two workspaces where neither, or both, are entitled.** No shared words apply and there's no crash or error banner.
2. **A word the user shared from desktop, on a phone where no workspace resolves.** It keeps applying as a personal word and stays visible in Personal.
3. **The API doesn't have the shared endpoints yet** (404). Sync finishes quietly and personal dictation is unchanged.
4. **Signing out or switching accounts.** The previous account's shared words stop applying immediately.
5. **Cloud, local or BYOK transcription with a large team list.** The prompt actually sent ends with the personal words and snippet triggers.

---

### Task 1: API client and capability header

**Files:**
- Create: `src/data/remote/sharedDictionaryApi.ts`, following `src/data/remote/dictionaryApi.ts`
- Modify: `src/data/remote/dictionaryApi.ts` (the remote entry type gains `shared_at: string | null`)
- Modify: `src/db/schema.ts` (`dictionaryEntries` L128 gains `sharedAt`), `src/db/migrate.ts` (`addColumnIfMissing('dictionary_entries', 'shared_at', 'TEXT')`), `src/data/local/__tests__/testDb.ts`
- Modify: `src/sync/pullDictionary.ts`, so the upsert stores `shared_at` on insert **and** update
- Modify: `src/store/useDictionaryStore.ts`: `DictionaryEntry` gains `sharedAt: number | null`, and `readAllActiveEntries` returns it
- Test: `src/data/remote/__tests__/sharedDictionaryApi.test.ts`, `src/sync/__tests__/pullDictionary.sharedAt.test.ts`

**Interfaces — Produces:**
```ts
export interface RemoteSharedEntry { id: string; workspace_id: string; space_id: string | null; word: string; created_at: string; updated_at: string; deleted_at: string | null }
export interface RemoteSharedScope { space_id: string | null; name: string; member_count: number; word_count: number }
export interface RemoteSharedHide { entry_id: string; workspace_id: string; updated_at: string; deleted_at: string | null }
export function fetchSharedDictionary(workspaceId: string, page: { since?: string; sinceId?: string; cursor?: string; cursorId?: string; limit?: number }): Promise<{ entries: RemoteSharedEntry[]; hasMore: boolean; scopes: RemoteSharedScope[]; paused: boolean; server_time: string }>;
export function fetchSharedDictionaryHides(workspaceId: string, page: { since?: string; sinceId?: string; cursor?: string; cursorId?: string; limit?: number }): Promise<{ hides: RemoteSharedHide[]; hasMore: boolean; server_time: string }>;
```
- One-time backfill: when sync_state `dictionary.shared_at_backfill` is unset, `pullDictionary` clears `DICTIONARY_CURSOR_KEY` and its id key first, then sets the flag. The snapshot then refreshes `shared_at` on rows a cursor already passed.
- [ ] **Step 1: Write the failing tests:**
  - `fetchSharedDictionary builds /api/shared-dictionary/list?workspace_id=W&since=S&since_id=I&limit=200` (mock `api.get`).
  - `pullDictionary stores shared_at on an existing row`.
  - `backfill clears the dictionary cursor exactly once`.
- [ ] **Step 2:** Run `npx jest src/data/remote/__tests__/sharedDictionaryApi.test.ts src/sync/__tests__/pullDictionary.sharedAt.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(mobile): shared dictionary API client and personal shared_at`.

### Task 2: Stored state and the pull step

**Files:**
- Create: `src/sync/sharedDictionaryState.ts`, `src/sync/pullSharedDictionary.ts`, `src/lib/activeWorkspace.ts`
- Modify:
  - `src/sync/pullCursors.ts`: add cursor keys to `resetAllPullCursors()` (L20)
  - `src/sync/syncEngine.ts`: call the step after `syncSpaces` (L307) in both branches (L371–384 and L428–459), wrapped in its own try/catch like snippets (L389–413), with an endpoint-unavailable session flag like L68–75
  - `src/data/local/notesRepository.ts:1302`: `wipeAllSyncableData()` also deletes the `shared_dictionary.*` sync_state keys
- Test: `src/sync/__tests__/pullSharedDictionary.test.ts`, `src/lib/__tests__/activeWorkspace.test.ts`, `src/sync/__tests__/syncEngine.test.ts` (extend, mock pattern at L107–111)

**Interfaces — Produces:**
```ts
// activeWorkspace.ts
export function resolveActiveWorkspaceId(workspaceIds: string[], entitledWorkspaceIds: string[]): string | null;
// sharedDictionaryState.ts — sync_state key `shared_dictionary.state`
export interface SharedDictionaryState { workspaceId: string; workspaceName: string; entries: Record<string, { spaceId: string | null; word: string }>; hiddenIds: string[]; scopes: RemoteSharedScope[]; paused: boolean }
export function loadSharedDictionaryState(): Promise<SharedDictionaryState | null>;
export function saveSharedDictionaryState(state: SharedDictionaryState | null): Promise<void>;
// pullSharedDictionary.ts
export function pullSharedDictionary(checkpoint?: SyncCheckpoint): Promise<{ changed: boolean }>;
```
Behaviour:
- Resolve the workspace from `fetchMyWorkspaces()` and the cached usage. When it differs from the stored `workspaceId`, start a fresh state and reset the cursors.
- **Entries:**
  - With no cursor, page the snapshot and **replace** the stored entries with it; otherwise page the delta.
  - A 410 `SHARED_DICTIONARY_CURSOR_EXPIRED` resets both cursors and re-runs as a snapshot.
  - After a complete pass, store the **first** page's `server_time` as the cursor (API ruling 8, desktop ruling 9). A tombstone written while a multi-page snapshot was paging is then re-read by the next delta, instead of being skipped forever.
  - Every delta, for entries and hides, starts from `since = storedCursor − 10 s` with no `since_id`, re-applying rows idempotently, because shared lists have many writers that can commit out of `updated_at` order (API ruling 5).
  - When the last page's `scopes` contain a list the stored state didn't have (a restored space, or the member re-added), reset both cursors and pull again from a snapshot, since a delta never resends rows pruned earlier.
  - Cursors live in `sync_state` keys `shared_dictionary.last_sync_at` / `.last_sync_id`, using `notesRepository.getSyncState/setSyncState`.
  - Tombstones remove entries. The last page's `scopes` and `paused` replace the stored ones, and entries whose non-null `spaceId` isn't in `scopes` are dropped.
- **Hides:** delta-paged under `shared_dictionary.hides_last_sync_at` / `_id`. With no cursor, or after a 410, the hides snapshot (`cursor`) replaces `hiddenIds`.
- **Errors and gaps:**
  - A 404 with code `SHARED_DICTIONARY_NOT_MEMBER`, a 403 `SSO_REQUIRED`, or no resolvable workspace: save `null` and reset the cursors.
  - A plain 404, 405 or 501: set the endpoint-unavailable session flag and return `{ changed: false }`.
- Call `checkpoint()` around every await and `checkpoint(true)` before writes.
- After the step, `syncEngine` calls `useSharedDictionaryStore.getState().load()`. Sign-out and account switch (`syncEngine.ts:192, :566`) call `useSharedDictionaryStore.getState().reset()`.

- [ ] **Step 1: Write the failing tests:**
  - `resolveActiveWorkspaceId`: `(["A"],[]) → "A"`, `(["A","B"],["B"]) → "B"`, `(["A","B"],["A","B"]) → null`, `([],[]) → null`.
  - `first pull pages the snapshot then stores delta cursors`.
  - `scopes prune words of a space the user left`.
  - `NOT_MEMBER clears state`, and `SSO_REQUIRED clears state`.
  - `expired cursor re-snapshots and drops an entry missing from the snapshot`.
  - `plain 404 sets the unavailable flag and does not throw`.
  - `runSyncNow calls pullSharedDictionary with cloud backup off`.
  - `resetAllPullCursors clears the shared keys`.
  - `a returning scope triggers a fresh snapshot`.
  - `delta passes overlap the stored cursor by 10 seconds`: with stored cursor T, the first delta request has `since = T − 10s` and no `since_id`, and re-applied rows don't change local state.
  - `sign-out resets the shared store`: after the sign-out path at `syncEngine.ts:192`, `useSharedDictionaryStore.getState().hints` is empty.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(mobile): pull shared dictionary words and hides`.

### Task 3: Store and hint ranking

**Files:**
- Create: `src/store/useSharedDictionaryStore.ts`
- Modify:
  - `src/lib/snippets.ts:70` (`getDictionaryHintWords`), `src/lib/dictationHints.ts:19` (`buildDictationHints`)
  - `src/lib/transcriptionPromptCap.ts` (add `formatDictionaryPrompt`)
  - `src/services/transcription/TranscriptionService.ts`. Every string prompt is built with `formatDictionaryPrompt(buildDictationHintTiers(ctx), limit)`:
    - cloud `transcribeWithApi` (L513, `parameters.prompt`): `limit = GROQ_PROMPT_CHARS` (890), because the OpenWhispr Cloud Groq provider keeps the head 896 characters, so a shared-first prompt must stay within it. The personal tier is never cut: the shared fill uses `max(890, personal-tier length)`, as on desktop.
    - local `transcribeLocally` (L854, `prompt`): `limit = WHISPER_PROMPT_CHARS`
    - BYOK (L993–994): `limit = dictionaryPromptLimit(route)`, replacing `trimDictionaryPrompt`
    - the fused-cleanup `extraParameters.customDictionary` (L901) stays an array and uses the flat ranked `buildDictationHints`
  - `src/services/agent/AgentComposerService.ts:221-225` (`resolveCustomDictionary`)
  - `src/screens/NoteEditorScreen.tsx:183-185, 239-240`, so `extractCorrections` and action runs include shared words
- Test: `src/lib/__tests__/dictationHints.shared.test.ts`, `src/lib/__tests__/transcriptionPromptCap.test.ts` (extend), `src/services/transcription/__tests__/TranscriptionService.dictionaryPrompt.test.ts`

**Interfaces — Produces:**
```ts
// useSharedDictionaryStore
interface SharedDictionaryStoreState { hints: { space: string[]; workspace: string[] }; sharedWordsLower: Set<string>; summary: { count: number; workspaceName: string } | null; load(): Promise<void>; reset(): void }
// snippets.ts
export function getDictionaryHintTiers(customDictionary: string[], snippets: Snippet[], shared: { space: string[]; workspace: string[] }, includeSnippetTriggers: boolean): string[][];   // [personal+triggers, space, workspace], deduped
// transcriptionPromptCap.ts
export function formatDictionaryPrompt(tiers: string[][], maxChars: number): string;   // same algorithm as desktop Part 2 Task 3
```
- Security (same as desktop Part 2, Task 4 rulings): shared words are teammate-controlled.
  - `load()` drops non-term-like shared words: after trim, 1–64 characters, and at most 6 whitespace-separated tokens. Rejected characters: control characters, Unicode format characters (except ZWNJ/ZWJ U+200C/U+200D, which ordinary Persian, Urdu and Indic words need), line or paragraph separators, `<>{}[]`, backtick and `|`. Share the predicate as `isTermLikeSharedWord`, ported from desktop `src/utils/sharedDictionaryHints.ts`.
  - LLM-bound consumers include at most 200 shared words (space before workspace): `cleanupTranscript.ts:117`, the fused-cleanup `customDictionary`, `AgentComposerService.resolveCustomDictionary` and the note action runs.
  - Tests:
    - `a newline/65-char/<tag> shared word never reaches hints`
    - `cleanup gets at most 200 shared words`
- `load()` computes the hints from the stored state: live entries not in `hiddenIds`, split by `spaceId` in scopes vs null. Paused or null state gives empty hints. `summary.count` is the number of applying words, or `null` when 0.
- New `buildDictationHintTiers(includeSnippetTriggers): string[][]`, with `buildDictationHints(includeSnippetTriggers)` = its `.flat()`. Array consumers (`cleanupTranscript.ts:117`, fused cleanup L901) keep `buildDictationHints`. String-prompt consumers use the tiers (above).

- [ ] **Step 1: Write the failing tests:**
  - `buildDictationHints puts personal before space before workspace`.
  - `dedupe keeps personal spelling`: personal `"OpenWhispr"`, workspace `"openwhispr"` → one entry, `"OpenWhispr"`.
  - `hidden and paused words are excluded`.
  - `formatDictionaryPrompt ends with personal words when over budget` (the same fixture as desktop Part 2 Task 3).
  - Outgoing requests, with 300 workspace words and personal `["Piha","Biscuit"]`:
    - `cloud request prompt ends with personal words`: capture the request `transcribeWithApi` sends and assert `parameters.prompt` ends with `"Piha, Biscuit"` and is ≤ 900 characters.
    - `local transcription prompt ends with personal words`: mock `LocalTranscriptionService.transcribe` and assert on its `prompt`.
    - `BYOK prompt ends with personal words`: mock `transcribeWithProvider` and assert on its `prompt`.
  - `extractCorrections receives shared words` (NoteEditorScreen helper, or the extracted function if it is inline).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(mobile): apply shared dictionary words in dictation`.

### Task 4: Read-only line on the Dictionary screen

**Files:**
- Modify: `src/screens/DictionaryScreen.tsx`, placing the line under `SyncStatusLabel` (L307–309) **and** in the `EmptyState` branch (L290)
- Test: `src/screens/__tests__/DictionaryScreen.shared.test.tsx`

**Behaviour:**
- The personal list leaves out entries with `sharedAt` while the shared store has a live entry with the same `lower(word)` (the store exposes `sharedWordsLower: Set<string>`). Otherwise they show as normal personal words.
- When `summary` is non-null, render one line in `text-[12px] text-tertiaryLabel`: "{count} team words from {workspaceName} also apply. Manage them on desktop."
- Render nothing when `summary` is null.

- [ ] **Step 1: Write the failing tests:**
  - `shows the shared line with count and workspace name`
  - `hides it when summary is null`
  - `shows it in the empty state`
  - `a moved word is hidden from Personal while shared, shown again once its shared copy is gone`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(mobile): show shared dictionary summary on Dictionary screen`.
