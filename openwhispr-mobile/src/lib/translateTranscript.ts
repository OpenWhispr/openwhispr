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
import { buildTranslatePrompt, translationFailureReason } from './keyboardTranslation';
import {
  LOCAL_OUTPUT_TOKEN_RESERVE,
  countLocalReasoningTokens,
  estimateLocalTokens,
} from './localReasoning';
import type { InferenceRoute } from './mobileProviders';
import { createApiRetryStrategy, withRetry } from './retry';

export const TRANSLATE_TIMEOUT_MS = 12_000;

export interface TranslateOptions {
  target: string;
  inferenceRoute?: InferenceRoute;
  cleanupUnavailable?: string;
  onSkipped?: (reason: string) => void;
  /** Polled while the request runs; true ends it and skips any retry. */
  shouldCancel?: () => boolean;
}

export interface TranslateResult {
  text: string;
  translated: boolean;
}

// Apple Intelligence stops at LOCAL_OUTPUT_TOKEN_RESERVE without an error. A counted reply within
// this many tokens of it was cut off; the count can be a few tokens off the model's own.
const LOCAL_CUT_OFF_MARGIN_TOKENS = 16;

// Whitespace and line breaks don't make a reply a translation (as desktop's translationChain.js).
function collapse(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// Same hints cleanup gives the service: a chosen provider is sent there even in On-Device mode,
// and an on-device route follows the privacy mode.
function routingFor(route: InferenceRoute): ReasoningRequest['routing'] {
  if (route.mode === 'providers') return { sendToChosenProvider: true };
  if (route.mode === 'local') {
    return { isPrivateNote: useProcessingModeStore.getState().activeMode === 'private' };
  }
  return undefined;
}

// Apple Intelligence writes a translation about as fast as a cleaned copy, so a long dictation
// gets cleanup's on-device budget rather than Cloud's 12 s.
async function timeoutFor(text: string, route: InferenceRoute): Promise<number> {
  if (route.mode !== 'local') return TRANSLATE_TIMEOUT_MS;
  const tokens = (await countLocalReasoningTokens({ prompt: text })) ?? estimateLocalTokens(text);
  return localCleanupTimeoutMs(tokens);
}

// Only a counted reply can tell: iOS counts tokens from 26.4, and an estimate from length is too
// rough to tell a long translation from a cut-off one.
async function isCutOff(reply: string, route: InferenceRoute): Promise<boolean> {
  if (route.mode !== 'local') return false;
  const tokens = await countLocalReasoningTokens({ prompt: reply });
  return tokens !== null && tokens >= LOCAL_OUTPUT_TOKEN_RESERVE - LOCAL_CUT_OFF_MARGIN_TOKENS;
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
  const { target, inferenceRoute, onSkipped, shouldCancel } = options;
  const failureReason = translationFailureReason(target);

  // Sending empty text invites the model to answer with its own instructions.
  if (!text.trim()) return untranslated;

  if (options.cleanupUnavailable) {
    onSkipped?.(options.cleanupUnavailable);
    return untranslated;
  }
  // Every job pins its cleanup route or says why it has none, so a missing one leaves no route
  // this text may be sent on.
  if (!inferenceRoute) {
    onSkipped?.(failureReason);
    return untranslated;
  }
  const { user } = useAuthStore.getState();
  if (inferenceRoute.mode === 'openwhispr' && requiresRealAccount(user)) {
    // An anonymous onboarding session has a session but no account.
    const action = user?.isAnonymous ? 'Create an account' : 'Sign in';
    onSkipped?.(`${action} to translate dictation. The text was left untranslated.`);
    return untranslated;
  }

  const routing = routingFor(inferenceRoute);

  try {
    const timeoutMs = await timeoutFor(text, inferenceRoute);
    const retryStrategy = createApiRetryStrategy();
    const result = await withRetry(
      async () => {
        const { signal, cancel } = createTimeoutSignal(timeoutMs, shouldCancel);
        try {
          return await ReasoningService.processText({
            text,
            systemPrompt: buildTranslatePrompt(target),
            inferenceScope: 'cleanup',
            inferenceRoute,
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
        // double the wait for a dictation that is about to be typed untranslated. A cancelled
        // dictation is thrown away, so it never pays for a second request.
        shouldRetry: (error) =>
          !isAbortError(error) && !shouldCancel?.() && (retryStrategy.shouldRetry?.(error) ?? true),
      },
    );
    const reply = collapse(result.text);
    if (!reply || (await isCutOff(result.text, inferenceRoute))) {
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
