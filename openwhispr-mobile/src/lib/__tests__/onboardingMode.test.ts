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
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      config: { defaultMode: 'private' },
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
  mockCurrentStep = 'privacy-mode';
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
  expect(mockUpdateConfig).toHaveBeenCalledWith({ defaultMode: 'cloud' });
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
  expect(mockUpdateConfig).toHaveBeenCalledWith({ defaultMode: 'cloud' });
  expect(mockChooseMode).toHaveBeenCalledWith('cloud', 'private-download');
});
