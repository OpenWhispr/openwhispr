import { useState } from 'react';
import { ScrollView } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useCustomPromptsStore } from '@/store/useCustomPromptsStore';
import { resolveCustomPrompt } from '@/config/prompts/registry';
import { cloudAccessFor } from '@/lib/aiWorkflows';
import { providerDisplayName, type InferenceMode } from '@/android/providers/mobileProviders';
import { switchWorkflowMode } from '@/lib/workflowModeSwitch.android';
import { BottomSheet, Group, ListRow, SettingsPage, useReduceMotion, useSettings } from './kit';
import { useKeyCheckColors } from './KeyCheckMark';
import type { KeyProviderId } from './keyCheck';
import { KeySheet } from './KeySheet';
import { SpeechModelSheet } from './ModelSheet';
import { formatSize, meetingModelRows, modelName, useModelsReady } from './modelCatalog';
import { ANDROID_MODELS } from '../models';
import {
  KEY_PROVIDERS,
  TASKS,
  providerCanRun,
  providerModels,
  runTaskOnKey,
  useSavedKeys,
  type KeyTask,
} from './ownKey';
import { LandingCheck } from './ProcessingScreen';
import { isLiveProvider, meetingKey } from '../providers/liveMeeting';
import { effectiveSelection, phoneModelFor, useChoosePhone } from './processingTasks';
import { setTask } from './processingDefault';
import { useSettingsT, type SettingsKey } from './strings';

const TITLE: Record<KeyTask | 'meeting', SettingsKey> = {
  dictation: 'dictation',
  upload: 'audioUploads',
  cleanup: 'textCleanup',
  notes: 'noteFormatting',
  agent: 'assistant',
  meeting: 'meetings',
};

/** Picks a provider's model for a task: from its list, or typed for a provider without one. */
function ModelPicker({
  visible,
  onClose,
  provider,
  task,
  current,
  onChoose,
}: {
  visible: boolean;
  onClose: () => void;
  provider: string;
  task: KeyTask;
  current: string;
  onChoose: (model: string) => void;
}) {
  const t = useSettingsT();
  const { surface } = useSettings();
  const models = providerModels(provider, task);
  // A model chosen before that has since left the list stays on it, as the old screen did.
  const options = models.includes(current) || !current ? models : [current, ...models];
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('chooseModel')}>
      {/* OpenRouter lists twelve; the list scrolls rather than run off the screen. */}
      <ScrollView
        style={{ maxHeight: 420, borderRadius: 16, backgroundColor: surface }}
        contentContainerStyle={{ paddingBottom: 4 }}
      >
        {options.map((model) => (
          <ListRow
            key={model}
            title={model}
            selected={model === current}
            onPress={() => onChoose(model)}
          />
        ))}
      </ScrollView>
    </BottomSheet>
  );
}

/**
 * Meetings: only what can transcribe them. Live on Cloud, on this phone afterwards with speaker
 * names, or live on a saved OpenAI, Deepgram or AssemblyAI key.
 */
