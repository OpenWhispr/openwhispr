import { getAffiliateClientConfig } from '@/lib/affiliateLink';
jest.mock('@/lib/affiliateLink', () => ({
  getAffiliateClientConfig: jest.fn().mockReturnValue(null),
}));
import { getStepProgress, useOnboardingStore } from '../useOnboardingStore';
import { OnboardingService } from '@/utils/onboarding';
import { logTutorialCompletion } from '@/lib/appsflyer';

jest.mock('@/lib/appsflyer', () => ({ logTutorialCompletion: jest.fn() }));
let mockConfig = { defaultMode: 'cloud' };
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
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
  jest.mocked(getAffiliateClientConfig).mockReturnValue(null);
  mockConfig = { defaultMode: 'cloud' };
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

const legacyProgress = (step: string) => ({
  step,
  keyboardInstalled: true,
  permissionsGranted: { microphone: true, notifications: false },
});

// Main offered the paywall and logged the tutorial after graduation, so installs that update
// before reaching it still owe both.
it.each([
  ['language', 'paywall', 'language', false, false],
  ['notifications', 'paywall', 'notifications', false, false],
  ['graduation', 'paywall', 'create-account', false, false],
  ['paywall', 'paywall', 'create-account', false, true],
  ['create-account', 'create-account', 'language', true, true],
  ['tracking-permission', 'tracking-permission', 'language', true, true],
] as const)(
  'resumes a legacy Cloud install at %s on %s, next %s',
  async (step, currentStep, paywallNextStep, paywallHandled, tutorialCompleted) => {
    service.getProgress.mockResolvedValue(legacyProgress(step));
    await useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState()).toMatchObject({
      currentStep,
      selectedMode: 'cloud',
      paywallNextStep,
      paywallHandled,
      tutorialCompleted,
    });
  },
);

it.each([
  ['language', 'language', false],
  ['notifications', 'notifications', false],
  ['graduation', 'create-account', false],
  ['paywall', 'create-account', true],
] as const)(
  'resumes a legacy Local install at %s on %s without an offer',
  async (step, currentStep, tutorialCompleted) => {
    mockConfig = { defaultMode: 'private' };
    service.getProgress.mockResolvedValue(legacyProgress(step));
    await useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState()).toMatchObject({
      currentStep,
      selectedMode: 'private',
      tutorialCompleted,
    });
  },
);

it('sends a legacy install from its owed offer on to the account step, logging the tutorial once', async () => {
  service.getProgress.mockResolvedValue(legacyProgress('graduation'));
  await useOnboardingStore.getState().hydrate();
  await useOnboardingStore.getState().goNext('paywall');
  await useOnboardingStore.getState().goNext('create-account');
  expect(useOnboardingStore.getState().currentStep).toBe('tracking-permission');
  expect(logTutorialCompletion).toHaveBeenCalledTimes(1);
});

it('logs the tutorial for a legacy install that resumes past the tone preview', async () => {
  service.getProgress.mockResolvedValue(legacyProgress('privacy-mode'));
  await useOnboardingStore.getState().hydrate();
  await useOnboardingStore.getState().chooseMode('private', 'privacy-mode');
  await useOnboardingStore.getState().goNext('language');
  expect(logTutorialCompletion).toHaveBeenCalledTimes(1);
});

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
    paywallHandled: false,
  });
});

it('resumes an owed offer that leads to the account step after a relaunch', async () => {
  service.getProgress.mockResolvedValue({
    version: 3,
    step: 'paywall',
    selectedMode: 'cloud',
    paywallNextStep: 'create-account',
    keyboardInstalled: true,
    permissionsGranted: { microphone: true, notifications: false },
  });
  await useOnboardingStore.getState().hydrate();
  await useOnboardingStore.getState().goNext('paywall');
  expect(useOnboardingStore.getState().currentStep).toBe('create-account');
});

it('does not restart completed installs', async () => {
  service.isOnboardingComplete.mockResolvedValue(true);
  await useOnboardingStore.getState().hydrate();
  expect(useOnboardingStore.getState().finished).toBe(true);
  expect(service.getProgress).not.toHaveBeenCalled();
});

// The optional download shares the language step's number, so choosing Local never grows the total.
it('counts only teaching screens and gives the local download the language step number', () => {
  expect(getStepProgress('microphone')).toEqual({ current: 1, total: 9 });
  expect(getStepProgress('voice-agent')).toEqual({ current: 5, total: 9 });
  expect(getStepProgress('tone')).toEqual({ current: 6, total: 9 });
  expect(getStepProgress('language')).toEqual({ current: 8, total: 9 });
  expect(getStepProgress('private-download')).toEqual({ current: 8, total: 9 });
  expect(getStepProgress('notifications')).toEqual({ current: 9, total: 9 });
  expect(getStepProgress('paywall')).toBeUndefined();
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

it('keeps fresh affiliate onboarding at graduation before payment and optional signup', async () => {
  jest
    .mocked(getAffiliateClientConfig)
    .mockReturnValue({ domain: 'sandbox.dub.link', publishableKey: 'dub_pk_test' });
  service.getProgress.mockResolvedValue({
    step: 'get-started',
    keyboardInstalled: false,
    permissionsGranted: { microphone: false, notifications: false },
  });
  await useOnboardingStore.getState().hydrate();
  await useOnboardingStore.getState().goToStep('privacy-mode');
  await useOnboardingStore.getState().chooseMode('cloud', 'privacy-mode');
  expect(useOnboardingStore.getState().currentStep).toBe('language');
  await useOnboardingStore.getState().goNext('language');
  await useOnboardingStore.getState().goNext('notifications');
  expect(useOnboardingStore.getState().currentStep).toBe('graduation');
  await useOnboardingStore.getState().goNext('graduation');
  expect(useOnboardingStore.getState().currentStep).toBe('paywall');
  await useOnboardingStore.getState().goNext('paywall');
  expect(useOnboardingStore.getState().currentStep).toBe('create-account');
  await useOnboardingStore.getState().goNext('create-account');
  await useOnboardingStore.getState().goNext('tracking-permission');
  expect(useOnboardingStore.getState().finished).toBe(true);
});
it('does not move an in-progress ordinary setup onto the affiliate route', async () => {
  jest
    .mocked(getAffiliateClientConfig)
    .mockReturnValue({ domain: 'sandbox.dub.link', publishableKey: 'dub_pk_test' });
  service.getProgress.mockResolvedValue({
    version: 3,
    step: 'notifications',
    paywallHandled: true,
    selectedMode: 'cloud',
    keyboardInstalled: true,
    permissionsGranted: { microphone: true, notifications: true },
  });
  await useOnboardingStore.getState().hydrate();
  expect(useOnboardingStore.getState().affiliateSequence).toBe(false);
  await useOnboardingStore.getState().goNext('notifications');
  expect(useOnboardingStore.getState().currentStep).toBe('create-account');
});
