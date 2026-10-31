import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { useAuthStore } from '@/store/useAuthStore';
import { ANDROID_MODELS } from './models';
import { Button, Card, Page, Row, styles, palette } from './ui';
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
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  return (
    <Page title={t('deviceCheck')} back>
      <Text style={styles.body}>{t('deviceCheckBody')}</Text>
      <Card>
        <Text style={styles.heading}>
          {profile ? `${profile.manufacturer} ${profile.model}` : t('deviceInfoUnavailable')}
        </Text>
        {profile ? (
          <>
            <Text style={styles.body}>
              {t('deviceMemory', {
                free: gib(profile.availableMemoryBytes),
                total: gib(profile.totalMemoryBytes),
              })}
            </Text>
            <Text style={styles.body}>
              {t('deviceStorage', { free: gib(profile.freeStorageBytes) })}
            </Text>
            <Text style={styles.caption}>
              {t('deviceSystem', { version: profile.androidVersion, cores: profile.cpuCores })}
            </Text>
            <Text style={styles.caption}>
              {t(
                profile.thermalStatus === null
                  ? 'deviceHeatUnknown'
                  : profile.thermalStatus >= 3
                    ? 'deviceHot'
                    : 'deviceHeatNormal',
              )}
            </Text>
          </>
        ) : null}
        <Button
          secondary
          disabled={busy}
          label={t('refreshDevice')}
          onPress={() => setProfile(readDeviceProfile())}
        />
      </Card>
      <Card>
        <Text style={styles.heading}>{t('deviceRecommendation')}</Text>
        <Text style={styles.body}>{t(deviceGuidance(profile, result))}</Text>
        <Text style={styles.caption}>{t('deviceChoiceUnchanged')}</Text>
      </Card>
      <Card>
        <Text style={styles.heading}>{t('benchmarkTitle')}</Text>
        <Text style={styles.body}>
          {ANDROID_MODELS[speechModel].title} + {ANDROID_MODELS[textModel].title}
        </Text>
        <Text style={styles.body}>{t('benchmarkBody')}</Text>
        <Text style={styles.caption}>{t('benchmarkPrivacy')}</Text>
        {busy ? (
          <>
            <ActivityIndicator color={palette.blue} accessibilityLabel={t(stage)} />
            <Text accessibilityLiveRegion="polite">{t(stage)}</Text>
            <Button secondary label={t('cancel')} onPress={cancel} />
          </>
        ) : (
          <Button
            label={t('benchmarkStart')}
            onPress={() => {
              void run();
            }}
          />
        )}
        {error ? (
          <Text accessibilityRole="alert" style={styles.body}>
            {error}
          </Text>
        ) : null}
      </Card>
      {result ? (
        <Card>
          <Text style={styles.heading}>{t('benchmarkResult')}</Text>
          <Text style={styles.body}>
            {ANDROID_MODELS[result.selection.speech].title} +{' '}
            {ANDROID_MODELS[result.selection.text].title}
          </Text>
          <Text style={styles.body}>
            {t('benchmarkTiming', {
              duration: seconds(result.durationMs),
              speech: seconds(result.speechMs),
              cleanup: seconds(result.cleanupMs),
              total: seconds(result.totalMs),
            })}
          </Text>
          <Text style={styles.caption}>{t('benchmarkTimingHint')}</Text>
          <Text style={styles.heading}>{t('benchmarkTranscript')}</Text>
          <Text selectable style={styles.body}>
            {result.transcript}
          </Text>
          <Text style={styles.heading}>{t('benchmarkCleaned')}</Text>
          <Text selectable style={styles.body}>
            {result.cleanedText}
          </Text>
          <Text style={styles.caption}>{t('benchmarkAccuracy')}</Text>
        </Card>
      ) : null}
      <Row title={t('models')} onPress={() => router.replace('/(account)/ai-models')} />
      <Row
        title={t('workflow')}
        onPress={() =>
          router.push({ pathname: '/(account)/ai-workflow', params: { scope: 'dictation' } })
        }
      />
    </Page>
  );
}
