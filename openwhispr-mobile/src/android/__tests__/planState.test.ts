import type { UsageInfo } from '@/android/remote/usageApi';
import {
  CONFIRMING_MS,
  formatPlanDate,
  isLowOnWords,
  planView,
  type PlanInput,
} from '../plan/planState';
import { pricesFromProducts } from '../plan/prices';

jest.mock('react-native-purchases', () => ({}));

const free = (change: Partial<UsageInfo> = {}) =>
  ({
    billingUserId: 'b',
    isSubscribed: false,
    wordsUsed: 73,
    wordsRemaining: 1927,
    limit: 2000,
    plan: 'free',
    status: 'active',
    isTrial: false,
    trialDaysLeft: null,
    currentPeriodEnd: null,
    billingInterval: null,
    resetAt: 'rolling',
    entitlementSources: { personal: false, provider: false, workspaceIds: [] },
    ...change,
  }) as UsageInfo;
const input = (change: Partial<PlanInput> = {}): PlanInput => ({
  signedIn: true,
  sessionRejected: false,
  usage: free(),
  loadFailed: false,
  billingStatus: undefined,
  waitingSince: undefined,
  now: 100_000,
  ...change,
});

it('reads a free plan, and one out of words', () => {
  expect(planView(input())).toEqual({ kind: 'free', outOfWords: false });
  expect(planView(input({ usage: free({ wordsRemaining: 0, wordsUsed: 2000 }) }))).toEqual({
    kind: 'free',
    outOfWords: true,
  });
});

it('waits 30 s on Unlocking Pro, then says it is taking longer', () => {
  const waiting = { billingStatus: 'access-pending' as const, waitingSince: 100_000 };
  expect(planView(input({ ...waiting, now: 100_000 + CONFIRMING_MS - 1 })).kind).toBe('confirming');
  expect(planView(input({ ...waiting, now: 100_000 + CONFIRMING_MS })).kind).toBe('on-its-way');
  expect(planView(input({ billingStatus: 'checking' })).kind).toBe('on-its-way');
  expect(planView(input({ billingStatus: 'payment-pending' })).kind).toBe('payment-pending');
});

it('shows server-confirmed access over a stale purchase wait', () => {
  const pro = free({
    isSubscribed: true,
    status: 'canceled',
    currentPeriodEnd: '2026-12-24T00:00:00Z',
    entitlementSources: {
      personal: false,
      provider: true,
      providerStore: 'play_store',
      workspaceIds: [],
    },
  });
  expect(planView(input({ usage: pro, billingStatus: 'access-pending' }))).toEqual({
    kind: 'pro-play-cancelled',
    periodEnd: '2026-12-24T00:00:00Z',
  });
});

it('never treats a trial as billed on the web', () => {
  const trial = free({
    isSubscribed: true,
    isTrial: true,
    plan: 'pro',
    currentPeriodEnd: '2026-12-01T00:00:00Z',
    entitlementSources: { personal: true, provider: false, workspaceIds: [] },
  });
  expect(planView(input({ usage: trial }))).toEqual({
    kind: 'pro-other',
    plan: 'pro',
    trialEnd: '2026-12-01T00:00:00Z',
  });
});

it('puts the Home meter up under 10% left, for free accounts only', () => {
  expect(isLowOnWords(free({ wordsRemaining: 201 }))).toBe(false);
  expect(isLowOnWords(free({ wordsRemaining: 199 }))).toBe(true);
  expect(isLowOnWords(free({ isSubscribed: true, limit: -1, wordsRemaining: -1 }))).toBe(false);
  expect(isLowOnWords(null)).toBe(false);
});

it('formats no date from a bad value', () => {
  expect(formatPlanDate('not a date', 'en')).toBeNull();
});

it('reads the Play prices for each base plan', () => {
  const products = [
    {
      identifier: 'com.openwhispr.pro:annual',
      subscriptionPeriod: 'P1Y',
      priceString: '$80.00',
      pricePerMonthString: '$6.67',
    },
    {
      identifier: 'com.openwhispr.pro:monthly',
      subscriptionPeriod: 'P1M',
      priceString: '$8.00',
      pricePerMonthString: '$8.00',
    },
  ] as never;
  expect(pricesFromProducts(products)).toEqual({
    annual: '$80.00',
    annualPerMonth: '$6.67',
    monthly: '$8.00',
  });
  expect(pricesFromProducts([])).toEqual({ annual: null, annualPerMonth: null, monthly: null });
});
