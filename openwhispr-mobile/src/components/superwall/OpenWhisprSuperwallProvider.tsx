import React, { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import { SuperwallProvider } from 'expo-superwall';
import { Sentry } from '@/lib/sentry';
import { SuperwallEntitlementBridge } from './SuperwallEntitlementBridge';
import {
  DisabledSuperwallGateProvider,
  EnabledSuperwallGateProvider,
} from './SuperwallGateProvider';

type Props = {
  children: React.ReactNode;
};

let didReportMissingProductionKeys = false;

function cleanApiKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function OpenWhisprSuperwallProvider({ children }: Props) {
  const apiKeys = useMemo(
    () => ({
      ios: cleanApiKey(process.env.EXPO_PUBLIC_SUPERWALL_IOS_API_KEY),
      android: cleanApiKey(process.env.EXPO_PUBLIC_SUPERWALL_ANDROID_API_KEY),
    }),
    [],
  );

  const handleConfigurationError = useCallback((error: Error) => {
    Sentry.captureException(error, {
      tags: { feature: 'superwall', operation: 'configure' },
    });
  }, []);

  const requiredPlatform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : null;
  const hasRequiredApiKey = requiredPlatform
    ? !!apiKeys[requiredPlatform]
    : !!apiKeys.ios || !!apiKeys.android;

  if (!hasRequiredApiKey) {
    if (!__DEV__ && !didReportMissingProductionKeys) {
      didReportMissingProductionKeys = true;
      Sentry.captureMessage(
        requiredPlatform
          ? `Superwall ${requiredPlatform} API key missing in production build`
          : 'Superwall API keys missing in production build',
        'warning',
      );
    }
    return <DisabledSuperwallGateProvider>{children}</DisabledSuperwallGateProvider>;
  }

  return (
    <SuperwallProvider
      apiKeys={apiKeys}
      options={{
        // Test mode fakes purchases without StoreKit, so nothing reaches the
        // billing webhook and the backend never grants access — a purchase in
        // test mode looks successful on-device and broken everywhere else.
        // 'automatic' also self-arms (test-store-user flag, bundle mismatch),
        // which silently swallowed paywalls on TestFlight. Never enter it.
        testModeBehavior: 'never',
        logging: {
          level: __DEV__ ? 'info' : 'warn',
          scopes: ['all'],
        },
      }}
      onConfigurationError={handleConfigurationError}
    >
      <SuperwallEntitlementBridge />
      <EnabledSuperwallGateProvider>{children}</EnabledSuperwallGateProvider>
    </SuperwallProvider>
  );
}
