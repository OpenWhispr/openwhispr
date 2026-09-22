const mockCompleteOnboarding = jest.fn();
const mockLogTutorialCompletion = jest.fn();

jest.mock('@/utils/onboarding', () => ({
  FIRST_ONBOARDING_STEP: 'get-started',
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
    currentStep: 'graduation',
    keyboardInstalled: true,
    permissionsGranted: {
      microphone: false,
      notifications: true,
    },
  });
});

describe('useOnboardingStore AppsFlyer events', () => {
  // The tutorial ends at graduation. The paywall and account steps that follow
  // are a different funnel, so the event fires when the user leaves graduation
  // rather than when onboarding is finally persisted — otherwise everyone who
  // drops at the paywall or the account screen would read as never having
  // finished the tutorial.
  it('logs tutorial completion when leaving graduation with the setup state', async () => {
    await useOnboardingStore.getState().goNext();

    expect(useOnboardingStore.getState().currentStep).toBe('paywall');
    expect(mockLogTutorialCompletion).toHaveBeenCalledWith({
      keyboardInstalled: true,
      microphonePermissionGranted: false,
    });
  });

  it('logs it once, not again on the steps after graduation', async () => {
    await useOnboardingStore.getState().goNext();
    await useOnboardingStore.getState().goNext();

    expect(useOnboardingStore.getState().currentStep).toBe('create-account');
    expect(mockLogTutorialCompletion).toHaveBeenCalledTimes(1);
  });

  it('does not log completion when onboarding is persisted', async () => {
    await useOnboardingStore.getState().finish();

    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
    expect(useOnboardingStore.getState().finished).toBe(true);
    expect(mockLogTutorialCompletion).not.toHaveBeenCalled();
  });

  it('does not persist completion again once onboarding is finished', async () => {
    await useOnboardingStore.getState().finish();
    await useOnboardingStore.getState().finish();

    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping completion attempts', async () => {
    const deferredPersistence = createDeferredPromise();
    mockCompleteOnboarding.mockReturnValueOnce(deferredPersistence.promise);

    const firstCompletion = useOnboardingStore.getState().finish();
    const secondCompletion = useOnboardingStore.getState().finish();

    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);

    deferredPersistence.resolve();
    await Promise.all([firstCompletion, secondCompletion]);

    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
  });

  it('does not log a failed completion and allows a later retry', async () => {
    mockCompleteOnboarding.mockRejectedValueOnce(new Error('secure storage unavailable'));

    await expect(useOnboardingStore.getState().finish()).rejects.toThrow(
      'secure storage unavailable',
    );

    expect(useOnboardingStore.getState().finished).toBe(false);

    mockCompleteOnboarding.mockResolvedValueOnce(undefined);

    await useOnboardingStore.getState().finish();

    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(2);
    expect(useOnboardingStore.getState().finished).toBe(true);
  });
});
