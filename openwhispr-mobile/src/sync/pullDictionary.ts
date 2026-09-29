import { uncheckedSync, type SyncCheckpoint } from './syncContext';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { dictionaryEntries } from '@/db/schema';
import {
  fetchDictionary,
  fetchDictionarySnapshot,
  type RemoteDictionaryEntry,
} from '@/data/remote/dictionaryApi';
import { notesRepository } from '@/data';
import { DICTIONARY_CURSOR_KEY, DICTIONARY_CURSOR_ID_KEY } from './pullCursors';

const PAGE_SIZE = 200;

// Prioritized lookup: client_dict_id (strongest identity, per-device unique),
// then remote_id (server-assigned UUID, set after first push), then lower(word)
// as a last-resort cross-device match. Each lookup prefers an active row over
// a tombstoned one so we can't accidentally restore a tombstone while an
// active row with the same lower(word) exists (which would violate the
// partial unique index).
function findLocal(remote: RemoteDictionaryEntry): typeof dictionaryEntries.$inferSelect | null {
  const lower = remote.word.toLowerCase();

  const tryFind = (where: ReturnType<typeof and>): typeof dictionaryEntries.$inferSelect | null => {
    const active = db
      .select()
      .from(dictionaryEntries)
      .where(and(where, isNull(dictionaryEntries.deletedAt)))
      .get();
    if (active) return active;
    return (
      db
        .select()
        .from(dictionaryEntries)
        .where(and(where, isNotNull(dictionaryEntries.deletedAt)))
        .get() ?? null
    );
  };

  if (remote.client_dict_id) {
    const byClient = tryFind(eq(dictionaryEntries.clientDictId, remote.client_dict_id));
    if (byClient) return byClient;
  }

  const byRemote = tryFind(eq(dictionaryEntries.remoteId, remote.id));
  if (byRemote) return byRemote;

  return tryFind(sql`lower(${dictionaryEntries.word}) = ${lower}`);
}

function applyRemote(remote: RemoteDictionaryEntry): void {
  const local = findLocal(remote);

  // Defensive: server enum is type-only via Drizzle's enum syntax. A future
  // server-side enum addition would otherwise silently land as unknown text.
  const source: 'manual' | 'learned' = remote.source === 'learned' ? 'learned' : 'manual';

  if (!local && remote.deleted_at) return;

  if (!local) {
    db.insert(dictionaryEntries)
      .values({
        word: remote.word,
        source,
        clientDictId: remote.client_dict_id,
        remoteId: remote.id,
        deletedAt: remote.deleted_at,
        pendingSync: 0,
        createdAt: remote.created_at,
        updatedAt: remote.updated_at,
      })
      .run();
    return;
  }

  // Server tombstones override local non-pending state, and override
  // pending state EXCEPT when local is a never-synced create — in that case
  // the local row represents a fresh user intent that predates the server
  // having seen anything; the tombstone is for an older incarnation and
  // shouldn't wipe the new one. The fresh create will push and resurrect.
  if (remote.deleted_at) {
    if (!local.remoteId && local.pendingSync === 1) return;
    db.delete(dictionaryEntries).where(eq(dictionaryEntries.id, local.id)).run();
    return;
  }

  // For non-tombstone updates, a local pending write wins until pushed.
  if (local.pendingSync === 1) return;

  db.update(dictionaryEntries)
    .set({
      word: remote.word,
      source,
      clientDictId: remote.client_dict_id ?? local.clientDictId,
      remoteId: remote.id,
      deletedAt: null,
      pendingSync: 0,
      updatedAt: remote.updated_at,
    })
    .where(eq(dictionaryEntries.id, local.id))
    .run();
}

type Fetcher = (
  cursor: string | null,
  limit: number,
  cursorId: string | null,
) => Promise<{ entries: RemoteDictionaryEntry[]; hasMore: boolean }>;

// Shared walk that paginates either keyset (snapshot or delta). The caller
// supplies the field that drives cursor advancement — `created_at` for
// snapshot pulls (which order by created_at) and `updated_at` for delta pulls
// (ordered by updated_at). Either way the (cursor, id) pair is a strict
// keyset; stale-cursor short-circuit guards against an infinite loop if the
// server ever returned a page without advancing the boundary.
async function walkPages(
  fetcher: Fetcher,
  cursorField: 'created_at' | 'updated_at',
  initialCursor: string | null,
  initialCursorId: string | null,
  maxes: { updatedAt: string; id: string },
  checkpoint: SyncCheckpoint,
): Promise<void> {
  let cursor = initialCursor;
  let cursorId = initialCursorId;

  while (true) {
    checkpoint();
    const { entries, hasMore } = await fetcher(cursor, PAGE_SIZE, cursorId);
    checkpoint();
    if (entries.length === 0) break;

    for (const remote of entries) {
      applyRemote(remote);
      if (remote.updated_at > maxes.updatedAt) {
        maxes.updatedAt = remote.updated_at;
        maxes.id = remote.id;
      } else if (remote.updated_at === maxes.updatedAt && remote.id > maxes.id) {
        maxes.id = remote.id;
      }
    }

    if (!hasMore) break;
    const last = entries[entries.length - 1];
    const lastCursor = last[cursorField];
    if (lastCursor === cursor && last.id === cursorId) break;
    cursor = lastCursor;
    cursorId = last.id;
  }
}

// Two-phase pull: first sync walks the (created_at, id) snapshot keyset so
// every row is fetched in a consistent ordering; later syncs walk the
// (updated_at, id) delta keyset to stream changes.
//
// Using delta on the first sync would mid-stream two orderings — the server's
// default no-keyset branch returns by created_at, but the loop's cursor
// advances by updated_at on iteration 2, which can silently skip rows whose
// updated_at < the first page's max updated_at. Snapshot avoids that entirely.
//
// `maxes.updatedAt` is tracked across both phases so the first sync persists a
// correct delta boundary for subsequent runs.
export async function pullDictionary(checkpoint: SyncCheckpoint = uncheckedSync): Promise<void> {
  checkpoint();
  const since = notesRepository.getSyncState(DICTIONARY_CURSOR_KEY);
  const sinceId = notesRepository.getSyncState(DICTIONARY_CURSOR_ID_KEY);
  const maxes = { updatedAt: since ?? '', id: sinceId ?? '' };

  if (!since) {
    checkpoint();
    await walkPages(fetchDictionarySnapshot, 'created_at', null, null, maxes, checkpoint);
    checkpoint();
  } else {
    checkpoint();
    await walkPages(fetchDictionary, 'updated_at', since, sinceId, maxes, checkpoint);
    checkpoint();
  }

  if (maxes.updatedAt) notesRepository.setSyncState(DICTIONARY_CURSOR_KEY, maxes.updatedAt);
  if (maxes.id) notesRepository.setSyncState(DICTIONARY_CURSOR_ID_KEY, maxes.id);
}
