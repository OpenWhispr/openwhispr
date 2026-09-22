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

export type OnboardingStepId =
  | 'get-started'
  | 'security-first'
  | 'welcome'
  | 'microphone'
  | 'keyboard-intro'
  | 'keyboard-switch'
  | 'dictation-email'
  | 'voice-agent'
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
  'privacy-mode': 'voice-agent',
  language: 'privacy-mode',
  'private-download': 'language',
};

export function getOnboardingRoute(mode: ProcessingMode | null): OnboardingStepId[] {
  return STEP_ORDER.filter((step) =>
    step === 'private-download' ? mode === 'private' : step !== 'paywall',
  );
}

export function getStepProgress(
  stepId: OnboardingStepId,
  mode: ProcessingMode | null = null,
): { current: number; total: number } | undefined {
  const steps = getOnboardingRoute(mode).filter((step) => !UNCOUNTED_STEPS.has(step));
  const index = steps.indexOf(stepId);
  return index < 0 ? undefined : { current: index + 1, total: steps.length };
}

interface OnboardingStore {
  hydrated: boolean;
  finished: boolean;
  transitioning: boolean;
  currentStep: OnboardingStepId;
  selectedMode: ProcessingMode | null;
  paywallHandled: boolean;
  paywallNextStep: 'language' | 'notifications';
  tutorialCompleted: boolean;
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
      const legacy = progress.version !== ONBOARDING_VERSION;
      const pastChoice =
        legacy &&
        [
          'language',
          'private-download',
          'notifications',
          'graduation',
          'paywall',
          'create-account',
          'tracking-permission',
        ].includes(step);
      if (legacy && (step === 'graduation' || step === 'paywall')) step = 'create-account';
      if (pastChoice && !useConfigStore.getState().config)
        await useConfigStore.getState().loadConfig();
      set({
        hydrated: true,
        finished: false,
        currentStep: step,
        selectedMode: pastChoice
          ? progress.step === 'private-download'
            ? 'private'
            : (useConfigStore.getState().config?.defaultMode ?? 'cloud')
          : (progress.selectedMode ?? null),
        paywallHandled: pastChoice || progress.paywallHandled === true,
        paywallNextStep:
          progress.paywallNextStep === 'notifications' ? 'notifications' : 'language',
        tutorialCompleted: pastChoice || progress.tutorialCompleted === true,
        keyboardInstalled: progress.keyboardInstalled,
        trackingAuthorizationRequestAttempted,
        permissionsGranted: progress.permissionsGranted,
      });
    },

    goToStep: async (step) => transition(get().currentStep, { currentStep: step }),

    goNext: async (from) => {
      const state = get();
      if (state.currentStep !== from || state.transitioning) return;
      const route = getOnboardingRoute(state.selectedMode);
      const next = from === 'paywall' ? state.paywallNextStep : route[route.indexOf(from) + 1];
      if (!next || from === 'graduation') return;
      const completesTutorial = from === 'voice-agent' && !state.tutorialCompleted;
      await transition(from, {
        currentStep: next,
        paywallHandled: state.paywallHandled || from === 'paywall',
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
        currentStep: mode === 'cloud' && !get().paywallHandled ? 'paywall' : next,
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
      if (get().finished || get().currentStep !== 'graduation') return Promise.resolve();
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
        keyboardInstalled: false,
        trackingAuthorizationRequestAttempted: attempted,
        permissionsGranted: { microphone: false, notifications: false },
      });
    },
  };
});
