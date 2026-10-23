import { SyncStalledError, uncheckedSync, type SyncCheckpoint } from './syncContext';
import { notesRepository } from '@/data';
import {
  fetchSharedDictionary,
  fetchSharedDictionaryHides,
  type RemoteSharedScope,
  type SharedDictionaryPage,
} from '@/data/remote/sharedDictionaryApi';
import { fetchMyWorkspaces, type RemoteWorkspace } from '@/data/remote/workspacesApi';
import { ApiError } from '@/lib/apiClient';
import { resolveActiveWorkspaceId } from '@/lib/activeWorkspace';
import { getUsageOwnerKey, useUsageStore } from '@/store/useUsageStore';
import type { UsageInfo } from '@/data/remote/usageApi';
import {
  SHARED_DICTIONARY_CURSOR_ID_KEY,
  SHARED_DICTIONARY_CURSOR_KEY,
  SHARED_DICTIONARY_HIDES_CURSOR_ID_KEY,
  SHARED_DICTIONARY_HIDES_CURSOR_KEY,
  resetSharedDictionaryCursors,
} from './pullCursors';
import {
  loadSharedDictionaryState,
  saveSharedDictionaryState,
  type SharedDictionaryState,
} from './sharedDictionaryState';

// Mirrors desktop SyncService's pullSharedEntries/pullSharedHides.
const PAGE_LIMIT = 200;
// Shared lists have many writers, whose rows can commit out of updated_at
// order, so every delta starts this far before the stored cursor (with no
// since_id) and re-applies the overlap idempotently.
const READ_OVERLAP_MS = 10_000;

// An API without the shared dictionary routes answers 404/405/501. Skip the
// step for the rest of the session (resets on next launch), like snippets.
let endpointUnavailable = false;

type Entries = SharedDictionaryState['entries'];

interface Cursor {
  at: string;
  id: string | null;
}

interface CursorKeys {
  at: string;
  id: string;
}

const ENTRIES_CURSOR: CursorKeys = {
  at: SHARED_DICTIONARY_CURSOR_KEY,
  id: SHARED_DICTIONARY_CURSOR_ID_KEY,
};
const HIDES_CURSOR: CursorKeys = {
  at: SHARED_DICTIONARY_HIDES_CURSOR_KEY,
  id: SHARED_DICTIONARY_HIDES_CURSOR_ID_KEY,
};

function readCursor(keys: CursorKeys): Cursor | null {
  const at = notesRepository.getSyncState(keys.at);
  if (!at || Number.isNaN(Date.parse(at))) return null;
  return { at, id: notesRepository.getSyncState(keys.id) };
}

// A pass stores its FIRST page's server_time: a row deleted (or unhidden)
// behind a later page of the same pass is then re-read next time. The cursor
// never moves backwards, whatever the server clock says. A snapshot whose first
// page had no usable server_time gets no cursor, so the next run snapshots.
function advanceCursor(
  previous: Cursor | null,
  at: string | undefined,
  id: string | null,
): Cursor | null {
  const valid = typeof at === 'string' && !Number.isNaN(Date.parse(at));
  if (!previous) return valid ? { at, id } : null;
  const next = valid && Date.parse(at) >= Date.parse(previous.at) ? at : previous.at;
  return { at: next, id: id ?? previous.id };
}

function writeCursor(keys: CursorKeys, cursor: Cursor | null): void {
  if (!cursor) {
    notesRepository.clearSyncState(keys.at);
    notesRepository.clearSyncState(keys.id);
    return;
  }
  notesRepository.setSyncState(keys.at, cursor.at);
  if (cursor.id) notesRepository.setSyncState(keys.id, cursor.id);
  else notesRepository.clearSyncState(keys.id);
}

function overlappedSince(cursor: Cursor): string {
  return new Date(Date.parse(cursor.at) - READ_OVERLAP_MS).toISOString();
}

const scopeKey = (scope: RemoteSharedScope): string => scope.space_id ?? 'workspace';