function MeetingsTask() {
  const t = useSettingsT();
  const keyCheckColors = useKeyCheckColors();
  const reduceMotion = useReduceMotion();
  // Read so the page follows what's saved for meetings.
  const meeting = useConfigStore((s) => s.config?.inference?.meeting);
  const keys = useSavedKeys();
  const { ready } = useModelsReady();
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  const mode = meeting?.mode ?? 'openwhispr';
  const key = meetingKey();
  const liveKeys = KEY_PROVIDERS.filter(({ id }) => keys[id] && isLiveProvider(id));
  const rows = [
    {
      key: 'cloud',
      icon: 'Cloud' as const,
      title: t('meetingCloud'),
      body: t('meetingCloudBody'),
      selected: mode === 'openwhispr',
      choose: () => void run(() => setTask('meeting', { mode: 'openwhispr' })),
    },
    {
      key: 'phone',
      icon: 'Smartphone' as const,
      title: t('meetingPhone'),
      body: t('meetingPhoneBody'),
      selected: mode === 'local',
      choose: () => void run(() => setTask('meeting', { mode: 'local' })),
    },
    ...(liveKeys.length
      ? liveKeys.map(({ id, name }) => ({
          key: id,
          icon: 'KeyRound' as const,
          title: name,
          body: t('yourKeyConnected'),
          selected: key?.providerId === id,
          choose: () => void run(() => runTaskOnKey(id, 'meeting')),
        }))
      : [
          {
            key: 'key',
            icon: 'KeyRound' as const,
            title: t('ownKey'),
            body: t('meetingOwnKeyBody'),
            selected: false,
            choose: () => setSheet(true),
          },
        ]),
  ];
  return (
    <SettingsPage title={t('meetings')}>
      <Group title={t('transcribeMeetings')}>
        {rows.map((row) => (
          <ListRow
            key={row.key}
            icon={row.icon}
            title={row.title}
            subtitle={row.body}
            subtitleStyle={
              row.selected && row.icon === 'KeyRound'
                ? { color: keyCheckColors.connected }
                : undefined
            }
            selected={row.selected}
            trailing={<LandingCheck shown={row.selected} reduceMotion={reduceMotion} />}
            onPress={row.selected ? undefined : row.choose}
          />
        ))}
        {liveKeys.length > 0 && (
          <ListRow title={t('addAnotherKey')} onPress={() => setSheet(true)} />
        )}
      </Group>
      {mode === 'local' ? (
        // S8: a meeting on the phone needs a Meeting recording model. Meeting speakers isn't
        // shown: it downloads by itself at launch (liveSpeakers/speakerModel.ts).
        <Group title={t('onDeviceModel')}>
          {meetingModelRows().map((row) => (
            <ListRow
              key={row.id}
              icon="AudioLines"
              title={modelName(row.id)}
              subtitle={`${t('meetingRecording')} · ${formatSize(ANDROID_MODELS[row.id].bytes)}`}
              value={ready[row.id] ? t('ready') : t('download')}
              valueAccent={!ready[row.id]}
              onPress={() =>
                router.push({ pathname: '/android-model', params: { kind: 'meeting' } })
              }
            />
          ))}
        </Group>
      ) : null}
      <KeySheet
        visible={sheet}
        onClose={() => setSheet(false)}
        initialProvider={
          KEY_PROVIDERS.find(({ id }) => !keys[id] && isLiveProvider(id))?.id ?? 'openai'
        }
        onlyTask="meeting"
      />
    </SettingsPage>
  );
}

/**
 * One task: where it runs (Cloud, this phone, or a saved key), then its model, then, for text
 * cleanup, its prompt. Changing it here changes only this task.
 */
