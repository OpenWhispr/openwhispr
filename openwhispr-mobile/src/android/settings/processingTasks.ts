import { useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useConfigStore } from '@/store/useConfigStore';
import { workflowSelection } from '@/lib/aiWorkflows';
import type { CloudAccess } from '@/lib/inferenceModes';
import { providerDisplayName } from '@/android/providers/mobileProviders';
import { getPreferredTranscriptionLanguages } from '@/lib/transcriptionLanguage';
import type { ProcessingMode, UserConfig } from '@/types';
import { speechModelSupportsLanguages } from '../speechCapabilities';
import type { AndroidSpeechModelId } from '../speechSelection';
import type { AndroidModelId } from '../models';
import { LIVE_MODEL, meetingKey } from '../providers/liveMeeting';
import { MODEL_ROWS, modelName, useModelsReady } from './modelCatalog';
import type { KeyTask } from './ownKey';
import { differsFromDefault, type ProcessingDefault } from './processingDefault';
import type { SettingsT } from './strings';

/** The on-phone model a task uses: speech for audio, text for words. */
export function phoneModelFor(config: UserConfig | null, task: KeyTask): AndroidModelId {
  return task === 'dictation' || task === 'upload'
    ? (config?.androidSpeechModel ?? 'parakeet-v3')
    : (config?.androidTextModel ?? 'qwen-balanced');
}

/**
 * What a task runs on: its own choice, or with none saved, what the mode gives it. The Assistant
 * (the bubble's hold menu) ran on Text cleanup's engine before it had a task of its own, so with
 * nothing saved for it, it still follows Text cleanup.
 */
export function effectiveSelection(
  config: UserConfig | null,
  task: KeyTask,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess,
) {
  if (task === 'agent' && !config?.inference?.agent)
    return workflowSelection(config, 'cleanup', activeMode, cloudAccess);
  return workflowSelection(config, task, activeMode, cloudAccess);
}

/** A task's row on Processing: where it runs, and whether that differs from the Default. */
export function taskSummary(
  t: SettingsT,
  config: UserConfig | null,
  task: KeyTask,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess,
  defaults: ProcessingDefault,
): { engine: string; changed: boolean } {
  if (task === 'cleanup' && !(config?.cleanupEnabled ?? true))
    return { engine: t('offInSettings'), changed: false };
  const selection = effectiveSelection(config, task, activeMode, cloudAccess);
  const changed = differsFromDefault(selection, selection.mode, defaults);
  if (selection.mode === 'openwhispr') return { engine: t('cloud'), changed };
  if (selection.mode === 'local')
    return { engine: `${t('thisPhone')} · ${modelName(phoneModelFor(config, task))}`, changed };
  if (!selection.providerId) return { engine: t('ownKey'), changed };
  return {
    engine: [providerDisplayName(selection.providerId), selection.modelId]
      .filter(Boolean)
      .join(' · '),
    changed,
  };
}

/** The Meetings row: a key, on device afterwards, or OpenWhispr Cloud. */
export function meetingSummary(
  t: SettingsT,
  config: UserConfig | null,
  defaults: ProcessingDefault,
): { engine: string; changed: boolean } {
  const selection = config?.inference?.meeting;
  const changed = differsFromDefault(selection, 'openwhispr', defaults);
  const key = meetingKey();
  if (key)
    return {
      engine: t('meetingKeyValue', {
        provider: providerDisplayName(key.providerId),
        model: key.modelId || LIVE_MODEL[key.providerId],
      }),
      changed,
    };
  return {
    engine: t(selection?.mode === 'local' ? 'meetingPhoneValue' : 'meetingCloudValue'),
    changed,
  };
}

/**
 * Puts something on the phone that needs a speech model (the On device Default, Dictation or
 * Audio uploads). With no speech model that can do the user's languages, the download sheet
 * opens instead (`needsModel`), and `goLocal` finishes the change once one is ready.
 */
export function useChoosePhone(t: SettingsT) {
  const { ready, checked } = useModelsReady();
  const [needsModel, setNeedsModel] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef<(() => Promise<unknown>) | null>(null);

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

  const choosePhone = (then: () => Promise<unknown>) => {
    // Until the phone's models are checked, a missing model can't be told from an unchecked one.
    if (!checked) return;
    const languages = getPreferredTranscriptionLanguages();
    const speechId = useConfigStore.getState().config?.androidSpeechModel ?? 'parakeet-v3';
    const usable = MODEL_ROWS.filter(
      (row) =>
        row.kind === 'speech' &&
        ready[row.id] &&
        speechModelSupportsLanguages(row.id as AndroidSpeechModelId, languages),
    ).map((row) => row.id as AndroidSpeechModelId);
    if (!usable.length) {
      pending.current = then;
      setNeedsModel(true);
      return;
    }
    void run(async () => {
      if (!usable.includes(speechId))
        await useConfigStore.getState().updateConfig({ androidSpeechModel: usable[0] });
      await then();
    });
  };

  return {
    choosePhone,
    run,
    needsModel,
    closeModelSheet: () => setNeedsModel(false),
    goLocal: () => {
      const then = pending.current;
      pending.current = null;
      if (then) void run(then);
    },
  };
}
