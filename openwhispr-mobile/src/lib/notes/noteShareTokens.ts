import * as SecureStore from 'expo-secure-store';
import { Buffer } from 'buffer';
import { getNoteShareViewerBaseUrl } from '@/config/noteSharing';

const FULL_TOKEN = /^ow_share_[A-Za-z0-9_-]{32}$/;
const TOKEN_PREFIX = /^ow_share_[A-Za-z0-9_-]{7}$/;
const ACCOUNT_PREFIX = 'openwhispr.noteShares.';
const OWNERS_KEY = `${ACCOUNT_PREFIX}owners`;
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};
const accountQueues = new Map<string, Promise<void>>();
const accountEpochs = new Map<string, number>();

function accountKey(userId: string): string {
  return `${ACCOUNT_PREFIX}${Buffer.from(userId, 'utf8').toString('hex')}`;
}

function indexKey(userId: string): string {
  return `${accountKey(userId)}.index`;
}

function tokenKey(userId: string, remoteId: string): string {
  return `${accountKey(userId)}.${Buffer.from(remoteId, 'utf8').toString('hex')}`;
}

/** Serializes read-modify-write operations on one account's entries, or on the owners record. */
function enqueue(queue: string, operation: () => Promise<void>): Promise<void> {
  const previous = accountQueues.get(queue) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  accountQueues.set(queue, current);
  const release = (): void => {
    if (accountQueues.get(queue) === current) accountQueues.delete(queue);
  };
  current.then(release, release);
  return current;
}

async function readIds(key: string): Promise<string[]> {
  const value = await SecureStore.getItemAsync(key, SECURE_OPTIONS);
  if (!value) return [];
  // A record we cannot trust must not block saving or signing in for good.
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

async function writeIds(key: string, ids: string[]): Promise<void> {
  if (ids.length) await SecureStore.setItemAsync(key, JSON.stringify(ids), SECURE_OPTIONS);
  else await SecureStore.deleteItemAsync(key, SECURE_OPTIONS);
}

export async function readNoteShareToken(
  userId: string,
  remoteId: string,
  expectedPrefix?: string | null,
): Promise<string | null> {
  const epoch = accountEpochs.get(userId) ?? 0;
  const stored = await SecureStore.getItemAsync(tokenKey(userId, remoteId), SECURE_OPTIONS);
  if (epoch !== (accountEpochs.get(userId) ?? 0)) return null;
  if (!stored) return null;
  if (
    !FULL_TOKEN.test(stored) ||
    (expectedPrefix !== undefined && (!expectedPrefix || !stored.startsWith(expectedPrefix)))
  ) {
    await removeNoteShareToken(userId, remoteId);
    return null;
  }
  return stored;
}

export async function saveNoteShareToken(
  userId: string,
  remoteId: string,
  token: string,
): Promise<void> {
  if (!FULL_TOKEN.test(token)) throw new Error('Invalid note share token');
  const epoch = accountEpochs.get(userId) ?? 0;
  // Record the owner before storing a secret, so the next account to sign in always erases it.
  await enqueue(OWNERS_KEY, async () => {
    const owners = await readIds(OWNERS_KEY);
    if (!owners.includes(userId)) await writeIds(OWNERS_KEY, [...owners, userId]);
  });
  await enqueue(userId, async () => {
    if (epoch !== (accountEpochs.get(userId) ?? 0)) return;
    const index = await readIds(indexKey(userId));
    if (epoch !== (accountEpochs.get(userId) ?? 0)) return;
    await SecureStore.setItemAsync(tokenKey(userId, remoteId), token, SECURE_OPTIONS);
    if (epoch !== (accountEpochs.get(userId) ?? 0)) {
      await SecureStore.deleteItemAsync(tokenKey(userId, remoteId), SECURE_OPTIONS);
      return;
    }
    if (!index.includes(remoteId)) {
      try {
        await writeIds(indexKey(userId), [...index, remoteId]);
      } catch (error) {
        await SecureStore.deleteItemAsync(tokenKey(userId, remoteId), SECURE_OPTIONS);
        throw error;
      }
    }
  });
}

export async function removeNoteShareToken(userId: string, remoteId: string): Promise<void> {
  await enqueue(userId, async () => {
    const index = await readIds(indexKey(userId));
    await SecureStore.deleteItemAsync(tokenKey(userId, remoteId), SECURE_OPTIONS);
    if (index.includes(remoteId)) {
      await writeIds(
        indexKey(userId),
        index.filter((id) => id !== remoteId),
      );
    }
  });
}

async function eraseAccount(userId: string): Promise<void> {
  accountEpochs.set(userId, (accountEpochs.get(userId) ?? 0) + 1);
  await enqueue(userId, async () => {
    for (const remoteId of await readIds(indexKey(userId))) {
      await SecureStore.deleteItemAsync(tokenKey(userId, remoteId), SECURE_OPTIONS);
    }
    await SecureStore.deleteItemAsync(indexKey(userId), SECURE_OPTIONS);
  });
}

/**
 * Erases the links every other account stored on this device, so links survive sign-out but
 * not the next account. Accounts are recorded when they store a link; one whose links could not
 * be erased stays recorded, and the next sign-in retries it.
 */
export async function claimNoteShareTokens(userId: string): Promise<void> {
  let failed = false;
  await enqueue(OWNERS_KEY, async () => {
    const owners = await readIds(OWNERS_KEY);
    const kept = owners.filter((id) => id === userId);
    for (const owner of owners.filter((id) => id !== userId)) {
      try {
        await eraseAccount(owner);
      } catch {
        kept.push(owner);
        failed = true;
      }
    }
    if (kept.length !== owners.length) await writeIds(OWNERS_KEY, kept);
  });
  if (failed) throw new Error('Could not erase note share links of a previous account');
}

/** Erases an account's links; if that fails, the account stays recorded for the next sign-in. */
export async function clearNoteShareTokens(userId: string): Promise<void> {
  await eraseAccount(userId);
  await enqueue(OWNERS_KEY, async () => {
    const owners = await readIds(OWNERS_KEY);
    if (owners.includes(userId)) {
      await writeIds(
        OWNERS_KEY,
        owners.filter((id) => id !== userId),
      );
    }
  });
}

export function buildNoteShareUrl(token: string): string {
  if (!FULL_TOKEN.test(token)) throw new Error('Invalid note share token');
  return `${getNoteShareViewerBaseUrl()}/n/${token}`;
}

/** The sign-in link invitation emails carry; it opens for invited people and needs no full token. */
export function buildNoteInviteUrl(prefix: string): string {
  if (!TOKEN_PREFIX.test(prefix)) throw new Error('Invalid note share token prefix');
  return `${getNoteShareViewerBaseUrl()}/invite/${prefix}`;
}
