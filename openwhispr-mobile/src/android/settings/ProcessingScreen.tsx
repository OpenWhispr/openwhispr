import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, View } from 'react-native';
import { router } from 'expo-router';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { cloudAccessFor } from '@/lib/aiWorkflows';
import { providerDisplayName } from '@/lib/mobileProviders';
import { switchWorkflowMode } from '@/lib/workflowModeSwitch.android';
import { home } from '../home/kit';
import type { AndroidSpeechModelId } from '../speechSelection';
import { ANDROID_MODELS, type AndroidModelId } from '../models';
import { Badge, Group, ListRow, SettingsPage, settings, useReduceMotion } from './kit';
import { KEY_CHECK_COLORS } from './KeyCheckMark';
import type { KeyProviderId } from './keyCheck';
import { KeySheet } from './KeySheet';
import { SpeechModelSheet } from './ModelSheet';
import { MODEL_ROWS, formatSize, modelName, useModelsReady, type ModelKind } from './modelCatalog';
import {
  KEY_PROVIDERS,
  TASKS,
  providerCanRun,
  runTaskOnKey,
  useSavedKeys,
  type KeyTask,
} from './ownKey';
import { effectiveSelection, taskSummary, useChoosePhone } from './processingTasks';
import { useSettingsT, type SettingsKey } from './strings';

/** The selected row's check, landing (200 ms) when the choice changes. */
export function LandingCheck({ shown, reduceMotion }: { shown: boolean; reduceMotion: boolean }) {
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
const TASK_TITLE: Record<KeyTask, SettingsKey> = {
  dictation: 'dictation',
  upload: 'audioUploads',
  cleanup: 'textCleanup',
  notes: 'noteFormatting',
};

/**
 * Settings → Processing: one default for every task, then each task with where it runs. A task
 * moved off the default is marked Changed. The phone's models show only while a task uses them.
 */
export default function ProcessingScreen() {
  const t = useSettingsT();
  const reduceMotion = useReduceMotion();
  const config = useConfigStore((s) => s.config);
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const cloudAccess = cloudAccessFor(useAuthStore((s) => s.user));
  const keys = useSavedKeys();
  const { ready, checked, progress } = useModelsReady();
  const { choosePhone, run, needsModel, closeModelSheet, goLocal } = useChoosePhone(t);
  const [sheet, setSheet] = useState(false);

  const dictation = effectiveSelection(config, 'dictation', activeMode, cloudAccess);
  // Your own key as the default: the key dictation used before, else any saved key that can
  // transcribe; with none saved, the key sheet opens.
  const chooseKey = () => {
    const remembered = Object.values(config?.rememberedInference?.dictation ?? {}).find(
      (selection) => selection.mode === 'providers' && selection.providerId,
    )?.providerId as KeyProviderId | undefined;
    const provider =
      remembered && keys[remembered]
        ? remembered
        : KEY_PROVIDERS.find(({ id }) => keys[id] && providerCanRun(id, 'dictation'))?.id;
    if (activeMode === 'providers' || !provider) {
      setSheet(true);
      return;
    }
    void run(() => runTaskOnKey(provider, 'dictation'));
  };

  const modes = [
    {
      mode: 'cloud',
      icon: 'Cloud',
      title: t('cloud'),
      body: t('cloudBody'),
      choose: () => void run(() => switchWorkflowMode('dictation', 'openwhispr')),
    },
    {
      mode: 'private',
      icon: 'Smartphone',
      title: t('thisPhone'),
      body: t('thisPhoneBody'),
      choose: choosePhone,
    },
    {
      mode: 'providers',
      icon: 'KeyRound',
      title: t('ownKey'),
      body:
        activeMode === 'providers' && dictation.providerId
          ? t('providerConnected', { provider: providerDisplayName(dictation.providerId) })
          : t('ownKeyBody'),
      choose: chooseKey,
    },
  ] as const;

  // The phone's models, for the tasks that run on the phone.
  const onPhone = TASKS.filter(
    (task) => effectiveSelection(config, task, activeMode, cloudAccess).mode === 'local',
  );
  const kinds: ModelKind[] = [
    ...(onPhone.some((task) => task === 'dictation' || task === 'upload')
      ? ['speech' as const]
      : []),
    ...(onPhone.some((task) => task === 'cleanup' || task === 'notes') ? ['text' as const] : []),
    ...(activeMode === 'private' ? ['diarization' as const] : []),
  ];
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
              mode === 'providers' && activeMode === 'providers'
                ? { color: KEY_CHECK_COLORS.connected }
                : undefined
            }
            selected={activeMode === mode}
            trailing={<LandingCheck shown={activeMode === mode} reduceMotion={reduceMotion} />}
            onPress={activeMode === mode && mode !== 'providers' ? undefined : choose}
          />
        ))}
      </Group>

      <Group title={t('tasks')}>
        {TASKS.map((task) => {
          const { engine, changed } = taskSummary(t, config, task, activeMode, cloudAccess);
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
          subtitle={t(activeMode === 'private' ? 'meetingPhoneValue' : 'meetingCloudValue')}
          onPress={() => openTask('meeting')}
        />
      </Group>

      {kinds.length > 0 && (
        <Group title={t('thisPhone')}>
          {kinds.map((kind) => {
            const id = kind === 'speech' ? speechId : kind === 'text' ? textId : 'meeting-speakers';
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
                      color={home.tertiary}
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
        initialProvider={(dictation.providerId as KeyProviderId | undefined) ?? 'openai'}
      />
    </SettingsPage>
  );
}
