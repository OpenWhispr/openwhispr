import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { router } from 'expo-router';
import { usePreventRemove, useNavigation } from '@react-navigation/native';
import { Text } from '@/components/ui/Text';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { home } from '../home/kit';
import { ANDROID_MODELS, type AndroidModelId } from '../models';
import type { AndroidSpeechModelId } from '../speechSelection';
import {
  Group,
  ListRow,
  PillAction,
  SettingsPage,
  settings,
  showToast,
  useReduceMotion,
} from '../settings/kit';
import { LandingCheck } from '../settings/ProcessingScreen';
import { SpeechModelSheet } from '../settings/ModelSheet';
import { formatSize, modelName, useModelsReady } from '../settings/modelCatalog';
import { useKeyCheck, type KeyProviderId } from '../settings/keyCheck';
import {
  providerCanRun,
  providerModels,
  saveKey,
  savedKey,
  startingModel,
} from '../settings/ownKey';
import { applyDefault, useProcessingDefault } from '../settings/processingDefault';
import { useChoosePhone } from '../settings/processingTasks';
import { EMPTY_DRAFT, editDraft, useKeyDraft } from './draft';
import {
  KEY_SOURCES,
  applyCustomDefault,
  applyKeyDefault,
  customServerKey,
  normalizeServer,
  saveCustomServer,
  sourceName,
  useCustomServer,
  useServerCheck,
  type KeySource,
} from './logic';
import { ConnectionValue, FieldCard, OptionSheet, reasonText } from './ui';
import { useV1T, type V1T } from './strings';

/** Seeds the key draft from what is saved, so the section opens on the current key. */
function draftFromSaved() {
  const defaults = useProcessingDefault.getState();
  const inference = useConfigStore.getState().config?.inference;
  if (defaults.mode !== 'providers' || !defaults.providerId) return EMPTY_DRAFT;
  const provider = defaults.providerId as KeySource;
  if (provider === 'custom')
    return {
      ...EMPTY_DRAFT,
      provider,
      server: useCustomServer.getState().endpoint ?? '',
      speechModel:
        inference?.dictation?.providerId === 'custom' ? (inference.dictation.modelId ?? '') : '',
      textModel:
        inference?.cleanup?.providerId === 'custom' ? (inference.cleanup.modelId ?? '') : '',
    };
  const speech = providerCanRun(provider, 'dictation');
  const task = speech ? 'dictation' : 'cleanup';
  const saved = inference?.[task];
  return {
    ...EMPTY_DRAFT,
    provider,
    model:
      saved?.providerId === provider && saved.modelId
        ? saved.modelId
        : startingModel(provider, task),
  };
}

/** Signed out, Cloud asks first (7.2). */
export function askSignIn(t: V1T) {
  Alert.alert(t('signInTitle'), t('signInBody'), [
    { text: t('cancel'), style: 'cancel' },
    { text: t('signIn'), onPress: () => router.push('/auth') },
  ]);
}

/** A server model row's sheet: the server's list, and a field to type one it didn't list. */
export function ServerModelSheet({
  visible,
  onClose,
  title,
  models,
  current,
  onChoose,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  models: string[];
  current: string;
  onChoose: (model: string) => void;
}) {
  const t = useV1T();
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (visible) setTyped(models.includes(current) ? '' : current);
  }, [visible, current, models]);
  return (
    <OptionSheet
      visible={visible}
      onClose={onClose}
      title={title}
      body={models.length ? undefined : t('noServerModels')}
      options={models.map((id) => ({ id, title: id }))}
      selected={current}
      onChoose={onChoose}
      footer={
        <View style={{ gap: 8, paddingBottom: 8 }}>
          <Text style={[settings.subtitle]}>{t('typeModelId')}</Text>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <FieldCard
                label={t('modelId')}
                value={typed}
                onChangeText={setTyped}
                placeholder={t('modelIdPlaceholder')}
              />
            </View>
            <PillAction
              label={t('use')}
              disabled={!typed.trim()}
              onPress={() => onChoose(typed.trim())}
            />
          </View>
        </View>
      }
    />
  );
}

/**
 * Settings → Processing, v1 (7.1, 8.1, 9.1): where your voice is processed, then what that
 * choice needs. Cloud and On device apply at once and set every task; your own key is set up
 * here and applies on Save.
 */
