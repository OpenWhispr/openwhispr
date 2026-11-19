import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore.android';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { createStripeBillingPortalSession } from '@/data/remote/billingApi';
import {
  restoreAndroidPurchases,
  refreshAndroidBillingAccess,
  useAndroidBillingStatus,
} from './billing';
import { Group, ListRow, PillAction, cardStyle, settings } from './settings/kit';
import { bodyText } from './settings/look';

const titleText = {
  fontSize: 32,
  lineHeight: 38,
  fontWeight: '700' as const,
  color: settings.text,
};

/** A one-row card that opens something (Manage on Google Play, Support, Web billing). */
function LinkCard({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Group inset={14}>
      <ListRow title={title} onPress={onPress} />
    </Group>
  );
}

export function PlanContent() {
  const { t } = useTranslation('android');
  const user = useAuthStore((state) => state.user);
  const sessionCookie = useAuthStore((state) => state.sessionCookie);
  const usage = useUsageStore((state) => state.usage);
  const isUsageLoading = useUsageStore((state) => state.isLoading);
  const sessionRejected = useUsageStore((state) => state.sessionRejected);
  const billingStatus = useAndroidBillingStatus((state) =>
    usage?.billingUserId ? state.accounts[usage.billingUserId] : undefined,
  );
  const sources = usage?.entitlementSources;
  const { register } = useSuperwallGate();
  const [busy, setBusy] = useState(false);
  const activeAction = useRef<symbol | null>(null);
  const [accessLoadFailed, setAccessLoadFailed] = useState(false);
  const signedIn = user && !user.isAnonymous;
  useEffect(() => {
    const unsubscribe = useAuthStore.subscribe((current, previous) => {
      if (
        current.user?.id !== previous.user?.id ||
        current.sessionCookie !== previous.sessionCookie
      ) {
        activeAction.current = null;
        setBusy(false);
      }
    });
    return () => {
      activeAction.current = null;
      unsubscribe();
    };
  }, []);
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
  }, [signedIn, user?.id, sessionCookie]);
  const run = async (action: (isCurrent: () => boolean) => Promise<unknown>) => {
    if (activeAction.current) return;
    const operation = Symbol();
    activeAction.current = operation;
    // Account changes and unmounts invalidate both successful and failed results.
    const isCurrent = () => activeAction.current === operation;
    setBusy(true);
    try {
      await action(isCurrent);
    } catch (error) {
      if (isCurrent()) Alert.alert(t('errorTitle'), (error as Error).message);
    } finally {
      if (isCurrent()) {
        activeAction.current = null;
        setBusy(false);
      }
    }
  };
  if (signedIn && sessionRejected) {
    return (
      <>
        <Text accessibilityRole="header" style={titleText}>
          {t('plansAndBilling')}
        </Text>
        <Text accessibilityLiveRegion="polite" style={bodyText}>
          {t('planSignInRequired')}
        </Text>
        <PillAction primary label={t('signIn')} onPress={() => router.push('/auth?reason=plan')} />
      </>
    );
  }
  if (signedIn && !usage) {
    return (
      <>
        <Text accessibilityRole="header" style={titleText}>
          {t('plansAndBilling')}
        </Text>
        <Text accessibilityLiveRegion="polite" style={bodyText}>
          {t(accessLoadFailed && !isUsageLoading ? 'planUnavailable' : 'planChecking')}
        </Text>
        <PillAction
          primary
          label={t('refreshAccess')}
          busy={busy || isUsageLoading}
          onPress={() => {
            run(async (isCurrent) => {
              const result = await useUsageStore.getState().load(true);
              if (isCurrent()) setAccessLoadFailed(result.status !== 'loaded');
            });
          }}
        />
      </>
    );
  }
  return (
    <>
      <Text accessibilityRole="header" style={titleText}>
        {usage?.isSubscribed
          ? usage.plan === 'business'
            ? 'OpenWhispr Business'
            : usage.plan === 'pro'
              ? 'OpenWhispr Pro'
              : t('plansAndBilling')
          : t('proTitle')}
      </Text>
      {!usage?.isSubscribed && <Text style={bodyText}>{t('proBody')}</Text>}
      {usage && (
        <Group title={t('cloud')} inset={14}>
          <ListRow
            title={
              usage.isSubscribed
                ? t('cloudUnlimited')
                : t('cloudAllowance', {
                    remaining: usage.wordsRemaining.toLocaleString(),
                    limit: usage.limit.toLocaleString(),
                  })
            }
            trailing={null}
          />
        </Group>
      )}
      {!usage?.isSubscribed && <Text style={settings.subtitle}>{t('proNote')}</Text>}
      {billingStatus && billingStatus !== 'idle' && (
        <View style={[cardStyle, { padding: 16 }]}>
          <Text accessibilityLiveRegion="polite" style={bodyText}>
            {t(
              billingStatus === 'checking'
                ? 'billingChecking'
                : billingStatus === 'payment-pending'
                  ? 'billingPaymentPending'
                  : 'billingAccessPending',
            )}
          </Text>
        </View>
      )}
      {(!signedIn || (!usage?.isSubscribed && (!billingStatus || billingStatus === 'idle'))) && (
        <PillAction
          primary
          label={signedIn ? t('upgrade') : t('signIn')}
          busy={busy}
          onPress={() => {
            if (!signedIn) {
              router.push('/auth?reason=plan');
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
          <PillAction
            label={t('restorePurchases')}
            disabled={busy}
            onPress={() => {
              void run(async (isCurrent) => {
                const restored = await restoreAndroidPurchases();
                if (!isCurrent()) return;
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
            <PillAction
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
            <LinkCard
              title={t('managePlay')}
              onPress={() => {
                void run(() =>
                  Linking.openURL('https://play.google.com/store/account/subscriptions'),
                );
              }}
            />
          )}
          {billingStatus && billingStatus !== 'idle' && (
            <LinkCard title={t('support')} onPress={() => router.push('/(account)/help')} />
          )}
          {sources?.providerStore === 'app_store' && (
            <Text style={settings.subtitle}>{t('billingAppStore')}</Text>
          )}
          {!!sources?.workspaceIds.length && (
            <Text style={settings.subtitle}>{t('billingWorkspace')}</Text>
          )}
          {usage?.entitlementSources?.personal && (
            <LinkCard
              title={t('manageWeb')}
              onPress={() => {
                void run(async (isCurrent) => {
                  const url = await createStripeBillingPortalSession();
                  if (isCurrent()) await Linking.openURL(url);
                });
              }}
            />
          )}
        </>
      )}
    </>
  );
}
