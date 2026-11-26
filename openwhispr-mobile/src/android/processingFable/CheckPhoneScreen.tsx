import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Text } from '@/components/ui/Text';
import { useAuthStore } from '@/android/store/useAuthStore';
import { useConfigStore } from '@/android/store/useConfigStore';
import { useHome } from '../home/kit';
import { waitForForeground } from '../DeviceCheckScreen';
import {
  readDeviceProfile,
  runLocalBenchmark,
  snapshotBenchmark,
  validateBenchmark,
  type BenchmarkStage,
  type LocalBenchmark,
} from '../deviceCheck';
import { Group, ListRow, PillAction, SettingsPage, useSettings } from '../settings/kit';
import { ResultTimes } from '../settings/ResultTimes';
import { modelName } from '../settings/modelCatalog';
import { useFableT } from './strings';
import { ProgressBar } from '../controls';

const STAGES: BenchmarkStage[] = ['preparingSample', 'processing', 'cleanup'];

/** A card of plain text, as the result's words show. */
function TextCard({ title, text }: { title: string; text: string }) {
  const settings = useSettings();
  const { type, card: cardStyle } = useHome();
  return (
    <View style={{ gap: 12 }}>
      <Text accessibilityRole="header" style={type.section}>
        {title}
      </Text>
      <View style={[cardStyle, { paddingHorizontal: 16, paddingVertical: 14 }]}>
        <Text selectable style={[settings.title, { fontWeight: '400' }]}>
          {text}
        </Text>
      </View>
    </View>
  );
}

/**
 * 8.9–8.12 Check this phone, restyled (copied from the v1 test build): what the phone reports, then a short recording run
 * through the selected speech and text models on the phone (three steps, Cancel stops it), then
 * the times and the words. The benchmark itself is the existing one (deviceCheck.ts).
 */
export default function CheckPhoneScreen() {
  const t = useFableT();
  const settings = useSettings();
  const { c: home, type, card: cardStyle } = useHome();
  const { t: shared } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const speechModel = config?.androidSpeechModel ?? 'parakeet-v3';
  const textModel = config?.androidTextModel ?? 'qwen-balanced';
  const [profile, setProfile] = useState(readDeviceProfile);
  const [result, setResult] = useState<LocalBenchmark | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<BenchmarkStage>('preparingSample');
  const [fileName, setFileName] = useState('');
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
      pickedUri = picked.canceled ? undefined : picked.assets[0]?.uri;
      if (controller.signal.aborted || !focused.current || !pickedUri) return;
      setFileName(picked.canceled ? '' : (picked.assets[0]?.name ?? ''));
      setBusy(true);
      await waitForForeground(controller.signal);
      if (controller.signal.aborted || !focused.current) return;
      const info = await FileSystem.getInfoAsync(pickedUri);
      if (!info.exists || info.isDirectory || info.size > 25 * 1024 * 1024)
        throw new Error(shared('benchmarkLength'));
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
  const step = STAGES.indexOf(stage) + 1;
  const heat =
    profile?.thermalStatus === null || profile?.thermalStatus === undefined
      ? t('heatUnknown')
      : profile.thermalStatus >= 3
        ? t('heatHot')
        : t('heatNormal');

  if (busy)
    return (
      <SettingsPage title={t('checkPhone')}>
        <View style={[cardStyle, { paddingHorizontal: 16, paddingVertical: 14, gap: 8 }]}>
          <Text style={settings.title} accessibilityLiveRegion="polite">
            {shared(stage)}
          </Text>
          {fileName ? <Text style={settings.subtitle}>{fileName}</Text> : null}
          <ProgressBar value={step / STAGES.length} />
          <Text style={[settings.subtitle, settings.tabular]}>
            {t('stepOf', { step, count: STAGES.length })}
          </Text>
        </View>
        <PillAction label={t('cancel')} onPress={cancel} />
      </SettingsPage>
    );

  if (result) {
    const faster = result.totalMs <= result.durationMs;
    return (
      <SettingsPage title={t('checkPhone')}>
        <ResultTimes
          times={{
            recording: result.durationMs,
            speech: result.speechMs,
            cleanup: result.cleanupMs,
            total: result.totalMs,
          }}
        />
        <Text style={[type.subhead, { color: home.text, paddingHorizontal: 4, marginTop: -8 }]}>
          {t(faster ? 'fasterThanSpoke' : 'slowerThanSpoke')}
        </Text>
        <TextCard title={t('recognizedWords')} text={result.transcript} />
        <TextCard title={t('afterCleanup')} text={result.cleanedText} />
        <View style={{ paddingBottom: 4 }}>
          <PillAction label={t('testAnother')} onPress={() => void run()} />
        </View>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title={t('checkPhone')}>
      <Text style={[type.subhead, { color: home.text, paddingHorizontal: 4 }]}>
        {shared('deviceCheckBody')}
      </Text>
      <Group title={profile ? `${profile.manufacturer} ${profile.model}` : undefined} inset={16}>
        {profile ? (
          [
            <ListRow
              key="memory"
              title={t('memoryNow')}
              value={`${gib(profile.availableMemoryBytes)} / ${gib(profile.totalMemoryBytes)} GiB`}
              trailing={null}
            />,
            <ListRow
              key="space"
              title={t('freeSpaceModels')}
              value={`${gib(profile.freeStorageBytes)} GiB`}
              trailing={null}
            />,
            <ListRow
              key="android"
              title={t('androidVersion', { version: profile.androidVersion })}
              value={t('coresValue', { count: profile.cpuCores })}
              valueAccent
              trailing={null}
            />,
            <ListRow key="heat" title={t('heat')} value={heat} trailing={null} />,
          ]
        ) : (
          <ListRow title={shared('deviceInfoUnavailable')} trailing={null} />
        )}
      </Group>
      <PillAction label={shared('refreshDevice')} onPress={() => setProfile(readDeviceProfile())} />
      <Group title={shared('benchmarkTitle')} inset={16} footer={t('recordingHint')}>
        <ListRow
          title={`${modelName(speechModel)} + ${modelName(textModel)}`}
          subtitle={t('usesSelected')}
          trailing={null}
        />
      </Group>
      {error ? (
        <Text accessibilityRole="alert" style={[settings.subtitle, { color: home.error }]}>
          {error}
        </Text>
      ) : null}
      <View style={{ paddingBottom: 4 }}>
        <PillAction primary label={shared('benchmarkStart')} onPress={() => void run()} />
      </View>
    </SettingsPage>
  );
}
