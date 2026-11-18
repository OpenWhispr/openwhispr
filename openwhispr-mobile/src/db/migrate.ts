import 'expo-sqlite/localStorage/install';
import * as SQLite from 'expo-sqlite';
import {
  DEFAULT_ACTIONS_SQL,
  migrateDictionaryFromLocalStorage,
  migrateSchema,
  seedPrivateSpaceAndBackfillSpaceId,
} from './migrationSteps';

const rawDb = SQLite.openDatabaseSync('openwhispr_notes.db');

export function runMigrations(): void {
  migrateSchema(rawDb);
  migrateDictionaryFromLocalStorage(rawDb);
  rawDb.execSync(`
    INSERT OR IGNORE INTO folders (id, name, is_default, sort_order) VALUES (1, 'Personal', 1, 0);
    INSERT OR IGNORE INTO folders (id, name, is_default, sort_order) VALUES (2, 'Meetings', 1, 1);
${DEFAULT_ACTIONS_SQL}`);
  rawDb.execSync('UPDATE folders SET sort_order = 0 WHERE id = 1');
  seedPrivateSpaceAndBackfillSpaceId(rawDb);
}
