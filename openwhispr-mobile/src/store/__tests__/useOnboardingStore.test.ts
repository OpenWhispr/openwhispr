import { getStepProgress, useOnboardingStore } from '../useOnboardingStore';
import { OnboardingService } from '@/utils/onboarding';
import { logTutorialCompletion } from '@/lib/appsflyer';

jest.mock('@/lib/appsflyer', () => ({ logTutorialCompletion: jest.fn() }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: { defaultMode: 'cloud' } }) },
}));
jest.mock('@/utils/onboarding', () => ({
  FIRST_ONBOARDING_STEP: 'get-started',
  ONBOARDING_VERSION: 3,
  OnboardingService: {
    isOnboardingComplete: jest.fn(),
    completeOnboarding: jest.fn(),
    hasAttemptedTrackingAuthorizationRequest: jest.fn(),
    markTrackingAuthorizationRequestAttempted: jest.fn(),
    getProgress: jest.fn(),
    setProgress: jest.fn(),
    resetOnboarding: jest.fn(),
  },
}));
const service = jest.mocked(OnboardingService);

beforeEach(() => {
  jest.clearAllMocks();
  service.setProgress.mockResolvedValue();
  service.completeOnboarding.mockResolvedValue();
  service.isOnboardingComplete.mockResolvedValue(false);
  service.hasAttemptedTrackingAuthorizationRequest.mockResolvedValue(false);
  useOnboardingStore.setState(useOnboardingStore.getInitialState());
});

it('ignores a late callback from a step that has already advanced', async () => {
  await useOnboardingStore.getState().goToStep('keyboard-intro');
  await Promise.all([
    useOnboardingStore.getState().goNext('keyboard-intro'),
    useOnboardingStore.getState().goNext('keyboard-intro'),
  ]);
  expect(useOnboardingStore.getState().currentStep).toBe('keyboard-switch');
});

it.each([
  ['get-started', 'get-started'],
  ['unknown-old-step', 'get-started'],
  ['keyboard-switch', 'keyboard-switch'],
] as const)('resumes %s at %s without replaying earlier content', async (step, expected) => {
  service.getProgress.mockResolvedValue({
    step,
    keyboardInstalled: false,
    permissionsGranted: { microphone: false, notifications: false },
  });
  service.hasAttemptedTrackingAuthorizationRequest.mockResolvedValue(true);
  await useOnboardingStore.getState().hydrate();
  expect(useOnboardingStore.getState()).toMatchObject({
    currentStep: expected,
    hydrated: true,
    finished: false,
    trackingAuthorizationRequestAttempted: true,
  });
});

it('marks tracking permission attempted only after its marker is saved', async () => {
  service.markTrackingAuthorizationRequestAttempted.mockRejectedValueOnce(
    new Error('Storage unavailable'),
  );
  await expect(
    useOnboardingStore.getState().markTrackingAuthorizationRequestAttempted(),
  ).rejects.toThrow();
  expect(useOnboardingStore.getState().trackingAuthorizationRequestAttempted).toBe(false);
  await useOnboardingStore.getState().markTrackingAuthorizationRequestAttempted();
  expect(useOnboardingStore.getState().trackingAuthorizationRequestAttempted).toBe(true);
});

it('does not leave a step when persisting the transition fails', async () => {
  service.setProgress.mockRejectedValueOnce(new Error('Keychain unavailable'));
  await expect(useOnboardingStore.getState().goNext('get-started')).rejects.toThrow();
  expect(useOnboardingStore.getState().currentStep).toBe('get-started');
  await useOnboardingStore.getState().goNext('get-started');
  expect(useOnboardingStore.getState().currentStep).toBe('security-first');
});

