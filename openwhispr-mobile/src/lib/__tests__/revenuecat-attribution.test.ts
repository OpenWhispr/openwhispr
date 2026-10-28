import { Platform } from 'react-native';
import Purchases from 'react-native-purchases';
import type { AppsFlyerAttributionConsent } from '@/lib/appsflyer';

let mockAttributionListener: (() => void) | undefined;
let mockConsent: AppsFlyerAttributionConsent = 'granted';
let mockSdkUser = '$RCAnonymousID:device';
const mockGetRevenueId = jest.fn<Promise<string | null>, []>(() => Promise.resolve('af-device'));
jest.mock('@/lib/appsflyer', () => ({
  getAppsFlyerRevenueId: () => mockGetRevenueId(),
  getAppsFlyerAttributionConsent: () => mockConsent,
  subscribeAppsFlyerAttribution: (listener: () => void) => {
    mockAttributionListener = listener;
    return () => {};
  },
}));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    configure: jest.fn(),
    setLogLevel: jest.fn(),
    getAppUserID: jest.fn(),
    isAnonymous: jest.fn(),
    logIn: jest.fn(),
    logOut: jest.fn(),
    collectDeviceIdentifiers: jest.fn(),
    setAppsflyerID: jest.fn(),
    syncAttributesAndOfferingsIfNeeded: jest.fn(),
    recordPurchase: jest.fn(),
    syncPurchasesForResult: jest.fn(),
  },
  LOG_LEVEL: { INFO: 'INFO' },
  PURCHASES_ARE_COMPLETED_BY_TYPE: { MY_APP: 'MY_APP' },
  STOREKIT_VERSION: { STOREKIT_2: 'STOREKIT_2' },
}));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let rc: typeof import('../revenuecat');
let sdk: jest.Mocked<typeof Purchases>;

function idsSet(): (string | null)[] {
  return sdk.setAppsflyerID.mock.calls.map(([id]) => id);
}

function lastOrder(mock: { mock: { invocationCallOrder: number[] } }): number {
  return mock.mock.invocationCallOrder.at(-1)!;
}

beforeEach(() => {
  jest.resetModules();
  process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = 'appl_test';
  process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY = 'goog_test';
  mockConsent = 'granted';
  mockSdkUser = '$RCAnonymousID:device';
  mockAttributionListener = undefined;
  mockGetRevenueId.mockReset().mockResolvedValue('af-device');
  sdk = require('react-native-purchases').default;
  sdk.getAppUserID.mockImplementation(async () => mockSdkUser);
  sdk.isAnonymous.mockImplementation(async () => mockSdkUser.startsWith('$RCAnonymousID'));
  sdk.logIn.mockImplementation(async (userId: string) => {
    mockSdkUser = userId;
    return {} as never;
  });
  sdk.logOut.mockImplementation(async () => {
    mockSdkUser = '$RCAnonymousID:next';
    return {} as never;
  });
  rc = require('../revenuecat');
});

it('turns off automatic device identifier collection', () => {
  rc.configureRevenueCat();
  expect(sdk.configure).toHaveBeenCalledWith(
    expect.objectContaining({ automaticDeviceIdentifierCollectionEnabled: false }),
  );
});

it('links the consented billing identity before recording the purchase', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(idsSet().at(-1)).toBe('af-device');
  expect(lastOrder(sdk.collectDeviceIdentifiers)).toBeLessThan(lastOrder(sdk.setAppsflyerID));
  expect(sdk.logIn.mock.invocationCallOrder[0]).toBeLessThan(lastOrder(sdk.setAppsflyerID));
  expect(lastOrder(sdk.setAppsflyerID)).toBeLessThan(
    sdk.recordPurchase.mock.invocationCallOrder[0],
  );
  // The receipt post carries the attribute; no extra network round trip first.
  expect(sdk.syncAttributesAndOfferingsIfNeeded).not.toHaveBeenCalled();
});

it('never collects device identifiers or links an opted-out user', async () => {
  mockConsent = 'revoked';
  rc.configureRevenueCat();
  await flush();
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(sdk.collectDeviceIdentifiers).not.toHaveBeenCalled();
  expect(idsSet()).not.toContain('af-device');
  expect(mockGetRevenueId).not.toHaveBeenCalled();
  // Nothing was linked, so there is nothing to withdraw on the server.
  expect(sdk.syncAttributesAndOfferingsIfNeeded).not.toHaveBeenCalled();
});

it('clears the link and pushes it when consent is withdrawn', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  mockConsent = 'revoked';
  mockAttributionListener?.();
  await flush();
  expect(idsSet().at(-1)).toBeNull();
  expect(sdk.syncAttributesAndOfferingsIfNeeded).toHaveBeenCalledTimes(1);
});

it('keeps the link through a foreground ATT re-check', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  mockConsent = 'pending';
  mockGetRevenueId.mockResolvedValue(null);
  mockAttributionListener?.();
  await flush();
  mockConsent = 'granted';
  mockAttributionListener?.();
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(idsSet()).toEqual(['af-device']);
  expect(sdk.syncAttributesAndOfferingsIfNeeded).not.toHaveBeenCalled();
});

