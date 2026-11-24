import {
  readKeyboardTranslationSnapshot,
  reconcileKeyboardTranslationFromAppGroup,
  setKeyboardTranslationTarget,
  snapshotKeyboardTranslation,
  startKeyboardTranslationSync,
} from '@/lib/keyboardTranslationSync';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';

const KEYS = {
  KEYBOARD_TRANSLATION_TARGET: 'keyboard_translation_target',
  KEYBOARD_TRANSLATION_LANGUAGES: 'keyboard_translation_languages',
  KEYBOARD_TRANSLATION_APPLICABLE: 'keyboard_translation_applicable',
  KEYBOARD_RECORDING_TRANSLATION: 'keyboard_recording_translation',
  KEYBOARD_RECORDING_TRANSLATION_JOB_ID: 'keyboard_recording_translation_job_id',
};

const store: Record<string, string> = {};
const mockRemoveItemFn = jest.fn((key: string) => {
  delete store[key];
  return true;
});
const updateConfig = jest.fn(async () => {});
const mockRoute = jest.fn();
const mockGuest = jest.fn();
const mockGetSupportedLanguages = jest.fn();
const mockReadiness = jest.fn();
const mockAppleEnabled = jest.fn();
const appStateListeners: Array<(state: string) => void> = [];

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
      return true;
    },
    removeItem: (key: string) => mockRemoveItemFn(key),
  },
  APP_GROUP_KEYS: {
    KEYBOARD_TRANSLATION_TARGET: 'keyboard_translation_target',
    KEYBOARD_TRANSLATION_LANGUAGES: 'keyboard_translation_languages',
    KEYBOARD_TRANSLATION_APPLICABLE: 'keyboard_translation_applicable',
    KEYBOARD_RECORDING_TRANSLATION: 'keyboard_recording_translation',
    KEYBOARD_RECORDING_TRANSLATION_JOB_ID: 'keyboard_recording_translation_job_id',
  },
}));

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (_: string, listener: (state: string) => void) => {
      appStateListeners.push(listener);
      return { remove: () => {} };
    },
  },
}));

jest.mock('@/services/storage/StorageService', () => ({
  StorageService: { saveConfig: jest.fn(async () => {}) },
}));
jest.mock('@/lib/keyboardDirectInputs', () => ({ dictationRoute: () => mockRoute() }));
jest.mock('@/store/useAuthStore', () => {
  // A real zustand store without expo-secure-store behind it.
  const { create } = jest.requireActual('zustand');
  return { useAuthStore: create(() => ({ user: null })) };
});
jest.mock('@/lib/accountAccess', () => ({
  requiresRealAccount: (user: unknown) => mockGuest(user),
}));
jest.mock('@/lib/appleLLM', () => ({
  AppleLLM: { getSupportedLanguages: () => mockGetSupportedLanguages() },
}));
jest.mock('@/lib/localReasoning', () => ({
  getLocalReasoningReadiness: () => mockReadiness(),
  isAppleLocalIntelligenceEnabled: () => mockAppleEnabled(),
}));

const cloudRoute = { provider: 'cloud', cleanupMode: 'openwhispr', cleanupUnavailable: false };
const localRoute = { provider: 'local', cleanupMode: 'local', cleanupUnavailable: false };

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  mockRemoveItemFn.mockClear();
  updateConfig.mockClear();
  appStateListeners.length = 0;
  mockRoute.mockReturnValue(cloudRoute);
  mockGuest.mockReturnValue(false);
  mockGetSupportedLanguages.mockResolvedValue([]);
  mockReadiness.mockResolvedValue({ status: 'ready', tokenCounting: true });
  mockAppleEnabled.mockReturnValue(true);
  useConfigStore.setState({
    config: { keyboardTranslationTarget: null } as never,
    updateConfig: updateConfig as never,
  });
});

const CACHED_ACCOUNT = {
  id: 'cached',
  email: 'person@example.com',
  emailVerified: true,
  isAnonymous: false,
};

