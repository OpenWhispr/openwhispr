import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { home, type } from '../home/kit';
import {
  BottomSheet,
  Group,
  ListRow,
  PillAction,
  SettingsPage,
  TextAction,
  showToast,
} from './kit';
import { noOrphan, useSettingsT } from './strings';
import { PERMISSION_ROWS, requestRuntime, usePermissions, type PermissionKey } from './permissions';

/**
 * Settings → Permissions: live status rows. A row that's off opens the one place Android lets you
 * turn it on (asking in-app first where Android can); an On row opens the same page.
 */
export default function SettingsPermissionsScreen() {
  const t = useSettingsT();
  const { granted, refresh } = usePermissions();
  const [explainInsertion, setExplainInsertion] = useState(false);
  // Says so at the bottom when something comes back on from Android's settings.
  const before = useRef(granted);
  useEffect(() => {
    for (const { key, title } of PERMISSION_ROWS)
      if (granted[key] && !before.current[key]) showToast(t('permissionOn', { name: t(title) }));
    before.current = granted;
  });

  const open = async (key: PermissionKey) => {
    const on = granted[key];
    if (key === 'microphone' || key === 'notifications') {
      // Android shows its own dialog once; after "Don't allow" only the app page can change it.
      if (on || !(await requestRuntime(key))) AndroidDictation?.openSettings('app');
      refresh();
    } else if (key === 'overlay') AndroidDictation?.openSettings('overlay');
    else if (key === 'background') AndroidDictation?.openSettings('battery');
    else if (on) AndroidDictation?.openSettings('accessibility');
    else setExplainInsertion(true);
  };

  return (
    <SettingsPage title={t('permissions')}>
      <Group title={t('theBubbleNeeds')}>
        {PERMISSION_ROWS.map(({ key, title, body, icon }) => (
          <ListRow
            key={key}
            icon={icon}
            title={t(title)}
            subtitle={t(body)}
            value={granted[key] ? t('on') : t('turnOn')}
            valueAccent={!granted[key]}
            onPress={() => {
              void open(key);
            }}
          />
        ))}
      </Group>
      <BottomSheet
        visible={explainInsertion}
        onClose={() => setExplainInsertion(false)}
        title={t('insertionNoticeTitle')}
        body={t('insertionNotice')}
      >
        <View style={{ gap: 12 }}>
          <Text textBreakStrategy="balanced" style={[type.subhead, { color: home.secondary }]}>
            {noOrphan(t('insertionNoticeSteps'))}
          </Text>
          <PillAction
            primary
            label={t('continue')}
            onPress={() => {
              setExplainInsertion(false);
              AndroidDictation?.openSettings('accessibility');
            }}
          />
          <TextAction label={t('notNow')} onPress={() => setExplainInsertion(false)} />
        </View>
      </BottomSheet>
    </SettingsPage>
  );
}