it('shows the paywall immediately for Cloud, then resumes languages only once', async () => {
  await useOnboardingStore.getState().goToStep('privacy-mode');
  await useOnboardingStore.getState().chooseMode('cloud', 'privacy-mode');
  expect(useOnboardingStore.getState().currentStep).toBe('paywall');
  await useOnboardingStore.getState().goNext('paywall');
  await useOnboardingStore.getState().goNext('paywall');
  expect(useOnboardingStore.getState()).toMatchObject({
    currentStep: 'language',
    paywallHandled: true,
  });
  await useOnboardingStore.getState().goBack('language');
  expect(useOnboardingStore.getState().currentStep).toBe('privacy-mode');
  await useOnboardingStore.getState().chooseMode('cloud', 'privacy-mode');
  expect(useOnboardingStore.getState().currentStep).toBe('language');
  await useOnboardingStore.getState().goNext('language');
  expect(useOnboardingStore.getState().currentStep).toBe('notifications');
});

it('routes Local through languages and download without a paywall', async () => {
  await useOnboardingStore.getState().goToStep('privacy-mode');
  await useOnboardingStore.getState().chooseMode('private', 'privacy-mode');
  expect(useOnboardingStore.getState().currentStep).toBe('language');
  await useOnboardingStore.getState().goNext('language');
  expect(useOnboardingStore.getState().currentStep).toBe('private-download');
  await useOnboardingStore.getState().goBack('private-download');
  expect(useOnboardingStore.getState().currentStep).toBe('language');
});

it('resumes a download-to-Cloud paywall at notifications after relaunch', async () => {
  await useOnboardingStore.getState().goToStep('private-download');
  await useOnboardingStore.getState().chooseMode('cloud', 'private-download');
  const saved = service.setProgress.mock.calls.at(-1)?.[0];
  service.getProgress.mockResolvedValue(saved!);
  useOnboardingStore.setState(useOnboardingStore.getInitialState());
  await useOnboardingStore.getState().hydrate();
  expect(useOnboardingStore.getState().currentStep).toBe('paywall');
  await useOnboardingStore.getState().goNext('paywall');
  expect(useOnboardingStore.getState().currentStep).toBe('notifications');
});

it.each(['graduation', 'paywall'] as const)(
  'migrates legacy %s past the relocated offer',
  async (step) => {
    service.getProgress.mockResolvedValue({
      step,
      keyboardInstalled: true,
      permissionsGranted: { microphone: true, notifications: false },
    });
    await useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState()).toMatchObject({
      currentStep: 'create-account',
      paywallHandled: true,
      tutorialCompleted: true,
    });
  },
);

it('preserves a legacy local download and does not replay earlier steps', async () => {
  service.getProgress.mockResolvedValue({
    step: 'private-download',
    keyboardInstalled: true,
    permissionsGranted: { microphone: true, notifications: false },
  });
  await useOnboardingStore.getState().hydrate();
  expect(useOnboardingStore.getState()).toMatchObject({
    currentStep: 'private-download',
    selectedMode: 'private',
    paywallHandled: true,
  });
});

it('does not restart completed installs', async () => {
  service.isOnboardingComplete.mockResolvedValue(true);
  await useOnboardingStore.getState().hydrate();
  expect(useOnboardingStore.getState().finished).toBe(true);
  expect(service.getProgress).not.toHaveBeenCalled();
});

it('counts only teaching screens and counts the local download once', () => {
  expect(getStepProgress('voice-agent', 'cloud')).toEqual({ current: 5, total: 9 });
  expect(getStepProgress('tone', 'cloud')).toEqual({ current: 6, total: 9 });
  expect(getStepProgress('microphone', 'cloud')).toEqual({ current: 1, total: 9 });
  expect(getStepProgress('notifications', 'cloud')).toEqual({ current: 9, total: 9 });
  expect(getStepProgress('private-download', 'private')).toEqual({ current: 9, total: 10 });
  expect(getStepProgress('notifications', 'private')).toEqual({ current: 10, total: 10 });
  expect(getStepProgress('paywall', 'cloud')).toBeUndefined();
});