describe('keyboardTranslationSync snapshot', () => {
  it('returns the frozen target only for its own job', () => {
    store[KEYS.KEYBOARD_TRANSLATION_TARGET] = 'es';
    expect(snapshotKeyboardTranslation('job-1')).toBe('es');
    store[KEYS.KEYBOARD_TRANSLATION_TARGET] = 'fr';
    expect(readKeyboardTranslationSnapshot('job-1')).toBe('es');
    expect(readKeyboardTranslationSnapshot('job-2')).toBeNull();
    expect(readKeyboardTranslationSnapshot(null)).toBeNull();
  });

  it('stores an Off snapshot as the empty string that reads back as null', () => {
    expect(snapshotKeyboardTranslation('job-1')).toBeNull();
    expect(store[KEYS.KEYBOARD_RECORDING_TRANSLATION]).toBe('');
    expect(readKeyboardTranslationSnapshot('job-1')).toBeNull();
  });

  it('snapshots Off for a guest on Cloud even with a stored language', () => {
    mockGuest.mockReturnValue(true);
    store[KEYS.KEYBOARD_TRANSLATION_TARGET] = 'es';
    expect(snapshotKeyboardTranslation('job-1')).toBeNull();
    expect(readKeyboardTranslationSnapshot('job-1')).toBeNull();
  });

  it('uses the account it is given while sign-in is still being restored', () => {
    // The auth store is empty at a cold launch; the handoff passes the cached account.
    mockGuest.mockImplementation((user: unknown) => !user);
    store[KEYS.KEYBOARD_TRANSLATION_TARGET] = 'es';
    expect(snapshotKeyboardTranslation('job-1')).toBeNull();
    expect(snapshotKeyboardTranslation('job-2', CACHED_ACCOUNT)).toBe('es');
    expect(readKeyboardTranslationSnapshot('job-2')).toBe('es');
  });

  it('snapshots Off when the stored code is not in the current language list', () => {
    store[KEYS.KEYBOARD_TRANSLATION_TARGET] = 'xx';
    expect(snapshotKeyboardTranslation('job-1')).toBeNull();
    expect(readKeyboardTranslationSnapshot('job-1')).toBeNull();
  });
});

describe('setKeyboardTranslationTarget', () => {
  it('removes the key for Off', () => {
    setKeyboardTranslationTarget(null);
    expect(mockRemoveItemFn).toHaveBeenCalledWith(KEYS.KEYBOARD_TRANSLATION_TARGET);
    expect(updateConfig).toHaveBeenCalledWith({ keyboardTranslationTarget: null });
  });

  it('writes the key before config for a language', () => {
    setKeyboardTranslationTarget('es');
    expect(store[KEYS.KEYBOARD_TRANSLATION_TARGET]).toBe('es');
    expect(updateConfig).toHaveBeenCalledWith({ keyboardTranslationTarget: 'es' });
  });
});

