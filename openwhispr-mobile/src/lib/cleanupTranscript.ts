import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { getActiveCustomCleanupPrompt } from '@/store/useCustomPromptsStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { requiresRealAccount } from './accountAccess';
import type { KeyboardTone } from '@/types';
import {
  getDictationAgentName,
  isDictationAgentApplicable,
  detectAgentMention,
} from './dictationAgent';
import { buildDictationHints } from './dictationHints';
import { withRetry, createApiRetryStrategy } from './retry';

// Only 'keyboard' and 'recording' may receive agentName — notes/meeting are not dictation flows.
type DictationCleanupContext = 'keyboard' | 'recording';
type CleanupContext = DictationCleanupContext | 'notes' | 'meeting';

interface CleanupOptions {
  tone?: KeyboardTone;
  includeSnippetTriggers?: boolean;
  context?: CleanupContext;
}

export const CLEANUP_TIMEOUT_MS = 12_000;
export const AGENT_ACTION_TIMEOUT_MS = 30_000;
export const CLEANUP_MAX_RETRIES = 1;
export const CLEANUP_INITIAL_RETRY_DELAY_MS = 750;

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeout),
  };
}

function isDictationCleanupContext(context: CleanupContext | undefined): boolean {
  return context === 'keyboard' || context === 'recording';
}

// Applies the user's configured post-transcription cleanup. Returns the
// original text unchanged when cleanup is disabled or the reasoning call
// fails, so callers can always use the result as the canonical transcript.
export async function cleanupTranscript(
  rawText: string,
  options: CleanupOptions = {},
): Promise<string> {
  const cfg = useConfigStore.getState().config;
  if (!(cfg?.cleanupEnabled ?? true)) return rawText;
  // The serial pass goes through /api/reason, which refuses an anonymous
  // onboarding session (the fused pass inside /api/transcribe does not). Skip
  // the doomed round trip and hand the transcript back as is — exactly what
  // the failure path would have done after the 403.
  if (requiresRealAccount(useAuthStore.getState().user)) return rawText;
  // Nothing to clean. Sending empty text to the reasoning model invites it to
  // echo its own instructions ("Transcribed speech to clean…") as the result,
  // which would then be inserted as a phantom transcript.
  if (!rawText.trim()) return rawText;

  const preferred = cfg?.preferredLanguage;
  const lang = preferred && preferred !== 'auto' ? preferred : undefined;
  const hintWords = buildDictationHints(options.includeSnippetTriggers ?? false);
  const customDictionary = hintWords.length > 0 ? hintWords : undefined;

  const activeMode = useProcessingModeStore.getState().activeMode;
  const agentApplicable =
    isDictationCleanupContext(options.context) &&
    isDictationAgentApplicable(activeMode, cfg ?? { defaultMode: activeMode });
  const agentName = agentApplicable
    ? getDictationAgentName(cfg ?? { defaultMode: activeMode })
    : undefined;

  // Bump timeout only when the mention is detected — ordinary dictation shouldn't
  // wait longer on a slow network just because the feature is on.
  const mentionDetected = agentName !== undefined && detectAgentMention(rawText, agentName);
  const timeoutMs = mentionDetected ? AGENT_ACTION_TIMEOUT_MS : CLEANUP_TIMEOUT_MS;

  // A custom prompt goes out with promptMode "cleanup", which turns off the
  // server's agent-name detection that the dictation agent relies on. When our
  // port of that detection fires, withhold the override so the server can still
  // route the utterance to the action prompt. If the two disagree, that one
  // utterance is cleaned with the default prompt instead — rare and harmless.
  const customPrompt = mentionDetected ? undefined : getActiveCustomCleanupPrompt();

  try {
    const startedAt = Date.now();
    let retryCount = 0;
    const result = await withRetry(
      async () => {
        const { signal, cancel } = createTimeoutSignal(timeoutMs);
        try {
          return await ReasoningService.processText({
            text: rawText,
            language: lang,
            locale: lang,
            customDictionary,
            signal,
            timeoutMs,
            tone: options.tone,
            agentName,
            customPrompt,
          });
        } finally {
          cancel();
        }
      },
      {
        ...createApiRetryStrategy(),
        maxRetries: CLEANUP_MAX_RETRIES,
        initialDelay: CLEANUP_INITIAL_RETRY_DELAY_MS,
        onRetry: (attempt, error, delayMs) => {
          retryCount = attempt;
          if (__DEV__) {
            console.log(
              `[cleanup] retry=${attempt} delayMs=${delayMs} error=${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        },
      },
    );
    if (__DEV__) {
      console.log(`[cleanup] elapsedMs=${Date.now() - startedAt} retries=${retryCount}`);
    }
    return result.text;
  } catch (err) {
    console.warn('Reasoning failed after retries, using original transcription:', err);
    return rawText;
  }
}
