import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import { useHandoffStore } from '@/store/useHandoffStore';
import { isRecoveryDeepLinkFresh, isRecoveryHolding } from '@/store/useKeyboardRecoveryStore';
import { useUsageStore } from '@/store/useUsageStore';

export interface ResumeDecision {
  /** Reset the stack to Home — the default for a warm resume. */
  readonly resetToHome: boolean;
  /** Force-refresh `/api/usage`: the user just came back from the external billing portal. */
  readonly refreshUsage: boolean;
}

const STAY: ResumeDecision = { resetToHome: false, refreshUsage: false };

/**
 * Decides what a background→foreground resume should do. Extracted from
 * app/_layout.tsx so the guard list is unit-testable without mounting the root
 * layout (which runs migrations, Sentry, and font loading at import time).
 *
 * Each guard covers a flow that owns its own navigation and would be broken by
 * being bounced to Home mid-way.
 */
export function resolveResumeAction(alreadyOnHome: boolean): ResumeDecision {
  const handoff = useHandoffStore.getState();
  if (handoff.isActive || handoff.isCheckingInitialUrl) return STAY;

  // The Full Access recovery screen sends the user to Settings and must be the
  // thing they come back to — bouncing them Home would drop them out of the flow
  // one tap before it completes. Time-bounded: a screen left open and abandoned
  // must not switch off the Home reset for the rest of the session.
  if (isRecoveryHolding()) return STAY;

  // And the window before it has mounted: the deep link arrives ahead of
  // `didBecomeActive`, but the screen's flag is raised in a passive effect, so
  // this handler can otherwise replace the screen with Home before it is seen.
  if (isRecoveryDeepLinkFresh()) return STAY;

  if (useGoogleCalendarStore.getState().isAuthSessionActive) return STAY;

  // Returning from the external billing portal: stay on Account and refresh
  // the entitlement after any subscription-management change.
  if (useUsageStore.getState().isBillingSessionActive) {
    return { resetToHome: false, refreshUsage: true };
  }

  // Already on Home → skip the redundant replace that would slide Home over itself.
  return { resetToHome: !alreadyOnHome, refreshUsage: false };
}
