const mockCompleteOnboarding = jest.fn();
const mockRecordOnboardingCompleted = jest.fn();

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
    resetOnboarding: jest.fn().mockResolvedValue(undefined),
    hasAttemptedTrackingAuthorizationRequest: jest.fn().mockResolvedValue(false),
  },
}));

jest.mock('@/lib/appsflyer', () => ({ logTutorialCompletion: jest.fn() }));

jest.mock('@/lib/productEvents', () => ({
  recordOnboardingCompleted: mockRecordOnboardingCompleted,
}));

const { useOnboardingStore } =
  require('../useOnboardingStore') as typeof import('../useOnboardingStore');

beforeEach(() => {
  jest.clearAllMocks();
  mockCompleteOnboarding.mockResolvedValue(undefined);
  useOnboardingStore.setState({
    hydrated: true,
    finished: false,
    currentStep: 'tone',
    selectedMode: 'private',
    tutorialCompleted: false,
    replaying: false,
  });
});

describe('useOnboardingStore onboarding milestone', () => {
  it('records the completion once it is persisted, with its mode and flow', async () => {
    useOnboardingStore.setState({ currentStep: 'graduation' });
    await useOnboardingStore.getState().finish();

    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
    expect(mockRecordOnboardingCompleted).toHaveBeenCalledWith({
      mode: 'private',
      replay: false,
      flowVersion: 'mobile-onboarding-3',
    });
  });

  it('records nothing when persisting the completion fails', async () => {
    mockCompleteOnboarding.mockRejectedValue(new Error('SecureStore unavailable'));
    useOnboardingStore.setState({ currentStep: 'graduation' });
    await expect(useOnboardingStore.getState().finish()).rejects.toThrow();

    expect(mockRecordOnboardingCompleted).not.toHaveBeenCalled();
  });

  it('a tutorial step, a duplicate finish or a finish before graduation records nothing more', async () => {
    await useOnboardingStore.getState().goNext('tone');
    await useOnboardingStore.getState().finish();
    expect(mockRecordOnboardingCompleted).not.toHaveBeenCalled();

    useOnboardingStore.setState({ currentStep: 'graduation' });
    await Promise.all([
      useOnboardingStore.getState().finish(),
      useOnboardingStore.getState().finish(),
    ]);
    await useOnboardingStore.getState().finish();
    expect(mockRecordOnboardingCompleted).toHaveBeenCalledTimes(1);
  });

  it('a completion after Reset is a replay', async () => {
    await useOnboardingStore.getState().reset();
    useOnboardingStore.setState({ currentStep: 'graduation', selectedMode: 'providers' });
    await useOnboardingStore.getState().finish();

    expect(mockRecordOnboardingCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'providers', replay: true }),
    );
  });
});
