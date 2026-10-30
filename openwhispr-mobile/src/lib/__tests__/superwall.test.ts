import type { UsageInfo } from '@/data/remote/usageApi';
import { getAffiliateClientConfig } from '@/lib/affiliateLink';
import {
  CREATOR_CODE_PAYWALL_PLACEMENT,
  SUPERWALL_APP_ENTITLEMENT_ID,
  SUPERWALL_PLACEMENTS,
  SUPERWALL_WORDS_REMAINING_SENTINEL,
  buildSuperwallAttributes,
  buildSuperwallSubscriptionStatus,
  buildUsageGateParams,
  isTransactionalSuperwallPlacement,
  resolveSuperwallPlacementName,
} from '@/lib/superwall';

jest.mock('@/lib/affiliateLink', () => ({ getAffiliateClientConfig: jest.fn(() => null) }));

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

describe('creator-code paywall placement', () => {
  afterEach(() => jest.mocked(getAffiliateClientConfig).mockReturnValue(null));

  it('keeps every placement unchanged in a build without creator codes', () => {
    for (const placement of Object.values(SUPERWALL_PLACEMENTS)) {
      expect(resolveSuperwallPlacementName(placement, false)).toBe(placement);
      expect(resolveSuperwallPlacementName(placement, true)).toBe(placement);
    }
  });

  it('sends onboarding and creator offers to the creator-code paywall when creator codes are on', () => {
    jest
      .mocked(getAffiliateClientConfig)
      .mockReturnValue({ domain: 'sandbox.dub.link', publishableKey: 'dub_pk_test' });
    expect(resolveSuperwallPlacementName(SUPERWALL_PLACEMENTS.onboardingPaywall, false)).toBe(
      CREATOR_CODE_PAYWALL_PLACEMENT,
    );
    expect(resolveSuperwallPlacementName(SUPERWALL_PLACEMENTS.accountBillingOpen, true)).toBe(
      CREATOR_CODE_PAYWALL_PLACEMENT,
    );
    expect(resolveSuperwallPlacementName(SUPERWALL_PLACEMENTS.accountBillingOpen, false)).toBe(
      SUPERWALL_PLACEMENTS.accountBillingOpen,
    );
    expect(resolveSuperwallPlacementName(SUPERWALL_PLACEMENTS.cloudUsageLimitReached, false)).toBe(
      SUPERWALL_PLACEMENTS.cloudUsageLimitReached,
    );
  });
});
