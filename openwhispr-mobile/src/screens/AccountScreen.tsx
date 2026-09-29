import React, { useCallback, useEffect, useRef } from 'react';
import { Alert, Platform, View, Pressable } from 'react-native';
import { Text } from '@/components/ui/Text';
import Constants from 'expo-constants';
import { router, useLocalSearchParams } from 'expo-router';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { PlanBadge } from '@/components/ui/PlanBadge';
import { UsageMeter } from '@/components/ui/UsageMeter';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { GlassBackButton } from '@/components/ui/GlassBackButton';
import { TabScreenHeader } from '@/components/ui/TabScreenHeader';
import { GradientGlassSurface } from '@/components/ui/GradientGlassSurface';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import type { UsageInfo } from '@/data/remote/usageApi';
import { createStripeBillingPortalSession } from '@/data/remote/billingApi';
import { ApiError } from '@/lib/apiClient';
import { openExternal, openMail } from '@/lib/openExternal';
import { getAppStorefrontCountryCode, showAppStoreManageSubscriptions } from '@/lib/revenuecat';
import { confirmAccountDeletion, confirmDestructive } from '@/lib/alerts';
import { safeHaptics } from '@/lib/utils';
import { iosColor } from '@/config/colors';
import { getAccountDisplay } from '@/lib/accountDisplay';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';

const MUTED_ICON_BG = iosColor('systemGray2');
const SHOW_GOOGLE_CALENDAR_INTEGRATION = Platform.OS === 'ios';
const APP_STORE_SUBSCRIPTIONS_URL = 'itms-apps://apps.apple.com/account/subscriptions';
const SUPPORT_EMAIL = 'support@openwhispr.com';
const SUPPORT_SUBJECT = 'OpenWhispr Billing Support';
const US_APP_STORE_COUNTRY_CODE = 'USA';
const WEB_SUBSCRIPTION_SUPPORT_COPY =
  "You can't make changes to your plan in the app. We know it's not ideal. Contact OpenWhispr Support for help with cancellation or billing.";

type SubscriptionManagementProvider = 'app-store' | 'web' | 'unknown';

function getSubscriptionManagementProvider(usage: UsageInfo): SubscriptionManagementProvider {
  const sources = usage.entitlementSources;
  if (!sources) return 'unknown';
  if (sources.provider) return 'app-store';
  if (sources.personal || sources.workspaceIds.length > 0) return 'web';
  return 'unknown';
}

function showWebSubscriptionSupport(): void {
  Alert.alert('Manage Subscription', WEB_SUBSCRIPTION_SUPPORT_COPY, [
    {
      text: 'Contact Support',
      onPress: () => {
        openMail(SUPPORT_EMAIL, SUPPORT_SUBJECT).catch(() => {});
      },
    },
    { text: 'Done', style: 'cancel' },
  ]);
}

async function openAppStoreManagement(): Promise<void> {
  if (await showAppStoreManageSubscriptions()) return;
  await openExternal(
    APP_STORE_SUBSCRIPTIONS_URL,
    'Open Settings > Apple Account > Subscriptions to manage mobile purchases.',
  );
}

async function openBillingManagement(usage: UsageInfo): Promise<void> {
  const provider = getSubscriptionManagementProvider(usage);
  if (provider === 'app-store') {
    await openAppStoreManagement();
    return;
  }
  if (provider === 'unknown') {
    showWebSubscriptionSupport();
    return;
  }

  const storefrontCountryCode = await getAppStorefrontCountryCode();
  if (storefrontCountryCode !== US_APP_STORE_COUNTRY_CODE) {
    showWebSubscriptionSupport();
    return;
  }

  let portalUrl: string;
  try {
    portalUrl = await createStripeBillingPortalSession();
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      showWebSubscriptionSupport();
      return;
    }
    Alert.alert("Couldn't Open Billing", 'Please try again in a moment.');
    return;
  }

  useUsageStore.getState().beginBillingSession();
  const didOpenPortal = await openExternal(portalUrl, 'Could not open the billing portal.');
  if (!didOpenPortal) useUsageStore.getState().endBillingSession();
}

async function openGrantedBillingManagement(usage: UsageInfo): Promise<void> {
  if (usage.isSubscribed) {
    await openBillingManagement(usage);
    return;
  }

  if (Platform.OS === 'ios') {
    await openAppStoreManagement();
    return;
  }

  showWebSubscriptionSupport();
}

