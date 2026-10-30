import { Platform } from 'react-native';
import Constants from 'expo-constants';
import {
  captureAffiliateArrival,
  consumeAffiliateArrival,
  parseAffiliateLink,
} from '../affiliateLink';
jest.mock('expo-constants', () => ({ expoConfig: { extra: {} } }));
const original = Constants.expoConfig;
beforeEach(() => {
  Constants.expoConfig = {
    ...original,
    extra: { affiliate: { domain: 'sandbox.dub.link', publishableKey: 'dub_pk_test' } },
  } as typeof original;
  consumeAffiliateArrival();
});
afterEach(() => {
  Constants.expoConfig = original;
});
it.each([
  'http://sandbox.dub.link/creator',
  'https://sandbox.dub.link.evil.test/creator',
  'https://person@sandbox.dub.link/creator',
  'https://sandbox.dub.link/',
  'https://sandbox.dub.link/creator/nested',
  'https://sandbox.dub.link/a%2Fb',
])('rejects an untrusted URL (%s)', (input) => {
  expect(() => parseAffiliateLink(input, 'sandbox.dub.link')).toThrow();
});
it('preserves explicit cold/warm arrivals without following their destination', () => {
  expect(captureAffiliateArrival('https://sandbox.dub.link/creator?x=1')).toBe(true);
  expect(consumeAffiliateArrival()).toBe('https://sandbox.dub.link/creator?x=1');
  expect(consumeAffiliateArrival()).toBeNull();
});
it('disabled builds leave native routes untouched', () => {
  Constants.expoConfig = { ...original, extra: {} } as typeof original;
  expect(captureAffiliateArrival('https://sandbox.dub.link/creator')).toBe(false);
});

it('keeps affiliate UI and capture disabled on Android even with shared config', () => {
  const previous = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  try {
    expect(captureAffiliateArrival('https://sandbox.dub.link/creator')).toBe(false);
  } finally {
    Object.defineProperty(Platform, 'OS', { value: previous, configurable: true });
  }
});

it('maps only bounded lowercase creator keys and preserves full-link key case', () => {
  const { parseAffiliateInput } = require('../affiliateLink') as typeof import('../affiliateLink');
  expect(parseAffiliateInput(' demo_creator-1 ', 'sandbox.dub.link').href).toBe(
    'https://sandbox.dub.link/demo_creator-1',
  );
  expect(parseAffiliateInput('https://sandbox.dub.link/Demo', 'sandbox.dub.link').pathname).toBe(
    '/Demo',
  );
});
it.each(['Demo', 'démø', 'demo/name', 'demo?x=1', 'demo#tag', 'demo name', 'a'.repeat(65), ''])(
  'rejects ambiguous short input %s',
  (input) => {
    const { parseAffiliateInput } =
      require('../affiliateLink') as typeof import('../affiliateLink');
    expect(() => parseAffiliateInput(input, 'sandbox.dub.link')).toThrow();
  },
);
