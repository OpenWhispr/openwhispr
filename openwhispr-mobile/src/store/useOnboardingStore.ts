import { create } from 'zustand';
import {
  FIRST_ONBOARDING_STEP,
  ONBOARDING_VERSION,
  OnboardingService,
  type OnboardingProgress,
} from '@/utils/onboarding';
import { logTutorialCompletion } from '@/lib/appsflyer';
import { useConfigStore } from './useConfigStore';
import type { ProcessingMode } from '@/types';
import { getAffiliateClientConfig } from '@/lib/affiliateLink';

export type OnboardingStepId =
  | 'get-started'
  | 'security-first'
  | 'welcome'
  | 'microphone'
  | 'keyboard-intro'
  | 'keyboard-switch'
  | 'dictation-email'
  | 'voice-agent'
  | 'tone'
  | 'privacy-mode'
  | 'paywall'
  | 'language'
  | 'private-download'
  | 'notifications'
  | 'create-account'
  | 'tracking-permission'
  | 'graduation';

export const STEP_ORDER: readonly OnboardingStepId[] = [
  'get-started',
  'security-first',
  'welcome',
  'microphone',
  'keyboard-intro',
  'keyboard-switch',
  'dictation-email',
  'voice-agent',
  'tone',
  'privacy-mode',
  'paywall',
  'language',
  'private-download',
  'notifications',
  'create-account',
  'tracking-permission',
  'graduation',
];

const UNCOUNTED_STEPS = new Set<OnboardingStepId>([
  'get-started',
  'security-first',
  'welcome',
  'paywall',
  'create-account',
  'tracking-permission',
  'graduation',
]);
const BACK_DESTINATIONS: Partial<Record<OnboardingStepId, OnboardingStepId>> = {
  'voice-agent': 'dictation-email',
  tone: 'voice-agent',
  'privacy-mode': 'tone',
  language: 'privacy-mode',
  'private-download': 'language',
};

export function getOnboardingRoute(
  mode: ProcessingMode | null,
  affiliateSequence = false,
): OnboardingStepId[] {
  const order = affiliateSequence
    ? ([
        ...STEP_ORDER.filter(
          (step) =>
            !['graduation', 'paywall', 'create-account', 'tracking-permission'].includes(step),
        ),
        'graduation',
        'paywall',
        'create-account',
        'tracking-permission',
      ] as OnboardingStepId[])
    : STEP_ORDER;
  return order.filter((step) =>
    step === 'private-download'
      ? mode === 'private'
      : step !== 'paywall' || (affiliateSequence && mode === 'cloud'),
  );
}

// The optional download shares the language step's number so choosing Local doesn't grow the total.
const COUNTED_STEPS = STEP_ORDER.filter(
  (step) => !UNCOUNTED_STEPS.has(step) && step !== 'private-download',
);

export function getStepProgress(
  stepId: OnboardingStepId,
): { current: number; total: number } | undefined {
  const index = COUNTED_STEPS.indexOf(stepId === 'private-download' ? 'language' : stepId);
  return index < 0 ? undefined : { current: index + 1, total: COUNTED_STEPS.length };
}

const PAYWALL_NEXT_STEPS = ['language', 'notifications', 'create-account'] as const;
export type PaywallNextStep = (typeof PAYWALL_NEXT_STEPS)[number];

function isPaywallNextStep(step: string | undefined): step is PaywallNextStep {
  return (PAYWALL_NEXT_STEPS as readonly (string | undefined)[]).includes(step);
}

// Main ran privacy-mode → language → [private-download] → notifications → graduation → paywall →
// create-account → tracking-permission, and logged the tutorial and offered the paywall only after
// graduation. Installs that update partway resume on the new route still owed both.
const LEGACY_POST_CHOICE_STEPS: readonly OnboardingStepId[] = [
  'language',
  'private-download',
  'notifications',
  'graduation',
  'paywall',
  'create-account',
  'tracking-permission',
];

function resumeLegacyChoice(
  step: OnboardingStepId,
  mode: ProcessingMode,
): Pick<
  OnboardingStore,
  'currentStep' | 'paywallHandled' | 'paywallNextStep' | 'tutorialCompleted'
