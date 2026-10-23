import { useDictionaryStore } from '@/store/useDictionaryStore';
import { useSharedDictionaryStore } from '@/store/useSharedDictionaryStore';
import { useSnippetsStore } from '@/store/useSnippetsStore';
import type { TranscriptionRequest } from '@/types';
import { sharedWordKey } from './sharedDictionaryHints';
import { getDictionaryHintTiers, splitLlmDictionary, type LlmDictionary } from './snippets';

// Snippet expansion and snippet-trigger hints apply to spoken dictation only —
// not to uploaded files (or meeting diarization). Mirrors desktop, which expands
// only in its dictation hook.
export function isDictationContext(
  requestContext: TranscriptionRequest['requestContext'],
): boolean {
  return requestContext === 'recording' || requestContext === 'keyboard';
}

// Dictionary hints in priority order: [personal + snippet triggers, space,
// workspace]. Snippet triggers (dictation contexts only) ride with personal
// words so they survive transcription and cleanup; only they are gated by
// `includeSnippetTriggers`. Shared words are deduped against higher tiers. A
// word moved into a shared list whose only copy the member hid stays out, as on
// desktop: hiding it is how the member stops it applying.
export function buildDictationHintTiers(includeSnippetTriggers: boolean): string[][] {
  const dict = useDictionaryStore.getState();
  const { hints: shared, hiddenOnlyKeys } = useSharedDictionaryStore.getState();
  const customDictionary = dict.isLoaded
    ? dict.entries
        .filter((e) => !(e.sharedAt && hiddenOnlyKeys.has(sharedWordKey(e.word))))
        .map((e) => e.word)
    : [];
  const snippetState = useSnippetsStore.getState();
  const snippets = snippetState.isLoaded ? snippetState.entries : [];
  return getDictionaryHintTiers(customDictionary, snippets, shared, includeSnippetTriggers);
}

// The ranked hints as one list, personal words first.
export function buildDictationHints(includeSnippetTriggers: boolean): string[] {
  return buildDictationHintTiers(includeSnippetTriggers).flat();
}

// LLM prompt hints (cleanup, fused cleanup, the voice assistant, note actions)
// with teammates' words kept apart, so prompts and the API quote them as data.
export function buildLlmDictionary(includeSnippetTriggers: boolean): LlmDictionary {
  return splitLlmDictionary(buildDictationHintTiers(includeSnippetTriggers));
}

// The words the dictionary effectively contains — personal, then the shared
// words that apply, no snippet triggers — so correction learning never learns a
// team word into the personal list.
export function buildEffectiveDictionaryWords(): string[] {
  return buildDictationHints(false);
}
