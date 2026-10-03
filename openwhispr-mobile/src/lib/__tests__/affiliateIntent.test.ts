import Constants from 'expo-constants';
import { redirectSystemPath } from '../../../app/+native-intent';
import { consumeAffiliateArrival } from '../affiliateLink';
jest.mock('expo-constants', () => ({
  expoConfig: {
    extra: { affiliate: { domain: 'try.openwhispr.com', publishableKey: 'dub_pk_TEST' } },
  },
}));

it('captures a trusted creator on cold and warm starts', () => {
  for (const initial of [true, false]) {
    expect(redirectSystemPath({ path: 'https://try.openwhispr.com/creator', initial })).toBe('/');
    expect(consumeAffiliateArrival()).toBe('https://try.openwhispr.com/creator');
  }
});
it.each([
  'openwhispr://keyboard?text=test',
  'openwhispr://oauth/callback',
  'https://elsewhere.test/creator',
])('preserves the existing route %s', (path) => {
  expect(redirectSystemPath({ path, initial: true })).toBe(path);
});
it('leaves routes alone in an unconfigured build', () => {
  Constants.expoConfig!.extra = {};
  const path = 'https://try.openwhispr.com/creator';
  expect(redirectSystemPath({ path, initial: true })).toBe(path);
});