> {
  const tutorialCompleted =
    step === 'paywall' || step === 'create-account' || step === 'tracking-permission';
  const paywallHandled = tutorialCompleted && step !== 'paywall';
  const resume = step === 'graduation' || step === 'paywall' ? 'create-account' : step;
  if (mode === 'cloud' && !paywallHandled && isPaywallNextStep(resume)) {
    return { currentStep: 'paywall', paywallNextStep: resume, paywallHandled, tutorialCompleted };
  }
  return { currentStep: resume, paywallNextStep: 'language', paywallHandled, tutorialCompleted };
}

interface OnboardingStore {
  hydrated: boolean;
  finished: boolean;
  transitioning: boolean;
  currentStep: OnboardingStepId;
  selectedMode: ProcessingMode | null;
  paywallHandled: boolean;
  paywallNextStep: PaywallNextStep;
  tutorialCompleted: boolean;
  affiliateSequence: boolean;
  keyboardInstalled: boolean;
  trackingAuthorizationRequestAttempted: boolean;
  permissionsGranted: { microphone: boolean; notifications: boolean };
  hydrate: () => Promise<void>;
  goToStep: (step: OnboardingStepId) => Promise<void>;
  goNext: (from: OnboardingStepId) => Promise<void>;
  goBack: (from: OnboardingStepId) => Promise<void>;
  chooseMode: (mode: ProcessingMode, from: 'privacy-mode' | 'private-download') => Promise<void>;
  setKeyboardInstalled: (installed: boolean) => Promise<void>;
  markTrackingAuthorizationRequestAttempted: () => Promise<void>;
  setPermissionGranted: (
    key: keyof OnboardingProgress['permissionsGranted'],
    granted: boolean,
  ) => Promise<void>;
  finish: () => Promise<void>;
  reset: () => Promise<void>;
}

function snapshot(state: OnboardingStore): OnboardingProgress {
  return {
    version: ONBOARDING_VERSION,
    step: state.currentStep,
    selectedMode: state.selectedMode,
    paywallHandled: state.paywallHandled,
    paywallNextStep: state.paywallNextStep,
    tutorialCompleted: state.tutorialCompleted,
    affiliateSequence: state.affiliateSequence,
    keyboardInstalled: state.keyboardInstalled,
    permissionsGranted: state.permissionsGranted,
  };
}

let finishInFlight: Promise<void> | null = null;