// A list the stored state didn't have (a member added to a space, a restored
// space, the member re-added): rows pruned earlier are unchanged on the
// server, so only a snapshot brings them back.
function hasReturningScope(stored: RemoteSharedScope[], incoming: RemoteSharedScope[]): boolean {
  const known = new Set(stored.map(scopeKey));
  return incoming.some((scope) => !known.has(scopeKey(scope)));
}

function isCursorExpired(err: unknown): boolean {
  return (
    err instanceof ApiError && err.status === 410 && err.code === 'SHARED_DICTIONARY_CURSOR_EXPIRED'
  );
}

// The member can't read this workspace's lists any more.
function isAccessLost(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    ((err.status === 404 && err.code === 'SHARED_DICTIONARY_NOT_MEMBER') ||
      (err.status === 403 && err.code === 'SSO_REQUIRED'))
  );
}

// Only an uncoded 404: the API's own 404s carry a code (NOT_MEMBER, handled as
// lost access) and are real answers from a deployed route. Coded 400s
// (SHARED_DICTIONARY_INVALID_REQUEST) are rethrown and reported.
function isEndpointUnavailable(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    ((err.status === 404 && !err.code) || err.status === 405 || err.status === 501)
  );
}

type WorkspaceTarget = { id: string; name: string } | null | 'unknown';

// The cached usage only counts when it was loaded for the signed-in account.
function currentUsage(): UsageInfo | null {
  const { usage, ownerKey } = useUsageStore.getState();
  return ownerKey !== null && ownerKey === getUsageOwnerKey() ? usage : null;
}

// 'unknown' when several workspaces need the entitlement to pick one and the
// usage can't be read: keep what is stored rather than clear it on a blip.
async function resolveWorkspace(
  checkpoint: SyncCheckpoint,
  known: RemoteWorkspace[] | null,
): Promise<WorkspaceTarget> {
  let workspaces = known;
  if (!workspaces) {
    checkpoint();
    workspaces = (await fetchMyWorkspaces()).data;
    checkpoint();
  }
  const ids = workspaces.map((workspace) => workspace.id);
  let entitled: string[] = [];
  if (new Set(ids).size > 1) {
    let usage = currentUsage();
    if (!usage) {
      checkpoint();
      await useUsageStore.getState().load();
      checkpoint();
      usage = currentUsage();
    }
    if (!usage) return 'unknown';
    entitled = usage.entitlementSources?.workspaceIds ?? [];
  }
  const id = resolveActiveWorkspaceId(ids, entitled);
  const workspace = workspaces.find((candidate) => candidate.id === id);
  return workspace ? { id: workspace.id, name: workspace.name } : null;
}

interface EntriesPass {
  kind: 'snapshot' | 'delta';
  entries: Entries;
  scopes: RemoteSharedScope[];
  paused: boolean;
  cursor: Cursor | null;
}

// Snapshot pages run on created_at, so a list the member joins mid-pass only
// shows up in later pages' scopes, without its older rows. `firstScopes` lets
// the caller spot that.
async function pullSnapshot(
  workspaceId: string,
  checkpoint: SyncCheckpoint,
): Promise<{ pass: EntriesPass; firstScopes: RemoteSharedScope[] }> {
  const entries: Entries = {};
  let page: SharedDictionaryPage = { limit: PAGE_LIMIT };
  let passStartedAt: string | undefined;
  let firstScopes: RemoteSharedScope[] | undefined;
  let lastId: string | null = null;
  while (true) {
    checkpoint();
    const response = await fetchSharedDictionary(workspaceId, page);
    checkpoint();
    passStartedAt ??= response.server_time;
    firstScopes ??= response.scopes;
    for (const entry of response.entries) {
      if (!entry.deleted_at) entries[entry.id] = { spaceId: entry.space_id, word: entry.word };
    }
    const last = response.entries.at(-1);
    if (last) lastId = last.id;
    if (!response.hasMore) {
      return {
        pass: {
          kind: 'snapshot',
          entries,
          scopes: response.scopes,
          paused: response.paused,
          cursor: advanceCursor(null, passStartedAt, lastId),
        },
        firstScopes,
      };
    }
    if (!last || (last.created_at === page.cursor && last.id === page.cursorId)) {
      throw new SyncStalledError('Shared dictionary snapshot stopped advancing');
    }
    page = { cursor: last.created_at, cursorId: last.id, limit: PAGE_LIMIT };
  }
}