it.each([
  ['voice-agent', 'tone'],
  ['privacy-mode', 'privacy-mode'],
  ['paywall', 'paywall'],
  ['graduation', 'graduation'],
] as const)('preserves version 2 progress at %s as %s', async (step, expected) => {
  service.getProgress.mockResolvedValue({
    version: 2,
    step,
    selectedMode: 'private',
    paywallHandled: false,
    paywallNextStep: 'notifications',
    keyboardInstalled: true,
    permissionsGranted: { microphone: true, notifications: false },
  });
  await useOnboardingStore.getState().hydrate();
  expect(useOnboardingStore.getState()).toMatchObject({
    currentStep: expected,
    selectedMode: 'private',
    paywallHandled: false,
    paywallNextStep: 'notifications',
  });
});

it('completes teaching once at the preview, but only finishes onboarding at graduation', async () => {
  await useOnboardingStore.getState().goToStep('voice-agent');
  await useOnboardingStore.getState().goNext('voice-agent');
  expect(useOnboardingStore.getState().currentStep).toBe('tone');
  expect(logTutorialCompletion).not.toHaveBeenCalled();
  await useOnboardingStore.getState().goNext('tone');
  await useOnboardingStore.getState().goBack('privacy-mode');
  await useOnboardingStore.getState().goNext('tone');
  expect(logTutorialCompletion).toHaveBeenCalledTimes(1);
  await useOnboardingStore.getState().goToStep('tracking-permission');
  await useOnboardingStore.getState().goNext('tracking-permission');
  expect(useOnboardingStore.getState()).toMatchObject({
    currentStep: 'graduation',
    finished: false,
  });
  await useOnboardingStore.getState().finish();
  expect(useOnboardingStore.getState().finished).toBe(true);
});

it.each(['cloud', 'private'] as const)(
  'completes the %s route through optional account and tracking',
  async (mode) => {
    await useOnboardingStore.getState().goToStep('privacy-mode');
    await useOnboardingStore.getState().chooseMode(mode, 'privacy-mode');
    if (mode === 'cloud') await useOnboardingStore.getState().goNext('paywall');
    await useOnboardingStore.getState().goNext('language');
    if (mode === 'private') await useOnboardingStore.getState().goNext('private-download');
    for (const from of ['notifications', 'create-account', 'tracking-permission'] as const) {
      expect(useOnboardingStore.getState().currentStep).toBe(from);
      await useOnboardingStore.getState().goNext(from);
    }
    expect(useOnboardingStore.getState().currentStep).toBe('graduation');
    expect(service.completeOnboarding).not.toHaveBeenCalled();
  },
);

it('keeps resolved offers and confirmed choices across a relaunch and backward navigation', async () => {
  await useOnboardingStore.getState().goToStep('privacy-mode');
  await useOnboardingStore.getState().chooseMode('cloud', 'privacy-mode');
  await useOnboardingStore.getState().goNext('paywall');
  service.getProgress.mockResolvedValue(service.setProgress.mock.calls.at(-1)![0]);
  useOnboardingStore.setState(useOnboardingStore.getInitialState());
  await useOnboardingStore.getState().hydrate();
  await useOnboardingStore.getState().goBack('language');
  await useOnboardingStore.getState().goBack('privacy-mode');
  await useOnboardingStore.getState().goBack('tone');
  await useOnboardingStore.getState().goBack('voice-agent');
  expect(useOnboardingStore.getState()).toMatchObject({
    currentStep: 'dictation-email',
    selectedMode: 'cloud',
    paywallHandled: true,
  });
  await useOnboardingStore.getState().goToStep('privacy-mode');
  await useOnboardingStore.getState().chooseMode('cloud', 'privacy-mode');
  expect(useOnboardingStore.getState().currentStep).toBe('language');
});

it('preserves the tracking request marker when resetting setup', async () => {
  useOnboardingStore.setState({
    finished: true,
    paywallHandled: true,
    selectedMode: 'private',
    trackingAuthorizationRequestAttempted: true,
  });
  await useOnboardingStore.getState().reset();
  expect(useOnboardingStore.getState()).toMatchObject({
    currentStep: 'get-started',
    finished: false,
    selectedMode: null,
    paywallHandled: false,
    trackingAuthorizationRequestAttempted: true,
  });
});
