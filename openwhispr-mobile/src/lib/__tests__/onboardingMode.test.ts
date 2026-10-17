import { Platform } from 'react-native';
const mockLocalReadiness = jest.fn();
jest.mock('../localReasoning', () => ({
  getLocalReasoningReadiness: () => mockLocalReadiness(),
  canRunLocalReasoning: (readiness: { status?: string } | null) => readiness?.status === 'ready',
}));
import { chooseOnboardingMode } from '../onboardingMode';
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
    getState: () => ({ currentStep: mockCurrentStep, chooseMode: mockChooseMode }),
  },
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
    inference: {
      dictation: { mode: 'local' },
      upload: { mode: 'local' },
      cleanup: { mode: 'local' },
    },
    pinnedInference: ['upload', 'cleanup'],
  });
  expect(mockUpdateConfig).toHaveBeenLastCalledWith({
    defaultMode: 'providers',
    inference,
    pinnedInference: ['upload'],
  });
});

// Choosing Local in setup keeps uploads and cleanup on this iPhone, even for a signed-in account,
// whose Local Mode defaults would send them to Cloud. They are automatic pins, not the user's own.
it('keeps uploads and cleanup on this iPhone when setup picks Local', async () => {
  mockUser = { id: 'u', isAnonymous: false };
  mockConfig = {
    defaultMode: 'cloud',
    inference: { dictation: { mode: 'openwhispr' }, cleanup: { mode: 'openwhispr' } },
    rememberedInference: { upload: { local: { mode: 'local', modelId: 'whisper-base' } } },
  };
  await chooseOnboardingMode('private', 'privacy-mode');
  expect(mockUpdateConfig.mock.calls[0][0]).toMatchObject({
    defaultMode: 'private',
    inference: {
      dictation: { mode: 'local' },
      upload: { mode: 'local', modelId: 'whisper-base' },
      cleanup: { mode: 'local' },
    },
    pinnedInference: ['upload', 'cleanup'],
  });
});

it.each([
  ['On-Device', { mode: 'local', modelId: 'parakeet-v2' }],
  ['provider', { mode: 'providers', providerId: 'groq', modelId: 'llama-3.3-70b-versatile' }],
])('keeps a saved %s choice when setup picks Local', async (_label, saved) => {
  mockConfig = { defaultMode: 'cloud', inference: { upload: saved, cleanup: saved } };
  await chooseOnboardingMode('private', 'privacy-mode');
  const { inference, pinnedInference } = mockUpdateConfig.mock.calls[0][0];
  expect(inference.upload).toEqual(saved);
  expect(inference.cleanup).toEqual(saved);
  expect(pinnedInference).toEqual([]);
});

// Going back to Cloud in setup changes the mode, which releases what Local held.
it('releases them when setup goes back to Cloud', async () => {
  mockUser = { id: 'u', isAnonymous: false };
  mockConfig = {
    defaultMode: 'private',
    inference: {
      dictation: { mode: 'local' },
      upload: { mode: 'local' },
      cleanup: { mode: 'local' },
    },
    pinnedInference: ['upload', 'cleanup'],
  };
  await chooseOnboardingMode('cloud', 'privacy-mode');
  expect(mockUpdateConfig.mock.calls[0][0]).toEqual({
    defaultMode: 'cloud',
    inference: { dictation: { mode: 'openwhispr' } },
    pinnedInference: undefined,
  });
});

it('keeps a cleanup the user saved when setup picks Cloud', async () => {
  mockUser = { id: 'u', isAnonymous: false };
  const cleanup = { mode: 'local' };
  mockConfig = { defaultMode: 'cloud', inference: { dictation: { mode: 'openwhispr' }, cleanup } };
  await chooseOnboardingMode('cloud', 'privacy-mode');
  expect(mockUpdateConfig.mock.calls[0][0].inference.cleanup).toEqual(cleanup);
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

describe('Android onboarding cleanup', () => {
  const originalOS = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'android';
  });
  afterEach(() => {
    Platform.OS = originalOS;
  });
  it('keeps downloaded Qwen cleanup selected when Local Mode is chosen', async () => {
    mockLocalReadiness.mockResolvedValue({ status: 'ready' });
    await chooseOnboardingMode('private', 'privacy-mode');
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        inference: { dictation: { mode: 'local' }, cleanup: { mode: 'local' } },
      }),
    );
  });
  it('does not select a cloud cleanup fallback when the text model is missing', async () => {
    mockLocalReadiness.mockResolvedValue({ status: 'modelNotDownloaded' });
    await chooseOnboardingMode('private', 'privacy-mode');
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        inference: { dictation: { mode: 'local' } },
      }),
    );
  });
  it('does not commit after navigation changes while readiness is being checked', async () => {
    mockLocalReadiness.mockImplementationOnce(async () => {
      mockCurrentStep = 'language';
      return { status: 'ready' };
    });
    await chooseOnboardingMode('private', 'privacy-mode');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});
