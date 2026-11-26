import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { create } from 'zustand';
import { db } from '@/db';
import { snippets } from '@/db/schema';
import type { Snippet } from '@/lib/snippets';
import { randomUUID } from '@/lib/uuid';

interface SnippetsStore {
  entries: Snippet[];
  isLoaded: boolean;
  load: () => Promise<void>;
  reset: () => void;
  addSnippet: (trigger: string, replacement: string) => void;
  updateSnippet: (oldTrigger: string, next: Snippet) => void;
  removeSnippet: (trigger: string) => void;
}

type Row = typeof snippets.$inferSelect;

function rowToSnippet(row: Row): Snippet {
  return { trigger: row.trigger, replacement: row.replacement };
}

function readAllActiveEntries(): Snippet[] {
  return db
    .select()
    .from(snippets)
    .where(isNull(snippets.deletedAt))
    .orderBy(asc(snippets.id))
    .all()
    .map(rowToSnippet);
}

// Prefer the active row when both an active and tombstoned row share lower(trigger).
// Restoring a tombstone while an active row exists would violate the partial unique
// index `idx_snippets_trigger_lower WHERE deleted_at IS NULL`.
function findActiveByLowerTrigger(trigger: string): Row | null {
  const lower = trigger.toLowerCase();
  return (
    db
      .select()
      .from(snippets)
      .where(and(sql`lower(${snippets.trigger}) = ${lower}`, isNull(snippets.deletedAt)))
      .get() ?? null
  );
}

function findTombstoneByLowerTrigger(trigger: string): Row | null {
  const lower = trigger.toLowerCase();
  return (
    db
      .select()
      .from(snippets)
      .where(and(sql`lower(${snippets.trigger}) = ${lower}`, isNotNull(snippets.deletedAt)))
      .get() ?? null
  );
}

// Upsert by lower(trigger): update an existing active row's text, revive a
// tombstone, or insert a new row. Returns false when nothing changed.
function applyAddOne(trigger: string, replacement: string): boolean {
  const active = findActiveByLowerTrigger(trigger);
  if (active) {
    if (active.trigger !== trigger || active.replacement !== replacement) {
      db.update(snippets)
        .set({ trigger, replacement, pendingSync: 1, updatedAt: sql`datetime('now')` })
        .where(eq(snippets.id, active.id))
        .run();
      return true;
    }
    return false;
  }

  const tombstone = findTombstoneByLowerTrigger(trigger);
  if (tombstone) {
    db.update(snippets)
      .set({
        deletedAt: null,
        trigger,
        replacement,
        pendingSync: 1,
        updatedAt: sql`datetime('now')`,
      })
      .where(eq(snippets.id, tombstone.id))
      .run();
    return true;
  }

  db.insert(snippets)
    .values({
      trigger,
      replacement,
      clientSnippetId: randomUUID(),
      pendingSync: 1,
      updatedAt: sql`datetime('now')`,
    })
    .run();
  return true;
}

function softDeleteOne(trigger: string): boolean {
  const active = findActiveByLowerTrigger(trigger);
  if (!active) return false;
  // A first upload may still be in flight without a remoteId. Keep its identity
  // until the serialized sync pass can acknowledge the create and send the delete.
  db.update(snippets)
    .set({
      deletedAt: sql`datetime('now')`,
      pendingSync: 1,
      updatedAt: sql`datetime('now')`,
    })
    .where(eq(snippets.id, active.id))
    .run();
  return true;
}

// Dynamic import to avoid a circular dep — syncEngine imports this store.
// Fire-and-forget: callers don't need to await or handle rejection.
function triggerSync(): void {
  import('@/sync/syncEngine').then(({ requestSync }) => requestSync('after-write')).catch(() => {});
}

export const useSnippetsStore = create<SnippetsStore>((set) => ({
  entries: [],
  isLoaded: false,

  load: async () => {
    set({ entries: readAllActiveEntries(), isLoaded: true });
  },

  // In-memory reset for sign-out; SQLite rows are wiped separately on account switch.
  reset: () => {
    set({ entries: [], isLoaded: false });
  },

  addSnippet: (triggerRaw, replacementRaw) => {
    const trigger = triggerRaw.trim();
    const replacement = replacementRaw.trim();
    if (!trigger || !replacement) return;
    let changed = false;
    db.transaction((_tx) => {
      changed = applyAddOne(trigger, replacement);
    });
    if (!changed) return;
    set({ entries: readAllActiveEntries() });
    triggerSync();
  },

  updateSnippet: (oldTrigger, next) => {
    const trigger = next.trigger.trim();
    const replacement = next.replacement.trim();
    if (!trigger || !replacement) return;
    let changed = false;
    db.transaction((_tx) => {
      const active = findActiveByLowerTrigger(oldTrigger);
      if (!active) return;
      // Renaming onto a trigger another active row already holds would violate the
      // unique index — skip (the UI validates this before calling).
      if (trigger.toLowerCase() !== oldTrigger.trim().toLowerCase()) {
        const collision = findActiveByLowerTrigger(trigger);
        if (collision && collision.id !== active.id) return;
      }
      if (active.trigger === trigger && active.replacement === replacement) return;
      db.update(snippets)
        .set({ trigger, replacement, pendingSync: 1, updatedAt: sql`datetime('now')` })
        .where(eq(snippets.id, active.id))
        .run();
      changed = true;
    });
    if (!changed) return;
    set({ entries: readAllActiveEntries() });
    triggerSync();
  },

  removeSnippet: (trigger) => {
    let changed = false;
    db.transaction((_tx) => {
      changed = softDeleteOne(trigger);
    });
    if (!changed) return;
    set({ entries: readAllActiveEntries() });
    triggerSync();
  },
}));
