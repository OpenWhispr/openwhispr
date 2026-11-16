import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Image, PermissionsAndroid, Platform, Switch, View } from 'react-native';
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
import { home, PillButton, type } from './kit';
import { missingPermissions, PERMISSION_LABEL, type Permission } from './model';

const GLOSSY_ICON = require('./assets/glossy-icon.png');

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
  tryItLabel,
  tryItDisabled,
  onTryIt,
  uploadLabel,
  uploadDisabled,
  onUpload,
}: {
  tryItLabel: string;
  tryItDisabled: boolean;
  onTryIt: () => void;
  uploadLabel: string;
  uploadDisabled: boolean;
  onUpload: () => void;
}) {
  const t = useHomeT();
  const { t: tAndroid } = useTranslation();
  const { status, refresh } = useBubbleStatus();
  const bubbleSize = useConfigStore((s) => s.config?.androidBubbleSize ?? 64);
  const [switching, setSwitching] = useState(false);
  const missing = missingPermissions(status);
  const needsPermission = missing.length > 0;
  const on = Boolean(status?.enabled) && !needsPermission;

  const setEnabled = async (value: boolean) => {
    if (switching || !AndroidDictation) return;
    if (value && needsPermission) {
      await grantPermission(missing[0]).catch((error: Error) =>
        Alert.alert(tAndroid('errorTitle'), error.message),
      );
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
        backgroundColor: needsPermission ? home.warningBackground : home.surface,
        borderRadius: 20,
        padding: 16,
        gap: 14,
        boxShadow: home.cardShadow,
      }}
    >
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
            style={[type.footnote, needsPermission && { color: home.warning }]}
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
        <>
          <PillButton
            primary
            label={t(PERMISSION_LABEL[missing[0]])}
            onPress={() => {
              grantPermission(missing[0]).catch((error: Error) =>
                Alert.alert(tAndroid('errorTitle'), error.message),
              );
            }}
            style={{ flex: 0, alignSelf: 'stretch' }}
          />
          <PillButton
            icon="FileUp"
            label={uploadLabel}
            disabled={uploadDisabled}
            onPress={onUpload}
            style={{ flex: 0, alignSelf: 'stretch' }}
          />
        </>
      ) : (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <PillButton icon="Mic" label={tryItLabel} disabled={tryItDisabled} onPress={onTryIt} />
          <PillButton
            icon="FileUp"
            label={uploadLabel}
            disabled={uploadDisabled}
            onPress={onUpload}
          />
        </View>
      )}
    </View>
  );
}

/** The upload under way, under the bubble card. */
export function UploadProgress({
  fileName,
  cleaning,
  onCancel,
}: {
  fileName: string;
  cleaning: boolean;
  onCancel: () => void;
}) {
  const t = useHomeT();
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
          <SystemIcon name="doc" mdName="FileAudio" size={20} color={home.accent} />
        </View>
        <Text numberOfLines={1} style={[type.headline, { flex: 1 }]}>
          {fileName || t('yourRecording')}
        </Text>
      </View>
      <View
        style={{ height: 6, borderRadius: 999, backgroundColor: home.fill, overflow: 'hidden' }}
      >
        <View
          style={{
            width: cleaning ? '80%' : '45%',
            height: 6,
            borderRadius: 999,
            backgroundColor: home.accent,
          }}
        />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text accessibilityLiveRegion="polite" style={type.footnote}>
          {cleaning ? t('tidyingUp') : t('writingItUp')}
        </Text>
        <Text
          accessibilityRole="button"
          onPress={onCancel}
          suppressHighlighting
          style={[type.footnote, { color: home.tertiary, paddingVertical: 8, paddingLeft: 16 }]}
        >
          {t('cancel')}
        </Text>
      </View>
    </View>
  );
}
