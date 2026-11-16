import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  Easing,
  Image,
  PermissionsAndroid,
  Platform,
  Switch,
  useWindowDimensions,
  View,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useConfigStore } from '@/store/useConfigStore';
import {
  AndroidDictation,
  dictationEvents,
  type BubbleStatus,
} from '../../../modules/android-dictation/src';
import { useHomeT } from './strings';
import { home, PILL_ICON_CHROME_COMPACT, PillButton, type } from './kit';
import { missingPermissions, PERMISSION_LABEL, uploadProgress, type Permission } from './model';

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
    <View
      style={{
        backgroundColor: home.surface,
        borderRadius: 20,
        padding: 16,
        gap: 14,
        boxShadow: home.cardShadow,
      }}
    >
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
        <Image
          source={GLOSSY_ICON}
          style={{ width: 40, height: 40 }}
          accessibilityIgnoresInvertColors
          accessible={false}
        />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.headline}>{title}</Text>
          <Text
            accessibilityLiveRegion="polite"
            style={[type.footnote, needsPermission && { color: home.accent }]}
          >
            {subtitle}
          </Text>
        </View>
        <Switch
          accessibilityLabel={t('bubble')}
          value={on}
          disabled={switching || !status}
          onValueChange={(value) => {
            void setEnabled(value);
          }}
          trackColor={{ false: home.fill, true: home.accent }}
          thumbColor="#FFFFFF"
        />
      </View>
      {needsPermission ? (
        <View style={{ gap: 10 }}>
          <PillButton
            primary
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

/** What is being written up, in one full-width card under the bubble card. Text wraps. */
export function ProgressCard({
  icon,
  title,
  footer,
  sizeBytes,
  cleaning,
  done,
  onCancel,
}: {
  /** What is being written up: a dictation (waveform) or an uploaded file. */
  icon: 'AudioLines' | 'FileUp';
  title: string;
  footer: string;
  sizeBytes?: number;
  cleaning: boolean;
  /** The text has arrived: fill the bar before the card goes. */
  done: boolean;
  onCancel?: () => void;
}) {
  const t = useHomeT();
  const fill = useRef(new Animated.Value(0)).current;
  const startedAt = useRef(Date.now());
  const cleaningSince = useRef<number | undefined>(undefined);
  if (cleaning && cleaningSince.current === undefined) cleaningSince.current = Date.now();
  useEffect(() => {
    const step = () => {
      const now = Date.now();
      Animated.timing(fill, {
        toValue: uploadProgress({
          elapsedMs: now - startedAt.current,
          sizeBytes,
          cleaningMs: cleaningSince.current === undefined ? undefined : now - cleaningSince.current,
          done,
        }),
        duration: done ? 250 : 200,
        easing: Easing.linear,
        useNativeDriver: false,
      }).start();
    };
    step();
    if (done) return;
    const timer = setInterval(step, 200);
    return () => clearInterval(timer);
  }, [fill, sizeBytes, cleaning, done]);
  return (
    <View
      style={{
        backgroundColor: home.surface,
        borderWidth: 1,
        borderColor: home.borderSubtle,
        borderRadius: 14,
        padding: 16,
        gap: 8,
        boxShadow: home.cardShadow,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            backgroundColor: home.tint,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <SystemIcon name="doc" mdName={icon} size={22} color={home.accent} />
        </View>
        <Text style={[type.headline, { flex: 1 }]}>{title}</Text>
      </View>
      <View
        style={{ height: 6, borderRadius: 999, backgroundColor: home.fill, overflow: 'hidden' }}
      >
        <Animated.View
          style={{
            width: fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            height: 6,
            borderRadius: 999,
            backgroundColor: home.accent,
          }}
        />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Text accessibilityLiveRegion="polite" style={[type.footnote, { flex: 1 }]}>
          {footer}
        </Text>
        {onCancel ? (
          <Text
            accessibilityRole="button"
            onPress={onCancel}
            suppressHighlighting
            style={{ fontSize: 15, lineHeight: 20, color: home.accent, paddingVertical: 12 }}
          >
            {t('cancel')}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
