import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, View } from 'react-native';
import { router } from 'expo-router';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { cloudAccessFor } from '@/lib/aiWorkflows';
import { providerDisplayName } from '@/android/providers/mobileProviders';
import { switchWorkflowMode } from '@/lib/workflowModeSwitch.android';
import type { AndroidSpeechModelId } from '../speechSelection';
import { ANDROID_MODELS, type AndroidModelId } from '../models';
import { Badge, Group, ListRow, SettingsPage, useReduceMotion, useSettings } from './kit';
import { useKeyCheckColors } from './KeyCheckMark';
import type { KeyProviderId } from './keyCheck';
import { KeySheet } from './KeySheet';
import { SpeechModelSheet } from './ModelSheet';
import {
  MODEL_ROWS,
  formatSize,
  meetingModelRows,
  modelName,
  useModelsReady,
  type ModelKind,
} from './modelCatalog';
import {
  KEY_PROVIDERS,
  TASKS,
  providerCanRun,
  runTaskOnKey,
  useSavedKeys,
  type KeyTask,
} from './ownKey';
import { effectiveSelection, meetingSummary, taskSummary, useChoosePhone } from './processingTasks';
import { applyDefault, useProcessingDefault } from './processingDefault';
import { useSettingsT, type SettingsKey } from './strings';

