import { startKeyboardLayoutSync } from '@/lib/keyboardLayoutSync';
import { useConfigStore } from '@/store/useConfigStore';
import { StorageService } from '@/services/storage/StorageService';

const store: Record<string, string> = {};

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    setItem: (key: string, value: string) => {
      store[key] = value;
      return true;
    },
  },
  APP_GROUP_KEYS: { KEYBOARD_MINIMAL_ENABLED: 'keyboard_minimal_enabled' },
}));

jest.mock('@/services/storage/StorageService', () => ({
  StorageService: {
    saveConfig: jest.fn(async () => {}),
    clearConfig: jest.fn(async () => {}),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  delete store.keyboard_minimal_enabled;
  useConfigStore.setState({ config: { defaultMode: 'cloud' }, isLoading: false });
});

it('defaults to off for existing configurations without the setting', () => {
  const stop = startKeyboardLayoutSync();
  expect(store.keyboard_minimal_enabled).toBe('0');
  stop();
});

it('restores an enabled preference at startup', () => {
  useConfigStore.setState({ config: { defaultMode: 'cloud', minimalKeyboardEnabled: true } });
  const stop = startKeyboardLayoutSync();
  expect(store.keyboard_minimal_enabled).toBe('1');
  stop();
});

it('mirrors saved toggle changes and resets to the extension', async () => {
  const stop = startKeyboardLayoutSync();
  try {
    await useConfigStore.getState().updateConfig({ minimalKeyboardEnabled: true });
    expect(store.keyboard_minimal_enabled).toBe('1');
    expect(StorageService.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ minimalKeyboardEnabled: true }),
    );
    await useConfigStore.getState().updateConfig({ minimalKeyboardEnabled: false });
    expect(store.keyboard_minimal_enabled).toBe('0');
    await useConfigStore.getState().updateConfig({ minimalKeyboardEnabled: true });
    await useConfigStore.getState().resetConfig();
    expect(store.keyboard_minimal_enabled).toBe('0');
  } finally {
    stop();
  }
});

it('keeps the extension unchanged when saving fails', async () => {
  const stop = startKeyboardLayoutSync();
  try {
    jest.mocked(StorageService.saveConfig).mockRejectedValueOnce(new Error('Disk full'));
    await useConfigStore.getState().updateConfig({ minimalKeyboardEnabled: true });
    expect(store.keyboard_minimal_enabled).toBe('0');
  } finally {
    stop();
  }
});

it('unsubscribes when stopped', () => {
  const stop = startKeyboardLayoutSync();
  stop();
  useConfigStore.setState({ config: { defaultMode: 'cloud', minimalKeyboardEnabled: true } });
  expect(store.keyboard_minimal_enabled).toBe('0');
});
