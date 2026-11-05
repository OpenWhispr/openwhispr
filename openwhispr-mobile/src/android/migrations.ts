import 'expo-sqlite/localStorage/install';
import type * as SQLite from 'expo-sqlite';
import { openApplicationDatabase } from '@/db/connections';
import {
  DEFAULT_ACTIONS_SQL,
  migrateDictionaryFromLocalStorage,
  migrateSchema,
  seedPrivateSpaceAndBackfillSpaceId,
} from '@/db/migrationSteps';

const legacyDb = openApplicationDatabase('openwhispr_notes.db');

function seedDefaultFolders(rawDb: SQLite.SQLiteDatabase): void {
  const privateSpaceId = rawDb.getAllSync<{ id: number }>(
    "SELECT id FROM spaces WHERE kind = 'private' LIMIT 1",
  )[0]?.id;
  if (privateSpaceId == null) return;

  for (const [legacyId, name, sortOrder] of [
    [1, 'Personal', 0],
    [2, 'Meetings', 1],
  ] as const) {
    // Old launches recreated ids 1/2 after account-switch pulls assigned new ids.
    // Retire only unused, unchanged seeds; synced/customized folders and every
    // note reference (including soft-deleted notes) must survive untouched.
    rawDb.runSync(
      `DELETE FROM folders
       WHERE id = ? AND name = ? AND sort_order = ? AND space_id = ?
         AND is_default = 1 AND deleted_at IS NULL AND pending_sync = 0
         AND remote_id IS NULL AND client_folder_id IS NULL AND updated_at = created_at
         AND NOT EXISTS (SELECT 1 FROM notes WHERE folder_id = folders.id)
         AND NOT EXISTS (SELECT 1 FROM folder_delete_journal WHERE folder_id = folders.id)
         AND EXISTS (
           SELECT 1 FROM folders AS synced
           WHERE synced.id != folders.id AND synced.space_id = folders.space_id
             AND synced.is_default = 1 AND synced.deleted_at IS NULL
             AND synced.remote_id IS NOT NULL AND lower(synced.name) = lower(folders.name)
         )`,
      legacyId,
      name,
      sortOrder,
      privateSpaceId,
    );
    // Local ids are not stable across account switches. Reuse a private default
    // by name, also preserving renamed legacy defaults and deletion tombstones.
    rawDb.runSync(
      `INSERT INTO folders (name, is_default, sort_order, space_id)
       SELECT ?, 1, ?, ? WHERE NOT EXISTS (
         SELECT 1 FROM folders WHERE space_id = ? AND is_default = 1
           AND (lower(name) = lower(?)
             OR (id = ? AND lower(name) NOT IN ('personal', 'meetings')))
       )`,
      name,
      sortOrder,
      privateSpaceId,
      privateSpaceId,
      name,
      legacyId,
    );
  }
}

export function runMigrations(
  rawDb: SQLite.SQLiteDatabase = legacyDb,
  migrateLegacyDictionary = true,
): void {
  migrateSchema(rawDb);
  if (migrateLegacyDictionary) migrateDictionaryFromLocalStorage(rawDb);
  seedPrivateSpaceAndBackfillSpaceId(rawDb);
  seedDefaultFolders(rawDb);
  rawDb.execSync(DEFAULT_ACTIONS_SQL);
}