export default function AccountScreen() {
  const params = useLocalSearchParams<{ superwallPlacement?: string }>();
  const { user, isGuest, signOut, deleteAccount } = useAuthStore();
  // An anonymous onboarding session: Sign Out would revoke it (and the notes
  // and purchase it carries) and the API refuses to delete it, so the one
  // account action it needs is creating the account.
  const isAnonymous = user?.isAnonymous === true;
  const usage = useUsageStore((s) => s.usage);
  const loadUsage = useUsageStore((s) => s.load);
  const resetOnboarding = useOnboardingStore((state) => state.reset);
  const { register: registerSuperwallGate } = useSuperwallGate();
  const handledBillingIntentRef = useRef<string | null>(null);

  useEffect(() => {
    if (user) loadUsage();
  }, [user, loadUsage]);

  const handleSignOut = useCallback(() => {
    confirmDestructive(
      user ? 'Sign Out' : 'Leave Guest Mode',
      user ? 'Are you sure you want to sign out?' : 'Return to sign in?',
      async () => {
        safeHaptics('warning');
        await signOut();
      },
      { destructiveLabel: user ? 'Sign Out' : 'Continue' },
    );
  }, [signOut, user]);

  const handleBillingPress = useCallback(async (): Promise<void> => {
    let currentUsage = useUsageStore.getState().usage;
    if (user && !currentUsage) {
      const loadResult = await loadUsage(true);
      currentUsage = loadResult.usage ?? useUsageStore.getState().usage;
      if (!currentUsage) {
        Alert.alert("Couldn't Load Billing", 'Please try again in a moment.');
        return;
      }
    }

    const managementUsage = currentUsage;

    await registerSuperwallGate({
      placement: SUPERWALL_PLACEMENTS.accountBillingOpen,
      params: currentUsage
        ? {
            plan: currentUsage.plan,
            status: currentUsage.status,
            isSubscribed: currentUsage.isSubscribed,
            isTrial: currentUsage.isTrial,
          }
        : undefined,
      onAccessGrantedWithoutPurchase: managementUsage
        ? () => {
            openGrantedBillingManagement(managementUsage).catch(() => {});
          }
        : undefined,
      onPurchaseComplete: (completion) => {
        router.replace({
          pathname: '/(tabs)/(record)',
          params: { proCompletion: completion },
        });
      },
    });
  }, [loadUsage, registerSuperwallGate, user]);

  useEffect(() => {
    if (!user || params.superwallPlacement !== SUPERWALL_PLACEMENTS.accountBillingOpen) return;
    const intentKey = `${user.id}:${params.superwallPlacement}`;
    if (handledBillingIntentRef.current === intentKey) return;
    handledBillingIntentRef.current = intentKey;
    handleBillingPress().catch(() => {});
  }, [handleBillingPress, params.superwallPlacement, user]);

  const {
    initials,
    name: accountName,
    subtitle: accountSubtitle,
  } = getAccountDisplay(user, isGuest);

  return (
    <View className="flex-1 bg-systemBackground">
      <TabScreenHeader
        title="Account"
        left={<GlassBackButton fallbackRoute="/(tabs)/(record)" />}
      />
      <SettingsScreen>
        {(user || isGuest) && (
          <Pressable
            onPress={() => router.push('/(account)/profile')}
            className="active:opacity-70"
          >
            <View
              style={{ borderCurve: 'continuous' }}
              className="mx-4 mb-5 flex-row items-center gap-3 rounded-[14px] p-3.5"
            >
              <View className="h-11 w-11 items-center justify-center overflow-hidden rounded-full bg-brand">
                <GradientGlassSurface shape="circle" />
                <Text className="text-[17px] font-semibold text-white tracking-tight">
                  {isGuest ? 'G' : initials}
                </Text>
              </View>
              <View className="flex-1">
                <View className="flex-row items-center gap-2">
                  <Text numberOfLines={1} className="shrink text-[17px] font-semibold text-label">
                    {accountName}
                  </Text>
                  {user ? <PlanBadge usage={usage} /> : null}
                </View>
                <Text numberOfLines={1} className="mt-0.5 text-sm text-secondaryLabel">
                  {accountSubtitle}
                </Text>
              </View>
              <SystemIcon
                name="chevron.right"
                mdName="ChevronRight"
                size={13}
                color="tertiaryLabel"
              />
            </View>
          </Pressable>
        )}

        {user && usage ? (
          <SettingsSection title="Usage">
            <UsageMeter usage={usage} />
          </SettingsSection>
        ) : null}

        <SettingsSection title="Preferences">
          <SettingsRow
            iconStyle="line"
            icon="brain.head.profile"
            mdIcon="Brain"
            title="AI Models"
            onPress={() => router.push('/(account)/ai-models')}
          />
          <SettingsRow
            iconStyle="line"
            icon="slider.horizontal.3"
            mdIcon="SlidersHorizontal"
            title="Preferences"
            onPress={() => router.push('/(account)/preferences')}
          />
          <SettingsRow
            iconStyle="line"
            icon="lock.shield"
            mdIcon="ShieldCheck"
            title="Privacy & Data"
            onPress={() => router.push('/(account)/privacy')}
          />
        </SettingsSection>

        {user && SHOW_GOOGLE_CALENDAR_INTEGRATION ? (
          <SettingsSection title="Integrations">
            <SettingsRow
              iconStyle="line"
              icon="calendar"
              mdIcon="CalendarDays"
              title="Google Calendar"
              onPress={() => router.push('/(account)/google-calendar')}
            />
          </SettingsSection>
        ) : null}

        <SettingsSection title="Subscription">
          <SettingsRow
            iconStyle="line"
            icon="creditcard"
            mdIcon="CreditCard"
            title="Plans & Billing"
            onPress={() => {
              handleBillingPress().catch(() => {});
            }}
          />
        </SettingsSection>

        <SettingsSection title="Support">
          <SettingsRow
            iconStyle="line"
            icon="envelope"
            mdIcon="Mail"
            title="Send Feedback"
            onPress={() => openMail(SUPPORT_EMAIL, 'OpenWhispr Mobile Feedback')}
            showChevron={false}
          />
          <SettingsRow
            iconStyle="line"
            icon="exclamationmark.triangle"
            mdIcon="AlertTriangle"
            title="Report a Bug"
            onPress={() => openMail(SUPPORT_EMAIL, 'OpenWhispr Mobile Bug Report')}
            showChevron={false}
          />
        </SettingsSection>

        <SettingsSection title="Onboarding">
          <SettingsRow
            icon="arrow.counterclockwise"
            mdIcon="RotateCcw"
            iconBg={MUTED_ICON_BG}
            title="Reset onboarding"
            subtitle="Replays the welcome flow on next launch"
            onPress={() => {
              confirmDestructive(
                'Reset onboarding?',
                'You will see the onboarding flow again on next app launch.',
                async () => {
                  await resetOnboarding();
                  Alert.alert('Done', 'Restart the app to replay onboarding.');
                },
                { destructiveLabel: 'Reset' },
              );
            }}
            showChevron={false}
          />
        </SettingsSection>

        <SettingsSection title="About">
          <SettingsRow
            iconStyle="line"
            icon="info.circle"
            mdIcon="Info"
            title="Version"
            subtitle={Constants.expoConfig?.version ?? 'unknown'}
            showChevron={false}
          />
          <SettingsRow
            iconStyle="line"
            icon="doc.text"
            mdIcon="FileText"
            title="Terms of Service"
            onPress={() => openExternal('https://openwhispr.com/terms')}
            showChevron={false}
          />
          <SettingsRow
            iconStyle="line"
            icon="hand.raised"
            mdIcon="Hand"
            title="Privacy Policy"
            onPress={() => openExternal('https://openwhispr.com/privacy')}
            showChevron={false}
          />
          <SettingsRow
            iconStyle="line"
            icon="text.badge.checkmark"
            mdIcon="ScrollText"
            title="Licenses & Attribution"
            onPress={() => router.push('/(account)/licenses')}
          />
        </SettingsSection>

        <SettingsSection borderless>
          {isAnonymous ? (
            <SettingsRow
              iconStyle="line"
              icon="person.crop.circle.badge.plus"
              mdIcon="UserPlus"
              title="Create Account"
              onPress={() => router.push('/auth')}
              showChevron={false}
            />
          ) : (
            <SettingsRow
              iconStyle="line"
              icon={user ? 'rectangle.portrait.and.arrow.right' : 'person.crop.circle.badge.plus'}
              mdIcon={user ? 'LogOut' : 'UserPlus'}
              title={user ? 'Sign Out' : 'Sign In'}
              destructive={!!user}
              onPress={handleSignOut}
              showChevron={false}
            />
          )}
        </SettingsSection>

        {user && !isAnonymous ? (
          <SettingsSection borderless>
            <SettingsRow
              iconStyle="line"
              icon="trash"
              mdIcon="Trash2"
              title="Delete Account"
              destructive
              onPress={() => confirmAccountDeletion(deleteAccount)}
              showChevron={false}
            />
          </SettingsSection>
        ) : null}
      </SettingsScreen>
    </View>
  );
}
