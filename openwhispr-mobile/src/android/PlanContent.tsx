import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useAuthStore } from '@/android/store/useAuthStore';
import { useUsageStore } from '@/android/store/useUsageStore';
import { useSuperwallGate } from '@/android/shared/hooks/useSuperwallGate';
import { SUPERWALL_PLACEMENTS, buildUsageGateParams } from '@/android/shared/lib/superwall';
import { createStripeBillingPortalSession } from '@/android/shared/data/remote/billingApi';
import {
  restoreAndroidPurchases,
  refreshAndroidBillingAccess,
  useAndroidBillingStatus,
} from './billing';
import { Group, ListRow, PillAction, showToast } from './settings/kit';
import { useNavigationBar } from './navigationBar';
import { ProgressBar } from './controls';
import { useHome } from './home/kit';
import { useSettingsLook } from './settings/look';
import { useTheme } from './ThemeProvider';
import { CONFIRMING_MS, formatPlanDate, planView, type PlanView } from './plan/planState';
import { LinkText, PlanCard } from './plan/parts';
import { usePlayPrices } from './plan/prices';
import { usePlanT } from './plan/strings';

const PLAY_SUBSCRIPTIONS = 'https://play.google.com/store/account/subscriptions';

/**
 * Plan & billing (Figma "Android · Upgrade & billing", sections 2 and 3). One card says which
 * plan this is and what happens next; the action that matters sits at the bottom of the screen.
 *
 * `openPaywall: 'limit'` comes from the bubble's "Out of cloud words this week · Go Pro": the
 * screen opens with the out-of-words paywall over it (`cloud_usage_limit_reached`).
 */
