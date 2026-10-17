import { useEffect, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { createStripeBillingPortalSession } from '@/data/remote/billingApi';
import {
  restoreAndroidPurchases,
  refreshAndroidBillingAccess,
  useAndroidBillingStatus,
} from './billing';
import { Button, Card, Row, styles } from './ui';

export function PlanContent() {
  const { t } = useTranslation('android');
  const user = useAuthStore((state) => state.user);
  const usage = useUsageStore((state) => state.usage);
  const isUsageLoading = useUsageStore((state) => state.isLoading);
  const billingStatus = useAndroidBillingStatus((state) =>
    usage?.billingUserId ? state.accounts[usage.billingUserId] : undefined,
  );
  const sources = usage?.entitlementSources;
  const { register } = useSuperwallGate();
  const [busy, setBusy] = useState(false);
  const [accessLoadFailed, setAccessLoadFailed] = useState(false);
  const signedIn = user && !user.isAnonymous;
  useEffect(() => {
    let active = true;
    setAccessLoadFailed(false);
    if (signedIn) {
      useUsageStore
        .getState()
        .load(true)
        .then((result) => {
          if (active) setAccessLoadFailed(result.status !== 'loaded' && !result.usage);
        });
    }
    return () => {
      active = false;
    };
  }, [signedIn, user?.id]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      Alert.alert(t('errorTitle'), (error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (signedIn && !usage) {
    return (
      <>
        <Text accessibilityRole="header" style={styles.title}>
          {t('plansAndBilling')}
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          {t(accessLoadFailed && !isUsageLoading ? 'planUnavailable' : 'planChecking')}
        </Text>
        <Button
          label={t('refreshAccess')}
          busy={busy || isUsageLoading}
          onPress={() => {
            run(async () => {
              const result = await useUsageStore.getState().load(true);
              setAccessLoadFailed(result.status !== 'loaded');
            });
          }}
        />
      </>
    );
  }
  return (
    <>
      <Text accessibilityRole="header" style={styles.title}>
        {usage?.isSubscribed
          ? usage.plan === 'business'
            ? 'OpenWhispr Business'
            : usage.plan === 'pro'
              ? 'OpenWhispr Pro'
              : t('plansAndBilling')
          : t('proTitle')}
      </Text>
      {!usage?.isSubscribed && <Text style={styles.body}>{t('proBody')}</Text>}
      {usage && (
        <Card>
          <Text style={styles.heading}>{t('cloud')}</Text>
          <Text style={styles.body}>
            {usage.isSubscribed
              ? t('cloudUnlimited')
              : t('cloudAllowance', {
                  remaining: usage.wordsRemaining.toLocaleString(),
                  limit: usage.limit.toLocaleString(),
                })}
          </Text>
        </Card>
      )}
      {!usage?.isSubscribed && <Text style={styles.caption}>{t('proNote')}</Text>}
      {billingStatus && billingStatus !== 'idle' && (
        <Card>
          <Text accessibilityLiveRegion="polite" style={styles.body}>
            {t(
              billingStatus === 'checking'
                ? 'billingChecking'
                : billingStatus === 'payment-pending'
                  ? 'billingPaymentPending'
                  : 'billingAccessPending',
            )}
          </Text>
        </Card>
      )}
      {(!signedIn || (!usage?.isSubscribed && (!billingStatus || billingStatus === 'idle'))) && (
        <Button
          label={signedIn ? t('upgrade') : t('signIn')}
          busy={busy}
          onPress={() => {
            if (!signedIn) {
              router.push('/auth');
              return;
            }
            void run(async () => {
              await register({ placement: SUPERWALL_PLACEMENTS.accountBillingOpen });
            });
          }}
        />
      )}
      {signedIn && (
        <>
          <Button
            secondary
            label={t('restorePurchases')}
            disabled={busy}
            onPress={() => {
              void run(async () => {
                const restored = await restoreAndroidPurchases();
                Alert.alert(
                  t('restorePurchases'),
                  t(
                    restored === 'restored'
                      ? 'purchaseRestored'
                      : restored === 'payment-pending'
                        ? 'billingPaymentPending'
                        : restored === 'pending'
                          ? 'billingAccessPending'
                          : 'noActivePurchase',
                  ),
                );
              });
            }}
          />
          {(sources?.providerStore === 'play_store' ||
            (billingStatus && billingStatus !== 'idle')) && (
            <Button
              secondary
              label={t('refreshAccess')}
              disabled={busy}
              onPress={() => {
                void run(async () => {
                  await refreshAndroidBillingAccess();
                });
              }}
            />
          )}
          {(sources?.providerStore === 'play_store' ||
            (billingStatus && billingStatus !== 'idle')) && (
            <Row
              title={t('managePlay')}
              onPress={() => {
                void run(() =>
                  Linking.openURL('https://play.google.com/store/account/subscriptions'),
                );
              }}
            />
          )}
          {billingStatus && billingStatus !== 'idle' && (
            <Row title={t('support')} onPress={() => router.push('/(account)/help')} />
          )}
          {sources?.providerStore === 'app_store' && (
            <Text style={styles.caption}>{t('billingAppStore')}</Text>
          )}
          {!!sources?.workspaceIds.length && (
            <Text style={styles.caption}>{t('billingWorkspace')}</Text>
          )}
          {usage?.entitlementSources?.personal && (
            <Row
              title={t('manageWeb')}
              onPress={() => {
                void run(async () => {
                  const url = await createStripeBillingPortalSession();
                  await Linking.openURL(url);
                });
              }}
            />
          )}
        </>
      )}
    </>
  );
}
