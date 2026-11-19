import { useRef } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { useConfigStore } from '@/store/useConfigStore';
import { applyHistoryRetention } from '../pipeline';
import { Group, ListRow, SettingsPage, showToast } from './kit';
import { useSettingsT, type SettingsKey } from './strings';

const PERIODS: { days: number; label: SettingsKey }[] = [
  { days: -1, label: 'forever' },
  { days: 30, label: 'thirtyDays' },
  { days: 7, label: 'sevenDays' },
  { days: 0, label: 'dontSave' },
];

/** Settings → Keep history. Only a choice that deletes something asks first. */
export default function HistoryScreen() {
  const t = useSettingsT();
  const current = useConfigStore((s) => s.config?.androidHistoryDays ?? -1);

  // One save at a time: history is pruned only after the choice is saved.
  const pending = useRef(false);
  const apply = async (days: number, deletes: boolean) => {
    if (pending.current) return;
    pending.current = true;
    try {
      await useConfigStore.getState().updateConfig({ androidHistoryDays: days });
      const error = useConfigStore.getState().error;
      if (error) throw new Error(error);
      await applyHistoryRetention();
      if (deletes) showToast(t('olderDeleted'));
      router.back();
    } catch (error) {
      showToast((error as Error).message, 'error');
    } finally {
      pending.current = false;
    }
  };

  const choose = (days: number, label: SettingsKey) => {
    if (days === current) return;
    // Longer than now deletes nothing.
    const deletes = days === 0 || (days > 0 && (current === -1 || days < current));
    if (!deletes) {
      void apply(days, false);
      return;
    }
    Alert.alert(
      t(days === 0 ? 'stopSavingTitle' : 'deleteOlderTitle'),
      days === 0 ? t('stopSavingBody') : t('deleteOlderBody', { period: t(label) }),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t(days === 0 ? 'deleteAll' : 'delete'),
          style: 'destructive',
          onPress: () => void apply(days, true),
        },
      ],
    );
  };

  return (
    <SettingsPage title={t('keepHistory')}>
      <Group title={t('keepDictationHistory')} inset={14} footer={t('historyFooter')}>
        {PERIODS.map(({ days, label }) => (
          <ListRow
            key={days}
            title={t(label)}
            selected={current === days}
            trailing={null}
            onPress={() => choose(days, label)}
          />
        ))}
      </Group>
    </SettingsPage>
  );
}
