const mockCompleteOnboarding = jest.fn();
const mockLogTutorialCompletion = jest.fn();

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: { defaultMode: 'cloud' } }) },
}));

jest.mock('@/utils/onboarding', () => ({
  FIRST_ONBOARDING_STEP: 'get-started',
  ONBOARDING_VERSION: 3,
  OnboardingService: {
    isOnboardingComplete: jest.fn(),
    getProgress: jest.fn(),
    setProgress: jest.fn().mockResolvedValue(undefined),
    completeOnboarding: mockCompleteOnboarding,
    resetOnboarding: jest.fn(),
  },
}));

jest.mock('@/lib/appsflyer', () => ({
  logTutorialCompletion: mockLogTutorialCompletion,
}));

const { useOnboardingStore } =
  require('../useOnboardingStore') as typeof import('../useOnboardingStore');

function createDeferredPromise(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCompleteOnboarding.mockResolvedValue(undefined);
  useOnboardingStore.setState({
    hydrated: true,
    finished: false,
    currentStep: 'tone',
    tutorialCompleted: false,
    keyboardInstalled: true,
    permissionsGranted: {
      microphone: false,
      notifications: true,
    },
  });
});

describe('useOnboardingStore AppsFlyer events', () => {
  it('logs tutorial completion when leaving the tone preview with the setup state', async () => {
    await useOnboardingStore.getState().goNext('tone');

    expect(useOnboardingStore.getState().currentStep).toBe('privacy-mode');
    expect(mockLogTutorialCompletion).toHaveBeenCalledWith({
      keyboardInstalled: true,
      microphonePermissionGranted: false,
    });
  });

  it('logs it once, not again on the duplicate callbacks', async () => {
    await useOnboardingStore.getState().goNext('tone');
    await useOnboardingStore.getState().goNext('tone');

    expect(useOnboardingStore.getState().currentStep).toBe('privacy-mode');
    expect(mockLogTutorialCompletion).toHaveBeenCalledTimes(1);
  });

  it('does not log completion when onboarding is persisted', async () => {
    useOnboardingStore.setState({ currentStep: 'graduation' });
    await useOnboardingStore.getState().finish();

    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
    expect(useOnboardingStore.getState().finished).toBe(true);
    expect(mockLogTutorialCompletion).not.toHaveBeenCalled();
  });

  it('does not persist completion again once onboarding is finished', async () => {
    useOnboardingStore.setState({ currentStep: 'graduation' });
    await useOnboardingStore.getState().finish();
    useOnboardingStore.setState({ currentStep: 'graduation' });
    await useOnboardingStore.getState().finish();

    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping completion attempts', async () => {
    const deferredPersistence = createDeferredPromise();
    mockCompleteOnboarding.mockReturnValueOnce(deferredPersistence.promise);

    useOnboardingStore.setState({ currentStep: 'graduation' });
    const firstCompletion = useOnboardingStore.getState().finish();
    const secondCompletion = useOnboardingStore.getState().finish();

    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);

    deferredPersistence.resolve();
    await Promise.all([firstCompletion, secondCompletion]);

    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
  });

  it('does not log a failed completion and allows a later retry', async () => {
    mockCompleteOnboarding.mockRejectedValueOnce(new Error('secure storage unavailable'));

    useOnboardingStore.setState({ currentStep: 'graduation' });
    await expect(useOnboardingStore.getState().finish()).rejects.toThrow(
      'secure storage unavailable',
    );

    expect(useOnboardingStore.getState().finished).toBe(false);

    mockCompleteOnboarding.mockResolvedValueOnce(undefined);

    useOnboardingStore.setState({ currentStep: 'graduation' });
    await useOnboardingStore.getState().finish();

    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(2);
    expect(useOnboardingStore.getState().finished).toBe(true);
  });
});
