import { StorageService as ios } from '../StorageService';
import { StorageService as android } from '../StorageService.android';
import { STORAGE_KEYS } from '@/config/constants';

const mockValues = new Map<string, string>();
const mockCapture = jest.fn(() => ({ key: 'owner-a', owner: 'fixture' }));
const mockDeleteAudio = jest.fn(async () => {});
const mockRecovery = jest.fn(() => []);
jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('expo-secure-store', () => ({}));
jest.mock('@/lib/transcriptScope', () => ({ captureTranscriptScope: () => mockCapture() }));
jest.mock('@/services/providers/ProviderCredentials', () => ({
  clearProviderCredentials: jest.fn(),
}));
jest.mock('@/lib/transcriptAudio', () => ({
  deleteManagedTranscriptAudio: () => mockDeleteAudio(),
}));
jest.mock('@/lib/keyboardInferenceRoute', () => ({
  listPendingProviderRecoveryJobs: () => mockRecovery(),
  clearKeyboardProviderRecovery: jest.fn(),
}));
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
beforeAll(() =>
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => mockValues.get(key) ?? null,
      setItem: (key: string, value: string) => {
        mockValues.set(key, value);
      },
      removeItem: (key: string) => {
        mockValues.delete(key);
      },
      clear: () => mockValues.clear(),
    },
  }),
);
afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
beforeEach(() => {
  mockValues.clear();
  jest.clearAllMocks();
  mockCapture.mockReturnValue({ key: 'owner-a', owner: 'fixture' });
});

it('keeps Android history methods out of the default API', () => {
  for (const name of [
    'transcriptOwner',
    'getAllTranscriptAudio',
    'getUnassignedTranscripts',
    'eraseTranscriptOwner',
  ]) {
    expect(Reflect.has(ios, name)).toBe(false);
    expect(Reflect.has(android, name)).toBe(true);
  }
});
it('reads default history without consulting an account scope', async () => {
  mockValues.set(STORAGE_KEYS.TRANSCRIPTS, JSON.stringify([{ id: 'legacy' }]));
  expect(await ios.getTranscripts()).toEqual([{ id: 'legacy' }]);
  expect(mockCapture).not.toHaveBeenCalled();
});
it('preserves default history writes and removal', async () => {
  await ios.saveTranscripts([]);
  expect(mockValues.get(STORAGE_KEYS.TRANSCRIPTS)).toBe('[]');
  await ios.clearTranscripts();
  expect(mockValues.has(STORAGE_KEYS.TRANSCRIPTS)).toBe(false);
  expect(mockCapture).not.toHaveBeenCalled();
});
it('retains Android owner partitioning and unassigned history', async () => {
  mockValues.set(STORAGE_KEYS.TRANSCRIPTS, JSON.stringify([{ id: 'legacy' }]));
  await android.saveTranscripts([]);
  expect(JSON.parse(mockValues.get('android.transcripts-by-owner.v1')!)).toEqual({ 'owner-a': [] });
  expect(mockValues.get(STORAGE_KEYS.TRANSCRIPTS)).toBe('[{"id":"legacy"}]');
  expect(await android.getTranscripts()).toEqual([]);
});
it('inherits the common config and session operations without copying them', () => {
  expect(android.getConfig).toBe(ios.getConfig);
  expect(android.saveConfig).toBe(ios.saveConfig);
  expect(android.clearConfig).toBe(ios.clearConfig);
  expect(android.saveAgentSessions).toBe(ios.saveAgentSessions);
  expect(android.loadAgentSessions).toBe(ios.loadAgentSessions);
  expect(android.clearAgentSessions).toBe(ios.clearAgentSessions);
  expect(android.clearAll).toBe(ios.clearAll);
});
it('preserves Android malformed-owner-map failure without changing saved bytes', async () => {
  const invalid = '{"owner-a":{}}';
  mockValues.set('android.transcripts-by-owner.v1', invalid);
  await expect(android.getTranscripts()).rejects.toThrow('Your history has been kept');
  expect(mockValues.get('android.transcripts-by-owner.v1')).toBe(invalid);
});
