import React, { useMemo } from 'react';
import { CustomPurchaseControllerProvider } from 'expo-superwall';
const { OpenWhisprSuperwallProvider: DefaultProvider } =
  require('@/android/shared/components/superwall/OpenWhisprSuperwallProviderBase') as typeof import('@/android/shared/components/superwall/OpenWhisprSuperwallProviderBase');

export function OpenWhisprSuperwallProvider({ children }: { children: React.ReactNode }) {
  const enabled = useMemo(() => !!process.env.EXPO_PUBLIC_SUPERWALL_ANDROID_API_KEY?.trim(), []);
  if (!enabled) return <DefaultProvider>{children}</DefaultProvider>;

  const { androidPurchaseController } =
    require('@/android/billing') as typeof import('@/android/billing');
  return (
    <CustomPurchaseControllerProvider controller={androidPurchaseController}>
      <DefaultProvider>{children}</DefaultProvider>
    </CustomPurchaseControllerProvider>
  );
}
