import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AppState,
  Image,
  PermissionsAndroid,
  Platform,
  useWindowDimensions,
  View,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import {
  AndroidDictation,
  dictationEvents,
  type BubbleStatus,
} from '../../../modules/android-dictation/src';
import { useHomeT } from './strings';
import { IconTile, PILL_ICON_CHROME_COMPACT, PillButton, useHome } from './kit';
import { Toggle } from '../settings/kit';
import { missingPermissions, PERMISSION_ICON, PERMISSION_LABEL, type Permission } from './model';

const GLOSSY_ICON = require('./assets/glossy-icon.png');
const FULL_WIDTH = { flex: 0, alignSelf: 'stretch' as const };
/** Screen width (dp) at or below which the two bubble-card buttons always stack. */
export const STACK_BUTTONS_AT_OR_BELOW = 360;

const readStatus = (): BubbleStatus | null => AndroidDictation?.getStatus() ?? null;

/** The bubble's switch and permission health, refreshed whenever Android may have changed them. */
export function useBubbleStatus() {
  const [status, setStatus] = useState(readStatus);
  const refresh = useCallback(() => setStatus(readStatus()), []);
  useEffect(() => {
    const service = dictationEvents?.addListener('onStatusChange', refresh);
    const app = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      service?.remove();
      app.remove();
    };
  }, [refresh]);
  const focused = useIsFocused();
  useEffect(() => {
    if (focused) refresh();
  }, [focused, refresh]);
  return { status, refresh };
}

async function requestMicrophone(): Promise<boolean> {
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/** Grants one permission: the microphone in-app, the rest on Android's own settings screens. */
export async function grantPermission(permission: Permission): Promise<void> {
  if (permission === 'overlay') AndroidDictation?.openSettings('overlay');
  else if (permission === 'accessibility') AndroidDictation?.openSettings('accessibility');
  // "Don't ask again" makes the request return at once; Android's app page still works.
  else if (!(await requestMicrophone())) AndroidDictation?.openSettings('app');
}

export function BubbleCard({
  busy,
  onDictate,
  onUpload,
}: {
  /** Dictating or uploading: both buttons dim; their labels never change. */
  busy: boolean;
  onDictate: () => void;
  onUpload: () => void;
}) {
  const t = useHomeT();
  const { t: tAndroid } = useTranslation();
  const { c, type, card } = useHome();
  const { status, refresh } = useBubbleStatus();
  const bubbleSize = useConfigStore((s) => s.config?.androidBubbleSize ?? 64);
  const [switching, setSwitching] = useState(false);
  // Tap to dictate and Upload audio share a row on screens wider than 360 dp (the Galaxy A73 is
  // 384 dp at its default display size), with compact padding, and only when both labels fit
  // on one line; otherwise (smaller phones, enlarged text, longer translations) they stack.
  const { fontScale, width } = useWindowDimensions();
  const [rowWidth, setRowWidth] = useState(0);
  const [labelWidth, setLabelWidth] = useState(0);
  const pairLabels = [t('dictate'), t('uploadAudio')];
  const fits =
    !rowWidth || !labelWidth || labelWidth <= (rowWidth - 8) / 2 - PILL_ICON_CHROME_COMPACT;
  const stacked = width <= STACK_BUTTONS_AT_OR_BELOW || fontScale > 1.15 || !fits;
  const pairStyle = stacked ? FULL_WIDTH : undefined;
  const missing = missingPermissions(status);
  const needsPermission = missing.length > 0;
  const on = Boolean(status?.enabled) && !needsPermission;

  const setEnabled = async (value: boolean) => {
    if (switching || !AndroidDictation) return;
    if (value && needsPermission) {
      await grantPermission(missing[0]).catch((error: Error) =>
        Alert.alert(tAndroid('errorTitle'), error.message),
      );
      refresh();
      return;
    }
    setSwitching(true);
    try {
      if (value && Number(Platform.Version) >= 33)
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      AndroidDictation.setEnabled(value, bubbleSize);
      setTimeout(refresh, 300);
    } catch (error) {
      Alert.alert(tAndroid('errorTitle'), (error as Error).message);
    } finally {
      setSwitching(false);
    }
  };

  const title = on ? t('bubbleOn') : t('bubbleOff');
  const subtitle = needsPermission
    ? missing.length === 1
      ? t('needsOnePermission')
      : t('needsPermissions', { count: missing.length })
    : on
      ? t('bubbleOnBody')
      : t('bubbleOffBody');

  return (
    <View style={[card, { padding: 14, gap: 14 }]}>
      <View
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        onLayout={({ nativeEvent }) => setLabelWidth(Math.ceil(nativeEvent.layout.width))}
        style={{ position: 'absolute', top: 0, left: 0, opacity: 0, alignItems: 'flex-start' }}
      >
        {pairLabels.map((label) => (
          <Text key={label} numberOfLines={1} style={type.subhead}>
            {label}
          </Text>
        ))}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {/* The glossy mark while the bubble is on; a grey tile while it is off. */}
        {on ? (
          <Image
            source={GLOSSY_ICON}
            style={{ width: 36, height: 36 }}
            accessibilityIgnoresInvertColors
            accessible={false}
          />
        ) : (
          <IconTile icon="AudioLines" color={c.secondary} />
        )}
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.rowTitle}>{title}</Text>
          <Text
            accessibilityLiveRegion="polite"
            style={[type.footnote, needsPermission && { color: c.accent }]}
          >
            {subtitle}
          </Text>
        </View>
        <Toggle
          label={t('bubble')}
          value={on}
          disabled={switching || !status}
          onValueChange={(value) => {
            void setEnabled(value);
          }}
        />
      </View>
      {/* Keyed, so the ask's glass button is never re-rendered into Dictate (see PillButton). */}
      {needsPermission ? (
        <View key="permission" style={{ gap: 10 }}>
          <PillButton
            primary
            icon={PERMISSION_ICON[missing[0]]}
            label={t(PERMISSION_LABEL[missing[0]])}
            onPress={() => {
              grantPermission(missing[0])
                .then(refresh)
                .catch((error: Error) => Alert.alert(tAndroid('errorTitle'), error.message));
            }}
            style={FULL_WIDTH}
          />
          <PillButton
            icon="FileUp"
            label={t('uploadAudio')}
            disabled={busy}
            onPress={onUpload}
            style={FULL_WIDTH}
          />
        </View>
      ) : (
        <View
          key="actions"
          onLayout={({ nativeEvent }) => setRowWidth(Math.round(nativeEvent.layout.width))}
          style={{ flexDirection: stacked ? 'column' : 'row', gap: stacked ? 10 : 8 }}
        >
          <PillButton
            icon="Mic"
            label={t('dictate')}
            disabled={busy}
            onPress={onDictate}
            compact={!stacked}
            style={pairStyle}
          />
          <PillButton
            icon="FileUp"
            label={t('uploadAudio')}
            disabled={busy}
            onPress={onUpload}
            compact={!stacked}
            style={pairStyle}
          />
        </View>
      )}
    </View>
  );
}
