import { Platform } from 'react-native';
import Purchases from 'react-native-purchases';

let mockAttributionListener: (() => void) | undefined;
let mockAllowed = true;
const mockGetRevenueId = jest.fn<Promise<string | null>, []>(() => Promise.resolve('af-device'));
jest.mock('@/lib/appsflyer', () => ({
  getAppsFlyerRevenueId: () => mockGetRevenueId(),
  isAppsFlyerAttributionAllowed: () => mockAllowed,
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
    logIn: jest.fn(),
    logOut: jest.fn(),
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

beforeEach(() => {
  jest.resetModules();
  process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = 'appl_test';
  process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY = 'goog_test';
  mockAllowed = true;
  mockAttributionListener = undefined;
  mockGetRevenueId.mockReset().mockResolvedValue('af-device');
  sdk = require('react-native-purchases').default;
  rc = require('../revenuecat');
});

it('links the consented billing identity and syncs before recording the purchase', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(sdk.setAppsflyerID).toHaveBeenLastCalledWith('af-device');
  expect(sdk.logIn.mock.invocationCallOrder[0]).toBeLessThan(
    sdk.setAppsflyerID.mock.invocationCallOrder.at(-1)!,
  );
  expect(sdk.syncAttributesAndOfferingsIfNeeded.mock.invocationCallOrder.at(-1)!).toBeLessThan(
    sdk.recordPurchase.mock.invocationCallOrder[0],
  );
});

it('clears the link and syncs when consent is withdrawn', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  sdk.setAppsflyerID.mockClear();
  sdk.syncAttributesAndOfferingsIfNeeded.mockClear();
  mockAllowed = false;
  mockGetRevenueId.mockResolvedValue(null);
  mockAttributionListener?.();
  await flush();
  expect(sdk.setAppsflyerID).toHaveBeenLastCalledWith(null);
  expect(sdk.syncAttributesAndOfferingsIfNeeded).toHaveBeenCalled();
});

it('does not link anonymous or denied users', async () => {
  mockAllowed = false;
  rc.configureRevenueCat();
  await flush();
  await rc.identifyRevenueCatUser('billing-a');
  expect(sdk.setAppsflyerID).toHaveBeenCalledWith(null);
  expect(sdk.setAppsflyerID).not.toHaveBeenCalledWith('af-device');
});

it('clears the old billing user before switching accounts', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  sdk.setAppsflyerID.mockClear();
  sdk.syncAttributesAndOfferingsIfNeeded.mockClear();
  await rc.identifyRevenueCatUser('billing-b');
  expect(sdk.setAppsflyerID.mock.calls).toEqual([[null], ['af-device']]);
  expect(sdk.syncAttributesAndOfferingsIfNeeded.mock.invocationCallOrder[0]).toBeLessThan(
    sdk.logIn.mock.invocationCallOrder[1],
  );
});

it('serializes a sign-out requested while sign-in is pending', async () => {
  let resolveLogin!: () => void;
  sdk.logIn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveLogin = () => resolve({} as never);
      }),
  );
  const login = rc.identifyRevenueCatUser('billing-a');
  await flush();
  const logout = rc.resetRevenueCatUser();
  resolveLogin();
  await Promise.all([login, logout]);
  expect(sdk.setAppsflyerID).toHaveBeenLastCalledWith(null);
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
  mockAllowed = false;
  resolveId('stale-id');
  await login;
  expect(sdk.setAppsflyerID).not.toHaveBeenCalledWith('stale-id');
});

it('does not stop purchase observation when attribute sync fails', async () => {
  sdk.syncAttributesAndOfferingsIfNeeded.mockRejectedValue(new Error('offline'));
  await rc.identifyRevenueCatUser('billing-a');
  await expect(rc.recordRevenueCatPurchase('pro.monthly')).resolves.toBe(true);
  expect(sdk.recordPurchase).toHaveBeenCalledWith('pro.monthly');
});

it('leaves Android attribution untouched', async () => {
  (require('react-native').Platform as typeof Platform).OS = 'android';
  await rc.identifyRevenueCatUser('billing-a');
  expect(sdk.setAppsflyerID).not.toHaveBeenCalled();
  expect(mockAttributionListener).toBeUndefined();
});

it('does not relink an account after a failed sign-out', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  sdk.logOut.mockRejectedValue(new Error('offline'));
  await rc.resetRevenueCatUser();
  sdk.setAppsflyerID.mockClear();
  mockAttributionListener?.();
  await flush();
  expect(sdk.setAppsflyerID).not.toHaveBeenCalledWith('af-device');
});

it('does not link a stale login when another account is already requested', async () => {
  let resolveLogin!: () => void;
  sdk.logIn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveLogin = () => resolve({} as never);
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

it('clears a grant revoked during its server sync before recording a purchase', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  let resolveSync!: (value: never) => void;
  sdk.syncAttributesAndOfferingsIfNeeded.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSync = resolve;
      }),
  );
  const record = rc.recordRevenueCatPurchase('pro.monthly');
  await flush();
  mockAllowed = false;
  resolveSync({} as never);
  await record;
  expect(sdk.setAppsflyerID).toHaveBeenLastCalledWith(null);
  expect(sdk.setAppsflyerID.mock.invocationCallOrder.at(-1)!).toBeLessThan(
    sdk.recordPurchase.mock.invocationCallOrder[0],
  );
});
