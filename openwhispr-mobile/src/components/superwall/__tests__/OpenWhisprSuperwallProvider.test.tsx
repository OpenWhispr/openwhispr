import React from 'react';
import { Platform } from 'react-native';
import { render } from '@testing-library/react-native';
import { CustomPurchaseControllerProvider, SuperwallProvider } from 'expo-superwall';
import { OpenWhisprSuperwallProvider as IOSProvider } from '@/components/superwall/OpenWhisprSuperwallProvider';
import { OpenWhisprSuperwallProvider as AndroidProvider } from '@/components/superwall/OpenWhisprSuperwallProvider.android';
const OpenWhisprSuperwallProvider = ({ children }: { children: React.ReactNode }) =>
  Platform.OS === 'android' ? (
    <AndroidProvider>{children}</AndroidProvider>
  ) : (
    <IOSProvider>{children}</IOSProvider>
  );

jest.mock(
  'expo-superwall',
  () => ({
    CustomPurchaseControllerProvider: jest.fn(
      ({ children }: { children: React.ReactNode }) => children,
    ),
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

jest.mock('@/android/billing', () => ({
  androidPurchaseController: { onPurchase: jest.fn(), onPurchaseRestore: jest.fn() },
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

  it('preserves the default iOS purchase owner', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    render(
      <OpenWhisprSuperwallProvider>
        <></>
      </OpenWhisprSuperwallProvider>,
    );

    const providerProps = jest.mocked(SuperwallProvider).mock.calls[0]?.[0];
    expect(providerProps?.options?.testModeBehavior).toBe('never');
    expect(CustomPurchaseControllerProvider).not.toHaveBeenCalled();
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
    expect(CustomPurchaseControllerProvider).toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])(
    'does not mount an Android purchase controller without a usable key: %s',
    (key) => {
      Platform.OS = 'android';
      if (key === undefined) delete process.env.EXPO_PUBLIC_SUPERWALL_ANDROID_API_KEY;
      else process.env.EXPO_PUBLIC_SUPERWALL_ANDROID_API_KEY = key;
      render(
        <OpenWhisprSuperwallProvider>
          <></>
        </OpenWhisprSuperwallProvider>,
      );
      expect(CustomPurchaseControllerProvider).not.toHaveBeenCalled();
      expect(SuperwallProvider).not.toHaveBeenCalled();
    },
  );

  it('preserves Android key trimming, controller identity and configuration errors', () => {
    Platform.OS = 'android';
    process.env.EXPO_PUBLIC_SUPERWALL_ANDROID_API_KEY = '  android-test-key  ';
    render(
      <OpenWhisprSuperwallProvider>
        <></>
      </OpenWhisprSuperwallProvider>,
    );
    const props = jest.mocked(SuperwallProvider).mock.calls[0]?.[0];
    expect(props?.apiKeys).toEqual({ ios: 'ios-test-key', android: 'android-test-key' });
    expect(jest.mocked(CustomPurchaseControllerProvider).mock.calls[0]?.[0].controller).toBe(
      require('@/android/billing').androidPurchaseController,
    );
    const error = new Error('configure failed');
    props?.onConfigurationError?.(error);
    expect(require('@/lib/sentry').Sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { feature: 'superwall', operation: 'configure' },
    });
  });

  it.each([true, false])(
    'retains the initially selected Android enabled state across a key change: %s',
    (enabled) => {
      Platform.OS = 'android';
      process.env.EXPO_PUBLIC_SUPERWALL_ANDROID_API_KEY = enabled ? 'android-test-key' : '';
      const view = render(
        <OpenWhisprSuperwallProvider>
          <></>
        </OpenWhisprSuperwallProvider>,
      );
      process.env.EXPO_PUBLIC_SUPERWALL_ANDROID_API_KEY = enabled ? '' : 'new-key';
      view.rerender(
        <OpenWhisprSuperwallProvider>
          <></>
        </OpenWhisprSuperwallProvider>,
      );
      expect(jest.mocked(CustomPurchaseControllerProvider).mock.calls.length > 0).toBe(enabled);
      expect(jest.mocked(SuperwallProvider).mock.calls.length > 0).toBe(enabled);
      if (enabled)
        expect(jest.mocked(SuperwallProvider).mock.calls.at(-1)?.[0].apiKeys.android).toBe(
          'android-test-key',
        );
    },
  );
});
