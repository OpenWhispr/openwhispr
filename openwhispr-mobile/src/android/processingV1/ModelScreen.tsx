import { ActivityIndicator, Alert } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useConfigStore } from '@/store/useConfigStore';
import type { UserConfig } from '@/types';
import { home } from '../home/kit';
import { ANDROID_MODELS, removeAndroidModel, type AndroidModelId } from '../models';
import type { AndroidSpeechModelId } from '../speechSelection';
import { Group, ListRow, SettingsPage, showToast, useReduceMotion } from '../settings/kit';
import { ModelRow } from '../settings/ModelRow';
import {
  MODEL_ROWS,
  formatSize,
  modelName,
  useModelsReady,
  type ModelKind,
} from '../settings/modelCatalog';
import { useV1T } from './strings';

const TITLE = { speech: 'speechModel', text: 'textModel', diarization: 'meetingSpeakers' } as const;

/**
 * 8.3–8.8: an on-device model kind. Downloaded models first (the one in use ticked), then the
 * ones to download, each with the V1 ring; then a Remove row per model on the phone. Removing
 * the one in use warns first (8.6). Cancelled and failed downloads say so (8.4, 8.5).
 */
export default function ModelScreenV1() {
  const t = useV1T();
  const reduceMotion = useReduceMotion();
  const params = useLocalSearchParams<{ kind?: string }>();
  const kind: ModelKind =
    params.kind === 'text' || params.kind === 'diarization' ? params.kind : 'speech';
  const config = useConfigStore((s) => s.config);
  const { ready, checked, progress, refresh } = useModelsReady();
  const rows = MODEL_ROWS.filter((row) => row.kind === kind);
  const chosen: AndroidModelId =
    kind === 'speech'
      ? (config?.androidSpeechModel ?? 'parakeet-v3')
      : kind === 'text'
        ? (config?.androidTextModel ?? 'qwen-balanced')
        : rows[0].id;
  const downloadingId = Object.keys(progress)[0];

  const use = (id: AndroidModelId) => {
    if (kind === 'diarization') return;
    const change: Partial<UserConfig> =
      kind === 'speech'
        ? { androidSpeechModel: id as AndroidSpeechModelId }
        : { androidTextModel: id as 'qwen-small' | 'qwen-balanced' };
    void useConfigStore.getState().updateConfig(change);
  };

  const remove = (id: AndroidModelId) => {
    const size = formatSize(ANDROID_MODELS[id].bytes);
    const inUse = id === chosen && kind !== 'diarization';
    Alert.alert(
      t('removeModelTitle', { model: modelName(id) }),
      inUse
        ? t('removeInUse', { kind: t(kind === 'speech' ? 'speechKind' : 'textKind') })
        : t('removeModelBody', { size }),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('remove'),
          style: 'destructive',
          onPress: () =>
            void removeAndroidModel(id)
              .then(() => showToast(t('removedModel', { model: modelName(id) }), 'neutral'))
              .catch((error: Error) => showToast(error.message, 'error'))
              .finally(() => void refresh()),
        },
      ],
    );
  };

  const row = (item: (typeof rows)[number]) => (
    <ModelRow
      key={item.id}
      row={item}
      ready={Boolean(ready[item.id])}
      inUse={Boolean(ready[item.id]) && item.id === chosen}
      progress={progress[item.id]}
      dimmed={downloadingId !== undefined && downloadingId !== item.id}
      reduceMotion={reduceMotion}
      onUse={() => use(item.id)}
      onSettled={(ok) => {
        void refresh();
        // A finished download is chosen when nothing usable was chosen yet.
        if (ok && !ready[chosen]) use(item.id);
      }}
    />
  );

  const onPhone = rows.filter((item) => ready[item.id] || progress[item.id] !== undefined);
  const toGet = rows.filter((item) => !ready[item.id] && progress[item.id] === undefined);
  const removable = rows.filter((item) => ready[item.id] && progress[item.id] === undefined);

  return (
    <SettingsPage title={t(TITLE[kind])}>
      {!checked ? (
        <ActivityIndicator color={home.accent} style={{ marginTop: 24 }} />
      ) : kind === 'diarization' ? (
        <Group title={t('speakerDetection')} footer={t('speakerFooter')}>
          {rows.map(row)}
        </Group>
      ) : (
        <>
          {onPhone.length > 0 && <Group title={t('downloaded')}>{onPhone.map(row)}</Group>}
          {toGet.length > 0 && <Group title={t('available')}>{toGet.map(row)}</Group>}
        </>
      )}
      {checked &&
        removable.map((item) => (
          <Group key={`remove-${item.id}`}>
            <ListRow
              icon="Trash2"
              title={t('removeModel', { model: modelName(item.id) })}
              subtitle={t('frees', { size: formatSize(ANDROID_MODELS[item.id].bytes) })}
              trailing={null}
              onPress={() => remove(item.id)}
            />
          </Group>
        ))}
    </SettingsPage>
  );
}
