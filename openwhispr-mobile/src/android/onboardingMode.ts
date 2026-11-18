import { canRunLocalReasoning, getLocalReasoningReadiness } from '@/lib/localReasoning';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import type { OnboardingModePolicy } from '../lib/onboardingModeCore';

export const androidOnboardingModePolicy: OnboardingModePolicy = {
  getLocalReadiness: () => getLocalReasoningReadiness(),
  configForMode: (config, next, mode, readiness) => {
    const saved = config?.inference?.cleanup;
    if (
      mode === 'private' &&
      (!saved || saved.mode === 'openwhispr') &&
      canRunLocalReasoning(readiness)
    ) {
      next.inference = { ...next.inference, cleanup: { mode: 'local' } };
    } else if (
      mode === 'cloud' &&
      useOnboardingStore.getState().selectedMode === 'private' &&
      saved?.mode === 'local' &&
      Object.keys(saved).length === 1
    ) {
      // Drop only the plain cleanup choice saved by Android setup when that setup returns to Cloud.
      next.inference = { ...next.inference };
      delete next.inference.cleanup;
    }
    return next;
  },
};