export function PlanContent({ openPaywall }: { openPaywall?: 'limit' } = {}) {
  const t = usePlanT();
  const { i18n } = useTranslation();
  const th = useTheme();
  const { c, type } = useHome();
  const { edgeCard } = useSettingsLook();
  const { buttons, inset } = useNavigationBar();
  const user = useAuthStore((state) => state.user);
  const sessionCookie = useAuthStore((state) => state.sessionCookie);
  const usage = useUsageStore((state) => state.usage);
  const isUsageLoading = useUsageStore((state) => state.isLoading);
  const sessionRejected = useUsageStore((state) => state.sessionRejected);
  const billingId = usage?.billingUserId;
  const billingStatus = useAndroidBillingStatus((state) =>
    billingId ? state.accounts[billingId] : undefined,
  );
  const waitingSince = useAndroidBillingStatus((state) =>
    billingId ? state.since?.[billingId] : undefined,
  );
  const { register } = useSuperwallGate();
  const [busy, setBusy] = useState(false);
  const activeAction = useRef<symbol | null>(null);
  const [accessLoadFailed, setAccessLoadFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const signedIn = Boolean(user && !user.isAnonymous);

  const view = planView({
    signedIn,
    sessionRejected,
    usage,
    loadFailed: accessLoadFailed && !isUsageLoading,
    billingStatus,
    waitingSince,
    now,
  });
  const prices = usePlayPrices(view.kind === 'free');

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
  // "Unlocking Pro" becomes "Pro is on its way" once the wait passes 30 s.
  useEffect(() => {
    if (view.kind !== 'confirming' || waitingSince === undefined) return;
    // Measured from the real clock: `now` dates from when the screen last rendered, often long
    // before the purchase started waiting.
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, waitingSince + CONFIRMING_MS - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [view.kind, waitingSince, now]);
  // A purchase that unlocks while the screen is open says so at the bottom (B5's toast).
  const previousKind = useRef(view.kind);
  useEffect(() => {
    const was = previousKind.current;
    previousKind.current = view.kind;
    if (
      (was === 'confirming' || was === 'on-its-way' || was === 'payment-pending') &&
      view.kind === 'pro-play'
    )
      showToast(t('proToast'), 'success');
  }, [view.kind, t]);

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
      if (isCurrent()) showToast((error as Error).message, 'error');
    } finally {
      if (isCurrent()) {
        activeAction.current = null;
        setBusy(false);
      }
    }
  };
  const openPlans = (placement: 'billing' | 'limit') => {
    void run(async () => {
      await register({
        placement:
          placement === 'limit'
            ? SUPERWALL_PLACEMENTS.cloudUsageLimitReached
            : SUPERWALL_PLACEMENTS.accountBillingOpen,
        params: usage ? buildUsageGateParams(usage) : undefined,
      });
    });
  };
  const restore = () => {
    void run(async (isCurrent) => {
      const restored = await restoreAndroidPurchases();
      if (!isCurrent()) return;
      // Pending results change this screen's state; the other two confirm at the bottom.
      if (restored === 'restored') showToast(t('restored'), 'success');
      else if (restored === 'none') showToast(t('noPurchase'), 'neutral');
    });
  };
  const openPlay = () => void run(() => Linking.openURL(PLAY_SUBSCRIPTIONS));
  const help = () => router.push('/(account)/help');
  const signIn = () => router.push('/auth?reason=plan');

  // The bubble's Go Pro opens this screen with the out-of-words paywall over it, once.
  const paywallOpened = useRef(false);
  useEffect(() => {
    if (openPaywall !== 'limit' || paywallOpened.current || view.kind !== 'free') return;
    paywallOpened.current = true;
    openPlans('limit');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPaywall, view.kind]);

  const date = (iso: string | null, short = false) =>
    iso ? formatPlanDate(iso, i18n.language, short) : null;

  let top: ReactNode = null;
  let bottom: ReactNode = null;
  switch (view.kind) {
    case 'signed-out':
    case 'session-rejected':
      top = (
        <PlanCard
          chip={{ label: t('chipNotSignedIn'), tone: 'neutral' }}
          title={t('signInTitle')}
          body={t('signInBody')}
        />
      );
      top = (
        <>
          {top}
          <PillAction primary label={t('signIn')} onPress={signIn} />
        </>
      );
      break;
    case 'loading':
    case 'load-failed':
      top = (
        <View style={[edgeCard, { padding: 16, gap: 12 }]}>
          <Text accessibilityLiveRegion="polite" style={[type.footnote, { fontSize: 14 }]}>
            {t(view.kind === 'loading' ? 'checkingPlan' : 'planUnavailable')}
          </Text>
          {view.kind === 'loading' && <ActivityIndicator color={c.accent} />}
        </View>
      );
      if (view.kind === 'load-failed')
        bottom = (
          <PillAction
            primary
            label={t('tryAgain')}
            busy={busy || isUsageLoading}
            onPress={() => {
              void run(async (isCurrent) => {
                const result = await useUsageStore.getState().load(true);
                if (isCurrent()) setAccessLoadFailed(result.status !== 'loaded');
              });
            }}
          />
        );
      break;
    case 'free': {
      const out = view.outOfWords;
      top = (
        <>
          <PlanCard
            chip={{ label: t('chipYourPlan'), tone: 'neutral' }}
            title={t('free')}
            body={out ? t('freeOutBody') : t('freeBody', { limit: usage!.limit.toLocaleString() })}
            usage={usage}
          />
          {prices.unavailable ? (
            <>
              <View
                accessibilityLiveRegion="polite"
                style={[edgeCard, { padding: 14, flexDirection: 'row', gap: 10 }]}
              >
                <SystemIcon
                  name="exclamationmark.circle"
                  mdName="CircleAlert"
                  size={18}
                  color={th.tokens.amber}
                />
                <Text style={[type.footnote, { flex: 1 }]}>{t('storeUnavailable')}</Text>
              </View>
              <PillAction
                icon="RotateCw"
                label={t('tryAgain')}
                busy={prices.loading}
                onPress={prices.retry}
              />
            </>
          ) : (
            !out && (
              <Group title={t('proAdds')}>
                <ListRow icon="Cloud" title={t('addWords')} subtitle={t('addWordsBody')} />
                <ListRow
                  icon="PenLine"
                  title={t('addAssistant')}
                  subtitle={t('addAssistantBody')}
                />
                <ListRow
                  icon="MonitorSmartphone"
                  title={t('addDevices')}
                  subtitle={t('addDevicesBody')}
                />
                <ListRow
                  icon="UsersRound"
                  title={t('addMeetings')}
                  subtitle={t('addMeetingsBody')}
                />
              </Group>
            )
          )}
        </>
      );
      if (!prices.unavailable)
        bottom = (
          <>
            <PillAction
              primary
              label={t(out ? 'goUnlimited' : 'seeProPlans')}
              busy={busy}
              onPress={() => openPlans(out ? 'limit' : 'billing')}
            />
            {!out && (
              <Text
                style={[type.footnote, { fontSize: 12, textAlign: 'center', color: c.tertiary }]}
              >
                {t('cancelAnytime')}
              </Text>
            )}
            <LinkText label={t('restorePurchases')} disabled={busy} onPress={restore} />
          </>
        );
      break;
    }
    case 'confirming':
      top = (
        <>
          <PlanCard
            chip={{ label: t('chipConfirming'), tone: 'accent' }}
            title={t('unlockingTitle')}
            body={t('unlockingBody')}
            footer={<ConfirmingBar />}
          />
          <Group>
            <ListRow leading={<StepTile done />} title={t('paidWithPlay')} trailing={null} />
            <ListRow
              leading={<StepTile />}
              title={t('addingPro')}
              subtitle={t('addingProBody')}
              trailing={null}
            />
          </Group>
        </>
      );
      bottom = <LinkText label={t('getHelp')} onPress={help} />;
      break;
    case 'payment-pending':
      top = (
        <>
          <PlanCard
            chip={{ label: t('chipPaymentPending'), tone: 'amber' }}
            title={t('pendingTitle')}
            body={t('pendingBody')}
          />
          <PillAction icon="ExternalLink" label={t('openGooglePlay')} onPress={openPlay} />
        </>
      );
      bottom = <LinkText label={t('getHelp')} onPress={help} />;
      break;
    case 'on-its-way':
      top = (
        <>
          <PlanCard
            chip={{ label: t('chipTakingLonger'), tone: 'amber' }}
            title={t('onItsWayTitle')}
            body={t('onItsWayBody')}
          />
          <PillAction
            primary
            label={t('checkAgain')}
            busy={busy}
            onPress={() => {
              void run(async () => {
                await refreshAndroidBillingAccess();
              });
            }}
          />
        </>
      );
      bottom = <LinkText label={t('contactSupport')} onPress={help} />;
      break;
    case 'pro-play': {
      const renews = date(view.periodEnd);
      const price =
        view.interval === 'annual'
          ? prices.prices?.annual && t('priceYear', { price: prices.prices.annual })
          : view.interval === 'monthly'
            ? prices.prices?.monthly && t('priceMonth', { price: prices.prices.monthly })
            : null;
      top = (
        <>
          <PlanCard
            chip={{ label: t('chipYourPlan'), tone: 'neutral' }}
            title={t('pro')}
            body={
              renews
                ? price
                  ? t('renewsPrice', { date: renews, price })
                  : t('renews', { date: renews })
                : undefined
            }
            usage={usage}
          />
          <Group title={t('subscription')}>
            <ListRow
              icon="ExternalLink"
              title={t('manageSubscription')}
              subtitle={t('manageSubscriptionBody')}
              onPress={openPlay}
            />
            <ListRow icon="RotateCw" title={t('restorePurchases')} onPress={restore} />
            <ListRow icon="CircleHelp" title={t('getHelp')} onPress={help} />
          </Group>
        </>
      );
      break;
    }
    case 'pro-play-cancelled': {
      const ends = date(view.periodEnd, true);
      top = (
        <>
          <PlanCard
            chip={{
              label: ends ? t('chipEnds', { date: ends }) : t('chipActionNeeded'),
              tone: 'amber',
            }}
            title={ends ? t('cancelledTitle', { date: ends }) : t('cancelledTitleNoDate')}
            body={t('cancelledBody')}
            usage={usage}
          />
          <PillAction primary label={t('keepPro')} onPress={openPlay} />
        </>
      );
      bottom = <LinkText label={t('getHelp')} onPress={help} />;
      break;
    }
    case 'pro-play-problem':
      top = (
        <>
          <PlanCard
            chip={{ label: t('chipActionNeeded'), tone: 'amber' }}
            title={t('problemTitle')}
            body={t('problemBody')}
            usage={usage}
          />
          <PillAction primary label={t('fixPayment')} onPress={openPlay} />
        </>
      );
      bottom = <LinkText label={t('getHelp')} onPress={help} />;
      break;
    case 'pro-web': {
      const renews = date(view.periodEnd);
      top = (
        <>
          <PlanCard
            chip={{ label: t('chipYourPlan'), tone: 'neutral' }}
            title={t('pro')}
            body={renews ? t('webRenews', { date: renews }) : t('webBody')}
            usage={usage}
          />
          <Group title={t('subscription')}>
            <ListRow
              icon="Globe"
              title={t('manageWeb')}
              subtitle={t('manageWebBody')}
              trailing={<SmallIcon />}
              onPress={() => {
                void run(async (isCurrent) => {
                  const url = await createStripeBillingPortalSession();
                  if (isCurrent()) await Linking.openURL(url);
                });
              }}
            />
            <ListRow icon="CircleHelp" title={t('getHelp')} onPress={help} />
          </Group>
        </>
      );
      break;
    }
    case 'business-workspace':
      top = (
        <>
          <PlanCard
            chip={{ label: t('chipBusiness'), tone: 'accent' }}
            title={t('workspaceTitle')}
            body={t('workspaceBody')}
            usage={usage}
          />
          <Group title={t('workspace')}>
            <ListRow
              icon="Building2"
              title={t('workspaceRow')}
              subtitle={t('workspaceRowBody')}
              trailing={null}
            />
            <ListRow icon="CircleHelp" title={t('getHelp')} onPress={help} />
          </Group>
        </>
      );
      break;
    case 'pro-app-store':
      top = (
        <>
          <PlanCard
            chip={{ label: t('chipYourPlan'), tone: 'neutral' }}
            title={t('pro')}
            body={t('appStoreBody')}
            usage={usage}
          />
          <Group title={t('subscription')}>
            <ListRow
              icon="Smartphone"
              title={t('billedByApple')}
              subtitle={t('billedByAppleBody')}
              trailing={null}
            />
            <ListRow icon="CircleHelp" title={t('getHelp')} onPress={help} />
          </Group>
        </>
      );
      break;
    case 'pro-other': {
      const ends = date(view.trialEnd);
      top = (
        <>
          <PlanCard
            chip={{ label: t('chipYourPlan'), tone: 'neutral' }}
            title={view.plan === 'business' ? t('business') : t('pro')}
            body={ends ? t('trialEnds', { date: ends }) : undefined}
            usage={usage}
          />
          <Group>
            <ListRow icon="RotateCw" title={t('restorePurchases')} onPress={restore} />
            <ListRow icon="CircleHelp" title={t('getHelp')} onPress={help} />
          </Group>
        </>
      );
      break;
    }
  }
  return (
    // SettingsPage already pads 16; the scroll view spans that gutter and pads itself, so cards
    // line up with the back button and their shadows aren't cut at the sides.
    <ScrollView
      style={{ marginHorizontal: -16, marginTop: -16 }}
      contentContainerStyle={{
        flexGrow: 1,
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 24 + (buttons ? 0 : inset),
        gap: 20,
      }}
    >
      <View style={{ gap: 20 }} testID={`plan-${planKindTestId(view)}`}>
        {top}
      </View>
      <View style={{ flex: 1 }} />
      {bottom && <View style={{ gap: 8 }}>{bottom}</View>}
    </ScrollView>
  );
}

function planKindTestId(view: PlanView): string {
  return view.kind === 'free' && view.outOfWords ? 'free-out' : view.kind;
}

/** The indeterminate bar under "Unlocking Pro". */
function ConfirmingBar() {
  return (
    <View style={{ marginTop: 4 }}>
      <ProgressBar />
    </View>
  );
}

/** A step of "Unlocking Pro": a green tick once done, a clock while it runs. */
function StepTile({ done }: { done?: boolean }) {
  const th = useTheme();
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: done ? th.tokens.successFill : th.tokens.selFill,
      }}
    >
      <SystemIcon
        name="circle"
        mdName={done ? 'Check' : 'Clock'}
        size={18}
        color={done ? th.tokens.success : th.tokens.accent}
      />
    </View>
  );
}

/** The small "opens outside" mark on Manage on openwhispr.com. */
function SmallIcon() {
  const { c } = useHome();
  return <SystemIcon name="arrow.up.right" mdName="ExternalLink" size={16} color={c.tertiary} />;
}