export default function ProcessingScreenV1() {
  const t = useV1T();
  const reduceMotion = useReduceMotion();
  const navigation = useNavigation();
  const user = useAuthStore((s) => s.user);
  const config = useConfigStore((s) => s.config);
  const defaults = useProcessingDefault();
  const draft = useKeyDraft();
  const { ready, progress } = useModelsReady();
  const { choosePhone, run, needsModel, closeModelSheet, goLocal } = useChoosePhone(t);
  const [sheet, setSheet] = useState<'provider' | 'model' | 'speech' | 'text' | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    useKeyDraft.setState(draftFromSaved(), true);
    return () => useKeyDraft.setState(EMPTY_DRAFT, true);
  }, []);

  const custom = draft.provider === 'custom';
  const provider = draft.provider;
  // The saved key (or server key) the check falls back on when nothing new was typed.
  useEffect(() => {
    let live = true;
    setSaved(null);
    const read = custom
      ? draft.server
        ? customServerKey(normalizeServer(draft.server))
        : Promise.resolve(null)
      : savedKey(provider as KeyProviderId).catch(() => null);
    void read.then((key) => live && setSaved(key));
    return () => {
      live = false;
    };
  }, [provider, custom, draft.server]);

  const keyMode = draft.open || defaults.mode === 'providers';
  const selectedMode = draft.open ? 'providers' : defaults.mode;
  const keyCheck = useKeyCheck(
    custom ? 'openai' : (provider as KeyProviderId),
    custom ? '' : draft.key || saved || '',
  );
  const serverCheck = useServerCheck(custom ? draft.server : '', draft.serverKey || saved || '');
  const check = custom ? serverCheck : keyCheck;

  // 9.7 / 9.8: a newly typed key's answer pops up at the bottom.
  const announced = useRef<unknown>(null);
  useEffect(() => {
    const typed = custom ? draft.server : draft.key;
    if (!draft.dirty || !typed || !check.result || announced.current === check.result) return;
    announced.current = check.result;
    if (check.result.state === 'connected') showToast(t('connectionWorks'), 'success');
    else if (check.result.state === 'failed')
      showToast(reasonText(t, sourceName(provider), check.result), 'error');
  }, [check.result, custom, draft.dirty, draft.key, draft.server, provider, t]);

  // 9.11: leaving with an unsaved key choice asks first.
  usePreventRemove(draft.dirty, ({ data }) => {
    Alert.alert(t('discardTitle'), t('discardBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('discard'),
        style: 'destructive',
        onPress: () => {
          useKeyDraft.setState(EMPTY_DRAFT, true);
          navigation.dispatch(data.action);
        },
      },
    ]);
  });

  const chooseCloud = () => {
    if (!user) return askSignIn(t);
    useKeyDraft.setState(EMPTY_DRAFT, true);
    void run(() => applyDefault({ mode: 'openwhispr' }));
  };
  const choosePhoneDefault = () => {
    useKeyDraft.setState(EMPTY_DRAFT, true);
    choosePhone(() => applyDefault({ mode: 'local' }));
  };
  const chooseKey = () => {
    if (keyMode) return;
    const remembered = Object.values(config?.rememberedInference?.dictation ?? {}).find(
      (selection) => selection.mode === 'providers' && selection.providerId,
    )?.providerId as KeySource | undefined;
    const first = remembered ?? 'openai';
    editDraft({
      ...EMPTY_DRAFT,
      open: true,
      provider: first,
      model: first === 'custom' ? '' : startingModel(first, 'dictation'),
      server: useCustomServer.getState().endpoint ?? '',
    });
  };

  const speech = custom || providerCanRun(provider, 'dictation');
  const modelTask = speech ? 'dictation' : 'cleanup';
  const models = custom ? [] : providerModels(provider, modelTask);
  const serverModels = serverCheck.result?.models ?? [];
  const keyTail = (draft.key || saved || '').slice(-4);
  const canSave =
    !busy &&
    (check.state === 'connected' || check.state === 'unverified') &&
    (custom ? !!(draft.speechModel.trim() || draft.textModel.trim()) : !!draft.model);

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      if (custom) {
        const endpoint = serverCheck.result?.endpoint ?? normalizeServer(draft.server);
        await saveCustomServer(endpoint, draft.serverKey || saved || '');
        await applyCustomDefault(endpoint, draft.speechModel, draft.textModel);
      } else {
        if (draft.key) await saveKey(provider as KeyProviderId, draft.key);
        await applyKeyDefault(provider as KeyProviderId, draft.model);
      }
      useKeyDraft.setState({ ...draft, open: false, dirty: false, key: '' });
      showToast(t('savedFor', { provider: sourceName(provider) }), 'success');
    } catch (error) {
      showToast((error as Error).message || t('keySaveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  // What the provider can't run stays where it is, said plainly.
  const stays = custom
    ? t('staysCantMeetings', { provider: sourceName(provider) })
    : [
        !providerCanRun(provider, 'cleanup') &&
          t('staysCantText', { provider: sourceName(provider) }),
        !providerCanRun(provider, 'dictation') &&
          t('staysCantSpeech', { provider: sourceName(provider) }),
        providerCanRun(provider, 'dictation') &&
          !providerCanRun(provider, 'meeting') &&
          t('staysCantMeetings', { provider: sourceName(provider) }),
      ]
        .filter(Boolean)
        .join(' ');
  const modelFooter = speech
    ? providerCanRun(provider, 'cleanup')
      ? t('speechModelFooter', { model: startingModel(provider, 'cleanup') })
      : undefined
    : t('textModelFooter');

  const speechId: AndroidSpeechModelId = config?.androidSpeechModel ?? 'parakeet-v3';
  const textId: AndroidModelId = config?.androidTextModel ?? 'qwen-balanced';
  const modelValue = (id: AndroidModelId) =>
    progress[id] !== undefined
      ? `${Math.min(99, Math.round(progress[id]! * 100))}%`
      : ready[id]
        ? t('ready')
        : t('download');

  const modes = [
    {
      mode: 'openwhispr',
      icon: 'Cloud' as const,
      title: t('cloud'),
      body: t('cloudBody'),
      choose: chooseCloud,
    },
    {
      mode: 'local',
      icon: 'Smartphone' as const,
      title: t('thisPhone'),
      body: t('thisPhoneBody'),
      choose: choosePhoneDefault,
    },
    {
      mode: 'providers',
      icon: 'Lock' as const,
      title: t('ownKey'),
      body: keyMode ? t('billedByProvider') : t('keyBody'),
      choose: chooseKey,
    },
  ];

  return (
    <SettingsPage title={t('processing')}>
      <Group title={t('whereProcessed')}>
        {modes.map(({ mode, icon, title, body, choose }) => (
          <ListRow
            key={mode}
            icon={icon}
            title={title}
            subtitle={body}
            selected={selectedMode === mode}
            trailing={<LandingCheck shown={selectedMode === mode} reduceMotion={reduceMotion} />}
            onPress={selectedMode === mode ? undefined : choose}
          />
        ))}
      </Group>

      {selectedMode === 'local' && (
        <Group title={t('onDeviceModels')}>
          {(
            [
              ['speech', 'AudioLines', t('speech'), speechId],
              ['text', 'Sparkles', t('textCleanup'), textId],
              ['diarization', 'UsersRound', t('meetingSpeakers'), 'meeting-speakers'],
            ] as const
          ).map(([kind, icon, title, id]) => (
            <ListRow
              key={kind}
              icon={icon}
              title={title}
              subtitle={
                kind === 'diarization'
                  ? `${t('meetingSpeakersBody')} · ${formatSize(ANDROID_MODELS[id].bytes)}`
                  : `${modelName(id)} · ${formatSize(ANDROID_MODELS[id].bytes)}`
              }
              value={modelValue(id)}
              valueAccent={!ready[id]}
              onPress={() => router.push({ pathname: '/android-v1-model', params: { kind } })}
            />
          ))}
        </Group>
      )}

      {keyMode && !custom && (
        <Group
          title={t('yourKey')}
          inset={16}
          footer={[modelFooter, stays].filter(Boolean).join(' ')}
        >
          <ListRow
            title={t('provider')}
            value={sourceName(provider)}
            onPress={() => setSheet('provider')}
          />
          <ListRow title={t('model')} value={draft.model} onPress={() => setSheet('model')} />
          <ListRow
            title={t('apiKey')}
            value={keyTail ? `••••${keyTail}` : t('addKey')}
            valueAccent
            onPress={() =>
              router.push({ pathname: '/android-v1-key', params: { provider, from: 'processing' } })
            }
          />
          <ListRow
            title={t('checkConnection')}
            trailing={<ConnectionValue t={t} state={keyTail ? check.state : 'idle'} />}
            onPress={
              check.state === 'failed' || check.state === 'unverified' ? check.retry : undefined
            }
          />
        </Group>
      )}

      {keyMode && custom && (
        <>
          <Group title={t('yourServer')} inset={16}>
            <ListRow
              title={t('provider')}
              value={t('customServer')}
              onPress={() => setSheet('provider')}
            />
          </Group>
          <View style={{ gap: 8, marginTop: -8 }}>
            <FieldCard
              label={t('server')}
              value={draft.server}
              onChangeText={(server) => editDraft({ server })}
              placeholder={t('serverPlaceholder')}
              keyboardType="url"
              failed={serverCheck.state === 'failed'}
            />
            <Text style={[settings.subtitle, { paddingHorizontal: 4 }]}>{t('serverHint')}</Text>
            <FieldCard
              label={t('apiKey')}
              value={draft.serverKey}
              onChangeText={(serverKey) => editDraft({ serverKey })}
              placeholder={saved ? `••••${saved.slice(-4)}` : t('optional')}
              secure
            />
          </View>
          <Group inset={16} footer={[t('modelIdBlank'), stays].join(' ')}>
            <ListRow
              title={t('speechModelId')}
              value={draft.speechModel || t('optional')}
              onPress={() => setSheet('speech')}
            />
            <ListRow
              title={t('textModelId')}
              value={draft.textModel || t('optional')}
              onPress={() => setSheet('text')}
            />
            <ListRow
              title={t('checkConnection')}
              trailing={<ConnectionValue t={t} state={check.state} />}
              onPress={check.state === 'idle' ? undefined : check.retry}
            />
          </Group>
          {check.result && check.state !== 'connected' && (
            <Text
              style={[
                settings.subtitle,
                { color: home.error, paddingHorizontal: 4, marginTop: -8 },
              ]}
            >
              {reasonText(t, t('customServer'), check.result)}
            </Text>
          )}
        </>
      )}

      {keyMode && draft.dirty && (
        // Room for the glass button's lift.
        <View style={{ paddingBottom: 4 }}>
          <PillAction primary label={t('save')} disabled={!canSave} onPress={() => void save()} />
        </View>
      )}

      <Group title={t('advanced')}>
        {selectedMode === 'local' && (
          <ListRow
            icon="Smartphone"
            title={t('checkPhone')}
            subtitle={t('checkPhoneBody')}
            onPress={() => router.push('/(account)/device-check')}
          />
        )}
        <ListRow
          icon="SlidersHorizontal"
          title={t('customizeTasks')}
          subtitle={t('customizeTasksBody')}
          onPress={() => router.push('/android-v1-tasks')}
        />
      </Group>

      <OptionSheet
        visible={sheet === 'provider'}
        onClose={() => setSheet(null)}
        title={t('provider')}
        options={KEY_SOURCES.map(({ id, name }) => ({
          id,
          title: id === 'custom' ? t('customServer') : name,
          subtitle: id === 'custom' ? t('customServerBody') : undefined,
        }))}
        selected={provider}
        onChoose={(id) => {
          setSheet(null);
          const next = id as KeySource;
          if (next === provider) return;
          editDraft({
            provider: next,
            key: '',
            model:
              next === 'custom'
                ? ''
                : startingModel(next, providerCanRun(next, 'dictation') ? 'dictation' : 'cleanup'),
            server: next === 'custom' ? (useCustomServer.getState().endpoint ?? '') : '',
          });
        }}
      />
      <OptionSheet
        visible={sheet === 'model'}
        onClose={() => setSheet(null)}
        title={t('model')}
        options={models.map((id) => ({ id, title: id }))}
        selected={draft.model}
        onChoose={(model) => {
          setSheet(null);
          editDraft({ model });
        }}
      />
      <ServerModelSheet
        visible={sheet === 'speech' || sheet === 'text'}
        onClose={() => setSheet(null)}
        title={t(sheet === 'text' ? 'textModelId' : 'speechModelId')}
        models={serverModels}
        current={sheet === 'text' ? draft.textModel : draft.speechModel}
        onChoose={(model) => {
          editDraft(sheet === 'text' ? { textModel: model } : { speechModel: model });
          setSheet(null);
        }}
      />
      <SpeechModelSheet visible={needsModel} onClose={closeModelSheet} onReady={goLocal} />
    </SettingsPage>
  );
}
