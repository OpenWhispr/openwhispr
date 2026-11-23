import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useCustomPromptsStore } from '@/store/useCustomPromptsStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { resolveCustomPrompt } from '@/config/prompts/registry';
import { cloudAccessFor } from '@/lib/aiWorkflows';
import type { UserConfig } from '@/types';
import { home } from '../home/kit';
import { ANDROID_MODELS, type AndroidModelId } from '../models';
import type { AndroidSpeechModelId } from '../speechSelection';
import { BottomSheet, ListRow, settings, useReduceMotion } from '../settings/kit';
import { ModelListRow, type ModelState } from '../settings/ModelListRow';
import { startModelDownload } from '../settings/ModelRow';
import { removeWithUndo, setPending, useRemovals } from '../settings/ModelScreen';
import {
  MODEL_ROWS,
  formatSize,
  meetingModelRows,
  modelName,
  useModelsReady,
} from '../settings/modelCatalog';
import { setTask } from '../settings/processingDefault';
import type { SheetTask } from '../settings/ownKey';
import { noOrphan } from '../settings/strings';
import {
  TASK_TITLE,
  kindOf,
  modelLabel,
  moveTasksOnDevice,
  phoneModelOf,
  placementOf,
  runOnSource,
  sourceCanRun,
  sourceModels,
  sourceName,
  stopWaiting,
  usePhoneQueue,
  useSavedSources,
  type Source,
} from './places';
import { useFableT, type FableT } from './strings';
import { TASK_ICON, Tile } from './look';
import { AddRow, RadioRow, SectionLabel, SheetCard, SlideIn } from './ui';
import { isLiveProvider } from '../providers/liveMeeting';

const SIBLING: Partial<Record<SheetTask, SheetTask>> = {
  dictation: 'upload',
  upload: 'dictation',
  cleanup: 'notes',
  notes: 'cleanup',
};

/** The on-device models a task can use, inline (T1): download, choose or remove. */
function PhoneModels({
  t,
  task,
  config,
  shared,
}: {
  t: FableT;
  task: SheetTask;
  config: UserConfig | null;
  shared: boolean;
}) {
  const reduceMotion = useReduceMotion();
  const pending = useRemovals((s) => s.pending);
  const { ready, progress, refresh } = useModelsReady();
  const kind = kindOf(task);
  // Meetings list the models that can transcribe them; choosing one never changes dictation's.
  const rows =
    kind === 'meeting' ? meetingModelRows() : MODEL_ROWS.filter((row) => row.kind === kind);
  const chosen = phoneModelOf(config, kind);
  const dictation = config?.androidSpeechModel ?? 'parakeet-v3';
  const onPhone = (id: AndroidModelId) => Boolean(ready[id]) && !pending.includes(id);
  const downloadingId = Object.keys(progress)[0];
  const use = (id: AndroidModelId) =>
    kind !== 'meeting' &&
    void useConfigStore
      .getState()
      .updateConfig(
        kind === 'speech'
          ? { androidSpeechModel: id as AndroidSpeechModelId }
          : { androidTextModel: id as 'qwen-small' | 'qwen-balanced' },
      );
  const remove = (id: AndroidModelId) => {
    // A meeting model that dictation also uses warns as the speech list does.
    if (id !== (kind === 'meeting' ? dictation : chosen)) return removeWithUndo(id, refresh);
    Alert.alert(
      t('removeTitle', { model: modelName(id) }),
      t('removeInUseBody', { kind: t(kind === 'text' ? 'textKind' : 'speechKind') }),
      [
        { text: t('cancel'), style: 'cancel' },
        { text: t('remove'), style: 'destructive', onPress: () => removeWithUndo(id, refresh) },
      ],
    );
  };
  const state = (id: AndroidModelId): ModelState =>
    progress[id] !== undefined
      ? 'downloading'
      : !onPhone(id)
        ? 'absent'
        : id === chosen
          ? 'inUse'
          : 'ready';
  return (
    <View style={{ gap: 8 }}>
      <SectionLabel>{t('modelOnPhone')}</SectionLabel>
      <SheetCard>
        {rows.map((row) => (
          <ModelListRow
            key={row.id}
            row={row}
            state={state(row.id)}
            progress={progress[row.id]}
            dimmed={downloadingId !== undefined && downloadingId !== row.id}
            reduceMotion={reduceMotion}
            onDownload={() =>
              pending.includes(row.id) ? setPending(row.id, false) : startModelDownload(row.id)
            }
            onUse={() => use(row.id)}
            onRemove={() => remove(row.id)}
            onSettled={(ok) => {
              void refresh();
              // A model downloaded here is picked when it lands, as T1 says.
              if (ok) use(row.id);
            }}
          />
        ))}
      </SheetCard>
      {shared && SIBLING[task] && (
        <Text style={[settings.subtitle, { paddingHorizontal: 4 }]}>
          {t('sharedModel', { task: t(TASK_TITLE[SIBLING[task]!]) })}
        </Text>
      )}
    </View>
  );
}