it('does not clear a restored user on launch', async () => {
  mockSdkUser = 'billing-a';
  rc.configureRevenueCat();
  await flush();
  await rc.identifyRevenueCatUser('billing-a');
  expect(idsSet()).toEqual(['af-device']);
});

it('waits for a started session instead of clearing when the ID is unreadable', async () => {
  mockGetRevenueId.mockResolvedValueOnce(null);
  await rc.identifyRevenueCatUser('billing-a');
  expect(sdk.setAppsflyerID).not.toHaveBeenCalled();
  mockAttributionListener?.();
  await flush();
  expect(idsSet()).toEqual(['af-device']);
});

it('clears the old billing user before switching accounts', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.identifyRevenueCatUser('billing-b');
  expect(idsSet()).toEqual(['af-device', null, 'af-device']);
  expect(sdk.setAppsflyerID.mock.invocationCallOrder[1]).toBeLessThan(
    sdk.logIn.mock.invocationCallOrder[1],
  );
});

it('clears the departing account before signing out', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.resetRevenueCatUser();
  expect(idsSet()).toEqual(['af-device', null]);
  expect(lastOrder(sdk.setAppsflyerID)).toBeLessThan(lastOrder(sdk.logOut));
});

it('does not call logOut for an anonymous user', async () => {
  const { Sentry } = require('@/lib/sentry');
  rc.configureRevenueCat();
  await rc.resetRevenueCatUser();
  expect(sdk.logOut).not.toHaveBeenCalled();
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

it('serializes a sign-out requested while sign-in is pending', async () => {
  let resolveLogin!: () => void;
  sdk.logIn.mockImplementationOnce(
    (userId: string) =>
      new Promise((resolve) => {
        resolveLogin = () => {
          mockSdkUser = userId;
          resolve({} as never);
        };
      }),
  );
  const login = rc.identifyRevenueCatUser('billing-a');
  await flush();
  const logout = rc.resetRevenueCatUser();
  resolveLogin();
  await Promise.all([login, logout]);
  expect(idsSet()).not.toContain('af-device');
  expect(sdk.logOut).toHaveBeenCalledTimes(1);
});

it('discards an ID lookup if consent changes while it is pending', async () => {
  let resolveId!: (id: string) => void;
  mockGetRevenueId.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveId = resolve;
      }),
  );
  const login = rc.identifyRevenueCatUser('billing-a');
  await flush();
  mockConsent = 'revoked';
  resolveId('stale-id');
  await login;
  expect(idsSet()).not.toContain('stale-id');
});

it('does not stop purchase observation when the attribute setter fails', async () => {
  sdk.setAppsflyerID.mockRejectedValue(new Error('bridge unavailable'));
  await rc.identifyRevenueCatUser('billing-a');
  await expect(rc.recordRevenueCatPurchase('pro.monthly')).resolves.toBe(true);
  expect(sdk.recordPurchase).toHaveBeenCalledWith('pro.monthly');
});

it('leaves Android attribution untouched', async () => {
  (require('react-native').Platform as typeof Platform).OS = 'android';
  await rc.identifyRevenueCatUser('billing-a');
  await rc.resetRevenueCatUser();
  expect(sdk.setAppsflyerID).not.toHaveBeenCalled();
  expect(sdk.collectDeviceIdentifiers).not.toHaveBeenCalled();
  expect(mockAttributionListener).toBeUndefined();
});

it('does not relink an account after a failed sign-out', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  sdk.logOut.mockRejectedValue(new Error('offline'));
  await rc.resetRevenueCatUser();
  sdk.setAppsflyerID.mockClear();
  mockAttributionListener?.();
  await flush();
  expect(idsSet()).not.toContain('af-device');
});

it('does not link a stale login when another account is already requested', async () => {
  let resolveLogin!: () => void;
  sdk.logIn.mockImplementationOnce(
    (userId: string) =>
      new Promise((resolve) => {
        resolveLogin = () => {
          mockSdkUser = userId;
          resolve({} as never);
        };
      }),
  );
  const first = rc.identifyRevenueCatUser('billing-a');
  await flush();
  const second = rc.identifyRevenueCatUser('billing-b');
  resolveLogin();
  await Promise.all([first, second]);
  const linked = sdk.setAppsflyerID.mock.calls.flatMap(([id], i) =>
    id ? [sdk.setAppsflyerID.mock.invocationCallOrder[i]] : [],
  );
  expect(linked).toHaveLength(1);
  expect(linked[0]).toBeGreaterThan(sdk.logIn.mock.invocationCallOrder[1]);
});

it('clears a grant withdrawn while the purchase links it, before recording', async () => {
  // The session starts only after login, so the purchase itself links the ID.
  mockGetRevenueId.mockResolvedValueOnce(null);
  await rc.identifyRevenueCatUser('billing-a');
  let resolveCollect!: () => void;
  sdk.collectDeviceIdentifiers.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveCollect = () => resolve();
      }),
  );
  const record = rc.recordRevenueCatPurchase('pro.monthly');
  await flush();
  mockConsent = 'revoked';
  resolveCollect();
  await record;
  expect(idsSet()).toEqual(['af-device', null]);
  expect(lastOrder(sdk.setAppsflyerID)).toBeLessThan(
    sdk.recordPurchase.mock.invocationCallOrder[0],
  );
});
