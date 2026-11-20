import { useEffect } from 'react';
import { router } from 'expo-router';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';
import { confirmAccountDeletion } from '@/lib/alerts';
import { Group, ListRow, SettingsPage } from '@/android/settings/kit';
import { useSettingsT } from '@/android/settings/strings';

/**
 * Settings → your account: name, email and plan, then Delete account. Sign out lives at the bottom
 * of Settings. An anonymous session gets Create account instead (the API refuses its deletion).
 */
export default function ProfileScreen() {
  const t = useSettingsT();
  const { user, deleteAccount } = useAuthStore();
  const usage = useUsageStore((s) => s.usage);
  const loadUsage = useUsageStore((s) => s.load);
  const realAccount = Boolean(user && !user.isAnonymous);

  useEffect(() => {
    if (realAccount) loadUsage();
  }, [realAccount, loadUsage]);

  if (!realAccount)
    return (
      <SettingsPage title={t('profile')}>
        <Group>
          <ListRow
            icon="UserPlus"
            title={user ? t('createAccount') : t('signIn')}
            subtitle={t('createAccountBody')}
            onPress={() => router.push('/auth?reason=sync')}
          />
        </Group>
      </SettingsPage>
    );

  return (
    <SettingsPage title={t('profile')}>
      <Group title={t('account')} inset={14}>
        {user?.name ? <ListRow title={t('name')} value={user.name} trailing={null} /> : null}
        <ListRow title={t('email')} value={user?.email} trailing={null} />
        <ListRow
          title={t('plan')}
          value={
            usage ? t(usage.isSubscribed ? (usage.isTrial ? 'trial' : 'pro') : 'free') : undefined
          }
          valueAccent
          onPress={() => router.push('/android-pro')}
        />
      </Group>
      <Group inset={14}>
        <ListRow
          title={t('deleteAccount')}
          subtitle={t('deleteAccountBody')}
          destructive
          trailing={null}
          onPress={() => confirmAccountDeletion(deleteAccount)}
        />
      </Group>
    </SettingsPage>
  );
}
