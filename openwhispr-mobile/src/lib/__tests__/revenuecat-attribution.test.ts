import { Platform } from 'react-native';
import Purchases from 'react-native-purchases';
import type { AppsFlyerAttributionConsent } from '@/lib/appsflyer';

const ANONYMOUS = '$RCAnonymousID:device';
let mockAttributionListener: (() => void) | undefined;
let mockConsent: AppsFlyerAttributionConsent = 'granted';
const mockGetRevenueId = jest.fn<Promise<string | null>, []>();
const mockWaitForConsent = jest.fn<Promise<AppsFlyerAttributionConsent>, []>();
jest.mock('@/lib/appsflyer', () => ({
  getAppsFlyerRevenueId: () => mockGetRevenueId(),
  getAppsFlyerAttributionConsent: () => mockConsent,
  waitForAppsFlyerAttributionConsent: () => mockWaitForConsent(),
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
    setAttributes: jest.fn(),
    syncAttributesAndOfferingsIfNeeded: jest.fn(),
    recordPurchase: jest.fn(),
    syncPurchasesForResult: jest.fn(),
  },
  LOG_LEVEL: { INFO: 'INFO' },
  PURCHASES_ARE_COMPLETED_BY_TYPE: { MY_APP: 'MY_APP' },
  PURCHASES_ERROR_CODE: { CONFIGURATION_ERROR: '23' },
  STOREKIT_VERSION: { STOREKIT_2: 'STOREKIT_2' },
}));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));

// A small model of the native SDK: setters change a local copy (skipping a value
// equal to it), and logIn/logOut, receipt posts and an explicit sync push it.
let mockSdkUser = ANONYMOUS;
let local: Record<string, { value: string; synced: boolean }> = {};
let server: Record<string, string> = {};
let serverHistory: Record<string, string[]> = {};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let rc: typeof import('../revenuecat');
let sdk: jest.Mocked<typeof Purchases>;

function push(): void {
  const attribute = local[mockSdkUser];
  if (!attribute || attribute.synced) return;
  attribute.synced = true;
  server[mockSdkUser] = attribute.value;
  (serverHistory[mockSdkUser] ??= []).push(attribute.value);
}

function storeLocally(value: string | null): void {
  const current = local[mockSdkUser];
  if (!current || current.value !== (value ?? '')) {
    local[mockSdkUser] = { value: value ?? '', synced: false };
  }
}

// Each call is a new app session: module state resets, the SDK's does not.
function startSession(): void {
  jest.resetModules();
  sdk = require('react-native-purchases').default;
  sdk.getAppUserID.mockImplementation(async () => mockSdkUser);
  sdk.isAnonymous.mockImplementation(async () => mockSdkUser.startsWith('$RCAnonymousID'));
  sdk.setAttributes.mockImplementation(async (attributes) => {
    storeLocally(attributes.$appsflyerId);
  });
  sdk.logIn.mockImplementation(async (userId: string) => {
    push();
    mockSdkUser = userId;
    return {} as never;
  });
  sdk.logOut.mockImplementation(async () => {
    push();
    mockSdkUser = '$RCAnonymousID:next';
    return {} as never;
  });
  sdk.recordPurchase.mockImplementation(async () => {
    push();
    return {} as never;
  });
  sdk.syncPurchasesForResult.mockImplementation(async () => {
    push();
    return {} as never;
  });
  sdk.syncAttributesAndOfferingsIfNeeded.mockImplementation(async () => {
    push();
    return {} as never;
  });
  rc = require('../revenuecat');
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = 'appl_test';
  process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY = 'goog_test';
  mockConsent = 'granted';
  mockSdkUser = ANONYMOUS;
  local = {};
  server = {};
  serverHistory = {};
  mockAttributionListener = undefined;
  mockGetRevenueId.mockReset().mockResolvedValue('af-device');
  mockWaitForConsent.mockReset().mockImplementation(async () => mockConsent);
  startSession();
});

it('links the consented billing identity before recording the purchase', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(serverHistory['billing-a']).toEqual(['af-device']);
  expect(sdk.recordPurchase).toHaveBeenCalledWith('pro.monthly');
  // The receipt post carries the attribute; no extra network round trip first.
  expect(sdk.syncAttributesAndOfferingsIfNeeded).not.toHaveBeenCalled();
});

it('never uses the setter that collects device identifiers', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  mockConsent = 'revoked';
  mockAttributionListener?.();
  await flush();
  await rc.resetRevenueCatUser();
  expect(sdk.setAppsflyerID).not.toHaveBeenCalled();
  expect(sdk.collectDeviceIdentifiers).not.toHaveBeenCalled();
});

it('never links an opted-out user', async () => {
  mockConsent = 'revoked';
  rc.configureRevenueCat();
  await flush();
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(server['billing-a'] ?? '').toBe('');
  expect(mockGetRevenueId).not.toHaveBeenCalled();
  // Nothing was linked, so there is nothing to withdraw right away.
  expect(sdk.syncAttributesAndOfferingsIfNeeded).not.toHaveBeenCalled();
});

it('removes the link from the server as soon as consent is withdrawn', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  mockConsent = 'revoked';
  mockAttributionListener?.();
  await flush();
  expect(server['billing-a']).toBe('');
  expect(sdk.syncAttributesAndOfferingsIfNeeded).toHaveBeenCalledTimes(1);
});