describe('reconcileKeyboardTranslationFromAppGroup', () => {
  it('keeps a target the current model cannot translate into', async () => {
    store[KEYS.KEYBOARD_TRANSLATION_TARGET] = 'xx';
    await reconcileKeyboardTranslationFromAppGroup();
    expect(mockRemoveItemFn).not.toHaveBeenCalled();
    expect(updateConfig).toHaveBeenCalledWith({ keyboardTranslationTarget: 'xx' });
  });

  it('pulls a keyboard-made choice into config', async () => {
    store[KEYS.KEYBOARD_TRANSLATION_TARGET] = 'es';
    await reconcileKeyboardTranslationFromAppGroup();
    expect(updateConfig).toHaveBeenCalledWith({ keyboardTranslationTarget: 'es' });
  });

  it('does not rewrite config when it already matches', async () => {
    store[KEYS.KEYBOARD_TRANSLATION_TARGET] = 'es';
    useConfigStore.setState({ config: { keyboardTranslationTarget: 'es' } as never });
    await reconcileKeyboardTranslationFromAppGroup();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('treats a missing key as Off and clears config, never rewriting the key', async () => {
    useConfigStore.setState({ config: { keyboardTranslationTarget: 'fr' } as never });
    await reconcileKeyboardTranslationFromAppGroup();
    expect(store[KEYS.KEYBOARD_TRANSLATION_TARGET]).toBeUndefined();
    expect(updateConfig).toHaveBeenCalledWith({ keyboardTranslationTarget: null });
  });

  it('leaves the key unchanged when reconciles overlap', async () => {
    store[KEYS.KEYBOARD_TRANSLATION_TARGET] = 'es';
    useConfigStore.setState({ config: { keyboardTranslationTarget: 'fr' } as never });
    await Promise.all([
      reconcileKeyboardTranslationFromAppGroup(),
      reconcileKeyboardTranslationFromAppGroup(),
    ]);
    expect(store[KEYS.KEYBOARD_TRANSLATION_TARGET]).toBe('es');
  });
});

describe('startKeyboardTranslationSync', () => {
  it('marks translation not applicable for a guest on Cloud', () => {
    mockGuest.mockReturnValue(true);
    const stop = startKeyboardTranslationSync();
    expect(store[KEYS.KEYBOARD_TRANSLATION_APPLICABLE]).toBe('0');
    stop();
  });

  it('marks translation applicable for a signed-in Cloud user and writes the language list', () => {
    const stop = startKeyboardTranslationSync();
    expect(store[KEYS.KEYBOARD_TRANSLATION_APPLICABLE]).toBe('1');
    const languages = JSON.parse(store[KEYS.KEYBOARD_TRANSLATION_LANGUAGES]);
    expect(languages.some((language: { code: string }) => language.code === 'es')).toBe(true);
    stop();
  });

  it('narrows the list to On-Device languages once the fetch resolves', async () => {
    mockRoute.mockReturnValue(localRoute);
    mockGetSupportedLanguages.mockResolvedValue(['es', 'fr']);
    const stop = startKeyboardTranslationSync();
    expect(JSON.parse(store[KEYS.KEYBOARD_TRANSLATION_LANGUAGES]).length).toBeGreaterThan(2);
    await flush();
    const codes = JSON.parse(store[KEYS.KEYBOARD_TRANSLATION_LANGUAGES]).map(
      (language: { code: string }) => language.code,
    );
    expect([...codes].sort()).toEqual(['es', 'fr']);
    stop();
  });

  it('writes nothing when the fetch resolves after stop', async () => {
    mockRoute.mockReturnValue(localRoute);
    mockGetSupportedLanguages.mockResolvedValue(['es']);
    const stop = startKeyboardTranslationSync();
    const before = store[KEYS.KEYBOARD_TRANSLATION_LANGUAGES];
    stop();
    await flush();
    expect(store[KEYS.KEYBOARD_TRANSLATION_LANGUAGES]).toBe(before);
  });

  it('keeps a language the On-Device list lacks, so it is back when the route is', async () => {
    // Local Mode with Cloud cleanup reads as On-Device until sign-in is restored.
    mockRoute.mockReturnValue(localRoute);
    mockGetSupportedLanguages.mockResolvedValue(['es', 'fr']);
    store[KEYS.KEYBOARD_TRANSLATION_TARGET] = 'ru';
    useConfigStore.setState({ config: { keyboardTranslationTarget: 'ru' } as never });
    const stop = startKeyboardTranslationSync();
    await flush();
    expect(store[KEYS.KEYBOARD_TRANSLATION_TARGET]).toBe('ru');
    expect(updateConfig).not.toHaveBeenCalled();
    // Off for a job on this route, since the keyboard can't show the language here.
    expect(snapshotKeyboardTranslation('job-1')).toBeNull();
    mockRoute.mockReturnValue(cloudRoute);
    useAuthStore.setState({ user: CACHED_ACCOUNT as never });
    expect(store[KEYS.KEYBOARD_TRANSLATION_TARGET]).toBe('ru');
    expect(snapshotKeyboardTranslation('job-2')).toBe('ru');
    stop();
  });

  it('marks On-Device not applicable while Apple Intelligence cannot run', async () => {
    mockRoute.mockReturnValue(localRoute);
    mockReadiness.mockResolvedValue({ status: 'unsupportedDevice', tokenCounting: false });
    const stop = startKeyboardTranslationSync();
    // Unknown until the read finishes, which leaves translation available.
    expect(store[KEYS.KEYBOARD_TRANSLATION_APPLICABLE]).toBe('1');
    await flush();
    expect(store[KEYS.KEYBOARD_TRANSLATION_APPLICABLE]).toBe('0');
    store[KEYS.KEYBOARD_TRANSLATION_TARGET] = 'es';
    expect(snapshotKeyboardTranslation('job-1')).toBeNull();
    stop();
  });

  it('reads readiness again when Apple Intelligence is switched in AI Models', async () => {
    mockRoute.mockReturnValue(localRoute);
    const stop = startKeyboardTranslationSync();
    await flush();
    expect(store[KEYS.KEYBOARD_TRANSLATION_APPLICABLE]).toBe('1');
    mockReadiness.mockResolvedValue({ status: 'disabled', tokenCounting: false });
    mockAppleEnabled.mockReturnValue(false);
    useConfigStore.setState({ config: { keyboardTranslationTarget: null } as never });
    await flush();
    expect(store[KEYS.KEYBOARD_TRANSLATION_APPLICABLE]).toBe('0');
    stop();
  });

  it('ignores a readiness read that a newer one replaced', async () => {
    mockRoute.mockReturnValue(localRoute);
    let resolveFirst: (value: unknown) => void = () => {};
    mockReadiness.mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)));
    const stop = startKeyboardTranslationSync();
    appStateListeners.forEach((listener) => listener('active'));
    await flush();
    expect(store[KEYS.KEYBOARD_TRANSLATION_APPLICABLE]).toBe('1');
    resolveFirst({ status: 'unsupportedDevice', tokenCounting: false });
    await flush();
    expect(store[KEYS.KEYBOARD_TRANSLATION_APPLICABLE]).toBe('1');
    stop();
  });

  it('keeps a keyboard-made target when an unrelated store changes', async () => {
    store[KEYS.KEYBOARD_TRANSLATION_TARGET] = 'es';
    useConfigStore.setState({ config: { keyboardTranslationTarget: 'fr' } as never });
    const stop = startKeyboardTranslationSync();
    await flush();
    useConfigStore.setState({ config: { keyboardTranslationTarget: 'fr', other: 1 } as never });
    expect(store[KEYS.KEYBOARD_TRANSLATION_TARGET]).toBe('es');
    stop();
  });

  it('rewrites applicability when the config store changes', () => {
    const stop = startKeyboardTranslationSync();
    mockRoute.mockReturnValue(null);
    useConfigStore.setState({ config: { keyboardTranslationTarget: null } as never });
    expect(store[KEYS.KEYBOARD_TRANSLATION_APPLICABLE]).toBe('0');
    stop();
  });

  it('rewrites applicability when the auth store changes', () => {
    const stop = startKeyboardTranslationSync();
    expect(store[KEYS.KEYBOARD_TRANSLATION_APPLICABLE]).toBe('1');
    mockGuest.mockReturnValue(true);
    useAuthStore.setState({ user: { id: 'guest' } as never });
    expect(store[KEYS.KEYBOARD_TRANSLATION_APPLICABLE]).toBe('0');
    stop();
  });

  it('reconciles and refetches when the app becomes active', async () => {
    const stop = startKeyboardTranslationSync();
    await flush();
    mockGetSupportedLanguages.mockClear();
    store[KEYS.KEYBOARD_TRANSLATION_TARGET] = 'de';
    appStateListeners.forEach((listener) => listener('active'));
    await flush();
    expect(mockGetSupportedLanguages).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledWith({ keyboardTranslationTarget: 'de' });
    stop();
  });
});
