import 'expo-sqlite/localStorage/install';
import * as FileSystem from 'expo-file-system/legacy';
import { create } from 'zustand';
import { activateAccountDatabase, blockAccountDatabase } from '@/db';
import { runMigrations } from '@/db/migrate';
import { openApplicationDatabase } from '@/db/connections';
import { randomUUID } from '@/lib/uuid';

const MANIFEST_KEY = 'android.local-accounts.v1';
const LEGACY_DATABASE = 'openwhispr_notes.db';
const LOCAL_OWNER = 'local';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type User = { id: string; isAnonymous?: boolean } | null;
type AccountData = {
  owner: string;
  file: string;
  audioNamespace: string;
  anonymous: boolean;
  deleted?: boolean;
  erasureComplete?: boolean;
  pendingAudio?: string[];
};
type Manifest = {
  accounts: AccountData[];
  anonymousOwner: string | null;
  realAccountHistory: boolean;
};

export const useAccountData = create<{
  owner: string | null;
  audioNamespace: string;
  revision: number;
  error: string | null;
  blocked: boolean;
}>(() => ({ owner: null, audioNamespace: '', revision: 0, error: null, blocked: true }));

const ownerFor = (user: User): string => (user ? `account:${user.id}` : LOCAL_OWNER);

function readManifest(): Manifest {
  const raw = localStorage.getItem(MANIFEST_KEY);
  if (raw !== null) {
    const value = JSON.parse(raw) as Manifest;
    if (
      !value ||
      !Array.isArray(value.accounts) ||
      !value.accounts.length ||
      typeof value.realAccountHistory !== 'boolean' ||
      !(value.anonymousOwner === null || typeof value.anonymousOwner === 'string') ||
      value.accounts.some(
        (entry) =>
          !entry ||
          typeof entry.owner !== 'string' ||
          typeof entry.anonymous !== 'boolean' ||
          !(entry.deleted === undefined || typeof entry.deleted === 'boolean') ||
          !(entry.erasureComplete === undefined || typeof entry.erasureComplete === 'boolean') ||
          !(
            entry.pendingAudio === undefined ||
            (Array.isArray(entry.pendingAudio) &&
              entry.pendingAudio.every((uri) => typeof uri === 'string'))
          ) ||
          !(entry.audioNamespace === ''
            ? entry.file === LEGACY_DATABASE
            : UUID.test(entry.audioNamespace) &&
              entry.file === `openwhispr_account_${entry.audioNamespace}.db`),
      ) ||
      new Set(value.accounts.map((entry) => entry.owner)).size !== value.accounts.length ||
      new Set(value.accounts.map((entry) => entry.file)).size !== value.accounts.length
    )
      throw new Error('Saved account data could not be opened. Your files have been kept.');
    return value;
  }

  // The only reliable owner on older installs is sync.user_id. Never infer
  // ownership from whoever happens to sign in during this upgrade.
  const legacy = openApplicationDatabase(LEGACY_DATABASE);
  const states = legacy.getAllSync<{ key: string; value: string }>(
    "SELECT key, value FROM sync_state WHERE key IN ('sync.user_id', 'sync.anonymous_user_id')",
  );
  const userId = states.find((entry) => entry.key === 'sync.user_id')?.value;
  const anonymous =
    !!userId &&
    states.some((entry) => entry.key === 'sync.anonymous_user_id' && entry.value === userId);
  const owner = userId ? `account:${userId}` : LOCAL_OWNER;
  return {
    accounts: [{ owner, file: LEGACY_DATABASE, audioNamespace: '', anonymous }],
    anonymousOwner: anonymous ? owner : null,
    realAccountHistory: !!userId && !anonymous,
  };
}

export function hasAndroidAccountHistory(): boolean {
  return readManifest().realAccountHistory;
}

export function assertAccountDataOwner(user: User): void {
  const state = useAccountData.getState();
  if (state.error || state.blocked || state.owner !== ownerFor(user))
    throw new Error('Local data does not belong to the active account.');
}

/** Select before publishing auth state, so neither UI nor sync can see another account's rows. */
export function selectAccountData(user: User): void {
  const owner = ownerFor(user);
  const previous = useAccountData.getState();
  if (previous.owner === owner && !previous.error && !previous.blocked) return;
  blockAccountDatabase();
  useAccountData.setState({ blocked: true });
  try {
    const manifest = readManifest();
    let account = manifest.accounts.find((entry) => entry.owner === owner);
    if (account?.deleted) throw new Error('This account was deleted from this device.');
    const linked =
      user &&
      !user.isAnonymous &&
      manifest.anonymousOwner &&
      manifest.accounts.find((entry) => entry.owner === manifest.anonymousOwner && !entry.deleted);
    if (linked && linked.owner !== owner) {
      // Two existing collections must never be overwritten by a link. Keep
      // both intact and fail closed if an unexpected legacy state reaches here.
      if (account)
        throw new Error('Both accounts have saved local data. Your files have been kept.');
      linked.owner = owner;
      linked.anonymous = false;
      account = linked;
    }
    if (!account) {
      const audioNamespace = randomUUID();
      account = {
        owner,
        file: `openwhispr_account_${audioNamespace}.db`,
        audioNamespace,
        anonymous: !!user?.isAnonymous,
      };
      manifest.accounts.push(account);
    }
    const connection = openApplicationDatabase(account.file);
    runMigrations(connection, account.file === LEGACY_DATABASE);
    if (user?.isAnonymous) {
      connection.runSync(
        "INSERT OR REPLACE INTO sync_state(key, value) VALUES ('sync.user_id', ?)",
        user.id,
      );
      connection.runSync(
        "INSERT OR REPLACE INTO sync_state(key, value) VALUES ('sync.anonymous_user_id', ?)",
        user.id,
      );
      manifest.anonymousOwner = owner;
    } else if (user) {
      manifest.anonymousOwner = null;
      manifest.realAccountHistory = true;
    }
    // One atomic storage value publishes ownership only after the target is
    // usable. A crash before this leaves the previous mapping and files intact.
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest));
    activateAccountDatabase(connection);
    useAccountData.setState({
      owner,
      audioNamespace: account.audioNamespace,
      revision: previous.revision + 1,
      error: null,
      blocked: false,
    });
  } catch (error) {
    useAccountData.setState({
      error: error instanceof Error ? error.message : 'Local account data could not be opened.',
    });
    throw error;
  }
}

