import { useRef, useState } from 'react';
import { ActivityIndicator, Alert } from 'react-native';
import { home } from '../home/kit';
import { useLocalSearchParams } from 'expo-router';
import { useConfigStore } from '@/store/useConfigStore';
import { ANDROID_MODELS, removeAndroidModel, type AndroidModelId } from '../models';
import type { AndroidSpeechModelId } from '../speechSelection';
import { Group, ListRow, SettingsPage, showToast, useReduceMotion } from './kit';
import { ModelRow } from './ModelRow';
import { MODEL_ROWS, formatSize, modelName, useModelsReady, type ModelKind } from './modelCatalog';
import { useSettingsT, type SettingsKey } from './strings';
import type { UserConfig } from '@/types';

const TITLE: Record<ModelKind, SettingsKey> = {
  speech: 'speechModel',
  text: 'textModel',
  diarization: 'meetingSpeakers',
};

/** Settings → Processing → Speech, Text cleanup or Meeting speakers: downloaded, available, remove. */
export default function ModelScreen() {
  const t = useSettingsT();
  const reduceMotion = useReduceMotion();
  const params = useLocalSearchParams<{ kind?: string }>();
  const kind: ModelKind =
    params.kind === 'text' || params.kind === 'diarization' ? params.kind : 'speech';
  const config = useConfigStore((s) => s.config);
  const { ready, checked, progress, refresh } = useModelsReady();
  const rows = MODEL_ROWS.filter((row) => row.kind === kind);
  const inUse: AndroidModelId | undefined =
    kind === 'speech'
      ? (config?.androidSpeechModel ?? 'parakeet-v3')
      : kind === 'text'
        ? (config?.androidTextModel ?? 'qwen-balanced')
        : undefined;
  const downloadingId = Object.keys(progress)[0];
  // A row keeps its place while it downloads and draws its check, then moves to Downloaded.
  const pinned = useRef(new Set<AndroidModelId>()).current;
  const [, settle] = useState(0);
  for (const item of rows) if (progress[item.id] !== undefined) pinned.add(item.id);
  const use = (id: AndroidModelId) => {
    if (kind === 'diarization') return;
    const change: Partial<UserConfig> =
      kind === 'speech'
        ? { androidSpeechModel: id as AndroidSpeechModelId }
        : { androidTextModel: id as 'qwen-small' | 'qwen-balanced' };
    void useConfigStore.getState().updateConfig(change);
  };

  const settled = (id: AndroidModelId, ok: boolean) => {
    if (ok) use(id);
    setTimeout(
      () => {
        pinned.delete(id);
        settle((count) => count + 1);
      },
      !ok || reduceMotion ? 0 : 900,
    );
  };

  const remove = (id: AndroidModelId) => {
    const name = modelName(id);
    Alert.alert(
      t('removeTitle', { model: name }),
      id === inUse
        ? t('removeInUseBody', { kind: t(kind === 'speech' ? 'speechKind' : 'textKind') })
        : t('removeBody'),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('remove'),
          style: 'destructive',
          onPress: () => {
            removeAndroidModel(id)
              .then(refresh)
              .catch((error: Error) => showToast(error.message, 'error'));
          },
        },
      ],
    );
  };

  const row = (item: (typeof rows)[number]) => (
    <ModelRow
      key={item.id}
      row={item}
      ready={Boolean(ready[item.id])}
      inUse={item.id === inUse}
      progress={progress[item.id]}
      dimmed={downloadingId !== undefined && downloadingId !== item.id}
      reduceMotion={reduceMotion}
      onUse={() => use(item.id)}
      onSettled={(ok) => settled(item.id, ok)}
    />
  );
  const downloaded = rows.filter((item) => ready[item.id] && !pinned.has(item.id));
  const available = checked ? rows.filter((item) => !ready[item.id] || pinned.has(item.id)) : [];

  return (
    <SettingsPage title={t(TITLE[kind])}>
      {!checked && <ActivityIndicator color={home.accent} style={{ marginTop: 24 }} />}
      {downloaded.length > 0 && (
        <Group title={kind === 'diarization' ? t('speakerDetection') : t('downloaded')}>
          {downloaded.map(row)}
        </Group>
      )}
      {available.length > 0 && (
        <Group
          title={kind === 'diarization' ? t('speakerDetection') : t('available')}
          footer={kind === 'diarization' ? t('meetingRuns') : undefined}
        >
          {available.map(row)}
        </Group>
      )}
      {downloaded.length > 0 && (
        <Group footer={kind === 'diarization' && !available.length ? t('meetingRuns') : undefined}>
          {downloaded.map((item) => (
            <ListRow
              key={item.id}
              icon="Trash2"
              title={t('removeModel', { model: modelName(item.id) })}
              subtitle={t('frees', { size: formatSize(ANDROID_MODELS[item.id].bytes) })}
              trailing={null}
              dimmed={downloadingId !== undefined}
              onPress={downloadingId ? undefined : () => remove(item.id)}
            />
          ))}
        </Group>
      )}
    </SettingsPage>
  );
}
