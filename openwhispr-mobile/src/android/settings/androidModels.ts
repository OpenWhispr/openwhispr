import { useConfigStore } from '@/android/store/useConfigStore';
import type { InferenceSelection } from '@/android/providers/mobileProviders';
import type { UserConfig } from '@/android/types';

/**
 * Android's model choices for your own key, checked against each provider's own model and
 * deprecation pages on 18 Nov 2026 (shared notes: android-byok-models-research.md). The shared
 * catalog, which iOS also reads, is left as it is; Android chooses from it here.
 */

/** OpenRouter has no catalog of its own: current models across vendors, the default first. */
export const OPENROUTER_MODELS = [
  'openai/gpt-6-luna',
  'anthropic/claude-haiku-5.5',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.6-flash',
  'google/gemini-3.8-flash',
  'openai/gpt-6.1-terra',
  'deepseek/deepseek-v4.1-flash',
  'qwen/qwen3.8-flash',
  'mistralai/mistral-small-2603',
  'openai/gpt-oss-120b',
  'google/gemma-4-31b-it',
  'minimax/minimax-m3.1-flash',
];

/** The model a provider's text tasks start on, when the catalog's first one is a flagship. */
export const TEXT_DEFAULT: Partial<Record<string, string>> = { openai: 'gpt-6-luna' };

/**
 * Models OpenAI has announced it will shut down (Feb 26, 2027). Hidden on Android, so nobody
 * new picks them. Live meetings keep `gpt-4o-transcribe` for now: its replacement takes no
 * server turn detection, which the meeting connection relies on.
 */
export const RETIRING = new Set(['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1']);

/** A saved model that's gone or going, and what it becomes, per provider. */
const REPLACED: Record<string, Record<string, string>> = {
  openrouter: { 'openai/gpt-4.1-mini': 'openai/gpt-6-luna' },
  openai: {
    'gpt-4o-mini-transcribe': 'gpt-transcribe',
    'whisper-1': 'gpt-transcribe',
  },
  assemblyai: {
    universal: 'assemblyai-stt-3-7',
    'universal-streaming': 'assemblyai-stt-3-7-realtime',
  },
};

function replaced(
  task: string,
  selection: InferenceSelection | undefined,
): InferenceSelection | undefined {
  if (selection?.mode !== 'providers' || !selection.providerId || !selection.modelId) return;
  // gpt-4o-transcribe stays on live meetings (see RETIRING); dictation and uploads move off it.
  const map =
    selection.providerId === 'openai' && task !== 'meeting'
      ? { ...REPLACED.openai, 'gpt-4o-transcribe': 'gpt-transcribe' }
      : REPLACED[selection.providerId];
  const next = map?.[selection.modelId];
  return next ? { ...selection, modelId: next } : undefined;
}

/** Moves saved choices off retired or retiring models, once per launch. */
export async function upgradeSavedModels(): Promise<void> {
  const { config, updateConfig } = useConfigStore.getState();
  if (!config) return;
  const change: Partial<UserConfig> = {};
  const inference = { ...config.inference };
  let changed = false;
  for (const [task, selection] of Object.entries(inference)) {
    const next = replaced(task, selection);
    if (next) {
      inference[task as keyof typeof inference] = next;
      changed = true;
    }
  }
  if (changed) change.inference = inference;
  const remembered = { ...config.rememberedInference };
  let rememberedChanged = false;
  for (const [task, byProvider] of Object.entries(remembered)) {
    const updated = { ...byProvider };
    for (const [provider, selection] of Object.entries(updated ?? {})) {
      const next = replaced(task, selection);
      if (next) {
        updated[provider] = next;
        rememberedChanged = true;
      }
    }
    remembered[task as keyof typeof remembered] = updated;
  }
  if (rememberedChanged) change.rememberedInference = remembered;
  if (changed || rememberedChanged) await updateConfig(change, 'retired_move');
}
