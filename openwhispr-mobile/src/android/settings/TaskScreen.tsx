import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useCustomPromptsStore } from '@/store/useCustomPromptsStore';
import { resolveCustomPrompt } from '@/config/prompts/registry';
import { cloudAccessFor } from '@/lib/aiWorkflows';
import { providerDisplayName, type InferenceMode } from '@/lib/mobileProviders';
import { switchWorkflowMode } from '@/lib/workflowModeSwitch.android';
import { home, type } from '../home/kit';
import {
  BottomSheet,
  Group,
  ListRow,
  PillAction,
  SettingsPage,
  settings,
  useReduceMotion,
} from './kit';
import { KEY_CHECK_COLORS } from './KeyCheckMark';
import type { KeyProviderId } from './keyCheck';
import { KeySheet } from './KeySheet';
import { SpeechModelSheet } from './ModelSheet';
import { modelName, useModelsReady } from './modelCatalog';
import {
  KEY_PROVIDERS,
  TASKS,
  clearMeetingKey,
  providerCanRun,
  providerModels,
  runTaskOnKey,
  useSavedKeys,
  type KeyTask,
} from './ownKey';
import { LandingCheck } from './ProcessingScreen';
import { isLiveProvider, meetingKey } from '../providers/liveMeeting';
import { effectiveSelection, lockedOut, phoneModelFor, useChoosePhone } from './processingTasks';
import { useSettingsT, type SettingsKey } from './strings';

const TITLE: Record<KeyTask | 'meeting', SettingsKey> = {
  dictation: 'dictation',
  upload: 'audioUploads',
  cleanup: 'textCleanup',
  notes: 'noteFormatting',
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
  const [typed, setTyped] = useState(current);
  const listed = provider !== 'openrouter';
  const models = providerModels(provider, task);
  // A model chosen before that has since left the list stays on it, as the old screen did.
  const options = models.includes(current) || !current ? models : [current, ...models];
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('chooseModel')}>
      {listed ? (
        <View style={{ borderRadius: 16, overflow: 'hidden', backgroundColor: home.surface }}>
          {options.map((model) => (
            <ListRow
              key={model}
              title={model}
              selected={model === current}
              onPress={() => onChoose(model)}
            />
          ))}
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          <Text style={[type.footnote, { color: home.secondary }]}>{t('modelId')}</Text>
          <TextInput
            value={typed}
            onChangeText={setTyped}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t('modelId')}
            style={[
              settings.title,
              {
                fontWeight: '400',
                minHeight: 48,
                borderRadius: 14,
                borderWidth: 1.5,
                borderColor: home.borderSubtle,
                backgroundColor: home.surface,
                paddingHorizontal: 16,
              },
            ]}
          />
          <View style={{ paddingBottom: 12 }}>
            <PillAction
              primary
              label={t('done')}
              disabled={!typed.trim()}
              onPress={() => onChoose(typed.trim())}
            />
          </View>
        </View>
      )}
    </BottomSheet>
  );
}

/**
 * Meetings: only what can transcribe them. Live on Cloud, on this phone afterwards with speaker
 * names, or live on a saved OpenAI, Deepgram or AssemblyAI key.
 */
