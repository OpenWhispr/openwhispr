import React, { useCallback, useEffect } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { router } from 'expo-router';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { PlanBadge } from '@/components/ui/PlanBadge';
import { GradientGlassSurface } from '@/components/ui/GradientGlassSurface';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';
import { confirmAccountDeletion, confirmDestructive } from '@/lib/alerts';
import { safeHaptics } from '@/lib/utils';
import { getAccountDisplay } from '@/lib/accountDisplay';

export default function ProfileScreen() {
  const { user, isGuest, signOut, deleteAccount } = useAuthStore();
  // See AccountScreen: an anonymous session gets Create Account, not Sign Out
  // (which would revoke it) or Delete Account (which the API refuses).
  const isAnonymous = user?.isAnonymous === true;
  const usage = useUsageStore((s) => s.usage);
  const loadUsage = useUsageStore((s) => s.load);

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

  const handleDeleteAccount = useCallback(() => {
    if (!user) return;
    confirmAccountDeletion(deleteAccount);
  }, [deleteAccount, user]);

  const { initials, name: displayName } = getAccountDisplay(
    user,
    isGuest,
    'Local notes and private workflows only',
  );
  const email = user?.email;

  return (
    <SettingsScreen>
      <View className="items-center px-6 pb-6 pt-4">
        <View
          style={{ borderCurve: 'continuous' }}
          className="h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-brand"
        >
          <GradientGlassSurface shape="circle" />
          <Text className="text-[28px] font-semibold text-white tracking-tight">{initials}</Text>
        </View>
        <View className="mt-3 flex-row items-center gap-2">
          <Text className="shrink text-[22px] font-semibold text-label tracking-tight">
            {displayName}
          </Text>
          {user ? <PlanBadge usage={usage} /> : null}
        </View>
        {email ? (
          <Text className="mt-1 text-[15px] text-secondaryLabel">{email}</Text>
        ) : (
          <Text className="mt-1 text-[15px] text-secondaryLabel">
            Local notes and private workflows only
          </Text>
        )}
      </View>

      {user ? (
        <SettingsSection>
          <SettingsRow
            iconStyle="line"
            icon="gift"
            mdIcon="Gift"
            title="Referral Code"
            onPress={() => router.push('/(tabs)/(referral)')}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection>
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
        <SettingsSection>
          <SettingsRow
            iconStyle="line"
            icon="trash"
            mdIcon="Trash2"
            title="Delete Account"
            destructive
            onPress={handleDeleteAccount}
            showChevron={false}
          />
        </SettingsSection>
      ) : null}
    </SettingsScreen>
  );
}
