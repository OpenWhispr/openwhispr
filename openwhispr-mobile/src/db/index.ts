import { drizzle } from 'drizzle-orm/expo-sqlite';
import * as SQLite from 'expo-sqlite';
import * as schema from './schema';
import { openApplicationDatabase } from './connections';

const expo = openApplicationDatabase('openwhispr_notes.db');
let active = drizzle(expo, { schema });
let unavailable = false;

// Repositories retain this handle. Resolve each operation against the selected
// account; already-created queries keep their original connection.
export const db = new Proxy(active, {
  get(_target, property) {
    if (unavailable) throw new Error('Local account data is unavailable. Please retry.');
    const value = Reflect.get(active, property);
    return typeof value === 'function' ? value.bind(active) : value;
  },
});

export function blockAccountDatabase(): void {
  unavailable = true;
}

export function activateAccountDatabase(database: SQLite.SQLiteDatabase): void {
  active = drizzle(database, { schema });
  unavailable = false;
}
