import { useState } from 'react';
import { Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useCustomPromptsStore } from '@/store/useCustomPromptsStore';
import { resolveCustomPrompt } from '@/config/prompts/registry';
import { ANDROID_MODELS } from '../models';
import { Group, ListRow, SettingsPage, settings, useReduceMotion } from '../settings/kit';
import { LandingCheck } from '../settings/ProcessingScreen';
import { SpeechModelSheet } from '../settings/ModelSheet';
import { formatSize, modelName, useModelsReady } from '../settings/modelCatalog';
import { useKeyCheck, type KeyProviderId } from '../settings/keyCheck';
import { TASKS, providerModels, runTaskOnKey, savedKey, type KeyTask } from '../settings/ownKey';
import { setTask } from '../settings/processingDefault';
import { useChoosePhone } from '../settings/processingTasks';
import { LIVE_PROVIDERS } from '../providers/liveMeeting';
import { askSignIn, ServerModelSheet } from './ProcessingScreen';
import {
  KEY_SOURCES,
  TASK_KEY,
  customSelection,
  phoneLine,
  sourceCanRun,
  sourceName,
  useCustomServer,
  useKeyTails,
  useSavedSecret,
  useServerCheck,
  type KeySource,
} from './logic';
import { ConnectionValue, OptionSheet } from './ui';
import { useV1T, type V1T } from './strings';

const speechTask = (task: KeyTask) => task === 'dictation' || task === 'upload';

/** Why a provider can't run a task, for its greyed row. */
function cantRun(t: V1T, source: KeySource, task: KeyTask | 'meeting'): string | undefined {
  if (sourceCanRun(source, task)) return undefined;
  if (task === 'meeting') return t('cantLiveShort');
  return t(speechTask(task) ? 'cantTranscribeShort' : 'cantWriteShort');
}

function keyPage(source: KeySource, task: KeyTask | 'meeting') {
  router.push({ pathname: '/android-v1-key', params: { provider: source, task } });
}

/** 10.6's switch, with note formatting where it belongs. */
function AutoTitles() {
  const t = useV1T();
  const value = useConfigStore((s) => s.config?.autoGenerateNoteTitle ?? true);
  return (
    <Group title={t('settingsGroup')}>
      <ListRow
        title={t('autoTitles')}
        subtitle={t('autoTitlesBody')}
        toggle={{
          value,
          onValueChange: (next) =>
            void useConfigStore.getState().updateConfig({ autoGenerateNoteTitle: next }),
        }}
      />
    </Group>
  );
}

/**
 * Meetings: something that transcribes live (Cloud, or an OpenAI, Deepgram or AssemblyAI key),
 * or the phone after the meeting, with speaker names. Groq, OpenRouter and custom servers can't.
 */
function MeetingsTaskV1() {
  const t = useV1T();
  const reduceMotion = useReduceMotion();
  const user = useAuthStore((s) => s.user);
  const meeting = useConfigStore((s) => s.config?.inference?.meeting);
  const tails = useKeyTails();
  const { ready } = useModelsReady();
  const mode = meeting?.mode ?? 'openwhispr';

  const live = [
    {
      id: 'cloud',
      icon: 'Cloud' as const,
      title: t('cloud'),
      body: t('liveBody'),
      selected: mode === 'openwhispr',
      value: undefined as string | undefined,
      choose: () => (user ? void setTask('meeting', { mode: 'openwhispr' }) : askSignIn(t)),
    },
    ...LIVE_PROVIDERS.map((id) => {
      const saved = tails[id] !== undefined;
      return {
        id,
        icon: 'Lock' as const,
        title: sourceName(id),
        body: t('meetingKeyBody', { provider: sourceName(id) }),
        selected: mode === 'providers' && meeting?.providerId === id,
        value: saved ? undefined : t('addKey'),
        choose: () => (saved ? void runTaskOnKey(id, 'meeting') : keyPage(id, 'meeting')),
      };
    }),
  ];

  return (
    <SettingsPage title={t('meetings')}>
      <Group title={t('live')} footer={t('meetingsCantNote')}>
        {live.map((row) => (
          <ListRow
            key={row.id}
            icon={row.icon}
            title={row.title}
            subtitle={row.body}
            selected={row.selected}
            value={row.value}
            valueAccent
            trailing={
              row.value ? undefined : (
                <LandingCheck shown={row.selected} reduceMotion={reduceMotion} />
              )
            }
            onPress={row.selected ? undefined : row.choose}
          />
        ))}
      </Group>
      <Group title={t('afterMeeting')}>
        <ListRow
          icon="Smartphone"
          title={t('thisPhone')}
          subtitle={t('meetingDeviceBody')}
          selected={mode === 'local'}
          trailing={<LandingCheck shown={mode === 'local'} reduceMotion={reduceMotion} />}
          onPress={mode === 'local' ? undefined : () => void setTask('meeting', { mode: 'local' })}
        />
        <ListRow
          icon="UsersRound"
          title={t('meetingSpeakers')}
          subtitle={`${t('meetingSpeakersBody')} · ${formatSize(ANDROID_MODELS['meeting-speakers'].bytes)}`}
          value={ready['meeting-speakers'] ? t('ready') : t('download')}
          valueAccent={!ready['meeting-speakers']}
          onPress={() =>
            router.push({ pathname: '/android-v1-model', params: { kind: 'diarization' } })
          }
        />
      </Group>
    </SettingsPage>
  );
}

