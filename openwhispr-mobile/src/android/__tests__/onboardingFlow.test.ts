import {
  clearProgress,
  nextStep,
  previousStep,
  saveProgress,
  savedMode,
  savedStep,
  stepsFor,
} from '../onboarding/flow';

const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  },
});

describe('Android onboarding flow', () => {
  beforeEach(() => store.clear());

  it('runs sign-in, the practices and permissions before the Cloud or On device choice', () => {
    const steps = stepsFor('cloud');
    expect(steps.slice(0, 7)).toEqual([
      'splash',
      'signin',
      'pitch',
      'how',
      'practiceDictate',
      'practiceAssistant',
      'practiceEdit',
    ]);
    expect(steps.indexOf('notifications')).toBeLessThan(steps.indexOf('mode'));
    expect(steps.indexOf('accessibility')).toBeGreaterThan(steps.indexOf('overlay'));
  });

  it('sends Cloud straight to ready and Private through its downloads', () => {
    expect(nextStep('mode', 'cloud')).toBe('ready');
    expect(nextStep('mode', 'private')).toBe('privateSetup');
    expect(nextStep('privateSetup', 'private')).toBe('privateReady');
    expect(nextStep('privateReady', 'private')).toBe('ready');
    expect(nextStep('ready', 'cloud')).toBeNull();
    expect(stepsFor('cloud')).not.toContain('privateSetup');
  });

  it('walks back one step and stops at the splash', () => {
    expect(previousStep('pitch', 'cloud')).toBe('signin');
    expect(previousStep('ready', 'private')).toBe('privateReady');
    expect(previousStep('splash', 'cloud')).toBeNull();
  });

  it('resumes where it left off and forgets progress when finished', () => {
    saveProgress('battery', 'private');
    expect(savedStep()).toBe('battery');
    expect(savedMode()).toBe('private');
    clearProgress();
    expect(savedStep()).toBe('splash');
    expect(savedMode()).toBe('cloud');
  });

  it('resumes a practice saved under its v3 name', () => {
    localStorage.setItem('android-onboarding-v3-step', 'practiceEmail');
    expect(savedStep()).toBe('practiceAssistant');
    localStorage.setItem('android-onboarding-v3-step', 'practiceList');
    expect(savedStep()).toBe('practiceEdit');
  });

  it('ignores a step saved by an older build', () => {
    localStorage.setItem('android-onboarding-v3-step', 'pro');
    expect(savedStep()).toBe('splash');
  });
});
