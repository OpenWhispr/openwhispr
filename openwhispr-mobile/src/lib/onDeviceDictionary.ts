import type { LocalReasoningReadiness } from '@/types';
import { fitsLocalReasoningBudget, getLocalReasoningReadiness } from './localReasoning';
import { splitLlmDictionary, type LlmDictionary } from './snippets';

// Apple Intelligence's context (4,096 tokens on most iPhones) holds the prompt, its input and the
// reply, so teammates' words get a smaller cap there than in Cloud and provider prompts.
export const MAX_SHARED_WORDS_ON_DEVICE = 50;

/**
 * The dictionary hints for a prompt that runs on this iPhone. Shared words must never make it too
 * large to run: they ride only while the prompt fits the context, else just the personal words do,
 * exactly as before shared words existed. When not even those fit, or Apple Intelligence isn't
 * ready, nothing on device runs (the request is refused or falls back to Cloud), so it gets the
 * usual list. `buildInput` builds the instructions and prompt exactly as Apple Intelligence will
 * receive them.
 */
export async function fitDictionaryOnDevice(
  tiers: string[][],
  buildInput: (dictionary: LlmDictionary) => { instructions: string; prompt: string },
  readiness?: LocalReasoningReadiness,
): Promise<LlmDictionary> {
  const personal = splitLlmDictionary(tiers, 0);
  const capped = splitLlmDictionary(tiers, MAX_SHARED_WORDS_ON_DEVICE);
  if (capped.shared.length === 0) return personal;
  const usual = splitLlmDictionary(tiers);
  const ready = readiness ?? (await getLocalReasoningReadiness());
  // Not ready: the request is refused or goes to Cloud, so there is nothing to fit.
  if (ready.status !== 'ready') return usual;
  const fits = (dictionary: LlmDictionary): Promise<boolean> =>
    fitsLocalReasoningBudget({ ...buildInput(dictionary), readiness: ready });
  if (await fits(capped)) return capped;
  return (await fits(personal)) ? personal : usual;
}
