import { asc, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { snippets } from '@/db/schema';
import type { CreateLibraryLoad } from '@/store/createLibraryLoad';

// Account recovery catches a failed collection read before continuing the switch.
export const createAndroidLibraryLoad: CreateLibraryLoad = (read) =>
  function load() {
    read();
    return Promise.resolve();
  };

export function findAndroidSnippetByTrigger(trigger: string, deleted: boolean) {
  const rows = db
    .select()
    .from(snippets)
    .where(deleted ? isNotNull(snippets.deletedAt) : isNull(snippets.deletedAt))
    .orderBy(asc(snippets.id))
    .all();
  // SQLite lower() folds ASCII only. Match the UI's Unicode normalization,
  // preferring an exact spelling when older synced rows differ only by case.
  return (
    rows.find((row) => row.trigger === trigger) ??
    rows.find((row) => row.trigger.toLowerCase() === trigger.toLowerCase()) ??
    null
  );
}
