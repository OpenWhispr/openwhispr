import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, View } from 'react-native';
import { router } from 'expo-router';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { switchWorkflowMode } from '@/lib/workflowModeSwitch.android';
import { getPreferredTranscriptionLanguages } from '@/lib/transcriptionLanguage';
import { home } from '../home/kit';
import { speechModelSupportsLanguages } from '../speechCapabilities';
import type { AndroidSpeechModelId } from '../speechSelection';
import { ANDROID_MODELS, type AndroidModelId } from '../models';
import { Group, ListRow, SettingsPage, settings, useReduceMotion } from './kit';
import { SpeechModelSheet } from './ModelSheet';
import { MODEL_ROWS, formatSize, modelName, useModelsReady, type ModelKind } from './modelCatalog';
import { useSettingsT, type SettingsKey } from './strings';

/** The selected row's check, landing (200 ms) when the choice changes. */
function LandingCheck({ shown, reduceMotion }: { shown: boolean; reduceMotion: boolean }) {
  const value = useRef(new Animated.Value(shown ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(value, {
      toValue: shown ? 1 : 0,
      duration: reduceMotion ? 0 : 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [shown, reduceMotion, value]);
  return (
    <Animated.View
      style={{
        width: 28,
        alignItems: 'center',
        opacity: value,
        transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
      }}
    >
      <SystemIcon name="checkmark" mdName="Check" size={22} color={home.accent} />
    </Animated.View>
  );
}

/** A row value that lifts 6 px into place (200 ms ease-out) when it changes, e.g. Download → Ready. */
function LiftValue({
  text,
  accent,
  reduceMotion,
}: {
  text: string;
  accent: boolean;
  reduceMotion: boolean;
}) {
  const value = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current || reduceMotion) {
      first.current = false;
      return;
    }
    value.setValue(0);
    Animated.timing(value, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [text, reduceMotion, value]);
  return (
    <Animated.Text
      style={[
        settings.rowValue,
        settings.tabular,
        accent && { color: home.accent },
        {
          opacity: value,
          transform: [
            { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) },
          ],
        },
      ]}
    >
      {text}
    </Animated.Text>
  );
}

const KIND_ICON = { speech: 'AudioLines', text: 'Sparkles', diarization: 'UsersRound' } as const;
const KIND_TITLE: Record<ModelKind, SettingsKey> = {
  speech: 'speech',
  text: 'textCleanup',
  diarization: 'meetingSpeakers',
};

/**
 * Settings → Processing: the one place cloud and on-device split. Choosing On this phone with no
 * speech model opens the download sheet; the switch completes once a model is ready.
 */
export default function ProcessingScreen() {
  const t = useSettingsT();
  const reduceMotion = useReduceMotion();
  const config = useConfigStore((s) => s.config);
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const { ready, checked, progress } = useModelsReady();
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const speechId: AndroidSpeechModelId = config?.androidSpeechModel ?? 'parakeet-v3';
  const textId: AndroidModelId = config?.androidTextModel ?? 'qwen-balanced';

  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      Alert.alert(t('errorTitle'), (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const goLocal = () => void run(() => switchWorkflowMode('dictation', 'local'));

  const chooseLocal = () => {
    // Until the phone's models are checked, a missing model can't be told from an unchecked one.
    if (!checked) return;
    const languages = getPreferredTranscriptionLanguages();
    const usable = MODEL_ROWS.filter(
      (row) =>
        row.kind === 'speech' &&
        ready[row.id] &&
        speechModelSupportsLanguages(row.id as AndroidSpeechModelId, languages),
    ).map((row) => row.id as AndroidSpeechModelId);
    if (!usable.length) {
      setSheet(true);
      return;
    }
    void run(async () => {
      if (!usable.includes(speechId))
        await useConfigStore.getState().updateConfig({ androidSpeechModel: usable[0] });
      await switchWorkflowMode('dictation', 'local');
    });
  };

  const modes = [
    {
      mode: 'cloud',
      icon: 'Cloud',
      title: 'cloud',
      body: 'cloudBody',
      choose: () => void run(() => switchWorkflowMode('dictation', 'openwhispr')),
    },
    {
      mode: 'private',
      icon: 'Smartphone',
      title: 'thisPhone',
      body: 'thisPhoneBody',
      choose: chooseLocal,
    },
    {
      mode: 'providers',
      icon: 'KeyRound',
      title: 'ownKey',
      body: 'ownKeyBody',
      choose: () =>
        router.push({ pathname: '/(account)/ai-workflow', params: { scope: 'dictation' } }),
    },
  ] as const;

  const modelValue = (id: AndroidModelId) =>
    progress[id] !== undefined
      ? `${Math.min(99, Math.round(progress[id]! * 100))}%`
      : !checked
        ? ''
        : ready[id]
          ? t('ready')
          : t('download');

  return (
    <SettingsPage title={t('processing')}>
      <Group title={t('whereProcessed')}>
        {modes.map(({ mode, icon, title, body, choose }) => (
          <ListRow
            key={mode}
            icon={icon}
            title={t(title)}
            subtitle={t(body)}
            selected={activeMode === mode}
            trailing={<LandingCheck shown={activeMode === mode} reduceMotion={reduceMotion} />}
            onPress={activeMode === mode && mode !== 'providers' ? undefined : choose}
          />
        ))}
      </Group>

      {activeMode === 'private' && (
        <Group title={t('onDeviceModels')}>
          {(['speech', 'text', 'diarization'] as const).map((kind) => {
            const id = kind === 'speech' ? speechId : kind === 'text' ? textId : 'meeting-speakers';
            const row = MODEL_ROWS.find((item) => item.id === id)!;
            const value = modelValue(id);
            return (
              <ListRow
                key={kind}
                icon={KIND_ICON[kind]}
                title={t(KIND_TITLE[kind])}
                subtitle={
                  kind === 'diarization'
                    ? `${t('meetingSpeakersBody')} · ${formatSize(ANDROID_MODELS[id].bytes)}`
                    : `${modelName(id)} · ${ready[id] && row.line ? t(row.line) : formatSize(ANDROID_MODELS[id].bytes)}`
                }
                trailing={
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <LiftValue text={value} accent={!ready[id]} reduceMotion={reduceMotion} />
                    <SystemIcon
                      name="chevron.right"
                      mdName="ChevronRight"
                      size={20}
                      color={home.tertiary}
                    />
                  </View>
                }
                onPress={() => router.push({ pathname: '/android-model', params: { kind } })}
              />
            );
          })}
        </Group>
      )}

      <Group title={t('advanced')}>
        {activeMode === 'private' && (
          <ListRow
            icon="Smartphone"
            title={t('checkPhone')}
            subtitle={t('checkPhoneBody')}
            onPress={() => router.push('/(account)/device-check')}
          />
        )}
        <ListRow
          icon="SlidersHorizontal"
          title={t('customize')}
          subtitle={t('customizeBody')}
          onPress={() => router.push('/android-tasks')}
        />
      </Group>

      <SpeechModelSheet visible={sheet} onClose={() => setSheet(false)} onReady={goLocal} />
    </SettingsPage>
  );
}