// Pages into memory; nothing is written until the whole pass is in, so a pass
// cut short never half-replaces the stored state.
async function pullEntries(
  workspaceId: string,
  base: SharedDictionaryState | null,
  checkpoint: SyncCheckpoint,
): Promise<EntriesPass | 'scopesReturned'> {
  const stored = readCursor(ENTRIES_CURSOR);

  if (!stored || !base) {
    const snapshot = await pullSnapshot(workspaceId, checkpoint);
    if (!hasReturningScope(snapshot.firstScopes, snapshot.pass.scopes)) return snapshot.pass;
    const redo = await pullSnapshot(workspaceId, checkpoint);
    if (!hasReturningScope(redo.firstScopes, redo.pass.scopes)) return redo.pass;
    // Joined again during the redo: keep what was read but store no cursor, so
    // the next run snapshots instead of this one looping.
    return { ...redo.pass, cursor: null };
  }

  const entries: Entries = { ...base.entries };
  let page: SharedDictionaryPage = { since: overlappedSince(stored), limit: PAGE_LIMIT };
  let passStartedAt: string | undefined;
  let lastId: string | null = null;
  while (true) {
    checkpoint();
    const response = await fetchSharedDictionary(workspaceId, page);
    checkpoint();
    passStartedAt ??= response.server_time;
    for (const entry of response.entries) {
      if (entry.deleted_at) delete entries[entry.id];
      else entries[entry.id] = { spaceId: entry.space_id, word: entry.word };
    }
    const last = response.entries.at(-1);
    if (last) lastId = last.id;
    if (!response.hasMore) {
      if (hasReturningScope(base.scopes, response.scopes)) return 'scopesReturned';
      return {
        kind: 'delta',
        entries,
        scopes: response.scopes,
        paused: response.paused,
        cursor: advanceCursor(stored, passStartedAt, lastId),
      };
    }
    if (!last || (last.updated_at === page.since && last.id === page.sinceId)) {
      throw new SyncStalledError('Shared dictionary delta stopped advancing');
    }
    page = { since: last.updated_at, sinceId: last.id, limit: PAGE_LIMIT };
  }
}

// `base` null pages the hides snapshot, which replaces the stored hidden ids.
async function pullHides(
  workspaceId: string,
  base: string[] | null,
  checkpoint: SyncCheckpoint,
): Promise<{ hiddenIds: string[]; cursor: Cursor | null }> {
  const stored = base ? readCursor(HIDES_CURSOR) : null;
  const hidden = new Set(stored && base ? base : []);
  let page: SharedDictionaryPage = stored
    ? { since: overlappedSince(stored), limit: PAGE_LIMIT }
    : { limit: PAGE_LIMIT };
  let passStartedAt: string | undefined;
  let lastId: string | null = null;
  while (true) {
    checkpoint();
    const response = await fetchSharedDictionaryHides(workspaceId, page);
    checkpoint();
    passStartedAt ??= response.server_time;
    for (const hide of response.hides) {
      if (hide.deleted_at) hidden.delete(hide.entry_id);
      else hidden.add(hide.entry_id);
    }
    const last = response.hides.at(-1);
    if (last) lastId = last.entry_id;
    if (!response.hasMore) {
      return { hiddenIds: [...hidden], cursor: advanceCursor(stored, passStartedAt, lastId) };
    }
    if (stored) {
      if (!last || (last.updated_at === page.since && last.entry_id === page.sinceId)) {
        throw new SyncStalledError('Shared dictionary hides delta stopped advancing');
      }
      page = { since: last.updated_at, sinceId: last.entry_id, limit: PAGE_LIMIT };
    } else {
      if (!last || (last.updated_at === page.cursor && last.entry_id === page.cursorId)) {
        throw new SyncStalledError('Shared dictionary hides snapshot stopped advancing');
      }
      page = { cursor: last.updated_at, cursorId: last.entry_id, limit: PAGE_LIMIT };
    }
  }
}

