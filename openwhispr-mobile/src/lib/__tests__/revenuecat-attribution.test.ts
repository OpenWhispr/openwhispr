import { Platform } from 'react-native';
import Purchases from 'react-native-purchases';
import type { AppsFlyerAttributionConsent } from '@/lib/appsflyer';

let mockAttributionListener: (() => void) | undefined;
let mockConsent: AppsFlyerAttributionConsent = 'granted';
const mockGetRevenueId = jest.fn<Promise<string | null>, []>();
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
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => mockDeviceStorage()[key] ?? null,
    setItem: async (key: string, value: string) => {
      mockDeviceStorage()[key] = value;
    },
  },
}));

// A small model of the native SDK on each device: setters change that device's
// local copy (skipping a value equal to it), and logIn/logOut, receipt posts and
// an explicit sync push every pending value to the one server the devices share.
// After a push, the device forgets synced attributes of users other than the
// current one, and logging in from an anonymous user carries its pending
// attributes over.
interface Device {
  user: string;
  local: Record<string, { value: string; synced: boolean }>;
  storage: Record<string, string>;
}
let device: Device;
let server: Record<string, string> = {};
let serverHistory: Record<string, string[]> = {};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let rc: typeof import('../revenuecat');
let sdk: jest.Mocked<typeof Purchases>;

function mockDeviceStorage(): Record<string, string> {
  return device.storage;
}

function newDevice(): Device {
  return { user: '$RCAnonymousID:device', local: {}, storage: {} };
}

function push(): void {
  Object.entries(device.local).forEach(([user, attribute]) => {
    if (attribute.synced) return;
    attribute.synced = true;
    server[user] = attribute.value;
    (serverHistory[user] ??= []).push(attribute.value);
  });
  Object.keys(device.local).forEach((user) => {
    if (user !== device.user && device.local[user].synced) delete device.local[user];
  });
}

function storeLocally(value: string): void {
  const current = device.local[device.user];
  if (!current || current.value !== value) {
    device.local[device.user] = { value, synced: false };
  }
}

function switchUser(userId: string): void {
  const previous = device.local[device.user];
  if (device.user.startsWith('$RCAnonymousID') && previous && !previous.synced) {
    device.local[userId] = { ...previous };
  }
  device.user = userId;
}

// Each call is a new app session on `device`: module state resets, the SDK's
// does not.
function startSession(on: Device = device): void {
  device = on;
  jest.resetModules();
  sdk = require('react-native-purchases').default;
  sdk.getAppUserID.mockImplementation(async () => device.user);
  sdk.isAnonymous.mockImplementation(async () => device.user.startsWith('$RCAnonymousID'));
  // The React Native bridge drops null-valued keys before they reach the SDK.
  sdk.setAttributes.mockImplementation(async (attributes) => {
    const value = attributes.$appsflyerId;
    if (value !== null && value !== undefined) storeLocally(value);
  });
  sdk.logIn.mockImplementation(async (userId: string) => {
    push();
    switchUser(userId);
    return {} as never;
  });
  sdk.logOut.mockImplementation(async () => {
    push();
    switchUser('$RCAnonymousID:next');
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

// A device that already linked billing-a with consent, then closed the app.
async function linkedDevice(): Promise<Device> {
  startSession(newDevice());
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  return device;
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = 'appl_test';
  process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY = 'goog_test';
  mockConsent = 'granted';
  server = {};
  serverHistory = {};
  mockAttributionListener = undefined;
  mockGetRevenueId.mockReset().mockResolvedValue('af-device');
  startSession(newDevice());
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

it('keeps the link while consent is being read again', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  mockConsent = 'pending';
  mockAttributionListener?.();
  await rc.recordRevenueCatPurchase('pro.monthly');
  await rc.reconcileRevenueCatPurchases('billing-a', () => true);
  expect(serverHistory['billing-a']).toEqual(['af-device']);
});

it.each(['undecided', 'pending'] as const)(
  'leaves the account’s link alone on a device whose consent is %s',
  async (consent) => {
    const other = await linkedDevice();
    startSession(newDevice());
    mockConsent = consent;
    rc.configureRevenueCat();
    await flush();
    await rc.identifyRevenueCatUser('billing-a');
    await rc.reconcileRevenueCatPurchases('billing-a', () => true);
    await rc.recordRevenueCatPurchase('pro.monthly');
    // A failed sign-out, then a later consent signal, then a sign-out that
    // succeeds and a switch away from the account.
    sdk.logOut.mockRejectedValueOnce(new Error('offline'));
    await rc.resetRevenueCatUser();
    mockAttributionListener?.();
    await flush();
    await rc.resetRevenueCatUser();
    await rc.identifyRevenueCatUser('billing-a');
    await rc.identifyRevenueCatUser('billing-b');
    expect(serverHistory['billing-a']).toEqual(['af-device']);
    expect(other.local['billing-a'].value).toBe('af-device');
  },
);

it('clears the account’s link on an explicit opt-out until a consenting device returns', async () => {
  const consenting = await linkedDevice();
  const optedOut = newDevice();
  startSession(optedOut);
  mockConsent = 'revoked';
  rc.configureRevenueCat();
  await flush();
  await rc.identifyRevenueCatUser('billing-a');
  // The restore that runs on launch posts the deletion.
  await rc.reconcileRevenueCatPurchases('billing-a', () => true);
  expect(server['billing-a']).toBe('');

  mockConsent = 'granted';
  startSession(consenting);
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(server['billing-a']).toBe('af-device');
});

it('links this device’s ID again before a purchase, even within one session', async () => {
  mockGetRevenueId.mockResolvedValue('af-a');
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  const deviceA = device;
  // Another device opts out in the meantime.
  device = newDevice();
  device.user = 'billing-a';
  storeLocally('');
  push();
  expect(server['billing-a']).toBe('');
  device = deviceA;
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(server['billing-a']).toBe('af-a');
});

it('relinks in a new session after another device cleared the account’s ID', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  server['billing-a'] = '';
  startSession();
  await rc.identifyRevenueCatUser('billing-a');
  await rc.reconcileRevenueCatPurchases('billing-a', () => true);
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
  expect(serverHistory['billing-a']).not.toContain('');
  expect(server['billing-a']).toBe('af-device');
});

it('does not restore under an account that changed while linking', async () => {
  let current = true;
  await rc.identifyRevenueCatUser('billing-a');
  sdk.setAttributes.mockImplementation(async (attributes) => {
    if (attributes.$appsflyerId) current = false;
  });
  await expect(rc.reconcileRevenueCatPurchases('billing-a', () => current)).resolves.toBe(false);
  expect(sdk.syncPurchasesForResult).not.toHaveBeenCalled();
});

it('clears an account this device linked in an earlier session when leaving it', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  startSession();
  mockConsent = 'pending';
  await rc.identifyRevenueCatUser('billing-a');
  await rc.identifyRevenueCatUser('billing-b');
  expect(server['billing-a']).toBe('');
});

it('never clears a link set by another device when leaving the account', async () => {
  await linkedDevice();
  startSession(newDevice());
  mockConsent = 'undecided';
  await rc.identifyRevenueCatUser('billing-a');
  sdk.logOut.mockRejectedValueOnce(new Error('offline'));
  await rc.resetRevenueCatUser();
  // The user then allows tracking on this device.
  mockConsent = 'granted';
  mockAttributionListener?.();
  await flush();
  await rc.resetRevenueCatUser();
  expect(serverHistory['billing-a']).toEqual(['af-device']);
});

it('pushes a withdrawal at once in a later session too', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  await rc.recordRevenueCatPurchase('pro.monthly');
  startSession();
  // Consent is still being read at login, so this session links nothing.
  mockConsent = 'pending';
  await rc.identifyRevenueCatUser('billing-a');
  mockConsent = 'revoked';
  mockAttributionListener?.();
  await flush();
  expect(server['billing-a']).toBe('');
  expect(sdk.syncAttributesAndOfferingsIfNeeded).toHaveBeenCalledTimes(1);
});

