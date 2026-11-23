export type OnboardingMode = 'cloud' | 'private';

export type OnboardingStep =
  | 'splash'
  | 'signin'
  | 'pitch'
  | 'how'
  | 'practiceDictate'
  | 'practiceAssistant'
  | 'practiceEdit'
  | 'languages'
  | 'apps'
  | 'overlay'
  | 'accessibility'
  | 'battery'
  | 'notifications'
  | 'mode'
  | 'privateSetup'
  | 'privateReady'
  | 'ready';

const SHARED: OnboardingStep[] = [
  'splash',
  'signin',
  'pitch',
  'how',
  'practiceDictate',
  'practiceAssistant',
  'practiceEdit',
  'languages',
  'apps',
  'overlay',
  'accessibility',
  'battery',
  'notifications',
  'mode',
];

// An account that already finished onboarding on Android (a new phone or a reinstall) skips the
// pitch, How it works and the practices and starts at Languages (decision F2).
const TOUR: OnboardingStep[] = [
  'pitch',
  'how',
  'practiceDictate',
  'practiceAssistant',
  'practiceEdit',
];

// Private downloads its models first; Cloud's Done opens the Pro offer, which is not a step.
export function stepsFor(mode: OnboardingMode, returning = false): OnboardingStep[] {
  const shared = returning ? SHARED.filter((step) => !TOUR.includes(step)) : SHARED;
  return mode === 'private'
    ? [...shared, 'privateSetup', 'privateReady', 'ready']
    : [...shared, 'ready'];
}

export function nextStep(
  step: OnboardingStep,
  mode: OnboardingMode,
  returning = false,
): OnboardingStep | null {
  const steps = stepsFor(mode, returning);
  const index = steps.indexOf(step);
  return index < 0 || index === steps.length - 1 ? null : steps[index + 1];
}

export function previousStep(
  step: OnboardingStep,
  mode: OnboardingMode,
  returning = false,
): OnboardingStep | null {
  const steps = stepsFor(mode, returning);
  const index = steps.indexOf(step);
  return index <= 0 ? null : steps[index - 1];
}

const STEP_KEY = 'android-onboarding-v3-step';
const MODE_KEY = 'android-onboarding-v3-mode';
const RETURNING_KEY = 'android-onboarding-v3-returning';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Steps saved by the v3 build, before the practices became dictate, assistant and edit.
const RENAMED: Record<string, OnboardingStep> = {
  practiceMessage: 'practiceDictate',
  practiceEmail: 'practiceAssistant',
  practiceList: 'practiceEdit',
};

export function savedStep(): OnboardingStep {
  const stored = read(STEP_KEY);
  const saved = (stored && (RENAMED[stored] ?? stored)) as OnboardingStep | null;
  return saved && [...stepsFor('cloud'), ...stepsFor('private')].includes(saved) ? saved : 'splash';
}

export function savedMode(): OnboardingMode {
  return read(MODE_KEY) === 'private' ? 'private' : 'cloud';
}

export function savedReturning(): boolean {
  return read(RETURNING_KEY) === 'true';
}

export function saveProgress(step: OnboardingStep, mode: OnboardingMode, returning = false): void {
  try {
    localStorage.setItem(STEP_KEY, step);
    localStorage.setItem(MODE_KEY, mode);
    localStorage.setItem(RETURNING_KEY, String(returning));
  } catch {
    /* Progress is a convenience; a lost write only replays a screen. */
  }
}

export function clearProgress(): void {
  try {
    localStorage.removeItem(STEP_KEY);
    localStorage.removeItem(MODE_KEY);
    localStorage.removeItem(RETURNING_KEY);
    localStorage.removeItem('android-onboarding-step');
  } catch {
    /* Nothing to clear. */
  }
}