/**
 * A task's sheet (T1–T4): where it runs (Cloud, On device, each saved key that can run it, then
 * Add a key), then the model for that place, then for Text cleanup its prompt. A pick applies at
 * once; there is no Save. A key's model list slides in inside the same sheet (T3).
 */
export function TaskSheet({
  task: requested,
  onClose,
  onAddKey,
}: {
  task: SheetTask | null;
  onClose: () => void;
  onAddKey: () => void;
}) {
  const t = useFableT();
  const config = useConfigStore((s) => s.config);
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const cloudAccess = cloudAccessFor(useAuthStore((s) => s.user));
  const sources = useSavedSources() ?? [];
  const { ready } = useModelsReady();
  const queued = usePhoneQueue((s) => s.jobs);
  const customPrompt = useCustomPromptsStore(
    (state) => resolveCustomPrompt(state.customPrompts.cleanup) !== undefined,
  );
  // The sheet keeps showing its task while it slides away.
  const [task, setShownTask] = useState<SheetTask>(requested ?? 'dictation');
  const [page, setPage] = useState<'main' | 'models' | 'phoneModels'>('main');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (requested) {
      setShownTask(requested);
      setPage('main');
    }
  }, [requested]);

  const placement = placementOf(config, task, activeMode, cloudAccess);
  const waiting = queued.some((job) => job.tasks.includes(task));
  const kind = kindOf(task);
  const phoneModel = phoneModelOf(config, kind);
  const meeting = task === 'meeting';
  const title = t(TASK_TITLE[task]);

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
  const pick = (work: () => Promise<unknown>) =>
    void run(async () => {
      stopWaiting(task);
      await work();
    });

  const deviceSubtitle =
    placement.place === 'device' && !meeting
      ? t('deviceBody')
      : ready[phoneModel]
        ? modelName(phoneModel)
        : t('modelDownloadLine', {
            model: modelName(phoneModel),
            size: formatSize(ANDROID_MODELS[phoneModel].bytes),
          });

  // Keys that can run this task; for meetings every saved key shows, the ones that can't greyed.
  const keyRows = sources
    .filter(({ source }) => meeting || sourceCanRun(source, task))
    .map(({ source }) => {
      const selected = placement.place === 'key' && placement.source === source;
      const can = sourceCanRun(source, task);
      const models = sourceModels(source, task);
      const model = selected ? placement.modelId : models[0];
      return {
        source,
        selected,
        can,
        subtitle: can
          ? modelLabel(source, task, model)
          : t('cantRunMeetings', { provider: sourceName(source) }),
      };
    });

  const keyModels =
    placement.place === 'key' && placement.source
      ? sourceModels(placement.source as Source, task)
      : [];
  const cleanupOff = task === 'cleanup' && !(config?.cleanupEnabled ?? true);
  const sibling = SIBLING[task];
  const siblingOnDevice =
    !!sibling && placementOf(config, sibling, activeMode, cloudAccess).place === 'device';

  // On device: the phone's models on their own page, as a key's models are (6C).
  if (page === 'phoneModels' && (placement.place === 'device' || waiting)) {
    return (
      <BottomSheet
        visible={!!requested}
        onClose={onClose}
        title={t('taskModel', { task: title })}
        onBack={() => setPage('main')}
      >
        <SlideIn pageKey="phoneModels">
          <PhoneModels t={t} task={task} config={config} shared={siblingOnDevice} />
        </SlideIn>
      </BottomSheet>
    );
  }

  if (page === 'models' && placement.place === 'key' && placement.source) {
    const source = placement.source as Source;
    return (
      <BottomSheet
        visible={!!requested}
        onClose={onClose}
        title={t('taskModel', { task: title })}
        onBack={() => setPage('main')}
      >
        <SlideIn pageKey="models">
          <SectionLabel source={source}>{sourceName(source)}</SectionLabel>
          <SheetCard>
            {keyModels.map((model) => (
              <RadioRow
                key={model}
                title={modelLabel(source, task, model)}
                selected={model === placement.modelId}
                onPress={() =>
                  pick(async () => {
                    await runOnSource(source, task, model);
                    setPage('main');
                  })
                }
              />
            ))}
          </SheetCard>
          <Text style={[settings.subtitle, { paddingHorizontal: 4 }]}>
            {noOrphan(t('onlyThisTask', { task: title }))}
          </Text>
        </SlideIn>
      </BottomSheet>
    );
  }

  return (
    <BottomSheet
      visible={!!requested}
      onClose={onClose}
      title={title}
      leading={<Tile kind="sel" icon={TASK_ICON[task]} />}
    >
      <SlideIn pageKey="main" back>
        {cleanupOff && (
          <Text style={[settings.subtitle, { paddingHorizontal: 4 }]}>{t('cleanupIsOff')}</Text>
        )}
        <View style={{ gap: 8 }}>
          <SectionLabel>{t('runsOn')}</SectionLabel>
          <SheetCard>
            <RadioRow
              icon="Cloud"
              title={t('cloud')}
              tag={meeting ? { label: t('live') } : undefined}
              subtitle={t(meeting ? 'wordsAsPeopleTalk' : 'fastest')}
              selected={placement.place === 'cloud' && !waiting}
              onPress={() => pick(() => setTask(task, { mode: 'openwhispr' }))}
            />
            <RadioRow
              icon="Smartphone"
              title={t('thisPhone')}
              tag={meeting ? { label: t('after'), neutral: true } : undefined}
              subtitle={deviceSubtitle}
              selected={placement.place === 'device' || waiting}
              onPress={
                placement.place === 'device' || waiting
                  ? undefined
                  : () => void run(() => moveTasksOnDevice([task]))
              }
            />
            {keyRows.map((row) => (
              <RadioRow
                key={row.source}
                leading={
                  <Tile
                    kind={
                      row.source !== 'custom' ? 'logo' : row.selected && !waiting ? 'sel' : 'idle'
                    }
                    source={row.source}
                  />
                }
                title={
                  row.source === 'custom'
                    ? t('customServer')
                    : t('sourceKey', { provider: sourceName(row.source) })
                }
                tag={
                  meeting && row.can && isLiveProvider(row.source)
                    ? { label: t('live') }
                    : undefined
                }
                subtitle={row.subtitle}
                selected={row.selected && !waiting}
                disabled={!row.can}
                onPress={row.selected ? undefined : () => pick(() => runOnSource(row.source, task))}
              />
            ))}
            <AddRow label={t('addAKey')} onPress={onAddKey} />
          </SheetCard>
        </View>

        {(placement.place === 'device' || waiting) && (
          <View style={{ gap: 8 }}>
            <SectionLabel>{t('model')}</SectionLabel>
            <SheetCard>
              <ListRow title={modelName(phoneModel)} onPress={() => setPage('phoneModels')} />
            </SheetCard>
          </View>
        )}

        {placement.place === 'key' && placement.source && keyModels.length > 1 && !waiting && (
          <View style={{ gap: 8 }}>
            <SectionLabel>{t('model')}</SectionLabel>
            <SheetCard>
              <ListRow
                title={modelLabel(placement.source, task, placement.modelId)}
                onPress={() => setPage('models')}
              />
            </SheetCard>
          </View>
        )}

        {task === 'cleanup' && (
          <View style={{ gap: 8 }}>
            <SectionLabel>{t('prompt')}</SectionLabel>
            <SheetCard>
              <ListRow
                title={t('cleanupPrompt')}
                value={customPrompt ? t('custom') : t('default')}
                onPress={() => {
                  onClose();
                  router.push('/(account)/cleanup-prompt');
                }}
              />
            </SheetCard>
          </View>
        )}
        {/* Room under the last card, so its shadow is never cut by the sheet's edge. */}
        <View style={{ height: 4 }} />
      </SlideIn>
    </BottomSheet>
  );
}
