import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Text } from '@/components/ui/Text';
import { ResultTimes } from './settings/ResultTimes';
import { useConfigStore } from '@/store/useConfigStore';
import { useAuthStore } from '@/store/useAuthStore';
import { ANDROID_MODELS } from './models';
import { Group, ListRow, PillAction, SettingsPage, useSettings } from './settings/kit';
import { useSettingsLook } from './settings/look';
import {
  deviceGuidance,
  readDeviceProfile,
  runLocalBenchmark,
  snapshotBenchmark,
  validateBenchmark,
  type BenchmarkStage,
  type LocalBenchmark,
} from './deviceCheck';

export function waitForForeground(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Cancelled'));
  if (AppState.currentState === 'active') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      subscription.remove();
      reject(new Error('Cancelled'));
    };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        subscription.remove();
        signal.removeEventListener('abort', abort);
        resolve();
      }
    });
    signal.addEventListener('abort', abort, { once: true });
  });
}

export default function DeviceCheckScreen() {
  const { t } = useTranslation();
  const settings = useSettings();
  const { bodyText, edgeCard: cardStyle } = useSettingsLook();
  const config = useConfigStore((state) => state.config);
  const speechModel = config?.androidSpeechModel ?? 'parakeet-v3';
  const textModel = config?.androidTextModel ?? 'qwen-balanced';
  const [profile, setProfile] = useState(readDeviceProfile);
  const [result, setResult] = useState<LocalBenchmark | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<BenchmarkStage>('preparingSample');
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const focused = useRef(false);
  const picking = useRef(false);
  const cancel = useCallback(() => active.current?.abort(), []);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      setBusy(Boolean(active.current));
      setProfile(readDeviceProfile());
      return () => {
        focused.current = false;
        cancel();
        setResult(null);
      };
    }, [cancel]),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && !picking.current) cancel();
      else setProfile(readDeviceProfile());
    });
    const unsubscribe = useAuthStore.subscribe((state, previous) => {
      if (state.user?.id !== previous.user?.id) {
        cancel();
        setResult(null);
      }
    });
    return () => {
      subscription.remove();
      unsubscribe();
      cancel();
    };
  }, [cancel]);
  const run = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    let pickedUri: string | undefined;
    setBusy(true);
    setResult(null);
    setError('');
    setStage('preparingSample');
    try {
      const selection = snapshotBenchmark();
      await validateBenchmark(selection, controller.signal);
      if (controller.signal.aborted || !focused.current) return;
      picking.current = true;
      const picked = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: true,
        multiple: false,
      });
      picking.current = false;
      // Keep ownership even when cancellation arrives while the picker is open.
      pickedUri = picked.canceled ? undefined : picked.assets[0]?.uri;
      if (controller.signal.aborted || !focused.current || !pickedUri) return;
      await waitForForeground(controller.signal);
      if (controller.signal.aborted || !focused.current) return;
      const info = await FileSystem.getInfoAsync(pickedUri);
      if (!info.exists || info.isDirectory || info.size > 25 * 1024 * 1024)
        throw new Error(t('benchmarkLength'));
      const measured = await runLocalBenchmark(pickedUri, selection, controller.signal, (value) => {
        if (focused.current && !controller.signal.aborted) setStage(value);
      });
      if (!controller.signal.aborted && focused.current) {
        setResult(measured);
        setProfile(readDeviceProfile());
      }
    } catch (cause) {
      if (!controller.signal.aborted && focused.current) setError((cause as Error).message);
    } finally {
      picking.current = false;
      if (pickedUri && FileSystem.cacheDirectory && pickedUri.startsWith(FileSystem.cacheDirectory))
        await FileSystem.deleteAsync(pickedUri, { idempotent: true }).catch(() => undefined);
      active.current = null;
      if (focused.current) setBusy(false);
    }
  };
  const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return (
    <SettingsPage title={t('deviceCheck')}>
      <Text style={bodyText}>{t('deviceCheckBody')}</Text>
      <Group
        title={profile ? `${profile.manufacturer} ${profile.model}` : t('deviceInfoUnavailable')}
        inset={14}
      >
        {profile ? (
          <>
            <ListRow
              title={t('deviceMemory', {
                free: gib(profile.availableMemoryBytes),
                total: gib(profile.totalMemoryBytes),
              })}
              trailing={null}
            />
            <ListRow
              title={t('deviceStorage', { free: gib(profile.freeStorageBytes) })}
              trailing={null}
            />
            <ListRow
              title={t('deviceSystem', {
                version: profile.androidVersion,
                cores: profile.cpuCores,
              })}
              trailing={null}
            />
            <ListRow
              title={t(
                profile.thermalStatus === null
                  ? 'deviceHeatUnknown'
                  : profile.thermalStatus >= 3
                    ? 'deviceHot'
                    : 'deviceHeatNormal',
              )}
              trailing={null}
            />
          </>
        ) : null}
      </Group>
      <PillAction
        disabled={busy}
        label={t('refreshDevice')}
        onPress={() => setProfile(readDeviceProfile())}
      />
      <View style={[cardStyle, { padding: 16, gap: 4 }]}>
        <Text style={settings.rowTitle}>{t('deviceRecommendation')}</Text>
        <Text style={bodyText}>{t(deviceGuidance(profile, result))}</Text>
        <Text style={settings.subtitle}>{t('deviceChoiceUnchanged')}</Text>
      </View>
      <Group title={t('benchmarkTitle')} inset={14}>
        <ListRow
          title={`${ANDROID_MODELS[speechModel].title} + ${ANDROID_MODELS[textModel].title}`}
          subtitle={t('benchmarkBody')}
          trailing={null}
        />
      </Group>
      <Text style={[settings.subtitle, { paddingHorizontal: 4 }]}>{t('benchmarkPrivacy')}</Text>
      {busy ? (
        <View style={{ gap: 12, alignItems: 'center' }}>
          <ActivityIndicator color={settings.accent} accessibilityLabel={t(stage)} />
          <Text accessibilityLiveRegion="polite" style={bodyText}>
            {t(stage)}
          </Text>
          <View style={{ alignSelf: 'stretch' }}>
            <PillAction label={t('cancel')} onPress={cancel} />
          </View>
        </View>
      ) : (
        <PillAction
          primary
          label={t('benchmarkStart')}
          onPress={() => {
            void run();
          }}
        />
      )}
      {error ? (
        <Text accessibilityRole="alert" style={bodyText}>
          {error}
        </Text>
      ) : null}
      {result ? (
        <ResultTimes
          times={{
            recording: result.durationMs,
            speech: result.speechMs,
            cleanup: result.cleanupMs,
            total: result.totalMs,
          }}
        />
      ) : null}
      {result ? (
        <View style={[cardStyle, { padding: 16, gap: 8 }]}>
          <Text style={settings.rowTitle}>{t('benchmarkResult')}</Text>
          <Text style={bodyText}>
            {ANDROID_MODELS[result.selection.speech].title} +{' '}
            {ANDROID_MODELS[result.selection.text].title}
          </Text>
          <Text style={settings.subtitle}>{t('benchmarkTimingHint')}</Text>
          <Text style={settings.rowTitle}>{t('benchmarkTranscript')}</Text>
          <Text selectable style={bodyText}>
            {result.transcript}
          </Text>
          <Text style={settings.rowTitle}>{t('benchmarkCleaned')}</Text>
          <Text selectable style={bodyText}>
            {result.cleanedText}
          </Text>
          <Text style={settings.subtitle}>{t('benchmarkAccuracy')}</Text>
        </View>
      ) : null}
      <Group inset={14}>
        <ListRow title={t('models')} onPress={() => router.replace('/(account)/ai-models')} />
        <ListRow
          title={t('workflow')}
          onPress={() =>
            router.push({ pathname: '/(account)/ai-workflow', params: { scope: 'dictation' } })
          }
        />
      </Group>
    </SettingsPage>
  );
}
