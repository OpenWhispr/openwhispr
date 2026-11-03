import { useEffect, useState } from 'react';
import { AppState, View, Switch, Alert, PermissionsAndroid, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { AndroidDictation, dictationEvents } from '../../modules/android-dictation/src';
import { Page, Card, Button, Row, styles } from './ui';
import { LanguageSheet } from './LanguageSheet';
export function PermissionsContent() {
  const { t } = useTranslation();
  const [status, setStatus] = useState(AndroidDictation!.getStatus());
  const config = useConfigStore((s) => s.config);
  const [choosingTarget, setChoosingTarget] = useState(false);
  const [enabling, setEnabling] = useState(false);
  useEffect(() => {
    const service = dictationEvents?.addListener('onStatusChange', () =>
      setStatus(AndroidDictation!.getStatus()),
    );
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setStatus(AndroidDictation!.getStatus());
    });
    return () => {
      sub.remove();
      service?.remove();
    };
  }, []);
  const enable = async (value: boolean) => {
    if (enabling) return;
    setEnabling(true);
    try {
      if (value) {
        const mic = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
        if (mic !== PermissionsAndroid.RESULTS.GRANTED) throw new Error(t('permissionDenied'));
        if (Number(Platform.Version) >= 33)
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      }
      AndroidDictation!.setEnabled(value, config?.androidBubbleSize ?? 64);
      setTimeout(() => setStatus(AndroidDictation!.getStatus()), 300);
    } catch (error) {
      Alert.alert(t('errorTitle'), (error as Error).message);
    } finally {
      setEnabling(false);
    }
  };
  return (
    <>
      <Text style={styles.body}>{t('acrossBody')}</Text>
      {(['overlay', 'insertion'] as const).map((key) => (
        <Card key={key}>
          <Text style={styles.heading}>{t(key)}</Text>
          <Text style={styles.body}>{t(`${key}Body`)}</Text>
          <Button
            secondary
            label={t(
              status[key === 'overlay' ? 'overlay' : 'accessibility'] ? 'enabled' : 'openSettings',
            )}
            onPress={() =>
              AndroidDictation!.openSettings(key === 'overlay' ? 'overlay' : 'accessibility')
            }
          />
        </Card>
      ))}
      <Card>
        <Text style={styles.heading}>{t('microphone')}</Text>
        <Text style={styles.body}>{t('microphoneBody')}</Text>
        <Text style={styles.caption}>{t(status.microphone ? 'enabled' : 'disabled')}</Text>
        <Row title={t('openSettings')} onPress={() => AndroidDictation!.openSettings('app')} />
      </Card>
      <Card>
        <View style={styles.row}>
          <Text style={{ flex: 1, fontSize: 17 }}>{t('background')}</Text>
          <Switch
            accessibilityLabel={t('background')}
            value={status.enabled}
            disabled={enabling}
            onValueChange={(value) => {
              void enable(value);
            }}
          />
        </View>
        <Text style={styles.caption}>{t('size')}</Text>
        <View style={styles.row}>
          {([48, 64, 80] as const).map((size, index) => (
            <Button
              key={size}
              secondary
              label={t(['small', 'medium', 'large'][index])}
              onPress={() => {
                useConfigStore.getState().updateConfig({ androidBubbleSize: size });
                if (status.enabled) {
                  AndroidDictation!.setEnabled(true, size);
                }
              }}
            />
          ))}
        </View>
        <Button
          secondary
          label={t('translateInto', {
            language: config?.androidTranslationTarget?.label ?? 'Spanish',
          })}
          onPress={() => setChoosingTarget(true)}
        />
      </Card>
      <LanguageSheet
        visible={choosingTarget}
        selected={config?.androidTranslationTarget?.code ?? 'es'}
        allowAuto={false}
        onClose={() => setChoosingTarget(false)}
        onSelect={(code, label) => {
          void useConfigStore
            .getState()
            .updateConfig({ androidTranslationTarget: { code, label } });
        }}
      />
      <Card>
        <Text style={styles.heading}>{t('reliability')}</Text>
        <Text style={styles.body}>{t('reliabilityBody')}</Text>
        <Button
          secondary
          label={t('openSettings')}
          onPress={() => AndroidDictation!.openSettings('battery')}
        />
      </Card>
    </>
  );
}
export default function PermissionsScreen() {
  const { t } = useTranslation();
  return (
    <Page title={t('permissions')} back>
      <PermissionsContent />
    </Page>
  );
}