/** 10.2–10.6: one task, where it runs, and what that needs. Only this task changes. */
function TaskV1({ task }: { task: KeyTask }) {
  const t = useV1T();
  const reduceMotion = useReduceMotion();
  const user = useAuthStore((s) => s.user);
  const config = useConfigStore((s) => s.config);
  const server = useCustomServer((s) => s.endpoint);
  const tails = useKeyTails();
  const { ready } = useModelsReady();
  const { choosePhone, run, needsModel, closeModelSheet, goLocal } = useChoosePhone(t);
  const [sheet, setSheet] = useState<'provider' | 'model' | 'server' | null>(null);
  const customPrompt = useCustomPromptsStore(
    (state) => resolveCustomPrompt(state.customPrompts.cleanup) !== undefined,
  );

  const selection = config?.inference?.[task];
  const mode = selection?.mode ?? 'openwhispr';
  const source = (selection?.providerId ?? '') as KeySource;
  const onKey = mode === 'providers' && !!selection?.providerId;
  const speech = speechTask(task);

  const saved = useSavedSecret(onKey ? source : '', source === 'custom' ? server : undefined);

  const keyCheck = useKeyCheck(
    source === 'custom' || !onKey ? 'openai' : (source as KeyProviderId),
    source === 'custom' || !onKey ? '' : (saved ?? ''),
  );
  // A server's model list comes from the server itself, when it is in use or being picked.
  const serverAddress =
    source === 'custom' ? (selection?.endpoint ?? '') : sheet === 'server' ? (server ?? '') : '';
  // The server's own key (it may take none), not the key the task is on now.
  const serverKey = useSavedSecret(server ? 'custom' : '', server);
  const serverCheck = useServerCheck(serverAddress, serverKey ?? '');
  const check = source === 'custom' ? serverCheck : keyCheck;

  const chooseCloud = () =>
    user ? void run(() => setTask(task, { mode: 'openwhispr' })) : askSignIn(t);
  const chooseDevice = () => {
    if (speech) return choosePhone(() => setTask(task, { mode: 'local' }));
    const usable = (['qwen-balanced', 'qwen-small'] as const).filter((id) => ready[id]);
    if (!usable.length) {
      // 10.5: text on device needs a text model first.
      Alert.alert(
        t('noTextModelTitle'),
        t('noTextModelBody', {
          task: t(TASK_KEY[task]),
          small: modelName('qwen-small'),
          smallSize: formatSize(ANDROID_MODELS['qwen-small'].bytes),
          large: modelName('qwen-balanced'),
          largeSize: formatSize(ANDROID_MODELS['qwen-balanced'].bytes),
        }),
        [
          { text: t('cancel'), style: 'cancel' },
          {
            text: t('download'),
            onPress: () => router.push({ pathname: '/android-v1-model', params: { kind: 'text' } }),
          },
        ],
      );
      return;
    }
    void run(async () => {
      const current = config?.androidTextModel ?? 'qwen-balanced';
      if (!usable.includes(current))
        await useConfigStore.getState().updateConfig({ androidTextModel: usable[0] });
      await setTask(task, { mode: 'local' });
    });
  };

  /** Puts the task on a source: a saved key moves it at once, otherwise the key page opens. */
  const pickSource = (next: KeySource) => {
    if (next === 'custom') {
      if (!server) return keyPage('custom', task);
      setSheet('server');
      return;
    }
    if (tails[next] === undefined) return keyPage(next, task);
    void run(() => runTaskOnKey(next, task));
  };
  const chooseKey = () => {
    const remembered = Object.keys(config?.rememberedInference?.[task] ?? {}) as KeySource[];
    const saved = [...remembered, ...KEY_SOURCES.map((s) => s.id)].find(
      (id) => tails[id] !== undefined && sourceCanRun(id, task),
    );
    if (saved) pickSource(saved);
    else setSheet('provider');
  };

  const deviceBody =
    task === 'dictation'
      ? t('deviceDictationBody')
      : task === 'upload'
        ? t('deviceUploadBody')
        : t('deviceTextBody');
  const rows = [
    {
      mode: 'openwhispr',
      icon: 'Cloud' as const,
      title: t('cloud'),
      body: t('cloudTaskBody'),
      choose: chooseCloud,
    },
    {
      mode: 'local',
      icon: 'Smartphone' as const,
      title: t('thisPhone'),
      body: deviceBody,
      choose: chooseDevice,
    },
    {
      mode: 'providers',
      icon: 'Lock' as const,
      title: t('ownKey'),
      body: speech ? t('billedByProvider') : t('keyTextBody'),
      choose: chooseKey,
    },
  ];
  const models = onKey && source !== 'custom' ? providerModels(source, task) : [];
  const keyReady = saved !== null && (saved !== '' || source === 'custom');

  return (
    <SettingsPage title={t(TASK_KEY[task])}>
      <Group title={t(task === 'dictation' ? 'whereProcessed' : 'runThisTaskOn')}>
        {rows.map((row) => (
          <ListRow
            key={row.mode}
            icon={row.icon}
            title={row.title}
            subtitle={row.body}
            selected={mode === row.mode}
            trailing={<LandingCheck shown={mode === row.mode} reduceMotion={reduceMotion} />}
            onPress={mode === row.mode ? undefined : row.choose}
          />
        ))}
      </Group>

      {mode === 'local' && (
        <Group
          title={t('onDeviceModels')}
          footer={t(speech ? 'sharedSpeechModel' : 'sharedTextModel')}
        >
          <ListRow
            icon={speech ? 'AudioLines' : 'Sparkles'}
            title={speech ? t('speech') : t('textCleanup')}
            value={phoneLine(config, task)}
            onPress={() =>
              router.push({
                pathname: '/android-v1-model',
                params: { kind: speech ? 'speech' : 'text' },
              })
            }
          />
        </Group>
      )}

      {onKey && (
        <Group title={t('yourKey')}>
          <ListRow
            icon="Lock"
            title={t('provider')}
            value={sourceName(source)}
            onPress={() => setSheet('provider')}
          />
          <ListRow
            icon="Brain"
            title={t('model')}
            value={selection?.modelId ?? ''}
            onPress={() => setSheet('model')}
          />
          <ListRow
            icon="Check"
            title={t('connection')}
            trailing={
              keyReady ? (
                <ConnectionValue t={t} state={check.state} />
              ) : (
                <Text style={[settings.rowValue, { color: settings.accent }]}>{t('addKey')}</Text>
              )
            }
            onPress={
              !keyReady
                ? () => keyPage(source, task)
                : check.state === 'failed' || check.state === 'unverified'
                  ? check.retry
                  : undefined
            }
          />
        </Group>
      )}

      {task === 'cleanup' && (
        <Group
          title={t('cleanup')}
          footer={(config?.cleanupEnabled ?? true) ? undefined : t('cleanupOffNote')}
        >
          <ListRow
            icon="Type"
            title={t('cleanupPrompt')}
            subtitle={t('cleanupPromptBody')}
            value={customPrompt ? t('custom') : t('default')}
            onPress={() => router.push('/(account)/cleanup-prompt')}
          />
        </Group>
      )}
      {task === 'notes' && <AutoTitles />}

      <OptionSheet
        visible={sheet === 'provider'}
        onClose={() => setSheet(null)}
        title={t('provider')}
        options={KEY_SOURCES.map(({ id, name }) => ({
          id,
          title: id === 'custom' ? t('customServer') : name,
          subtitle:
            cantRun(t, id, task) ??
            (tails[id] !== undefined ? t('keyValue', { provider: sourceName(id) }) : t('addKey')),
          disabled: !sourceCanRun(id, task),
        }))}
        selected={onKey ? source : undefined}
        onChoose={(id) => {
          setSheet(null);
          pickSource(id as KeySource);
        }}
      />
      <OptionSheet
        visible={sheet === 'model' && onKey && source !== 'custom'}
        onClose={() => setSheet(null)}
        title={t('model')}
        options={models.map((id) => ({ id, title: id }))}
        selected={selection?.modelId}
        onChoose={(model) => {
          setSheet(null);
          void run(() => runTaskOnKey(source as KeyProviderId, task, model));
        }}
      />
      <ServerModelSheet
        visible={(sheet === 'server' || (sheet === 'model' && source === 'custom')) && !!server}
        onClose={() => setSheet(null)}
        title={t('model')}
        models={serverCheck.result?.models ?? []}
        current={source === 'custom' ? (selection?.modelId ?? '') : ''}
        onChoose={(model) => {
          setSheet(null);
          if (server) void run(async () => setTask(task, await customSelection(server, model)));
        }}
      />
      <SpeechModelSheet visible={needsModel} onClose={closeModelSheet} onReady={goLocal} />
    </SettingsPage>
  );
}

/** Settings → Processing → Customize each task → a task (`?task=`). */
export default function TaskScreenV1() {
  const { task } = useLocalSearchParams<{ task?: string }>();
  if (task === 'meeting') return <MeetingsTaskV1 />;
  return <TaskV1 task={TASKS.find((item) => item === task) ?? 'dictation'} />;
}
