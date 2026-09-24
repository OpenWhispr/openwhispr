import type { UsageInfo } from '@/data/remote/usageApi';
import {
  SUPERWALL_APP_ENTITLEMENT_ID,
  SUPERWALL_PLACEMENTS,
  SUPERWALL_WORDS_REMAINING_SENTINEL,
  buildSuperwallAttributes,
  buildSuperwallSubscriptionStatus,
  buildUsageGateParams,
  isTransactionalSuperwallPlacement,
} from '@/lib/superwall';

const baseUsage: UsageInfo = {
  billingUserId: '00000000-0000-4000-8000-000000000001',
  wordsUsed: 750,
  wordsRemaining: 250,
  limit: 1000,
  plan: 'free',
  status: 'active',
  isSubscribed: false,
  isTrial: false,
  trialDaysLeft: null,
  currentPeriodEnd: null,
  billingInterval: null,
  resetAt: '2026-06-30T00:00:00.000Z',
};

describe('superwall billing bridge mapping', () => {
  it('maps free backend usage to an inactive Superwall subscription status', () => {
    expect(buildSuperwallSubscriptionStatus(baseUsage)).toEqual({ status: 'INACTIVE' });
  });

  it('maps paid backend usage to the app entitlement', () => {
    expect(
      buildSuperwallSubscriptionStatus({
        ...baseUsage,
        plan: 'business',
        isSubscribed: true,
      }),
    ).toEqual({
      status: 'ACTIVE',
      entitlements: [{ id: SUPERWALL_APP_ENTITLEMENT_ID, type: 'SERVICE_LEVEL' }],
    });
  });

  it('builds non-PII user attributes from usage and client state', () => {
    expect(
      buildSuperwallAttributes({
        usage: baseUsage,
        activeMode: 'private',
        appInfo: { appEnvironment: 'development', appVersion: '1.1.0' },
      }),
    ).toEqual({
      plan: 'free',
      status: 'active',
      isSubscribed: false,
      isTrial: false,
      trialDaysLeft: 0,
      wordsUsed: 750,
      wordsRemaining: 250,
      activeMode: 'private',
      appEnvironment: 'development',
      appVersion: '1.1.0',
    });
  });

  it('normalizes subscribed users away from backend -1 remaining words', () => {
    const attributes = buildSuperwallAttributes({
      usage: {
        ...baseUsage,
        plan: 'pro',
        isSubscribed: true,
        wordsRemaining: -1,
      },
      activeMode: 'cloud',
      appInfo: { appEnvironment: 'production', appVersion: '1.1.0' },
    });

    expect(attributes.wordsRemaining).toBe(SUPERWALL_WORDS_REMAINING_SENTINEL);
  });

  it('classifies purchase-capable placements as transactional', () => {
    expect(isTransactionalSuperwallPlacement(SUPERWALL_PLACEMENTS.accountBillingOpen)).toBe(true);
    expect(isTransactionalSuperwallPlacement(SUPERWALL_PLACEMENTS.cloudUsageLimitReached)).toBe(
      true,
    );
    expect(isTransactionalSuperwallPlacement(SUPERWALL_PLACEMENTS.aiActionRun)).toBe(false);
  });

  it('snapshots gate params from usage with remaining words clamped to zero', () => {
    expect(buildUsageGateParams({ ...baseUsage, wordsRemaining: -1 })).toEqual({
      wordsUsed: 750,
      wordsRemaining: 0,
      limit: 1000,
      plan: 'free',
      isSubscribed: false,
    });
  });
});