it('links before restoring purchases', async () => {
  await expect(rc.reconcileRevenueCatPurchases('billing-a', () => true)).resolves.toBe(true);
  expect(server['billing-a']).toBe('af-device');
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

it.each(['ios', 'android'] as const)(
  'does not call logOut for an anonymous user on %s',
  async (os) => {
    (require('react-native').Platform as typeof Platform).OS = os;
    const { Sentry } = require('@/lib/sentry');
    rc.configureRevenueCat();
    await rc.resetRevenueCatUser();
    expect(sdk.logOut).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  },
);

it('serializes a sign-out requested while sign-in is pending', async () => {
  let resolveLogin!: () => void;
  sdk.logIn.mockImplementationOnce(
    (userId: string) =>
      new Promise((resolve) => {
        resolveLogin = () => {
          device.user = userId;
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

it('does not relink an account whose sign-out failed', async () => {
  await rc.identifyRevenueCatUser('billing-a');
  sdk.logOut.mockRejectedValue(new Error('offline'));
  await rc.resetRevenueCatUser();
  mockAttributionListener?.();
  await flush();
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(device.local['billing-a'].value).toBe('');
  expect(server['billing-a']).toBe('');
});

it('does not link a stale login when another account is already requested', async () => {
  let resolveLogin!: () => void;
  sdk.logIn.mockImplementationOnce(
    (userId: string) =>
      new Promise((resolve) => {
        resolveLogin = () => {
          device.user = userId;
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
  await rc.identifyRevenueCatUser('billing-a');
  sdk.setAttributes.mockImplementation(async (attributes) => {
    const value = attributes.$appsflyerId;
    if (value === null || value === undefined) return;
    storeLocally(value);
    if (value) mockConsent = 'revoked';
  });
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(server['billing-a']).toBe('');
});

it('records the purchase and logs in even when attribution fails', async () => {
  mockConsent = 'revoked';
  sdk.getAppUserID.mockRejectedValue(new Error('bridge unavailable'));
  await expect(rc.identifyRevenueCatUser('billing-a')).resolves.toBe(true);
  await expect(rc.recordRevenueCatPurchase('pro.monthly')).resolves.toBe(true);
  expect(sdk.logIn).toHaveBeenCalledWith('billing-a');
  expect(sdk.recordPurchase).toHaveBeenCalledWith('pro.monthly');
});

it('keeps the record of linked accounts when it cannot be read', async () => {
  startSession(await linkedDevice());
  const storage = require('@react-native-async-storage/async-storage').default;
  jest.spyOn(storage, 'getItem').mockRejectedValue(new Error('storage unavailable'));
  await rc.identifyRevenueCatUser('billing-b');
  await rc.recordRevenueCatPurchase('pro.monthly');
  expect(JSON.parse(device.storage['revenuecat.appsflyerLinkedUsers'])).toContain('billing-a');
});

it('records a link before writing it, so an interrupted link is still cleared', async () => {
  sdk.setAttributes.mockImplementation(async (attributes) => {
    const value = attributes.$appsflyerId;
    if (value === 'af-device') throw new Error('bridge unavailable');
    if (value !== null && value !== undefined) storeLocally(value);
  });
  await rc.identifyRevenueCatUser('billing-a');
  expect(JSON.parse(device.storage['revenuecat.appsflyerLinkedUsers'])).toContain('billing-a');
});