export const useOnboardingStore = create<OnboardingStore>((set, get) => {
  const transition = async (
    from: OnboardingStepId,
    updates: Partial<OnboardingStore>,
  ): Promise<void> => {
    if (get().currentStep !== from || get().transitioning || get().finished) return;
    set({ transitioning: true });
    try {
      await OnboardingService.setProgress(snapshot({ ...get(), ...updates }));
      set(updates);
    } finally {
      set({ transitioning: false });
    }
  };

  return {
    hydrated: false,
    finished: false,
    transitioning: false,
    currentStep: FIRST_ONBOARDING_STEP,
    selectedMode: null,
    paywallHandled: false,
    paywallNextStep: 'language',
    tutorialCompleted: false,
    affiliateSequence: false,
    keyboardInstalled: false,
    trackingAuthorizationRequestAttempted: false,
    permissionsGranted: { microphone: false, notifications: false },

    hydrate: async () => {
      const [finished, trackingAuthorizationRequestAttempted] = await Promise.all([
        OnboardingService.isOnboardingComplete(),
        OnboardingService.hasAttemptedTrackingAuthorizationRequest(),
      ]);
      if (finished) {
        set({ hydrated: true, finished: true, trackingAuthorizationRequestAttempted });
        return;
      }
      const progress = await OnboardingService.getProgress();
      let step = STEP_ORDER.includes(progress.step as OnboardingStepId)
        ? (progress.step as OnboardingStepId)
        : FIRST_ONBOARDING_STEP;
      const legacy = (progress.version ?? 1) < 2;
      // Version 2 used this identifier for the combined agent/tone preview.
      if (progress.version === 2 && step === 'voice-agent') step = 'tone';
      const resumed = {
        hydrated: true,
        finished: false,
        currentStep: step,
        selectedMode: progress.selectedMode ?? null,
        paywallHandled: progress.paywallHandled === true,
        paywallNextStep: isPaywallNextStep(progress.paywallNextStep)
          ? progress.paywallNextStep
          : 'language',
        tutorialCompleted: progress.tutorialCompleted === true,
        // Pin the route once setup starts; enabling offers in an update must not
        // repeat an earlier paywall or move signup for an existing installation.
        affiliateSequence:
          progress.affiliateSequence ??
          (step === FIRST_ONBOARDING_STEP && Boolean(getAffiliateClientConfig())),
        keyboardInstalled: progress.keyboardInstalled,
        trackingAuthorizationRequestAttempted,
        permissionsGranted: progress.permissionsGranted,
      };
      if (legacy && LEGACY_POST_CHOICE_STEPS.includes(step)) {
        if (!useConfigStore.getState().config) await useConfigStore.getState().loadConfig();
        const mode =
          step === 'private-download'
            ? 'private'
            : (useConfigStore.getState().config?.defaultMode ?? 'cloud');
        set({ ...resumed, selectedMode: mode, ...resumeLegacyChoice(step, mode) });
        return;
      }
      set(resumed);
    },

    goToStep: async (step) => transition(get().currentStep, { currentStep: step }),

    goNext: async (from) => {
      const state = get();
      if (state.currentStep !== from || state.transitioning) return;
      if (from === 'tracking-permission' && state.affiliateSequence) {
        await get().finish();
        return;
      }
      const route = getOnboardingRoute(state.selectedMode, state.affiliateSequence);
      const next = from === 'paywall' ? state.paywallNextStep : route[route.indexOf(from) + 1];
      if (!next || (from === 'graduation' && !state.affiliateSequence)) return;
      // Legacy installs can resume past the tone preview, so leaving it or any later step counts.
      const completesTutorial =
        !state.tutorialCompleted && STEP_ORDER.indexOf(from) >= STEP_ORDER.indexOf('tone');
      await transition(from, {
        currentStep: next,
        paywallHandled: state.paywallHandled || from === 'paywall',
        paywallNextStep: state.affiliateSequence ? 'create-account' : state.paywallNextStep,
        tutorialCompleted: state.tutorialCompleted || completesTutorial,
      });
      if (completesTutorial) {
        logTutorialCompletion({
          keyboardInstalled: state.keyboardInstalled,
          microphonePermissionGranted: state.permissionsGranted.microphone,
        });
      }
    },

    goBack: async (from) => {
      const previous = BACK_DESTINATIONS[from];
      if (previous) await transition(from, { currentStep: previous });
    },

    chooseMode: async (mode, from) => {
      const next = from === 'private-download' ? 'notifications' : 'language';
      await transition(from, {
        selectedMode: mode,
        paywallNextStep: next,
        currentStep:
          mode === 'cloud' && !get().paywallHandled && !get().affiliateSequence ? 'paywall' : next,
      });
    },

    setKeyboardInstalled: async (installed) => {
      set({ keyboardInstalled: installed });
      await OnboardingService.setProgress(snapshot(get()));
    },
    markTrackingAuthorizationRequestAttempted: async () => {
      await OnboardingService.markTrackingAuthorizationRequestAttempted();
      set({ trackingAuthorizationRequestAttempted: true });
    },
    setPermissionGranted: async (key, granted) => {
      set((state) => ({ permissionsGranted: { ...state.permissionsGranted, [key]: granted } }));
      await OnboardingService.setProgress(snapshot(get()));
    },
    finish: () => {
      const finalStep = get().affiliateSequence ? 'tracking-permission' : 'graduation';
      if (get().finished || get().currentStep !== finalStep) return Promise.resolve();
      if (finishInFlight) return finishInFlight;
      finishInFlight = (async (): Promise<void> => {
        try {
          await OnboardingService.completeOnboarding();
          set({ finished: true });
        } finally {
          finishInFlight = null;
        }
      })();
      return finishInFlight;
    },
    reset: async () => {
      await OnboardingService.resetOnboarding();
      const attempted =
        get().trackingAuthorizationRequestAttempted ||
        (await OnboardingService.hasAttemptedTrackingAuthorizationRequest());
      set({
        finished: false,
        transitioning: false,
        currentStep: FIRST_ONBOARDING_STEP,
        selectedMode: null,
        paywallHandled: false,
        paywallNextStep: 'language',
        tutorialCompleted: false,
        affiliateSequence: Boolean(getAffiliateClientConfig()),
        keyboardInstalled: false,
        trackingAuthorizationRequestAttempted: attempted,
        permissionsGranted: { microphone: false, notifications: false },
      });
    },
  };
});
