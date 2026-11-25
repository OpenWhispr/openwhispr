import type { UsageInfo } from '@/data/remote/usageApi';
import type { BillingStatus } from '../billing';

/**
 * Which Plan & billing screen to show (Figma "Android · Upgrade & billing", sections 2 and 3).
 * Letters are the design's: A free … L restore found nothing (a toast on A, not a state).
 */
export type PlanView =
  | { kind: 'signed-out' } // J
  | { kind: 'session-rejected' } // J, with the cached plan hidden
  | { kind: 'loading' }
  | { kind: 'load-failed' }
  | { kind: 'confirming' } // B3 Unlocking Pro
  | { kind: 'on-its-way' } // B3b paid, not unlocked after ~30 s
  | { kind: 'payment-pending' } // B4
  | { kind: 'free'; outOfWords: boolean } // A, B
  | { kind: 'pro-play'; periodEnd: string | null; interval: UsageInfo['billingInterval'] } // C
  | { kind: 'pro-play-cancelled'; periodEnd: string | null } // D
  | { kind: 'pro-play-problem' } // E
  | { kind: 'pro-web'; periodEnd: string | null } // G
  | { kind: 'business-workspace' } // H
  | { kind: 'pro-app-store' } // I
  | { kind: 'pro-other'; plan: string; trialEnd: string | null }; // a trial or a comped plan

/** How long "Unlocking Pro" waits before it says Pro is taking longer (B3 → B3b). */
export const CONFIRMING_MS = 30_000;

export interface PlanInput {
  signedIn: boolean;
  sessionRejected: boolean;
  usage: UsageInfo | null;
  loadFailed: boolean;
  billingStatus: BillingStatus | undefined;
  /** When this run of the app saw the purchase start waiting for access. */
  waitingSince: number | undefined;
  now: number;
}

export function planView(input: PlanInput): PlanView {
  const { usage, billingStatus } = input;
  if (!input.signedIn) return { kind: 'signed-out' };
  if (input.sessionRejected) return { kind: 'session-rejected' };
  if (!usage) return { kind: input.loadFailed ? 'load-failed' : 'loading' };
  if (usage.isSubscribed) return subscribedView(usage);
  if (billingStatus === 'payment-pending') return { kind: 'payment-pending' };
  if (billingStatus === 'checking' || billingStatus === 'access-pending') {
    const fresh =
      input.waitingSince !== undefined && input.now - input.waitingSince < CONFIRMING_MS;
    return { kind: fresh ? 'confirming' : 'on-its-way' };
  }
  return { kind: 'free', outOfWords: usage.limit > 0 && usage.wordsRemaining <= 0 };
}

function subscribedView(usage: UsageInfo): PlanView {
  const sources = usage.entitlementSources;
  if (sources?.provider && sources.providerStore === 'play_store') {
    if (usage.status === 'canceled')
      return { kind: 'pro-play-cancelled', periodEnd: usage.currentPeriodEnd };
    if (usage.status === 'past_due') return { kind: 'pro-play-problem' };
    return { kind: 'pro-play', periodEnd: usage.currentPeriodEnd, interval: usage.billingInterval };
  }
  if (sources?.provider && sources.providerStore === 'app_store') return { kind: 'pro-app-store' };
  if (sources?.personal && !usage.isTrial)
    return { kind: 'pro-web', periodEnd: usage.currentPeriodEnd };
  if (sources?.workspaceIds.length && !sources.personal && !sources.provider)
    return { kind: 'business-workspace' };
  return {
    kind: 'pro-other',
    plan: usage.plan,
    trialEnd: usage.isTrial ? usage.currentPeriodEnd : null,
  };
}

/** Whether a free account has under 10% of its weekly cloud words left (Home's E1 card). */
export function isLowOnWords(usage: UsageInfo | null | undefined): boolean {
  if (!usage || usage.isSubscribed || usage.limit <= 0) return false;
  return usage.wordsRemaining < usage.limit * 0.1;
}

/** "24 Nov 2027" (or "24 Dec" when `short`) in the app's language. */
export function formatPlanDate(iso: string, locale: string, short = false): string | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(short ? {} : { year: 'numeric' }),
  }).format(new Date(time));
}