function MeetingsTask() {
  const t = useSettingsT();
  const reduceMotion = useReduceMotion();
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  // Read so the page follows a key saved or cleared for meetings.
  useConfigStore((s) => s.config?.inference?.meeting);
  const keys = useSavedKeys();
  const { ready } = useModelsReady();
  const { choosePhone, run, needsModel, closeModelSheet, goLocal } = useChoosePhone(t);
  const [sheet, setSheet] = useState(false);
  const onPhone = activeMode === 'private';
  const key = meetingKey();
  const liveKeys = KEY_PROVIDERS.filter(({ id }) => keys[id] && isLiveProvider(id));
  const rows = [
    {
      key: 'cloud',
      icon: 'Cloud' as const,
      title: t('meetingCloud'),
      body: t('meetingCloudBody'),
      selected: !onPhone && !key,
      disabled: false,
      choose: () =>
        void run(async () => {
          await clearMeetingKey();
          if (onPhone) await switchWorkflowMode('dictation', 'openwhispr');
        }),
    },
    {
      key: 'phone',
      icon: 'Smartphone' as const,
      title: t('meetingPhone'),
      body: t('meetingPhoneBody'),
      selected: onPhone,
      disabled: false,
      choose: () => {
        void clearMeetingKey();
        choosePhone();
      },
    },
    ...(liveKeys.length
      ? liveKeys.map(({ id, name }) => ({
          key: id,
          icon: 'KeyRound' as const,
          title: name,
          body: onPhone ? t('notWithPhoneDefault') : t('yourKeyConnected'),
          selected: key?.providerId === id,
          disabled: onPhone,
          choose: () => void run(() => runTaskOnKey(id, 'meeting')),
        }))
      : [
          {
            key: 'key',
            icon: 'KeyRound' as const,
            title: t('ownKey'),
            body: onPhone ? t('notWithPhoneDefault') : t('meetingOwnKeyBody'),
            selected: false,
            disabled: onPhone,
            choose: () => setSheet(true),
          },
        ]),
  ];
  return (
    <SettingsPage title={t('meetings')}>
      <Text style={[type.subhead, { color: home.secondary, paddingHorizontal: 4 }]}>
        {t('meetingsIntro')}
      </Text>
      <Group title={t('transcribeMeetings')}>
        {rows.map((row) => (
          <ListRow
            key={row.key}
            icon={row.icon}
            title={row.title}
            subtitle={row.body}
            subtitleStyle={
              row.selected && row.icon === 'KeyRound'
                ? { color: KEY_CHECK_COLORS.connected }
                : undefined
            }
            selected={row.selected}
            dimmed={row.disabled}
            trailing={<LandingCheck shown={row.selected} reduceMotion={reduceMotion} />}
            onPress={row.selected || row.disabled ? undefined : row.choose}
          />
        ))}
        {liveKeys.length > 0 && (
          <ListRow title={t('addAnotherKey')} onPress={() => setSheet(true)} />
        )}
      </Group>
      <Group title={t('speakerNames')}>
        <ListRow
          icon="UsersRound"
          title={t('meetingSpeakers')}
          subtitle={t('meetingSpeakersBody')}
          value={ready['meeting-speakers'] ? t('ready') : t('download')}
          valueAccent={!ready['meeting-speakers']}
          onPress={() =>
            router.push({ pathname: '/android-model', params: { kind: 'diarization' } })
          }
        />
      </Group>
      <SpeechModelSheet visible={needsModel} onClose={closeModelSheet} onReady={goLocal} />
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
 * cleanup, its prompt. Dictation sets the default for every task, so changing it here changes
 * the default.
 */
function Task({ task }: { task: KeyTask }) {
  const t = useSettingsT();
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
  // In Local Mode, cleanup not set to the phone or a key is skipped: nothing is chosen yet.
  const skipped =
    task === 'cleanup' &&
    activeMode === 'private' &&
    !['local', 'providers'].includes(config?.inference?.cleanup?.mode ?? '');
  const chosen = skipped ? null : selection.mode;
  const phoneModel = phoneModelFor(config, task);

  const choose = (mode: Exclude<InferenceMode, 'providers'>) =>
    task === 'dictation' && mode === 'local'
      ? choosePhone()
      : void run(() => switchWorkflowMode(task, mode));

  const runsOn = [
    {
      key: 'openwhispr',
      icon: 'Cloud' as const,
      title: t('cloud'),
      body: lockedOut(task, 'openwhispr', activeMode) ? t('notWithPhoneDefault') : undefined,
      selected: chosen === 'openwhispr',
      disabled: lockedOut(task, 'openwhispr', activeMode),
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
        body: lockedOut(task, 'providers', activeMode)
          ? t('notWithPhoneDefault')
          : t('yourKeyConnected'),
        selected: chosen === 'providers' && selection.providerId === id,
        disabled: lockedOut(task, 'providers', activeMode),
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
                ? { color: KEY_CHECK_COLORS.connected }
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
