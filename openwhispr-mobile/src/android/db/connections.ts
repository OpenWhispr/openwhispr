import { Platform } from 'react-native';
import * as SQLite from 'expo-sqlite';

const androidConnections = new Map<string, SQLite.SQLiteDatabase>();

export function openApplicationDatabase(name: string): SQLite.SQLiteDatabase {
  if (Platform.OS !== 'android') return SQLite.openDatabaseSync(name);

  const existing = androidConnections.get(name);
  if (existing) return existing;

  // SDK 55 can release a cached native binding when another JS handle is
  // collected. Retain one handle per file and bypass that native cache.
  // Account switches must not close connections still held by pending queries.
  const connection = SQLite.openDatabaseSync(name, { useNewConnection: true });
  androidConnections.set(name, connection);
  return connection;
}
