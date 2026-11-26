import { useEffect, useState } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import {
  getMobileProvidersForScope,
  isTranscriptionScope,
  type MobileInferenceScope,
} from '@/android/providers/mobileProviders';
import {
  getProviderCredential,
  getProviderCredentialReference,
  getProviderCredentialStatus,
  setProviderCredential,
  subscribeProviderCredentialChanges,
} from '@/services/providers/ProviderCredentials';
import { LIVE_MODEL, isLiveProvider } from '../providers/liveMeeting';
import { OPENROUTER_MODELS, RETIRING, TEXT_DEFAULT } from './androidModels';
import type { KeyProviderId } from './keyCheck';
import { keySelection, setTask } from './processingDefault';

/** The tasks with a Runs on page of their own, in order. Meetings has its own page. */
export const TASKS = ['dictation', 'upload', 'cleanup', 'notes', 'agent'] as const;
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

/**
 * The models a provider offers for a task, the starting one first; none for a task it can't
 * run. Legacy and retiring models are left out (androidModels.ts).
 */
export function providerModels(provider: string, task: MobileInferenceScope): string[] {
  const definition = getMobileProvidersForScope(task).find((item) => item.id === provider);
  if (!definition) return [];
  if (provider === 'openrouter') return OPENROUTER_MODELS;
  const models = definition.models
    .filter((model) => !model.legacy && !RETIRING.has(model.id))
    .map((model) => model.id);
  const first = isTranscriptionScope(task) ? undefined : TEXT_DEFAULT[provider];
  return first && models.includes(first)
    ? [first, ...models.filter((model) => model !== first)]
    : models;
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
  const models = providerModels(provider, task);
  if (remembered?.modelId && models.includes(remembered.modelId)) return remembered.modelId;
  return models[0] ?? '';
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
  // Each task runs its own engine: moving one onto a key leaves the others where they are.
  await setTask(task as SheetTask, await keySelection(provider, task as SheetTask, modelId));
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