interface PassResult {
  state: SharedDictionaryState;
  entriesCursor: Cursor | null;
  hidesCursor: Cursor | null;
}

// An expired cursor or a returning list re-runs the whole pass as a snapshot,
// once; a snapshot can neither expire nor bring a list back.
async function pullPass(
  workspace: { id: string; name: string },
  base: SharedDictionaryState | null,
  checkpoint: SyncCheckpoint,
): Promise<PassResult> {
  let forceSnapshot = false;
  while (true) {
    try {
      const entries = await pullEntries(workspace.id, forceSnapshot ? null : base, checkpoint);
      if (entries === 'scopesReturned') {
        checkpoint();
        resetSharedDictionaryCursors();
        forceSnapshot = true;
        continue;
      }
      const hides = await pullHides(
        workspace.id,
        entries.kind === 'snapshot' ? null : (base?.hiddenIds ?? null),
        checkpoint,
      );
      // A delta never resends a row of a list the member left, so prune here.
      const readableSpaces = new Set(entries.scopes.map((scope) => scope.space_id));
      const kept: Entries = {};
      for (const [id, entry] of Object.entries(entries.entries)) {
        if (entry.spaceId === null || readableSpaces.has(entry.spaceId)) kept[id] = entry;
      }
      return {
        state: {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          entries: kept,
          hiddenIds: hides.hiddenIds,
          scopes: entries.scopes,
          paused: entries.paused,
        },
        entriesCursor: entries.cursor,
        hidesCursor: hides.cursor,
      };
    } catch (err) {
      if (forceSnapshot || !isCursorExpired(err)) throw err;
      checkpoint();
      resetSharedDictionaryCursors();
      forceSnapshot = true;
    }
  }
}

// Returns whether a stored state was actually removed.
async function clearSharedDictionary(checkpoint: SyncCheckpoint): Promise<boolean> {
  checkpoint();
  const changed = await saveSharedDictionaryState(null);
  resetSharedDictionaryCursors();
  return changed;
}

/**
 * Mirrors the active workspace's shared words and the member's hides into
 * `shared_dictionary.state`. Gated on nothing but a signed-in account: shared
 * lists follow workspace membership, not cloud backup or a subscription, so
 * its writes check only the account (`checkpoint()`, never the upload gate).
 * `workspaces` is GET /api/workspaces as the spaces pass already read it;
 * null fetches it here.
 */
export async function pullSharedDictionary(
  checkpoint: SyncCheckpoint = uncheckedSync,
  workspaces: RemoteWorkspace[] | null = null,
): Promise<{ changed: boolean }> {
  if (endpointUnavailable) return { changed: false };
  const stored = await loadSharedDictionaryState();
  // Whether this run already removed a stored state, for the paths that end early.
  let removed = false;
  try {
    const workspace = await resolveWorkspace(checkpoint, workspaces);
    if (workspace === 'unknown') return { changed: false };
    if (!workspace) {
      return { changed: await clearSharedDictionary(checkpoint) };
    }

    const base = stored?.workspaceId === workspace.id ? stored : null;
    if (!base) {
      checkpoint();
      // The old workspace's words go too: if this workspace's first snapshot
      // fails, they must not be republished as its words.
      removed = await saveSharedDictionaryState(null);
      resetSharedDictionaryCursors();
    }

    const result = await pullPass(workspace, base, checkpoint);
    checkpoint();
    const changed = await saveSharedDictionaryState(result.state);
    writeCursor(ENTRIES_CURSOR, result.entriesCursor);
    writeCursor(HIDES_CURSOR, result.hidesCursor);
    return { changed };
  } catch (err) {
    if (isAccessLost(err)) {
      return { changed: (await clearSharedDictionary(checkpoint)) || removed };
    }
    if (isEndpointUnavailable(err)) {
      endpointUnavailable = true;
      return { changed: removed };
    }
    throw err;
  }
}
