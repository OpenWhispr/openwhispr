import { SyncCancelledError, uncheckedSync, type SyncCheckpoint } from './syncContext';
import * as Sentry from '@sentry/react-native';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { dictionaryEntries } from '@/db/schema';
import {
  batchCreateDictionary,
  deleteDictionaryEntry,
  updateDictionaryEntry,
  type DictionaryPushInput,
} from '@/data/remote/dictionaryApi';

const PUSH_BATCH_SIZE = 200;

interface ApiErrorLike {
  status?: number;
  code?: string;
}

function isHttpStatus(error: unknown, status: number): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as ApiErrorLike).status === status;
}

// Terminal: server has rejected this row and retrying won't change the outcome.
// Treat 400 (validation), 404 (target gone), and 409 (conflict) as terminal;
// other failures (5xx, network) retry on the next sync.
function isTerminal(error: unknown): boolean {
  return isHttpStatus(error, 400) || isHttpStatus(error, 404) || isHttpStatus(error, 409);
}

// The org turned cloud backup off (see policyBlocked in syncEngine.ts). Every
// row would fail identically, so bail out of the whole push immediately
// instead of retry-counting each one — see the matching guard in
// pushNotes.ts. Duck-typed so this file stays decoupled from apiClient.
function isPolicyCloudBackupBlocked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as ApiErrorLike;
  return e.status === 403 && e.code === 'POLICY_CLOUD_BACKUP_BLOCKED';
}

type Entry = typeof dictionaryEntries.$inferSelect;

function getPending(): Entry[] {
  return db.select().from(dictionaryEntries).where(eq(dictionaryEntries.pendingSync, 1)).all();
}

function markPushed(pushed: Entry, remoteId: string, serverUpdatedAt: string): void {
  const unchanged = and(
    eq(dictionaryEntries.word, pushed.word),
    eq(dictionaryEntries.source, pushed.source),
    isNull(dictionaryEntries.deletedAt),
    sql`${dictionaryEntries.updatedAt} IS ${pushed.updatedAt}`,
  );
  db.update(dictionaryEntries)
    .set({
      remoteId,
      pendingSync: sql`CASE WHEN ${unchanged} THEN 0 ELSE ${dictionaryEntries.pendingSync} END`,
      updatedAt: sql`CASE WHEN ${unchanged} THEN ${serverUpdatedAt} ELSE ${dictionaryEntries.updatedAt} END`,
    })
    .where(
      and(
        eq(dictionaryEntries.id, pushed.id),
        eq(dictionaryEntries.clientDictId, pushed.clientDictId!),
      ),
    )
    .run();
}

function markTerminal(localId: number): void {
  // Clear pendingSync so the row stops re-attempting; preserve the local state
  // so the user still sees their attempted change. They can edit it to fix and
  // retry — that will re-flag pending.
  db.update(dictionaryEntries)
    .set({ pendingSync: 0 })
    .where(eq(dictionaryEntries.id, localId))
    .run();
}

// Clear the stale remoteId so the next pending push goes through create rather
// than update. Used when the server says the target row no longer exists.
function clearRemoteId(localId: number): void {
  db.update(dictionaryEntries)
    .set({ remoteId: null })
    .where(eq(dictionaryEntries.id, localId))
    .run();
}

function hardDelete(localId: number): void {
  db.delete(dictionaryEntries).where(eq(dictionaryEntries.id, localId)).run();
}

