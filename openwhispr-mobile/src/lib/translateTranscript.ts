import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { useAuthStore } from '@/store/useAuthStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import type { ReasoningRequest } from '@/types';
import { requiresRealAccount } from './accountAccess';
import {
  CLEANUP_INITIAL_RETRY_DELAY_MS,
  CLEANUP_MAX_RETRIES,
  createTimeoutSignal,
  localCleanupTimeoutMs,
} from './cleanupTranscript';
import { buildTranslatePrompt, translationLabel } from './keyboardTranslation';
import { countLocalReasoningTokens, estimateLocalTokens } from './localReasoning';
import type { InferenceRoute } from './mobileProviders';
import { createApiRetryStrategy, withRetry } from './retry';

export const TRANSLATE_TIMEOUT_MS = 12_000;

export interface TranslateOptions {
  target: string;
  inferenceRoute?: InferenceRoute;
  cleanupUnavailable?: string;
  onSkipped?: (reason: string) => void;
}

export interface TranslateResult {
  text: string;
  translated: boolean;
}

const GUEST_SKIP_REASON = 'Sign in to translate dictation. Your text was typed untranslated.';

// Whitespace and line breaks don't make a reply a translation (as desktop's translationChain.js).
function collapse(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// Same hints cleanup gives the service: a chosen provider is sent there even in On-Device mode,
// and an on-device route follows the privacy mode.
function routingFor(route: InferenceRoute | undefined): ReasoningRequest['routing'] {
  if (route?.mode === 'providers') return { sendToChosenProvider: true };
  if (route?.mode === 'local') {
    return { isPrivateNote: useProcessingModeStore.getState().activeMode === 'private' };
  }
  return undefined;
}

// Apple Intelligence writes a translation about as fast as a cleaned copy, so a long dictation
// gets cleanup's on-device budget rather than Cloud's 12 s.
async function timeoutFor(text: string, route: InferenceRoute | undefined): Promise<number> {
  if (route?.mode !== 'local') return TRANSLATE_TIMEOUT_MS;
  const tokens = (await countLocalReasoningTokens({ prompt: text })) ?? estimateLocalTokens(text);
  return localCleanupTimeoutMs(tokens);
}

/**
 * Translates a dictation into `options.target` with the cleanup route's model. Never throws: on
 * any skip or failure the input comes back with `translated: false`, so the caller types it as
 * dictated. `translated` is true only when the reply has text and differs from the input.
 */
export async function translateTranscript(
  text: string,
  options: TranslateOptions,
): Promise<TranslateResult> {
  const untranslated: TranslateResult = { text, translated: false };
  const { target, inferenceRoute, onSkipped } = options;

  // Sending empty text invites the model to answer with its own instructions.
  if (!text.trim()) return untranslated;

  if (options.cleanupUnavailable) {
    onSkipped?.(options.cleanupUnavailable);
    return untranslated;
  }
  if (
    (!inferenceRoute || inferenceRoute.mode === 'openwhispr') &&
    requiresRealAccount(useAuthStore.getState().user)
  ) {
    onSkipped?.(GUEST_SKIP_REASON);
    return untranslated;
  }

  const failureReason = `Couldn't translate to ${translationLabel(target)}. Your text was typed untranslated.`;
  const routing = routingFor(inferenceRoute);

  try {
    const timeoutMs = await timeoutFor(text, inferenceRoute);
    const retryStrategy = createApiRetryStrategy();
    const result = await withRetry(
      async () => {
        const { signal, cancel } = createTimeoutSignal(timeoutMs);
        try {
          return await ReasoningService.processText({
            text,
            systemPrompt: buildTranslatePrompt(target),
            inferenceScope: 'cleanup',
            ...(inferenceRoute ? { inferenceRoute } : {}),
            ...(routing ? { routing } : {}),
            purpose: 'translation',
            timeoutMs,
            signal,
          });
        } finally {
          cancel();
        }
      },
      {
        ...retryStrategy,
        maxRetries: CLEANUP_MAX_RETRIES,
        initialDelay: CLEANUP_INITIAL_RETRY_DELAY_MS,
        // A request the timeout or a cancel aborted already used its time; another try would
        // double the wait for a dictation that is about to be typed untranslated.
        shouldRetry: (error) =>
          !isAbortError(error) && (retryStrategy.shouldRetry?.(error) ?? true),
      },
    );
    const reply = collapse(result.text);
    if (!reply) {
      onSkipped?.(failureReason);
      return untranslated;
    }
    // The text already reads in the target language (spoken in it, or a regional variant of it):
    // nothing to warn about, as desktop treats it.
    if (reply === collapse(text)) return untranslated;
    return { text: result.text, translated: true };
  } catch {
    onSkipped?.(failureReason);
    return untranslated;
  }
}
