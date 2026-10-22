import { useDictionaryStore } from '@/store/useDictionaryStore';
import { useSnippetsStore } from '@/store/useSnippetsStore';
import type { TranscriptionRequest } from '@/types';
import { getDictionaryHintWords } from './snippets';

// Snippet expansion and snippet-trigger hints apply to spoken dictation only —
// not to uploaded files (or meeting diarization). Mirrors desktop, which expands
// only in its dictation hook.
export function isDictationContext(
  requestContext: TranscriptionRequest['requestContext'],
): boolean {
  return requestContext === 'recording' || requestContext === 'keyboard';
}

// Dictionary words for the STT prompt / cleanup `customDictionary`, optionally
// augmented with snippet triggers (dictation contexts only) so triggers survive
// transcription and cleanup. Dictionary words are always included; only the
// snippet triggers are gated by `includeSnippetTriggers`.
export function buildDictationHints(includeSnippetTriggers: boolean): string[] {
  const dict = useDictionaryStore.getState();
  const customDictionary = dict.isLoaded ? dict.entries.map((e) => e.word) : [];
  const snippetState = useSnippetsStore.getState();
  const snippets = includeSnippetTriggers && snippetState.isLoaded ? snippetState.entries : [];
  return getDictionaryHintWords({ customDictionary, snippets });
}
