import { Platform } from 'react-native';
import { applyPendingOnDeviceCleanup, chooseOnboardingMode } from '../onboardingMode';
import { OnboardingError } from '../onboardingErrors';

jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
const mockUpdateConfig = jest.fn();
const mockChooseMode = jest.fn();
const mockEnsureSession = jest.fn();
const mockResetMode = jest.fn();
let mockError: string | null = null;
let mockUser: { id: string; isAnonymous: boolean } | null = null;
let mockGuest = false;
let mockCurrentStep = 'privacy-mode';
let mockSelectedMode: string | null = null;
let mockReadiness: { status: string } = { status: 'ready' };
let mockConfig: Record<string, unknown> = { defaultMode: 'private' };
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      config: mockConfig,
      updateConfig: mockUpdateConfig,
      error: mockError,
    }),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ resetToDefault: mockResetMode }) },
}));
jest.mock('@/store/useOnboardingStore', () => ({
  useOnboardingStore: {
    getState: () => ({
      currentStep: mockCurrentStep,
      selectedMode: mockSelectedMode,
      chooseMode: mockChooseMode,
    }),
  },
}));
const mockGetReadiness = jest.fn();
jest.mock('@/lib/localReasoning', () => ({
  ...jest.requireActual('@/lib/localReasoning'),
  getLocalReasoningReadiness: (...args: unknown[]) => mockGetReadiness(...args),
}));
let mockAccountHistory = false;
jest.mock('@/sync/syncIdentity', () => ({
  hasRealAccountHistory: () => mockAccountHistory,
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({
      user: mockUser,
      isGuest: mockGuest,
      ensureAnonymousSession: mockEnsureSession,
    }),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockError = null;
  mockUser = null;
  mockGuest = false;
  mockAccountHistory = false;
  mockCurrentStep = 'privacy-mode';
  mockSelectedMode = null;
  mockReadiness = { status: 'ready' };
  mockGetReadiness.mockImplementation(async () => mockReadiness);
  Platform.OS = 'ios';
  mockConfig = { defaultMode: 'private' };
  mockUpdateConfig.mockResolvedValue(undefined);
  mockChooseMode.mockResolvedValue(undefined);
  mockEnsureSession.mockResolvedValue(undefined);
});
it('retries anonymous authentication before allowing Cloud', async () => {
  mockEnsureSession.mockImplementationOnce(async () => {
    mockUser = { id: 'anon', isAnonymous: true };
  });
  await chooseOnboardingMode('cloud', 'privacy-mode');
  expect(mockChooseMode).toHaveBeenCalledWith('cloud', 'privacy-mode');
  expect(mockUpdateConfig).toHaveBeenCalledWith({
    defaultMode: 'cloud',
    inference: { dictation: { mode: 'openwhispr' } },
  });
});
it('rejects Cloud without a session from download fallbacks too', async () => {
  mockCurrentStep = 'private-download';
  const attempt = chooseOnboardingMode('cloud', 'private-download');
  await expect(attempt).rejects.toThrow('connection');
  await expect(attempt).rejects.toBeInstanceOf(OnboardingError);
  expect(mockUpdateConfig).not.toHaveBeenCalled();
  expect(mockChooseMode).not.toHaveBeenCalled();
});
it('does not advance or change the active mode after a failed save', async () => {
  mockUpdateConfig.mockImplementationOnce(async () => {
    mockError = 'Cannot save';
  });
  await expect(chooseOnboardingMode('private', 'privacy-mode')).rejects.toThrow('Cannot save');
  expect(mockChooseMode).not.toHaveBeenCalled();
  expect(mockResetMode).not.toHaveBeenCalled();
});
it('does not change the mode for a stale screen callback', async () => {
  mockCurrentStep = 'language';
  await chooseOnboardingMode('private', 'privacy-mode');
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('restores Local if a Cloud choice saves configuration but fails to save onboarding progress', async () => {
  mockUser = { id: 'anon', isAnonymous: true };
  mockCurrentStep = 'private-download';
  mockChooseMode.mockRejectedValueOnce(new Error('Keychain unavailable'));
  await expect(chooseOnboardingMode('cloud', 'private-download')).rejects.toThrow(
    'Keychain unavailable',
  );
  expect(mockUpdateConfig).toHaveBeenLastCalledWith({ defaultMode: 'private' });
  expect(mockResetMode).toHaveBeenLastCalledWith('private');
});

it('refuses Cloud for a guest at the mode choice with a message meant for them', async () => {
  mockGuest = true;
  await expect(chooseOnboardingMode('cloud', 'privacy-mode')).rejects.toBeInstanceOf(
    OnboardingError,
  );
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

// Guests can't open a session during setup. Refusing Cloud here too would leave a guest whose
// download failed with no way to finish, so the choice is saved for after sign-in, as before.
it('lets a guest leave a stuck download for Cloud', async () => {
  mockGuest = true;
  mockCurrentStep = 'private-download';
  await chooseOnboardingMode('cloud', 'private-download');
  expect(mockEnsureSession).not.toHaveBeenCalled();
  expect(mockUpdateConfig).toHaveBeenCalledWith({
    defaultMode: 'cloud',
    inference: { dictation: { mode: 'openwhispr' } },
  });
  expect(mockChooseMode).toHaveBeenCalledWith('cloud', 'private-download');
});

// A replayed onboarding pick must also move a Providers dictation route, or the
// screens would show the new mode while dictation kept using the provider.
it('moves the dictation route with the chosen mode and restores both on failure', async () => {
  const providerRoute = { mode: 'providers', providerId: 'groq', modelId: 'whisper-large-v3' };
  const inference = { dictation: providerRoute, upload: { mode: 'openwhispr' } };
  mockConfig = { defaultMode: 'providers', inference, pinnedInference: ['upload'] };
  mockChooseMode.mockRejectedValueOnce(new Error('Keychain unavailable'));
  await expect(chooseOnboardingMode('private', 'privacy-mode')).rejects.toThrow(
    'Keychain unavailable',
  );
  expect(mockUpdateConfig).toHaveBeenNthCalledWith(1, {
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' }, cleanup: { mode: 'local' } },
    pinnedInference: undefined,
  });
  expect(mockUpdateConfig).toHaveBeenLastCalledWith({
    defaultMode: 'providers',
    inference,
    pinnedInference: ['upload'],
  });
});

// A new identity there would read as an account switch and wipe the synced account's notes.
describe('on a device that synced an account, signed out', () => {
  beforeEach(() => {
    mockAccountHistory = true;
  });

  it('refuses Cloud at the mode choice without opening a session', async () => {
    const attempt = chooseOnboardingMode('cloud', 'privacy-mode');
    await expect(attempt).rejects.toThrow('Cloud needs you signed in');
    expect(mockEnsureSession).not.toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('saves Cloud for after sign-in when leaving a stuck download', async () => {
    mockCurrentStep = 'private-download';
    await chooseOnboardingMode('cloud', 'private-download');
    expect(mockEnsureSession).not.toHaveBeenCalled();
    expect(mockChooseMode).toHaveBeenCalledWith('cloud', 'private-download');
  });
});

// Private mode skips cleanup with no selection of its own, which nobody choosing it in setup
// would know to go save.
describe('cleanup', () => {
  it.each(['ready', 'appleIntelligenceOff', 'modelNotReady'])(
    'saves On-Device cleanup with Private mode (Apple Intelligence %s)',
    async (status) => {
      mockReadiness = { status };
      await chooseOnboardingMode('private', 'privacy-mode');
      expect(mockUpdateConfig).toHaveBeenCalledWith({
        defaultMode: 'private',
        inference: { dictation: { mode: 'local' }, cleanup: { mode: 'local' } },
      });
    },
  );

  it('saves it from the download step too', async () => {
    mockCurrentStep = 'private-download';
    await chooseOnboardingMode('private', 'private-download');
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' }, cleanup: { mode: 'local' } },
    });
  });

  it('leaves cleanup unset on an iPhone that can never run Apple Intelligence', async () => {
    mockReadiness = { status: 'unsupportedDevice' };
    await chooseOnboardingMode('private', 'privacy-mode');
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' } },
    });
  });

  // An iOS update may make it run, and readiness that can't be read says nothing either way.
  it.each(['unsupportedOS', 'disabled', 'unavailable'])(
    'marks On-Device cleanup pending when readiness is %s',
    async (status) => {
      mockReadiness = { status };
      await chooseOnboardingMode('private', 'privacy-mode');
      expect(mockUpdateConfig).toHaveBeenCalledWith({
        defaultMode: 'private',
        inference: { dictation: { mode: 'local' } },
        onDeviceCleanupPending: true,
      });
    },
  );

  it('marks nothing pending on Android', async () => {
    Platform.OS = 'android';
    mockReadiness = { status: 'unsupportedOS' };
    await chooseOnboardingMode('private', 'privacy-mode');
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' } },
    });
  });

  it('clears a pending cleanup when Cloud is chosen', async () => {
    mockUser = { id: 'anon', isAnonymous: true };
    mockSelectedMode = 'private';
    mockConfig = { defaultMode: 'private', onDeviceCleanupPending: true };
    await chooseOnboardingMode('cloud', 'privacy-mode');
    const saved = mockUpdateConfig.mock.calls[0][0];
    expect(saved).toHaveProperty('onDeviceCleanupPending', undefined);
    expect(saved.inference).toEqual({ dictation: { mode: 'openwhispr' } });
    expect(mockGetReadiness).not.toHaveBeenCalled();
  });

  it('restores a pending cleanup if progress cannot be saved', async () => {
    mockReadiness = { status: 'unsupportedOS' };
    mockConfig = { defaultMode: 'cloud' };
    mockChooseMode.mockRejectedValueOnce(new Error('Keychain unavailable'));
    await expect(chooseOnboardingMode('private', 'privacy-mode')).rejects.toThrow('Keychain');
    expect(mockUpdateConfig.mock.calls.at(-1)?.[0]).toHaveProperty(
      'onDeviceCleanupPending',
      undefined,
    );
  });

  it('keeps a pending cleanup marked if progress cannot be saved', async () => {
    mockConfig = { defaultMode: 'private', onDeviceCleanupPending: true };
    mockChooseMode.mockRejectedValueOnce(new Error('Keychain unavailable'));
    await expect(chooseOnboardingMode('private', 'privacy-mode')).rejects.toThrow('Keychain');
    expect(mockUpdateConfig.mock.calls[0][0]).toHaveProperty('onDeviceCleanupPending', undefined);
    expect(mockUpdateConfig.mock.calls.at(-1)?.[0]).toHaveProperty('onDeviceCleanupPending', true);
  });

  // Private mode never runs Cloud cleanup, so a saved one gives way as if nothing were saved.
  it('saves On-Device cleanup over a saved Cloud cleanup', async () => {
    mockConfig = { defaultMode: 'cloud', inference: { cleanup: { mode: 'openwhispr' } } };
    await chooseOnboardingMode('private', 'privacy-mode');
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' }, cleanup: { mode: 'local' } },
    });
  });

  it.each(['unsupportedDevice', 'unsupportedOS'])(
    'keeps a saved Cloud cleanup, with nothing pending, when readiness is %s',
    async (status) => {
      mockReadiness = { status };
      mockConfig = { defaultMode: 'cloud', inference: { cleanup: { mode: 'openwhispr' } } };
      await chooseOnboardingMode('private', 'privacy-mode');
      expect(mockUpdateConfig).toHaveBeenCalledWith({
        defaultMode: 'private',
        inference: { dictation: { mode: 'local' }, cleanup: { mode: 'openwhispr' } },
      });
    },
  );

  it('keeps a cleanup selection already saved', async () => {
    const provider = { mode: 'providers', providerId: 'groq', modelId: 'llama' };
    mockConfig = { defaultMode: 'cloud', inference: { cleanup: provider } };
    await chooseOnboardingMode('private', 'privacy-mode');
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' }, cleanup: provider },
    });
  });

  it('drops the On-Device cleanup an earlier Private choice saved when Cloud is chosen', async () => {
    mockUser = { id: 'anon', isAnonymous: true };
    mockSelectedMode = 'private';
    mockConfig = {
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' }, cleanup: { mode: 'local' } },
    };
    await chooseOnboardingMode('cloud', 'privacy-mode');
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      defaultMode: 'cloud',
      inference: { dictation: { mode: 'openwhispr' } },
    });
  });

  it.each([
    ['On-Device saved before this setup', null, { mode: 'local' }],
    ['a picked On-Device model', 'private', { mode: 'local', modelId: 'apple' }],
    ['a provider', 'private', { mode: 'providers', providerId: 'groq' }],
  ])('keeps %s when Cloud is chosen', async (_label, selectedMode, cleanup) => {
    mockUser = { id: 'anon', isAnonymous: true };
    mockSelectedMode = selectedMode;
    mockConfig = { defaultMode: 'private', inference: { cleanup } };
    await chooseOnboardingMode('cloud', 'privacy-mode');
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      defaultMode: 'cloud',
      inference: { dictation: { mode: 'openwhispr' }, cleanup },
    });
  });
});

