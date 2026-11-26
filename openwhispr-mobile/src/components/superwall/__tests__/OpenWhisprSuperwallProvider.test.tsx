import React from 'react';
import { Platform } from 'react-native';
import { render } from '@testing-library/react-native';
import { SuperwallProvider } from 'expo-superwall';
import { OpenWhisprSuperwallProvider } from '@/components/superwall/OpenWhisprSuperwallProvider';

jest.mock(
  'expo-superwall',
  () => ({
    SuperwallProvider: jest.fn(({ children }: { children: React.ReactNode }) => children),
  }),
  { virtual: true },
);

jest.mock('@/components/superwall/SuperwallEntitlementBridge', () => ({
  SuperwallEntitlementBridge: () => null,
}));

jest.mock('@/components/superwall/SuperwallGateProvider', () => ({
  DisabledSuperwallGateProvider: ({ children }: { children: React.ReactNode }) => children,
  EnabledSuperwallGateProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/lib/sentry', () => ({
  Sentry: { captureException: jest.fn(), captureMessage: jest.fn() },
}));

describe('OpenWhisprSuperwallProvider', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPO_PUBLIC_SUPERWALL_IOS_API_KEY = 'ios-test-key';
    process.env.EXPO_PUBLIC_SUPERWALL_ANDROID_API_KEY = 'android-test-key';
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    delete process.env.EXPO_PUBLIC_SUPERWALL_IOS_API_KEY;
    delete process.env.EXPO_PUBLIC_SUPERWALL_ANDROID_API_KEY;
  });

  it('never enters Superwall test mode so purchases always go through StoreKit', () => {
    render(
      <OpenWhisprSuperwallProvider>
        <></>
      </OpenWhisprSuperwallProvider>,
    );

    const providerProps = jest.mocked(SuperwallProvider).mock.calls[0]?.[0];
    expect(providerProps?.options?.testModeBehavior).toBe('never');
  });

  it('never enters Superwall test mode on Android either', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });

    render(
      <OpenWhisprSuperwallProvider>
        <></>
      </OpenWhisprSuperwallProvider>,
    );

    const providerProps = jest.mocked(SuperwallProvider).mock.calls[0]?.[0];
    expect(providerProps?.options?.testModeBehavior).toBe('never');
  });
});