/** Called only after the server confirms the user's explicit account deletion. */
export async function eraseAccountData(userId: string): Promise<void> {
  blockAccountDatabase();
  useAccountData.setState({ blocked: true });
  try {
    const manifest = readManifest();
    const account = manifest.accounts.find((entry) => entry.owner === `account:${userId}`);
    if (!account) return;
    const connection = openApplicationDatabase(account.file);
    const directory =
      FileSystem.documentDirectory &&
      `${FileSystem.documentDirectory}${account.audioNamespace ? `account-audio/${account.audioNamespace}/` : ''}`;
    const savedAudio = connection
      .getAllSync<{ id: number; source_file: string | null }>('SELECT id, source_file FROM notes')
      .filter((note) => directory && note.source_file === `${directory}meeting-${note.id}.wav`)
      .map((note) => note.source_file!);
    const audio = [...new Set([...savedAudio, ...(account.pendingAudio ?? [])])];
    if (
      audio.some(
        (uri) =>
          !directory ||
          !uri.startsWith(directory) ||
          !/^meeting-[1-9][0-9]*\.wav$/.test(uri.slice(directory.length)),
      )
    )
      throw new Error('Invalid saved audio ownership.');
    account.deleted = true;
    account.erasureComplete = false;
    account.pendingAudio = audio;
    if (manifest.anonymousOwner === account.owner) manifest.anonymousOwner = null;
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest));
    const tables = connection.getAllSync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    connection.withTransactionSync(() => {
      for (const table of tables)
        connection.execSync(`DELETE FROM "${table.name.replace(/"/g, '""')}"`);
    });
    await Promise.all(audio.map((uri) => FileSystem.deleteAsync(uri, { idempotent: true })));
    const { StorageService } =
      require('@/services/storage/StorageService') as typeof import('@/services/storage/StorageService');
    await StorageService.eraseTranscriptOwner(`history:${account.audioNamespace || 'original'}`);
    const latest = readManifest();
    const erased = latest.accounts.find((entry) => entry.owner === account.owner);
    if (!erased) throw new Error('Deleted account ownership is unavailable.');
    erased.pendingAudio = [];
    erased.erasureComplete = true;
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(latest));
  } catch (error) {
    useAccountData.setState({
      error: 'The account was deleted, but its local data could not be fully erased. Please retry.',
    });
    throw error;
  }
}

export async function retryAccountDataDeletion(): Promise<void> {
  blockAccountDatabase();
  useAccountData.setState({ blocked: true, error: null });
  try {
    for (const account of readManifest().accounts) {
      if (account.deleted && !account.erasureComplete && account.owner.startsWith('account:'))
        await eraseAccountData(account.owner.slice('account:'.length));
    }
  } catch (error) {
    if (!useAccountData.getState().error)
      useAccountData.setState({
        error: 'Saved account data could not be opened. Your files have been kept. Please retry.',
      });
    throw error;
  }
}

export function prepareAccountData(user: User): void {
  try {
    // Abort old requests and drop visible messages before the database changes; saved chats
    // stay with the account's notes and are available when that account returns.
    const { useChatStore } =
      require('@/store/useChatStore') as typeof import('@/store/useChatStore');
    useChatStore.getState().reset();
    const { useBubbleResult } = require('./bubbleResult') as typeof import('./bubbleResult');
    useBubbleResult.getState().dismiss();
    const { useSharedDictionaryStore } =
      require('@/store/useSharedDictionaryStore') as typeof import('@/store/useSharedDictionaryStore');
    // Invalidate pending loads before changing databases, including failed switches.
    useSharedDictionaryStore.getState().reset();
    selectAccountData(user);
    const { useNotesStore } =
      require('@/store/useNotesStore') as typeof import('@/store/useNotesStore');
    const { useDictionaryStore } =
      require('@/store/useDictionaryStore') as typeof import('@/store/useDictionaryStore');
    const { useSnippetsStore } =
      require('@/store/useSnippetsStore') as typeof import('@/store/useSnippetsStore');
    useNotesStore.getState().reset();
    useNotesStore.getState().initialize();
    useDictionaryStore.getState().reset();
    useSnippetsStore.getState().reset();
    useDictionaryStore.getState().load();
    useSnippetsStore.getState().load();
  } catch (error) {
    blockAccountDatabase();
    useAccountData.setState({
      blocked: true,
      error: 'Local account data could not be loaded. Please retry.',
    });
    throw error;
  }
}
