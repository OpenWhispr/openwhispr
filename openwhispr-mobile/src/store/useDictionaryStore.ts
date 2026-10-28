import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { create } from 'zustand';
import { db } from '@/db';
import { dictionaryEntries } from '@/db/schema';
import { randomUUID } from '@/lib/uuid';

export type DictionarySource = 'manual' | 'learned';

export interface DictionaryEntry {
  word: string;
  source: DictionarySource;
  addedAt: number | null;
  // When the word was moved into a shared list; it stays a live personal word.
  sharedAt: number | null;
}

interface DictionaryStore {
  entries: DictionaryEntry[];
  isLoaded: boolean;
  load: () => Promise<void>;
  reset: () => void;
  addWords: (input: string) => void;
  addLearnedWords: (words: string[]) => void;
  removeWord: (word: string) => void;
  clearAll: () => void;
}

type Row = typeof dictionaryEntries.$inferSelect;

// SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" (no T, no Z); remote
// pulls store ISO 8601 already containing T+Z. Normalize so both yield a valid
// Date — replace space with T, strip any trailing Z, then append exactly one.
function parseStoredTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(' ', 'T').replace(/Z$/, '') + 'Z';
  const ms = new Date(normalized).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function rowToEntry(row: Row): DictionaryEntry {
  return {
    word: row.word,
    source: row.source,
    addedAt: parseStoredTimestamp(row.createdAt),
    sharedAt: parseStoredTimestamp(row.sharedAt),
  };
}

function readAllActiveEntries(): DictionaryEntry[] {
  return db
    .select()
    .from(dictionaryEntries)
    .where(isNull(dictionaryEntries.deletedAt))
    .all()
    .map(rowToEntry);
}

// Prefer the active row when both an active and tombstoned row share lower(word).
// Restoring a tombstone while an active row exists would violate the partial
// unique index `idx_dictionary_word_lower WHERE deleted_at IS NULL`.
function findActiveByLowerWord(word: string): Row | null {
  const lower = word.toLowerCase();
  return (
    db
      .select()
      .from(dictionaryEntries)
      .where(
        and(sql`lower(${dictionaryEntries.word}) = ${lower}`, isNull(dictionaryEntries.deletedAt)),
      )
      .get() ?? null
  );
}

function findTombstoneByLowerWord(word: string): Row | null {
  const lower = word.toLowerCase();
  return (
    db
      .select()
      .from(dictionaryEntries)
      .where(
        and(
          sql`lower(${dictionaryEntries.word}) = ${lower}`,
          isNotNull(dictionaryEntries.deletedAt),
        ),
      )
      .get() ?? null
  );
}

function applyAddOne(word: string, source: DictionarySource): boolean {
  const active = findActiveByLowerWord(word);
  if (active) {
    // Active row exists. Promote learned→manual if appropriate, and update
    // casing so the user's latest input wins. An explicit add of a word moved
    // into a shared list takes it back into Personal (as desktop does); a
    // learned one never does. Otherwise no-op.
    const promote = active.source === 'learned' && source === 'manual';
    const takeBack = source === 'manual' && active.sharedAt !== null;
    if (!promote && !takeBack && active.word === word) return false;
    db.update(dictionaryEntries)
      .set({
        word,
        ...(promote ? { source: 'manual' as const } : {}),
        ...(takeBack ? { sharedAt: null, sharedAtCleared: 1 } : {}),
        pendingSync: 1,
        updatedAt: sql`datetime('now')`,
      })
      .where(eq(dictionaryEntries.id, active.id))
      .run();
    return true;
  }

  // A restored word is personal again (as desktop's restore), so the clear is
  // pushed whatever shared_at the server last sent: it may have moved the word
  // since.
  const tombstone = findTombstoneByLowerWord(word);
  if (tombstone) {
    const nextSource: DictionarySource =
      tombstone.source === 'learned' && source === 'manual' ? 'manual' : tombstone.source;
    db.update(dictionaryEntries)
      .set({
        deletedAt: null,
        word,
        source: nextSource,
        sharedAt: null,
        sharedAtCleared: 1,
        pendingSync: 1,
        updatedAt: sql`datetime('now')`,
      })
      .where(eq(dictionaryEntries.id, tombstone.id))
      .run();
    return true;
  }

  db.insert(dictionaryEntries)
    .values({
      word,
      source,
      clientDictId: randomUUID(),
      pendingSync: 1,
      updatedAt: sql`datetime('now')`,
    })
    .run();
  return true;
}

function softDeleteOne(word: string): boolean {
  const active = findActiveByLowerWord(word);
  if (!active) return false;
  // A first upload may still be in flight without a remoteId. Keep its identity
  // until the serialized sync pass can acknowledge the create and send the delete.
  db.update(dictionaryEntries)
    .set({
      deletedAt: sql`datetime('now')`,
      pendingSync: 1,
      updatedAt: sql`datetime('now')`,
    })
    .where(eq(dictionaryEntries.id, active.id))
    .run();
  return true;
}

// Dynamic import to avoid a circular dep — syncEngine imports this store.
// Fire-and-forget: callers don't need to await or handle rejection.
function triggerSync(): void {
  import('@/sync/syncEngine').then(({ requestSync }) => requestSync('after-write')).catch(() => {});
}

// Wraps the per-word loop in a single transaction so concurrent writers
// (manual addWords + background addLearnedWords) can't both pass the
// existence check and race to INSERT. The tx param is unused — applyAddOne
// uses the outer `db`, which expo-sqlite's single-connection engine routes
// through the active transaction.
function addUnique(words: string[], source: DictionarySource): boolean {
  let changed = false;
  db.transaction((_tx) => {
    for (const raw of words) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (applyAddOne(trimmed, source)) changed = true;
    }
  });
  return changed;
}

export const useDictionaryStore = create<DictionaryStore>((set) => ({
  entries: [],
  isLoaded: false,

  load: async () => {
    set({ entries: readAllActiveEntries(), isLoaded: true });
  },

  // In-memory reset for sign-out; SQLite rows are wiped separately by
  // notesRepository.wipeAllSyncableData on account switch.
  reset: () => {
    set({ entries: [], isLoaded: false });
  },

  addWords: (input: string) => {
    const changed = addUnique(input.split(','), 'manual');
    if (!changed) return;
    set({ entries: readAllActiveEntries() });
    triggerSync();
  },

  addLearnedWords: (incoming: string[]) => {
    const changed = addUnique(incoming, 'learned');
    if (!changed) return;
    set({ entries: readAllActiveEntries() });
    triggerSync();
  },

  removeWord: (word: string) => {
    let changed = false;
    db.transaction((_tx) => {
      changed = softDeleteOne(word);
    });
    if (!changed) return;
    set({ entries: readAllActiveEntries() });
    triggerSync();
  },

  clearAll: () => {
    // Preserve identities for creates that may still be in flight, just as removeWord does.
    const tombstoned = db
      .update(dictionaryEntries)
      .set({
        deletedAt: sql`datetime('now')`,
        pendingSync: 1,
        updatedAt: sql`datetime('now')`,
      })
      .where(isNull(dictionaryEntries.deletedAt))
      .run();
    if ((tombstoned.changes ?? 0) === 0) return;
    set({ entries: readAllActiveEntries() });
    triggerSync();
  },
}));
