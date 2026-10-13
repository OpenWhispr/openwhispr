import { useDictionaryStore } from '@/store/useDictionaryStore';
import { useSnippetsStore } from '@/store/useSnippetsStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import type { TranscriptionRequest } from '@/types';
import { getDictationAgentName, isDictationAgentApplicable } from './dictationAgent';
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
//
// When the dictation agent is applicable (cloud + enabled), the agent name is
// appended so the STT model hears it correctly — mirrors desktop parity.
export function buildDictationHints(includeSnippetTriggers: boolean): string[] {
  const dict = useDictionaryStore.getState();
  const customDictionary = dict.isLoaded ? dict.entries.map((e) => e.word) : [];
  const snippetState = useSnippetsStore.getState();
  const snippets = includeSnippetTriggers && snippetState.isLoaded ? snippetState.entries : [];

  const cfg = useConfigStore.getState().config;
  const activeMode = useProcessingModeStore.getState().activeMode;
  const agentApplicable = isDictationAgentApplicable(
    activeMode,
    cfg ?? { defaultMode: activeMode },
  );

  // Deduplicate in case the user already added the agent name to their dictionary.
  const agentName = agentApplicable
    ? getDictationAgentName(cfg ?? { defaultMode: activeMode })
    : undefined;

  const baseHints = getDictionaryHintWords({ customDictionary, snippets });

  if (!agentName || baseHints.includes(agentName)) return baseHints;
  return [...baseHints, agentName];
}
