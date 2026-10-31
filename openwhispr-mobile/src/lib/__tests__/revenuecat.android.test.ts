import Purchases from 'react-native-purchases';
import {
  configureRevenueCat,
  identifyRevenueCatUser,
  resetRevenueCatUser,
  withRevenueCatUser,
} from '../revenuecat';
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    configure: jest.fn(),
    logIn: jest.fn(async () => ({})),
    logOut: jest.fn(async () => ({})),
    setLogLevel: jest.fn(),
  },
  LOG_LEVEL: { INFO: 'INFO' },
  PURCHASES_ARE_COMPLETED_BY_TYPE: { MY_APP: 'MY_APP' },
  STOREKIT_VERSION: { STOREKIT_2: 'STOREKIT_2' },
}));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
beforeEach(() => {
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY = 'goog_test';
});
it('lets RevenueCat own Android purchases and serializes identity across a store interaction', async () => {
  configureRevenueCat();
  expect(Purchases.configure).toHaveBeenCalledWith({ apiKey: 'goog_test' });
  let release!: () => void;
  const purchase = withRevenueCatUser(
    'a',
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  for (let index = 0; index < 5; index++) await Promise.resolve();
  const switchAccount = identifyRevenueCatUser('b');
  const reset = resetRevenueCatUser();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(Purchases.logIn).toHaveBeenCalledTimes(1);
  expect(Purchases.logOut).not.toHaveBeenCalled();
  release();
  await purchase;
  await switchAccount;
  await reset;
  expect(Purchases.logIn).toHaveBeenNthCalledWith(2, 'b');
  expect(Purchases.logOut).toHaveBeenCalledTimes(1);
});