/** The selected row's check, landing (200 ms) when the choice changes. */
export function LandingCheck({ shown, reduceMotion }: { shown: boolean; reduceMotion: boolean }) {
  const { accent } = useSettings();
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
      <SystemIcon name="checkmark" mdName="Check" size={22} color={accent} />
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
  const settings = useSettings();
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
        accent && { color: settings.accent },
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

/** `meeting`: the speech model meetings on the phone transcribe with (Meeting recording). */
type PhoneKind = ModelKind | 'meeting';
const KIND_ICON = {
  speech: 'AudioLines',
  text: 'Sparkles',
  meeting: 'AudioLines',
  diarization: 'UsersRound',
} as const;
const KIND_TITLE: Record<PhoneKind, SettingsKey> = {
  speech: 'speech',
  text: 'textCleanup',
  meeting: 'meetingRecording',
  diarization: 'meetingSpeakers',
};
const TASK_TITLE: Record<KeyTask, SettingsKey> = {
  dictation: 'dictation',
  upload: 'audioUploads',
  cleanup: 'textCleanup',
  notes: 'noteFormatting',
  agent: 'assistant',
};

/**
 * Settings → Processing: one default for every task, then each task with where it runs. A task
 * moved off the default is marked Changed. The phone's models show only while a task uses them.
 */
export default function ProcessingScreen() {
  const t = useSettingsT();
  const settings = useSettings();
  const keyCheckColors = useKeyCheckColors();
  const reduceMotion = useReduceMotion();
  const config = useConfigStore((s) => s.config);
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const cloudAccess = cloudAccessFor(useAuthStore((s) => s.user));
  const keys = useSavedKeys();
  const { ready, checked, progress } = useModelsReady();
  const { choosePhone, run, needsModel, closeModelSheet, goLocal } = useChoosePhone(t);
  const [sheet, setSheet] = useState(false);

  const defaults = useProcessingDefault();
  const meeting = meetingSummary(t, config, defaults);
  // Your own key as the Default: the key used as the Default before, else any saved key that
  // can transcribe; with none saved, the key sheet opens and makes the key it saves the Default.
  const chooseKey = () => {
    const provider =
      (defaults.providerId && keys[defaults.providerId] ? defaults.providerId : undefined) ??
      KEY_PROVIDERS.find(({ id }) => keys[id] && providerCanRun(id, 'dictation'))?.id;
    if (defaults.mode === 'providers' || !provider) {
      setSheet(true);
      return;
    }
    void run(() => applyDefault({ mode: 'providers', providerId: provider }));
  };

  const modes = [
    {
      mode: 'openwhispr',
      icon: 'Cloud',
      title: t('cloud'),
      body: t('cloudBody'),
      choose: () => void run(() => applyDefault({ mode: 'openwhispr' })),
    },
    {
      mode: 'local',
      icon: 'Smartphone',
      title: t('thisPhone'),
      body: t('thisPhoneBody'),
      choose: () => choosePhone(() => applyDefault({ mode: 'local' })),
    },
    {
      mode: 'providers',
      icon: 'KeyRound',
      title: t('ownKey'),
      body:
        defaults.mode === 'providers' && defaults.providerId
          ? t('providerConnected', { provider: providerDisplayName(defaults.providerId) })
          : t('ownKeyBody'),
      choose: chooseKey,
    },
  ] as const;
  const allOnDevice =
    TASKS.every(
      (task) => effectiveSelection(config, task, activeMode, cloudAccess).mode === 'local',
    ) && config?.inference?.meeting?.mode === 'local';

  // The phone's models, for the tasks that run on the phone.
  const onPhone = TASKS.filter(
    (task) => effectiveSelection(config, task, activeMode, cloudAccess).mode === 'local',
  );
  const kinds: PhoneKind[] = [
    ...(onPhone.some((task) => task === 'dictation' || task === 'upload')
      ? ['speech' as const]
      : []),
    ...(onPhone.some((task) => task === 'cleanup' || task === 'notes' || task === 'agent')
      ? ['text' as const]
      : []),
    ...(config?.inference?.meeting?.mode === 'local' ? (['meeting', 'diarization'] as const) : []),
  ];
  const meetingRows = meetingModelRows();
  const meetingId: AndroidModelId =
    meetingRows.find((row) => ready[row.id])?.id ?? meetingRows[0]?.id ?? 'parakeet-v3';
  const speechId: AndroidSpeechModelId = config?.androidSpeechModel ?? 'parakeet-v3';
  const textId: AndroidModelId = config?.androidTextModel ?? 'qwen-balanced';
  const modelValue = (id: AndroidModelId) =>
    progress[id] !== undefined
      ? `${Math.min(99, Math.round(progress[id]! * 100))}%`
      : !checked
        ? ''
        : ready[id]
          ? t('ready')
          : t('download');

  const openTask = (task: KeyTask | 'meeting') =>
    router.push({ pathname: '/android-task', params: { task } });

  return (
    <SettingsPage title={t('processing')}>
      <Group title={t('defaultForEveryTask')}>
        {modes.map(({ mode, icon, title, body, choose }) => (
          <ListRow
            key={mode}
            icon={icon}
            title={title}
            subtitle={body}
            subtitleStyle={
              mode === 'providers' && defaults.mode === 'providers'
                ? { color: keyCheckColors.connected }
                : undefined
            }
            selected={defaults.mode === mode}
            trailing={<LandingCheck shown={defaults.mode === mode} reduceMotion={reduceMotion} />}
            onPress={defaults.mode === mode && mode !== 'providers' ? undefined : choose}
          />
        ))}
      </Group>

      <Group title={t('tasks')} footer={allOnDevice ? t('allOnDevice') : undefined}>
        {TASKS.map((task) => {
          const { engine, changed } = taskSummary(
            t,
            config,
            task,
            activeMode,
            cloudAccess,
            defaults,
          );
          return (
            <ListRow
              key={task}
              title={t(TASK_TITLE[task])}
              badge={changed ? <Badge label={t('changed')} neutral /> : undefined}
              subtitle={engine}
              onPress={() => openTask(task)}
            />
          );
        })}
        <ListRow
          title={t('meetings')}
          badge={meeting.changed ? <Badge label={t('changed')} neutral /> : undefined}
          subtitle={meeting.engine}
          onPress={() => openTask('meeting')}
        />
      </Group>

      {kinds.length > 0 && (
        <Group title={t('thisPhone')}>
          {kinds.map((kind) => {
            const id =
              kind === 'speech'
                ? speechId
                : kind === 'text'
                  ? textId
                  : kind === 'meeting'
                    ? meetingId
                    : 'meeting-speakers';
            const row = MODEL_ROWS.find((item) => item.id === id)!;
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
                    <LiftValue
                      text={modelValue(id)}
                      accent={!ready[id]}
                      reduceMotion={reduceMotion}
                    />
                    <SystemIcon
                      name="chevron.right"
                      mdName="ChevronRight"
                      size={20}
                      color={settings.tertiary}
                    />
                  </View>
                }
                onPress={() => router.push({ pathname: '/android-model', params: { kind } })}
              />
            );
          })}
          <ListRow
            icon="Gauge"
            title={t('checkPhone')}
            subtitle={t('checkPhoneBody')}
            onPress={() => router.push('/(account)/device-check')}
          />
        </Group>
      )}

      <SpeechModelSheet visible={needsModel} onClose={closeModelSheet} onReady={goLocal} />
      <KeySheet
        visible={sheet}
        onClose={() => setSheet(false)}
        initialProvider={defaults.providerId ?? 'openai'}
        asDefault
      />
    </SettingsPage>
  );
}
