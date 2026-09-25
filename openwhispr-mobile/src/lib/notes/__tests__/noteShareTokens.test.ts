const mockStored = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStored.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStored.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStored.delete(key);
  }),
}));

import * as SecureStore from 'expo-secure-store';
import {
  readNoteShareToken,
  saveNoteShareToken,
  removeNoteShareToken,
  clearNoteShareTokens,
  buildNoteShareUrl,
  buildNoteInviteUrl,
} from '../noteShareTokens';

const token = `ow_share_${'A'.repeat(32)}`;

beforeEach(() => {
  mockStored.clear();
  jest.clearAllMocks();
});

it('isolates tokens by account and note', async () => {
  await saveNoteShareToken('account-a', 'note', token);
  expect(await readNoteShareToken('account-a', 'note')).toBe(token);
  expect(await readNoteShareToken('account-b', 'note')).toBeNull();
  expect(await readNoteShareToken('account-a', 'other')).toBeNull();
});

it('rejects malformed tokens without writing them', async () => {
  await expect(saveNoteShareToken('user', 'note', 'ow_share_short')).rejects.toThrow();
  expect(mockStored.size).toBe(0);
  expect(() => buildNoteShareUrl('ow_share_short')).toThrow();
});

it('builds the invitation link from the server token prefix', () => {
  expect(buildNoteInviteUrl('ow_share_Ab_9-xY')).toBe(
    'https://notes.openwhispr.com/invite/ow_share_Ab_9-xY',
  );
  expect(() => buildNoteInviteUrl(token)).toThrow();
  expect(() => buildNoteInviteUrl('ow_share_ab')).toThrow();
});

it('removes a token when the server prefix changes', async () => {
  await saveNoteShareToken('user', 'note', token);
  expect(await readNoteShareToken('user', 'note', 'ow_share_B')).toBeNull();
  expect(await readNoteShareToken('user', 'note')).toBeNull();
});

it('removes individual tokens and all tokens for an account', async () => {
  await Promise.all([
    saveNoteShareToken('user', 'one', token),
    saveNoteShareToken('user', 'two', token),
  ]);
  await removeNoteShareToken('user', 'one');
  expect(await readNoteShareToken('user', 'one')).toBeNull();
  await clearNoteShareTokens('user');
  expect(await readNoteShareToken('user', 'two')).toBeNull();
  expect(mockStored.size).toBe(0);
});

it('does not recreate a secret when cleanup overtakes a pending write', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
    await gate;
    mockStored.set(key, value);
  });
  const save = saveNoteShareToken('user', 'note', token);
  while (jest.mocked(SecureStore.setItemAsync).mock.calls.length === 0) await Promise.resolve();
  const clear = clearNoteShareTokens('user');
  release();
  await Promise.all([save, clear]);
  expect(await readNoteShareToken('user', 'note')).toBeNull();
  expect(mockStored.size).toBe(0);
});

it('propagates storage failures without leaving an indexed token', async () => {
  jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(saveNoteShareToken('user', 'note', token)).rejects.toThrow('storage unavailable');
  expect(await readNoteShareToken('user', 'note')).toBeNull();
});

it('removes a newly saved secret if its account index cannot be stored', async () => {
  jest
    .mocked(SecureStore.setItemAsync)
    .mockImplementationOnce(async (key, value) => {
      mockStored.set(key, value);
    })
    .mockRejectedValueOnce(new Error('index unavailable'));
  await expect(saveNoteShareToken('user', 'note', token)).rejects.toThrow('index unavailable');
  expect(await readNoteShareToken('user', 'note')).toBeNull();
});

it('removes a cached token when the server reports no live token prefix', async (): Promise<void> => {
  await saveNoteShareToken('user', 'note', token);
  expect(await readNoteShareToken('user', 'note', null)).toBeNull();
  expect(await readNoteShareToken('user', 'note')).toBeNull();
});