// Setup couldn't save On-Device cleanup on an older iOS; a later launch saves it once it can.
describe('applyPendingOnDeviceCleanup', () => {
  beforeEach(() => {
    mockConfig = {
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' }, notes: { mode: 'openwhispr' } },
      onDeviceCleanupPending: true,
    };
  });

  it('saves On-Device cleanup once Apple Intelligence can run', async () => {
    await applyPendingOnDeviceCleanup();
    expect(mockGetReadiness).toHaveBeenCalledWith({ refresh: true });
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      onDeviceCleanupPending: undefined,
      inference: {
        dictation: { mode: 'local' },
        notes: { mode: 'openwhispr' },
        cleanup: { mode: 'local' },
      },
    });
  });

  it.each(['unsupportedOS', 'disabled', 'unavailable'])(
    'keeps waiting while readiness is %s',
    async (status) => {
      mockReadiness = { status };
      await applyPendingOnDeviceCleanup();
      expect(mockUpdateConfig).not.toHaveBeenCalled();
    },
  );

  // An older iOS can't tell an iPhone that will never run Apple Intelligence; once updated it can.
  it('stops waiting once this iPhone turns out never to run Apple Intelligence', async () => {
    mockReadiness = { status: 'unsupportedDevice' };
    await applyPendingOnDeviceCleanup();
    expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
    expect(mockUpdateConfig).toHaveBeenCalledWith({ onDeviceCleanupPending: undefined });
  });

  it('does nothing without a pending cleanup', async () => {
    mockConfig = { defaultMode: 'private' };
    await applyPendingOnDeviceCleanup();
    expect(mockGetReadiness).not.toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  // Unset cleanup outside Private mode runs on Cloud; coming back to Private mode applies it.
  it('waits while Private mode is off', async () => {
    mockConfig = { ...mockConfig, defaultMode: 'cloud' };
    await applyPendingOnDeviceCleanup();
    expect(mockGetReadiness).not.toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('only clears the flag once cleanup was set some other way', async () => {
    const provider = { mode: 'providers', providerId: 'groq' };
    mockConfig = { ...mockConfig, inference: { cleanup: provider } };
    await applyPendingOnDeviceCleanup();
    expect(mockGetReadiness).not.toHaveBeenCalled();
    expect(mockUpdateConfig).toHaveBeenCalledWith({ onDeviceCleanupPending: undefined });
  });

  it('keeps a cleanup choice saved while readiness was being read', async () => {
    const provider = { mode: 'providers', providerId: 'groq' };
    mockGetReadiness.mockImplementationOnce(async () => {
      mockConfig = { ...mockConfig, inference: { cleanup: provider } };
      return { status: 'ready' };
    });
    await applyPendingOnDeviceCleanup();
    expect(mockUpdateConfig).toHaveBeenCalledWith({ onDeviceCleanupPending: undefined });
  });

  it('saves nothing if Private mode was turned off while readiness was being read', async () => {
    mockGetReadiness.mockImplementationOnce(async () => {
      mockConfig = { ...mockConfig, defaultMode: 'cloud' };
      return { status: 'ready' };
    });
    await applyPendingOnDeviceCleanup();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});
