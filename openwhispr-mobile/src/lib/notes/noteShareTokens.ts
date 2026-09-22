import * as SecureStore from 'expo-secure-store';
import { Buffer } from 'buffer';
import { getNoteShareViewerBaseUrl } from '@/config/noteSharing';

const FULL_TOKEN = /^ow_share_[A-Za-z0-9_-]{32}$/;
const TOKEN_PREFIX = /^ow_share_[A-Za-z0-9_-]{7}$/;
const ACCOUNT_PREFIX = 'openwhispr.noteShares.';
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

function enqueue(userId: string, operation: () => Promise<void>): Promise<void> {
  const previous = accountQueues.get(userId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  accountQueues.set(userId, current);
  const release = (): void => {
    if (accountQueues.get(userId) === current) accountQueues.delete(userId);
  };
  current.then(release, release);
  return current;
}

async function readIndex(userId: string): Promise<string[]> {
  const value = await SecureStore.getItemAsync(indexKey(userId));
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('Invalid note share token index');
  }
  return parsed;
}

export async function readNoteShareToken(
  userId: string,
  remoteId: string,
  expectedPrefix?: string | null,
): Promise<string | null> {
  const epoch = accountEpochs.get(userId) ?? 0;
  const stored = await SecureStore.getItemAsync(tokenKey(userId, remoteId));
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
  await enqueue(userId, async () => {
    if (epoch !== (accountEpochs.get(userId) ?? 0)) return;
    const index = await readIndex(userId);
    if (epoch !== (accountEpochs.get(userId) ?? 0)) return;
    await SecureStore.setItemAsync(tokenKey(userId, remoteId), token);
    if (epoch !== (accountEpochs.get(userId) ?? 0)) {
      await SecureStore.deleteItemAsync(tokenKey(userId, remoteId));
      return;
    }
    if (!index.includes(remoteId)) {
      try {
        await SecureStore.setItemAsync(indexKey(userId), JSON.stringify([...index, remoteId]));
      } catch (error) {
        await SecureStore.deleteItemAsync(tokenKey(userId, remoteId));
        throw error;
      }
    }
  });
}

export async function removeNoteShareToken(userId: string, remoteId: string): Promise<void> {
  await enqueue(userId, async () => {
    const index = await readIndex(userId);
    await SecureStore.deleteItemAsync(tokenKey(userId, remoteId));
    if (index.includes(remoteId)) {
      const remaining = index.filter((id) => id !== remoteId);
      if (remaining.length)
        await SecureStore.setItemAsync(indexKey(userId), JSON.stringify(remaining));
      else await SecureStore.deleteItemAsync(indexKey(userId));
    }
  });
}

export async function clearNoteShareTokens(userId: string): Promise<void> {
  accountEpochs.set(userId, (accountEpochs.get(userId) ?? 0) + 1);
  await enqueue(userId, async () => {
    for (const remoteId of await readIndex(userId)) {
      await SecureStore.deleteItemAsync(tokenKey(userId, remoteId));
    }
    await SecureStore.deleteItemAsync(indexKey(userId));
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
