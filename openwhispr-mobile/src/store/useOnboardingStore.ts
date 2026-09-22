import { create } from 'zustand';
import {
  FIRST_ONBOARDING_STEP,
  OnboardingService,
  type OnboardingProgress,
} from '@/utils/onboarding';
import { logTutorialCompletion } from '@/lib/appsflyer';

export type OnboardingStepId =
  | 'get-started'
  | 'security-first'
  | 'welcome'
  | 'microphone'
  | 'keyboard-intro'
  | 'keyboard-switch'
  | 'dictation-email'
  | 'privacy-mode'
  | 'language'
  | 'private-download'
  | 'notifications'
  | 'graduation'
  | 'paywall'
  | 'create-account'
  | 'tracking-permission';

// Language comes BEFORE the model download so the download step can pick the right
// on-device model (Parakeet v2/v3 vs Whisper) from the user's language selection.
//
// The closing sequence is deliberate: the user experiences the whole product
// first, then sees the paywall and account screen. Tracking permission is the
// final optional system decision before onboarding is persisted.
export const STEP_ORDER: readonly OnboardingStepId[] = [
  'get-started',
  'security-first',
  'welcome',
  'microphone',
  'keyboard-intro',
  'keyboard-switch',
  'dictation-email',
  'privacy-mode',
  'language',
  'private-download',
  'notifications',
  'graduation',
  'paywall',
  'create-account',
  'tracking-permission',
] as const;

// The "Step N of M" counter covers the teaching steps only. The intro screens
// and the closing sequence (graduation → paywall → account → tracking) stay
// uncounted, so the range is pinned to named endpoints rather than offsets.
const MIDDLE_STEPS = STEP_ORDER.slice(
  STEP_ORDER.indexOf('welcome'),
  STEP_ORDER.indexOf('graduation'),
);

export function getStepProgress(stepId: OnboardingStepId): { current: number; total: number } {
  const idx = MIDDLE_STEPS.indexOf(stepId);
  return { current: Math.max(idx + 1, 1), total: MIDDLE_STEPS.length };
}

interface OnboardingStore {
  hydrated: boolean;
  finished: boolean;
  currentStep: OnboardingStepId;
  keyboardInstalled: boolean;
  trackingAuthorizationRequestAttempted: boolean;
  permissionsGranted: {
    microphone: boolean;
    notifications: boolean;
  };

  hydrate: () => Promise<void>;
  goToStep: (step: OnboardingStepId) => Promise<void>;
  goNext: () => Promise<void>;
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
    step: state.currentStep,
    keyboardInstalled: state.keyboardInstalled,
    permissionsGranted: state.permissionsGranted,
  };
}

let finishInFlight: Promise<void> | null = null;

export const useOnboardingStore = create<OnboardingStore>((set, get) => ({
  hydrated: false,
  finished: false,
  currentStep: FIRST_ONBOARDING_STEP,
  keyboardInstalled: false,
  trackingAuthorizationRequestAttempted: false,
  permissionsGranted: {
    microphone: false,
    notifications: false,
  },

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
    const step = (STEP_ORDER as readonly string[]).includes(progress.step)
      ? (progress.step as OnboardingStepId)
      : FIRST_ONBOARDING_STEP;
    set({
      hydrated: true,
      finished: false,
      currentStep: step,
      keyboardInstalled: progress.keyboardInstalled,
      trackingAuthorizationRequestAttempted,
      permissionsGranted: progress.permissionsGranted,
    });
  },

  goToStep: async (step) => {
    set({ currentStep: step });
    await OnboardingService.setProgress(snapshot(get()));
  },

  goNext: async () => {
    const { currentStep, keyboardInstalled, permissionsGranted } = get();
    const idx = STEP_ORDER.indexOf(currentStep);
    if (idx === -1 || idx === STEP_ORDER.length - 1) return;
    const next = STEP_ORDER[idx + 1];
    set({ currentStep: next });
    await OnboardingService.setProgress(snapshot(get()));
    // The tutorial ends at graduation. The paywall and account steps after it
    // are a different funnel, so the AppsFlyer milestone fires here rather
    // than on finish() — otherwise everyone who drops at the paywall or the
    // account screen would read as never having finished the tutorial.
    if (currentStep === 'graduation') {
      logTutorialCompletion({
        keyboardInstalled,
        microphonePermissionGranted: permissionsGranted.microphone,
      });
    }
  },

  setKeyboardInstalled: async (installed) => {
    set({ keyboardInstalled: installed });
    await OnboardingService.setProgress(snapshot(get()));
  },

  markTrackingAuthorizationRequestAttempted: async () => {
    set({ trackingAuthorizationRequestAttempted: true });
    await OnboardingService.markTrackingAuthorizationRequestAttempted();
  },

  setPermissionGranted: async (key, granted) => {
    set((state) => ({
      permissionsGranted: { ...state.permissionsGranted, [key]: granted },
    }));
    await OnboardingService.setProgress(snapshot(get()));
  },

  finish: () => {
    if (get().finished) return Promise.resolve();
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
    const trackingAuthorizationRequestAttempted =
      get().trackingAuthorizationRequestAttempted ||
      (await OnboardingService.hasAttemptedTrackingAuthorizationRequest());
    set({
      finished: false,
      currentStep: FIRST_ONBOARDING_STEP,
      keyboardInstalled: false,
      trackingAuthorizationRequestAttempted,
      permissionsGranted: {
        microphone: false,
        notifications: false,
      },
    });
  },
}));