export async function pushDictionary(checkpoint: SyncCheckpoint = uncheckedSync): Promise<void> {
  checkpoint();
  const pending = getPending();
  if (pending.length === 0) return;

  const creates: { pushed: Entry; localId: number; payload: DictionaryPushInput }[] = [];
  const updates: {
    pushed: Entry;
    localId: number;
    remoteId: string;
    payload: { word: string; source: 'manual' | 'learned' };
  }[] = [];
  const deletes: { localId: number; remoteId: string }[] = [];
  let failed = 0;

  for (const entry of pending) {
    if (entry.deletedAt) {
      if (entry.remoteId) {
        deletes.push({ localId: entry.id, remoteId: entry.remoteId });
      } else {
        hardDelete(entry.id);
      }
      continue;
    }

    if (!entry.clientDictId) {
      Sentry.captureMessage('pushDictionary: missing clientDictId', 'warning');
      markTerminal(entry.id);
      continue;
    }

    if (!entry.remoteId) {
      creates.push({
        pushed: entry,
        localId: entry.id,
        payload: {
          client_dict_id: entry.clientDictId,
          word: entry.word,
          source: entry.source,
          created_at: entry.createdAt ?? undefined,
          updated_at: entry.updatedAt ?? undefined,
        },
      });
      continue;
    }

    updates.push({
      pushed: entry,
      localId: entry.id,
      remoteId: entry.remoteId,
      payload: { word: entry.word, source: entry.source },
    });
  }

  for (let i = 0; i < creates.length; i += PUSH_BATCH_SIZE) {
    const chunk = creates.slice(i, i + PUSH_BATCH_SIZE);
    try {
      checkpoint(true);
      const created = await batchCreateDictionary(chunk.map((c) => c.payload));
      checkpoint();
      // Server may dedupe on lower(word); match by client_dict_id (server's
      // upsert favors the incoming client_dict_id over the existing one,
      // so the returned row should carry the one we sent).
      const byClientId = new Map(created.map((c) => [c.client_dict_id, c]));
      let unmatched = 0;
      for (const c of chunk) {
        const server = byClientId.get(c.payload.client_dict_id);
        if (server) {
          markPushed(c.pushed, server.id, server.updated_at);
        } else {
          unmatched += 1;
        }
      }
      if (unmatched > 0) {
        Sentry.captureMessage(
          `pushDictionary: ${unmatched}/${chunk.length} create rows had no matching server response`,
          'warning',
        );
      }
    } catch (e) {
      if (e instanceof SyncCancelledError) throw e;
      checkpoint();
      if (isPolicyCloudBackupBlocked(e)) throw e;
      if (isTerminal(e)) {
        for (const c of chunk) markTerminal(c.localId);
        Sentry.captureException(e, { tags: { sync: 'pushDictionary.create.terminal' } });
      } else {
        failed += 1;
        Sentry.captureException(e, { tags: { sync: 'pushDictionary.create' } });
      }
    }
  }

  for (const u of updates) {
    try {
      checkpoint(true);
      const server = await updateDictionaryEntry(u.remoteId, u.payload);
      checkpoint();
      if (!server || !server.id) {
        // Server returned a falsy response — should not happen with the
        // current API, but defend against it rather than throwing on null.id.
        Sentry.captureMessage('pushDictionary: update returned empty response', 'warning');
        markTerminal(u.localId);
        continue;
      }
      markPushed(u.pushed, server.id, server.updated_at);
    } catch (e) {
      if (e instanceof SyncCancelledError) throw e;
      checkpoint();
      if (isPolicyCloudBackupBlocked(e)) throw e;
      if (isHttpStatus(e, 404)) {
        // Target row was tombstoned/purged on the server. Clear the stale
        // remoteId so the next push re-creates instead of retrying the 404.
        clearRemoteId(u.localId);
        Sentry.captureException(e, { tags: { sync: 'pushDictionary.update.404' } });
      } else if (isTerminal(e)) {
        markTerminal(u.localId);
        Sentry.captureException(e, { tags: { sync: 'pushDictionary.update.terminal' } });
      } else {
        failed += 1;
        Sentry.captureException(e, { tags: { sync: 'pushDictionary.update' } });
      }
    }
  }

  for (const d of deletes) {
    try {
      checkpoint(true);
      await deleteDictionaryEntry(d.remoteId);
      checkpoint();
      hardDelete(d.localId);
    } catch (e) {
      if (e instanceof SyncCancelledError) throw e;
      checkpoint();
      if (isPolicyCloudBackupBlocked(e)) throw e;
      if (isHttpStatus(e, 404)) {
        // Server already doesn't know about this row — treat as success.
        hardDelete(d.localId);
      } else if (isTerminal(e)) {
        markTerminal(d.localId);
        Sentry.captureException(e, { tags: { sync: 'pushDictionary.delete.terminal' } });
      } else {
        failed += 1;
        Sentry.captureException(e, { tags: { sync: 'pushDictionary.delete' } });
      }
    }
  }

  if (failed > 0) {
    throw new Error(`pushDictionary: ${failed} operation(s) failed`);
  }
}
