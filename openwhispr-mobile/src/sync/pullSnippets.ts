import { uncheckedSync, type SyncCheckpoint } from './syncContext';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { snippets } from '@/db/schema';
import {
  fetchSnippets,
  fetchSnippetsSnapshot,
  type RemoteSnippet,
} from '@/data/remote/snippetsApi';
import { notesRepository } from '@/data';
import { SNIPPETS_CURSOR_KEY, SNIPPETS_CURSOR_ID_KEY } from './pullCursors';

const PAGE_SIZE = 200;

// Prioritized lookup: client_snippet_id (strongest identity, per-device unique),
// then remote_id (server-assigned UUID, set after first push), then lower(trigger)
// as a last-resort cross-device match. Each lookup prefers an active row over a
// tombstoned one so we can't restore a tombstone while an active row with the
// same lower(trigger) exists (which would violate the partial unique index).
function findLocal(remote: RemoteSnippet): typeof snippets.$inferSelect | null {
  const lower = remote.trigger.toLowerCase();

  const tryFind = (where: ReturnType<typeof and>): typeof snippets.$inferSelect | null => {
    const active = db
      .select()
      .from(snippets)
      .where(and(where, isNull(snippets.deletedAt)))
      .get();
    if (active) return active;
    return (
      db
        .select()
        .from(snippets)
        .where(and(where, isNotNull(snippets.deletedAt)))
        .get() ?? null
    );
  };

  if (remote.client_snippet_id) {
    const byClient = tryFind(eq(snippets.clientSnippetId, remote.client_snippet_id));
    if (byClient) return byClient;
  }

  const byRemote = tryFind(eq(snippets.remoteId, remote.id));
  if (byRemote) return byRemote;

  return tryFind(sql`lower(${snippets.trigger}) = ${lower}`);
}

function applyRemote(remote: RemoteSnippet): void {
  const local = findLocal(remote);

  if (!local && remote.deleted_at) return;

  if (!local) {
    db.insert(snippets)
      .values({
        trigger: remote.trigger,
        replacement: remote.replacement,
        clientSnippetId: remote.client_snippet_id,
        remoteId: remote.id,
        deletedAt: remote.deleted_at,
        pendingSync: 0,
        createdAt: remote.created_at,
        updatedAt: remote.updated_at,
      })
      .run();
    return;
  }

  // Server tombstones override local non-pending state, and override pending
  // state EXCEPT when local is a never-synced create — that row is fresh user
  // intent the server hasn't seen; the tombstone is for an older incarnation and
  // shouldn't wipe it. The fresh create will push and resurrect.
  if (remote.deleted_at) {
    if (!local.remoteId && local.pendingSync === 1) return;
    db.delete(snippets).where(eq(snippets.id, local.id)).run();
    return;
  }

  // For non-tombstone updates, a local pending write wins until pushed.
  if (local.pendingSync === 1) return;

  db.update(snippets)
    .set({
      trigger: remote.trigger,
      replacement: remote.replacement,
      clientSnippetId: remote.client_snippet_id ?? local.clientSnippetId,
      remoteId: remote.id,
      deletedAt: null,
      pendingSync: 0,
      updatedAt: remote.updated_at,
    })
    .where(eq(snippets.id, local.id))
    .run();
}

type Fetcher = (
  cursor: string | null,
  limit: number,
  cursorId: string | null,
) => Promise<{ entries: RemoteSnippet[]; hasMore: boolean }>;

// Shared walk that paginates either keyset (snapshot or delta). The caller
// supplies the field driving cursor advancement — `created_at` for snapshot
// pulls, `updated_at` for delta pulls. The (cursor, id) pair is a strict keyset;
// the stale-cursor short-circuit guards against an infinite loop.
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

// Two-phase pull: first sync walks the (created_at, id) snapshot keyset; later
// syncs walk the (updated_at, id) delta keyset. `maxes.updatedAt` is tracked
// across both phases so the first sync persists a correct delta boundary.
export async function pullSnippets(checkpoint: SyncCheckpoint = uncheckedSync): Promise<void> {
  checkpoint();
  const since = notesRepository.getSyncState(SNIPPETS_CURSOR_KEY);
  const sinceId = notesRepository.getSyncState(SNIPPETS_CURSOR_ID_KEY);
  const maxes = { updatedAt: since ?? '', id: sinceId ?? '' };

  if (!since) {
    checkpoint();
    await walkPages(fetchSnippetsSnapshot, 'created_at', null, null, maxes, checkpoint);
    checkpoint();
  } else {
    checkpoint();
    await walkPages(fetchSnippets, 'updated_at', since, sinceId, maxes, checkpoint);
    checkpoint();
  }

  if (maxes.updatedAt) notesRepository.setSyncState(SNIPPETS_CURSOR_KEY, maxes.updatedAt);
  if (maxes.id) notesRepository.setSyncState(SNIPPETS_CURSOR_ID_KEY, maxes.id);
}