function Task({ task }: { task: KeyTask }) {
  const t = useSettingsT();
  const keyCheckColors = useKeyCheckColors();
  const reduceMotion = useReduceMotion();
  const config = useConfigStore((s) => s.config);
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const cloudAccess = cloudAccessFor(useAuthStore((s) => s.user));
  const keys = useSavedKeys();
  const { choosePhone, run, needsModel, closeModelSheet, goLocal } = useChoosePhone(t);
  const [sheet, setSheet] = useState(false);
  const [picker, setPicker] = useState(false);
  const customPrompt = useCustomPromptsStore(
    (state) => resolveCustomPrompt(state.customPrompts.cleanup) !== undefined,
  );
  const selection = effectiveSelection(config, task, activeMode, cloudAccess);
  const chosen = selection.mode;
  const phoneModel = phoneModelFor(config, task);

  // Only this task changes. Speech on the phone needs a speech model first; text on the phone
  // goes through the existing switch, which offers the text model's download when it's missing.
  const choose = (mode: Exclude<InferenceMode, 'providers'>) => {
    if (mode === 'openwhispr') void run(() => setTask(task, { mode }));
    else if (task === 'dictation' || task === 'upload')
      choosePhone(() => setTask(task, { mode: 'local' }));
    else void run(() => switchWorkflowMode(task, 'local'));
  };

  const runsOn = [
    {
      key: 'openwhispr',
      icon: 'Cloud' as const,
      title: t('cloud'),
      body: undefined,
      selected: chosen === 'openwhispr',
      disabled: false,
      onPress: () => choose('openwhispr'),
    },
    {
      key: 'local',
      icon: 'Smartphone' as const,
      title: t('thisPhone'),
      body: modelName(phoneModel),
      selected: chosen === 'local',
      disabled: false,
      onPress: () => choose('local'),
    },
    ...KEY_PROVIDERS.filter(({ id }) => keys[id] && providerCanRun(id, task)).map(
      ({ id, name }) => ({
        key: id,
        icon: 'KeyRound' as const,
        title: name,
        body: t('yourKeyConnected'),
        selected: chosen === 'providers' && selection.providerId === id,
        disabled: false,
        onPress: () => void run(() => runTaskOnKey(id, task)),
      }),
    ),
    // A custom server saved on the old screen keeps its row while it's in use.
    ...(selection.mode === 'providers' && selection.providerId === 'custom'
      ? [
          {
            key: 'custom',
            icon: 'Server' as const,
            title: providerDisplayName('custom'),
            body: selection.endpoint ? new URL(selection.endpoint).host : undefined,
            selected: true,
            disabled: false,
            onPress: () => {},
          },
        ]
      : []),
  ];

  return (
    <SettingsPage title={t(TITLE[task])}>
      <Group title={t('runsOn')}>
        {runsOn.map((row) => (
          <ListRow
            key={row.key}
            icon={row.icon}
            title={row.title}
            subtitle={row.body}
            subtitleStyle={
              row.selected && row.icon === 'KeyRound'
                ? { color: keyCheckColors.connected }
                : undefined
            }
            selected={row.selected}
            dimmed={row.disabled}
            trailing={<LandingCheck shown={row.selected} reduceMotion={reduceMotion} />}
            onPress={row.selected || row.disabled ? undefined : row.onPress}
          />
        ))}
        <ListRow
          title={t('addAnotherKey')}
          onPress={() => setSheet(true)}
          accessibilityLabel={t('addAnotherKey')}
        />
      </Group>

      {selection.mode === 'providers' && selection.providerId !== 'custom' && (
        <Group title={t('model')}>
          <ListRow title={selection.modelId ?? ''} onPress={() => setPicker(true)} />
        </Group>
      )}
      {chosen === 'local' && (
        <Group title={t('model')}>
          <ListRow
            title={modelName(phoneModel)}
            onPress={() =>
              router.push({
                pathname: '/android-model',
                params: { kind: task === 'dictation' || task === 'upload' ? 'speech' : 'text' },
              })
            }
          />
        </Group>
      )}

      {task === 'cleanup' && (
        <Group title={t('prompt')}>
          <ListRow
            title={t('cleanupPrompt')}
            value={customPrompt ? t('custom') : t('default')}
            onPress={() => router.push('/(account)/cleanup-prompt')}
          />
        </Group>
      )}

      {selection.mode === 'providers' && selection.providerId && (
        <ModelPicker
          visible={picker}
          onClose={() => setPicker(false)}
          provider={selection.providerId}
          task={task}
          current={selection.modelId ?? ''}
          onChoose={(model) => {
            setPicker(false);
            void run(() => runTaskOnKey(selection.providerId as KeyProviderId, task, model));
          }}
        />
      )}
      <SpeechModelSheet visible={needsModel} onClose={closeModelSheet} onReady={goLocal} />
      <KeySheet
        visible={sheet}
        onClose={() => setSheet(false)}
        initialProvider={
          KEY_PROVIDERS.find(({ id }) => !keys[id] && providerCanRun(id, task))?.id ?? 'openai'
        }
        onlyTask={task}
      />
    </SettingsPage>
  );
}

/** Settings → Processing → a task (`?task=dictation|upload|cleanup|notes|meeting`). */
export default function TaskScreen() {
  const { task } = useLocalSearchParams<{ task?: string }>();
  if (task === 'meeting') return <MeetingsTask />;
  const known = TASKS.find((item) => item === task) ?? 'dictation';
  return <Task task={known} />;
}
