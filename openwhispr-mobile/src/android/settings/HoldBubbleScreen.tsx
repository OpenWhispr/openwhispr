import { Group, ListRow, SettingsPage } from './kit';
import { useSettingsT } from './strings';
import { setHoldAction, useHoldAction, type HoldAction } from './bubbleAppearance';

const CHOICES: { value: HoldAction; label: 'holdShowMenu' | 'holdNothing' }[] = [
  { value: 'menu', label: 'holdShowMenu' },
  { value: 'nothing', label: 'holdNothing' },
];

/** Settings → Bubble → Hold the bubble. A tap always dictates; this decides what a hold does. */
export default function HoldBubbleScreen() {
  const t = useSettingsT();
  const current = useHoldAction((s) => s.value);
  return (
    <SettingsPage title={t('holdBubble')}>
      <Group title={t('holdGroup')} inset={14} footer={t('holdFooter')}>
        {CHOICES.map(({ value, label }) => (
          <ListRow
            key={value}
            title={t(label)}
            selected={current === value}
            trailing={null}
            onPress={() => setHoldAction(value)}
          />
        ))}
      </Group>
    </SettingsPage>
  );
}
