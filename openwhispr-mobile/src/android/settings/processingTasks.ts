import { useState } from 'react';
import { Alert } from 'react-native';
import { useConfigStore } from '@/store/useConfigStore';
import { workflowSelection } from '@/lib/aiWorkflows';
import { ANDROID_LOCAL_MODE_LOCKED } from '../workflowPolicy';
import type { CloudAccess } from '@/lib/inferenceModes';
import { providerDisplayName, type InferenceMode } from '@/lib/mobileProviders';
import { switchWorkflowMode } from '@/lib/workflowModeSwitch.android';
import { getPreferredTranscriptionLanguages } from '@/lib/transcriptionLanguage';
import type { ProcessingMode, UserConfig } from '@/types';
import { speechModelSupportsLanguages } from '../speechCapabilities';
import type { AndroidSpeechModelId } from '../speechSelection';
import type { AndroidModelId } from '../models';
import { LIVE_MODEL, meetingKey } from '../providers/liveMeeting';
import { MODEL_ROWS, modelName, useModelsReady } from './modelCatalog';
import type { KeyTask } from './ownKey';
import type { SettingsT } from './strings';

/** The mode each task follows when it has no choice of its own. */
export const DEFAULT_MODE: Record<ProcessingMode, InferenceMode> = {
  cloud: 'openwhispr',
  private: 'local',
  providers: 'providers',
};

/** The on-phone model a task uses: speech for audio, text for words. */
export function phoneModelFor(config: UserConfig | null, task: KeyTask): AndroidModelId {
  return task === 'dictation' || task === 'upload'
    ? (config?.androidSpeechModel ?? 'parakeet-v3')
    : (config?.androidTextModel ?? 'qwen-balanced');
}

/** Whether a mode can't be chosen for a task while On this phone is the default. */
export function lockedOut(task: KeyTask, mode: InferenceMode, activeMode: ProcessingMode) {
  return activeMode === 'private' && !!ANDROID_LOCAL_MODE_LOCKED[task]?.includes(mode);
}

/** What a task actually runs on, with Local Mode's locks applied. */
export function effectiveSelection(
  config: UserConfig | null,
  task: KeyTask,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess,
) {
  const selection = workflowSelection(config, task, activeMode, cloudAccess);
  if (task === 'dictation' && activeMode === 'private') return { mode: 'local' as const };
  if (lockedOut(task, selection.mode, activeMode)) return { mode: 'local' as const };
  return selection;
}

/**
 * A task's row on Processing: where it runs, and whether that differs from the default for
 * every task ("Changed"). Dictation sets the default, so it is never changed.
 */
export function taskSummary(
  t: SettingsT,
  config: UserConfig | null,
  task: KeyTask,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess,
): { engine: string; changed: boolean } {
  if (task === 'cleanup' && !(config?.cleanupEnabled ?? true))
    return { engine: t('offInSettings'), changed: false };
  // In Local Mode, cleanup that wasn't set to the phone or a key is skipped.
  if (
    task === 'cleanup' &&
    activeMode === 'private' &&
    !['local', 'providers'].includes(config?.inference?.cleanup?.mode ?? '')
  )
    return { engine: t('cleanupSkipped'), changed: true };
  const selection = effectiveSelection(config, task, activeMode, cloudAccess);
  const dictation = effectiveSelection(config, 'dictation', activeMode, cloudAccess);
  const changed =
    task !== 'dictation' &&
    (selection.mode !== DEFAULT_MODE[activeMode] ||
      (selection.mode === 'providers' && selection.providerId !== dictation.providerId));
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

/** The Meetings row: live on a key saved for meetings, else whatever the default gives. */
export function meetingSummary(
  t: SettingsT,
  activeMode: ProcessingMode,
): { engine: string; changed: boolean } {
  const key = meetingKey();
  if (key)
    return {
      engine: t('meetingKeyValue', {
        provider: providerDisplayName(key.providerId),
        model: key.modelId || LIVE_MODEL[key.providerId],
      }),
      changed: activeMode !== 'providers',
    };
  return {
    engine: t(activeMode === 'private' ? 'meetingPhoneValue' : 'meetingCloudValue'),
    changed: false,
  };
}

/**
 * Makes On this phone the default. With no speech model that can do the user's languages, the
 * download sheet opens instead (`needsModel`), and `goLocal` finishes the switch once one is ready.
 */
export function useChoosePhone(t: SettingsT) {
  const { ready, checked } = useModelsReady();
  const [needsModel, setNeedsModel] = useState(false);
  const [busy, setBusy] = useState(false);

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

  const choosePhone = () => {
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
      setNeedsModel(true);
      return;
    }
    void run(async () => {
      if (!usable.includes(speechId))
        await useConfigStore.getState().updateConfig({ androidSpeechModel: usable[0] });
      await switchWorkflowMode('dictation', 'local');
    });
  };

  return {
    choosePhone,
    run,
    needsModel,
    closeModelSheet: () => setNeedsModel(false),
    goLocal: () => void run(() => switchWorkflowMode('dictation', 'local')),
  };
}
