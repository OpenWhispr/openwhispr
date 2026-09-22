import {
  STEP_ORDER,
  getStepProgress,
  useOnboardingStore,
  type OnboardingStepId,
} from '@/store/useOnboardingStore';
import { FIRST_ONBOARDING_STEP, OnboardingService } from '@/utils/onboarding';

// The tutorial milestone reports to AppsFlyer, whose module pulls in the
// SQLite-backed config store; the event itself has its own focused suite.
jest.mock('@/lib/appsflyer', () => ({ logTutorialCompletion: jest.fn() }));

jest.mock('@/utils/onboarding', () => ({
  FIRST_ONBOARDING_STEP: 'get-started',
  OnboardingService: {
    isOnboardingComplete: jest.fn(),
    completeOnboarding: jest.fn(),
    resetOnboarding: jest.fn(),
    hasAttemptedTrackingAuthorizationRequest: jest.fn(),
    markTrackingAuthorizationRequestAttempted: jest.fn(),
    getProgress: jest.fn(),
    setProgress: jest.fn(),
  },
}));

const mockedService = OnboardingService as jest.Mocked<typeof OnboardingService>;

async function advanceTo(step: OnboardingStepId): Promise<void> {
  await useOnboardingStore.getState().goToStep(step);
}

describe('useOnboardingStore step order', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedService.setProgress.mockResolvedValue();
    mockedService.completeOnboarding.mockResolvedValue();
    mockedService.hasAttemptedTrackingAuthorizationRequest.mockResolvedValue(false);
    mockedService.markTrackingAuthorizationRequestAttempted.mockResolvedValue(undefined);
    useOnboardingStore.setState({
      currentStep: 'security-first',
      finished: false,
      trackingAuthorizationRequestAttempted: false,
    });
  });

  it('opens on Get Started and ends with account creation then tracking permission', () => {
    expect(STEP_ORDER[0]).toBe('get-started');
    expect(STEP_ORDER.slice(-4)).toEqual([
      'graduation',
      'paywall',
      'create-account',
      'tracking-permission',
    ]);
  });

  it('starts a fresh install at the first step', async () => {
    mockedService.isOnboardingComplete.mockResolvedValue(false);
    mockedService.getProgress.mockResolvedValue({
      step: FIRST_ONBOARDING_STEP,
      keyboardInstalled: false,
      permissionsGranted: { microphone: false, notifications: false },
    });

    await useOnboardingStore.getState().hydrate();

    expect(useOnboardingStore.getState().currentStep).toBe('get-started');
  });

  it('falls back to the first step when saved progress names an unknown step', async () => {
    mockedService.isOnboardingComplete.mockResolvedValue(false);
    mockedService.getProgress.mockResolvedValue({
      step: 'a-step-that-was-removed',
      keyboardInstalled: false,
      permissionsGranted: { microphone: false, notifications: false },
    });

    await useOnboardingStore.getState().hydrate();

    expect(useOnboardingStore.getState().currentStep).toBe(FIRST_ONBOARDING_STEP);
  });

  it('resumes mid-onboarding installs where they left off', async () => {
    mockedService.isOnboardingComplete.mockResolvedValue(false);
    mockedService.getProgress.mockResolvedValue({
      step: 'language',
      keyboardInstalled: true,
      permissionsGranted: { microphone: true, notifications: false },
    });

    await useOnboardingStore.getState().hydrate();

    expect(useOnboardingStore.getState().currentStep).toBe('language');
  });

  it('restores a persisted ATT request attempt when resuming onboarding', async () => {
    mockedService.isOnboardingComplete.mockResolvedValue(false);
    mockedService.hasAttemptedTrackingAuthorizationRequest.mockResolvedValue(true);
    mockedService.getProgress.mockResolvedValue({
      step: 'tracking-permission',
      keyboardInstalled: true,
      permissionsGranted: { microphone: true, notifications: true },
    });

    await useOnboardingStore.getState().hydrate();

    expect(useOnboardingStore.getState()).toMatchObject({
      currentStep: 'tracking-permission',
      trackingAuthorizationRequestAttempted: true,
    });
  });

  it('walks graduation into the paywall rather than finishing', async () => {
    await advanceTo('graduation');
    await useOnboardingStore.getState().goNext();

    expect(useOnboardingStore.getState().currentStep).toBe('paywall');
    expect(useOnboardingStore.getState().finished).toBe(false);
    expect(mockedService.completeOnboarding).not.toHaveBeenCalled();
  });

  it('walks the paywall into account creation', async () => {
    await advanceTo('paywall');
    await useOnboardingStore.getState().goNext();

    expect(useOnboardingStore.getState().currentStep).toBe('create-account');
    expect(useOnboardingStore.getState().finished).toBe(false);
  });

  it('walks account creation into tracking permission without finishing', async () => {
    await advanceTo('create-account');
    await useOnboardingStore.getState().goNext();

    expect(useOnboardingStore.getState().currentStep).toBe('tracking-permission');
    expect(useOnboardingStore.getState().finished).toBe(false);
    expect(mockedService.completeOnboarding).not.toHaveBeenCalled();
  });

  it('only completes onboarding once the tracking step finishes', async () => {
    await advanceTo('tracking-permission');
    await useOnboardingStore.getState().goNext();

    // tracking-permission is terminal: goNext is a no-op, finish() is the only exit.
    expect(useOnboardingStore.getState().currentStep).toBe('tracking-permission');
    expect(useOnboardingStore.getState().finished).toBe(false);

    await useOnboardingStore.getState().finish();

    expect(mockedService.completeOnboarding).toHaveBeenCalledTimes(1);
    expect(useOnboardingStore.getState().finished).toBe(true);
  });

  it('persists the ATT attempt before the system request can run', async () => {
    await advanceTo('tracking-permission');

    await useOnboardingStore.getState().markTrackingAuthorizationRequestAttempted();

    expect(useOnboardingStore.getState().trackingAuthorizationRequestAttempted).toBe(true);
    expect(mockedService.markTrackingAuthorizationRequestAttempted).toHaveBeenCalledTimes(1);
  });

  it('keeps the ATT request attempt when onboarding is reset', async () => {
    mockedService.hasAttemptedTrackingAuthorizationRequest.mockResolvedValue(true);
    useOnboardingStore.setState({ trackingAuthorizationRequestAttempted: false });

    await useOnboardingStore.getState().reset();

    expect(useOnboardingStore.getState().trackingAuthorizationRequestAttempted).toBe(true);
    expect(mockedService.hasAttemptedTrackingAuthorizationRequest).toHaveBeenCalledTimes(1);
  });

  it('counts only the teaching steps, not the intro or closing screens', () => {
    const total = getStepProgress('welcome').total;

    expect(getStepProgress('welcome').current).toBe(1);
    expect(getStepProgress('notifications').current).toBe(total);
    // Uncounted screens clamp to 1 rather than reporting a bogus position.
    for (const step of [
      'get-started',
      'security-first',
      'graduation',
      'paywall',
      'create-account',
      'tracking-permission',
    ] as const) {
      expect(getStepProgress(step).current).toBe(1);
    }
  });
});
