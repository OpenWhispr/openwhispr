import { useEffect, useState } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { workflowSaveConfig } from '@/lib/inferenceModes';
import {
  defaultModelId,
  getMobileProvidersForScope,
  type InferenceSelection,
  type MobileInferenceScope,
} from '@/lib/mobileProviders';
import {
  getProviderCredential,
  getProviderCredentialReference,
  getProviderCredentialStatus,
  setProviderCredential,
  subscribeProviderCredentialChanges,
} from '@/services/providers/ProviderCredentials';
import { LIVE_MODEL, isLiveProvider } from '../providers/liveMeeting';
import type { KeyProviderId } from './keyCheck';

/** The tasks with a Runs on page of their own, in order. Meetings has its own page. */
export const TASKS = ['dictation', 'upload', 'cleanup', 'notes'] as const;
export type KeyTask = (typeof TASKS)[number];
/** Every task a key can run, as the key sheet lists them. */
export const SHEET_TASKS = [...TASKS, 'meeting'] as const;
export type SheetTask = (typeof SHEET_TASKS)[number];

export const KEY_PROVIDERS: { id: KeyProviderId; name: string; keyUrl: string }[] = [
  { id: 'openai', name: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'groq', name: 'Groq', keyUrl: 'https://console.groq.com/keys' },
  { id: 'deepgram', name: 'Deepgram', keyUrl: 'https://console.deepgram.com' },
  { id: 'assemblyai', name: 'AssemblyAI', keyUrl: 'https://www.assemblyai.com/dashboard' },
  { id: 'openrouter', name: 'OpenRouter', keyUrl: 'https://openrouter.ai/keys' },
];

// OpenRouter has no catalog of its own; this is the model the design starts it on.
const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4.1-mini';

/** The models a provider offers for a task, best first; none for a task it can't run. */
export function providerModels(provider: string, task: MobileInferenceScope): string[] {
  const definition = getMobileProvidersForScope(task).find((item) => item.id === provider);
  if (!definition) return [];
  if (provider === 'openrouter') return [OPENROUTER_DEFAULT_MODEL];
  return definition.models.filter((model) => !model.legacy).map((model) => model.id);
}

/** Meetings need a provider that transcribes while people talk. */
export function providerCanRun(provider: string, task: MobileInferenceScope | 'meeting'): boolean {
  if (task === 'meeting') return isLiveProvider(provider);
  return getMobileProvidersForScope(task).some((item) => item.id === provider);
}

/** The model a task starts on with a provider: the one used before, else the provider's best. */
export function startingModel(provider: string, task: MobileInferenceScope | 'meeting'): string {
  if (task === 'meeting') return isLiveProvider(provider) ? LIVE_MODEL[provider] : '';
  const remembered = useConfigStore.getState().config?.rememberedInference?.[task]?.[provider];
  if (remembered?.modelId) return remembered.modelId;
  if (provider === 'openrouter') return OPENROUTER_DEFAULT_MODEL;
  return defaultModelId(getMobileProvidersForScope(task).find((item) => item.id === provider));
}

/** Which providers have a saved key, kept current as keys are added and removed. */
export function useSavedKeys(): Partial<Record<KeyProviderId, boolean>> {
  const [saved, setSaved] = useState<Partial<Record<KeyProviderId, boolean>>>({});
  useEffect(() => {
    let live = true;
    const read = async () => {
      const entries = await Promise.all(
        KEY_PROVIDERS.map(async ({ id }) => {
          const reference = await getProviderCredentialReference(id);
          const status = await getProviderCredentialStatus(reference).catch(() => null);
          return [id, !!status?.isConfigured] as const;
        }),
      );
      if (live) setSaved(Object.fromEntries(entries));
    };
    void read();
    const unsubscribe = subscribeProviderCredentialChanges(() => void read());
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return saved;
}

/** The saved key for a provider, for the sheet to show locked in. */
export async function savedKey(provider: KeyProviderId): Promise<string | null> {
  const credential = await getProviderCredential(await getProviderCredentialReference(provider));
  return credential?.apiKey ?? null;
}

/** First and last characters only, as a locked key shows. */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 10) return '•'.repeat(trimmed.length);
  const head = trimmed.indexOf('-') > 0 && trimmed.indexOf('-') < 8 ? trimmed.indexOf('-') + 1 : 3;
  return `${trimmed.slice(0, head)}••••••••${trimmed.slice(-4)}`;
}

/** Runs a task on a provider whose key is saved, on the model it used before or its best one. */
export async function runTaskOnKey(
  provider: KeyProviderId,
  task: MobileInferenceScope | 'meeting',
  modelId = startingModel(provider, task),
): Promise<void> {
  const selection: InferenceSelection = {
    mode: 'providers',
    providerId: provider,
    modelId,
    credentialRef: await getProviderCredentialReference(provider),
  };
  const { activeMode, setActiveMode } = useProcessingModeStore.getState();
  const { updateConfig } = useConfigStore.getState();
  // Meetings keep their key beside the other tasks' choices; nothing else follows it.
  if (task === 'meeting') {
    const config = useConfigStore.getState().config;
    await updateConfig({ inference: { ...config?.inference, meeting: selection } });
    return;
  }
  await updateConfig(
    workflowSaveConfig(useConfigStore.getState().config, task, selection, activeMode),
  );
  // Dictation sets the default for every task, so its key becomes the default.
  if (task === 'dictation') setActiveMode('providers', true);
}

/** Meetings go back to following the default for every task. */
export async function clearMeetingKey(): Promise<void> {
  const { config, updateConfig } = useConfigStore.getState();
  if (!config?.inference?.meeting) return;
  const { meeting: _meeting, ...rest } = config.inference;
  await updateConfig({ inference: rest });
}

/** Saves a key that passed its check, so every task page can offer it. */
export async function saveKey(provider: KeyProviderId, apiKey: string): Promise<void> {
  await setProviderCredential(await getProviderCredentialReference(provider), {
    apiKey: apiKey.trim(),
  });
}

/** Saves the key once, then runs each ticked task on it. Dictation goes first: it sets the mode. */
export async function applyKeyToTasks(
  provider: KeyProviderId,
  apiKey: string,
  tasks: SheetTask[],
): Promise<void> {
  await saveKey(provider, apiKey);
  const ordered = SHEET_TASKS.filter((task) => tasks.includes(task));
  for (const task of ordered) await runTaskOnKey(provider, task);
}