it('does not report a withdrawal push that only failed to fetch offerings', async () => {
  const { Sentry } = require('@/lib/sentry');
  await rc.identifyRevenueCatUser('billing-a');
  sdk.syncAttributesAndOfferingsIfNeeded.mockImplementationOnce(async () => {
    push();
    throw Object.assign(new Error('no products'), { code: '23' });
  });
  mockConsent = 'revoked';
  mockAttributionListener?.();
  await flush();
  expect(server['billing-a']).toBe('');
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

it('keeps the link through a foreground ATT re-check', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  mockConsent = 'pending';
  mockAttributionListener?.();
  await flush();
  mockConsent = 'granted';
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(serverHistory['billing-a']).toEqual(['af-device']);
});

it.each(['revoked', 'undecided', 'pending'] as const)(
  'records a purchase without the link when consent is %s at that moment',
  async (consent) => {
    server['billing-a'] = 'af-other-device';
    mockSdkUser = 'billing-a';
    local['billing-a'] = { value: 'af-other-device', synced: true };
    mockConsent = 'pending';
    await rc.identifyRevenueCatUser('billing-a');
    mockWaitForConsent.mockResolvedValueOnce(consent);
    mockConsent = consent;
    await rc.recordRevenueCatPurchase('pro.monthly');
    expect(server['billing-a']).toBe('');
  },
);

it('waits for the ATT decision before linking a purchase', async () => {
  mockConsent = 'pending';
  await rc.identifyRevenueCatUser('billing-a');
  mockWaitForConsent.mockImplementationOnce(async () => {
    mockConsent = 'granted';
    return 'granted';
  });
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(serverHistory['billing-a']).toEqual(['af-device']);
});

it('leaves another device’s link alone before this device answers ATT', async () => {
  server['billing-a'] = 'af-other-device';
  mockConsent = 'undecided';
  rc.configureRevenueCat();
  await flush();
  await rc.identifyRevenueCatUser('billing-a');
  expect(server['billing-a']).toBe('af-other-device');
});

it('relinks after another device cleared the account’s ID', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  server['billing-a'] = '';
  startSession();
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(server['billing-a']).toBe('af-device');
});

it('does not clear a restored user on launch', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  startSession();
  rc.configureRevenueCat();
  await flush();
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(serverHistory['billing-a']).not.toContain('');
});

it('links once the ID becomes readable instead of clearing', async () => {
  mockGetRevenueId.mockResolvedValueOnce(null);
  await rc.identifyRevenueCatUser('billing-a');
  expect(sdk.setAttributes).not.toHaveBeenCalled();
  mockAttributionListener?.();
  await flush();
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(serverHistory['billing-a']).toEqual(['af-device']);
});

it('links before restoring purchases', async () => {
  await expect(rc.reconcileRevenueCatPurchases('billing-a', () => true)).resolves.toBe(true);
  expect(serverHistory['billing-a']).toEqual(['af-device']);
});

it('restores without another device’s link when this device has not consented', async () => {
  server['billing-a'] = 'af-other-device';
  mockSdkUser = 'billing-a';
  local['billing-a'] = { value: 'af-other-device', synced: true };
  mockConsent = 'undecided';
  await expect(rc.reconcileRevenueCatPurchases('billing-a', () => true)).resolves.toBe(true);
  expect(server['billing-a']).toBe('');
});

it('clears the old billing user before switching accounts', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  await rc.identifyRevenueCatUser('billing-b');
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(server).toEqual({ 'billing-a': '', 'billing-b': 'af-device' });
});

it('clears the departing account when signing out', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  await rc.resetRevenueCatUser();
  expect(server['billing-a']).toBe('');
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
  expect(serverHistory['billing-a'] ?? []).not.toContain('af-device');
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
  expect(sdk.setAttributes).not.toHaveBeenCalledWith({ $appsflyerId: 'stale-id' });
});

it('does not stop purchase observation when the attribute setter fails', async () => {
  sdk.setAttributes.mockRejectedValue(new Error('not configured'));
  await rc.identifyRevenueCatUser('billing-a');
  await expect(rc.recordRevenueCatPurchase('pro.monthly')).resolves.toBe(true);
  expect(sdk.recordPurchase).toHaveBeenCalledWith('pro.monthly');
});

it('leaves Android attribution untouched', async () => {
  (require('react-native').Platform as typeof Platform).OS = 'android';
  rc.configureRevenueCat();
  await rc.identifyRevenueCatUser('billing-a');
  await rc.resetRevenueCatUser();
  expect(sdk.setAttributes).not.toHaveBeenCalled();
  expect(sdk.configure).toHaveBeenCalledWith(
    expect.not.objectContaining({ automaticDeviceIdentifierCollectionEnabled: expect.anything() }),
  );
  expect(mockAttributionListener).toBeUndefined();
});

it('does not relink an account after a failed sign-out', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  sdk.logOut.mockRejectedValue(new Error('offline'));
  await rc.resetRevenueCatUser();
  sdk.setAttributes.mockClear();
  mockAttributionListener?.();
  await flush();
  expect(sdk.setAttributes).not.toHaveBeenCalledWith({ $appsflyerId: 'af-device' });
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
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(server['billing-a'] ?? '').toBe('');
  expect(server['billing-b']).toBe('af-device');
});

it('clears a grant withdrawn while the purchase links it, before recording', async () => {
  // The ID is not readable at login, so the purchase itself links it.
  mockGetRevenueId.mockResolvedValueOnce(null);
  await rc.identifyRevenueCatUser('billing-a');
  sdk.setAttributes.mockImplementation(async (attributes) => {
    storeLocally(attributes.$appsflyerId);
    if (attributes.$appsflyerId) mockConsent = 'revoked';
  });
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(server['billing-a']).toBe('');
});
