import { ActivityIndicator, Alert } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { create } from 'zustand';
import { useConfigStore } from '@/store/useConfigStore';
import { home } from '../home/kit';
import { ANDROID_MODELS, removeAndroidModel, type AndroidModelId } from '../models';
import { canTranscribeMeetings, type AndroidSpeechModelId } from '../speechSelection';
import { modelSupported } from '../models';
import { Group, SettingsPage, showToast, useReduceMotion } from './kit';
import { ModelListRow, type ModelState } from './ModelListRow';
import { startModelDownload } from './ModelRow';
import { MODEL_ROWS, formatSize, modelName, useModelsReady, type ModelKind } from './modelCatalog';
import { settingsT, useSettingsT, type SettingsKey } from './strings';
import type { UserConfig } from '@/types';
import { speakerModelRemovedByUser } from '../liveSpeakers/speakerModel';

/** `meeting`: the speech models that can transcribe meetings, apart from dictation's choice. */
type ScreenKind = ModelKind | 'meeting';
const TITLE: Record<ScreenKind, SettingsKey> = {
  speech: 'speechModel',
  text: 'textModel',
  diarization: 'meetingSpeakers',
  meeting: 'meetingRecording',
};
const NOTHING: Record<ScreenKind, SettingsKey> = {
  speech: 'nothingSpeech',
  text: 'nothingText',
  diarization: 'nothingMeeting',
  meeting: 'nothingMeetingRecording',
};

/** Models removed from the list whose files wait for the Undo snackbar to close. */
export const useRemovals = create<{ pending: AndroidModelId[] }>(() => ({ pending: [] }));
export const setPending = (id: AndroidModelId, pending: boolean) =>
  useRemovals.setState((state) => ({
    pending: pending ? [...state.pending, id] : state.pending.filter((item) => item !== id),
  }));

/** The row goes back to "not downloaded" at once; the files go only when the snackbar closes. */
export function removeWithUndo(id: AndroidModelId, refresh: () => Promise<void>) {
  setPending(id, true);
  showToast(settingsT('removedModel', { model: modelName(id) }), 'neutral', {
    label: settingsT('undo'),
    onPress: () => setPending(id, false),
    onClose: () => {
      removeAndroidModel(id)
        .then(() => {
          if (id === 'meeting-speakers') speakerModelRemovedByUser(true);
        })
        .catch((error: Error) => showToast(error.message, 'error'))
        .then(refresh)
        .finally(() => setPending(id, false));
    },
  });
}

/**
 * Settings → Processing → Speech, Text cleanup or Meeting speakers (8.3 v2): one list in a fixed
 * order, each row showing whether it is on the phone, downloading, ready or in use, with a bin.
 */
export default function ModelScreen() {
  const t = useSettingsT();
  const reduceMotion = useReduceMotion();
  const params = useLocalSearchParams<{ kind?: string }>();
  const kind: ScreenKind =
    params.kind === 'text' || params.kind === 'diarization' || params.kind === 'meeting'
      ? params.kind
      : 'speech';
  const config = useConfigStore((s) => s.config);
  const pending = useRemovals((s) => s.pending);
  const { ready, checked, progress, refresh } = useModelsReady();
  const rows = MODEL_ROWS.filter((row) =>
    kind === 'meeting'
      ? row.kind === 'speech' && canTranscribeMeetings(row.id) && modelSupported(row.id)
      : row.kind === kind,
  );
  const onPhone = (id: AndroidModelId) => Boolean(ready[id]) && !pending.includes(id);
  // Meeting speakers has one model, used whenever it is on the phone. Meetings use the first
  // meeting model on the phone, so nothing is chosen there.
  const chosen: AndroidModelId =
    kind === 'speech'
      ? (config?.androidSpeechModel ?? 'parakeet-v3')
      : kind === 'text'
        ? (config?.androidTextModel ?? 'qwen-balanced')
        : kind === 'meeting'
          ? (rows.find((row) => ready[row.id])?.id ?? rows[0].id)
          : rows[0].id;
  const downloadingId = Object.keys(progress)[0];

  const use = (id: AndroidModelId) => {
    if (kind === 'diarization' || kind === 'meeting') return;
    const change: Partial<UserConfig> =
      kind === 'speech'
        ? { androidSpeechModel: id as AndroidSpeechModelId }
        : { androidTextModel: id as 'qwen-small' | 'qwen-balanced' };
    void useConfigStore.getState().updateConfig(change);
  };

  const remove = (id: AndroidModelId) => {
    // A meeting model that is also the dictation model warns as the speech list does.
    const inUse =
      kind === 'meeting' ? id === (config?.androidSpeechModel ?? 'parakeet-v3') : id === chosen;
    if (!inUse || kind === 'diarization') {
      removeWithUndo(id, refresh);
      return;
    }
    // 8.6: removing the model in use stops on-device processing until another is chosen.
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

  const downloaded = rows.filter((row) => onPhone(row.id));
  const bytes = downloaded.reduce((sum, row) => sum + ANDROID_MODELS[row.id].bytes, 0);

  return (
    <SettingsPage title={t(TITLE[kind])}>
      {!checked ? (
        <ActivityIndicator color={home.accent} style={{ marginTop: 24 }} />
      ) : (
        <Group
          inset={56}
          footer={
            downloaded.length
              ? t('modelsOnPhone', { count: downloaded.length, size: formatSize(bytes) })
              : t(NOTHING[kind])
          }
        >
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
                // A finished download is only chosen when nothing usable was chosen yet.
                if (ok && kind !== 'meeting' && !onPhone(chosen)) use(row.id);
              }}
            />
          ))}
        </Group>
      )}
    </SettingsPage>
  );
}
