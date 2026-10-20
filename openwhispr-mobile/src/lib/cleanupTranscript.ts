import { resolveMobileInferenceRoute } from '@/lib/mobileProviders';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { getActiveCustomCleanupPrompt } from '@/store/useCustomPromptsStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { requiresRealAccount } from './accountAccess';
import type { KeyboardTone, ReasoningRequest, TextInferenceSnapshot } from '@/types';
import { getDictationAgentName } from './dictationAgent';
import { buildDictationHints } from './dictationHints';
import {
  LOCAL_CLEANUP_MAX_TRANSCRIPT_TOKENS,
  countLocalReasoningTokens,
  estimateLocalTokens,
  getLocalReasoningReadiness,
  getLocalReasoningUnavailableMessage,
  LocalReasoningError,
  UNSUPPORTED_LANGUAGE_MESSAGE,
} from './localReasoning';
import { withRetry, createApiRetryStrategy } from './retry';

// Only 'keyboard' and 'recording' are dictation, where the prompt is told the assistant's name.
type DictationCleanupContext = 'keyboard' | 'recording';
type CleanupContext = DictationCleanupContext | 'notes' | 'meeting';

interface CleanupOptions
  extends Pick<TextInferenceSnapshot, 'cleanupRoute' | 'cleanupUnavailable'> {
  inferenceRoute?: ReasoningRequest['inferenceRoute'];
  requireProvider?: boolean;
  onSkipped?: (reason: string) => void;
  tone?: KeyboardTone;
  includeSnippetTriggers?: boolean;
  context?: CleanupContext;
}

export const CLEANUP_TIMEOUT_MS = 12_000;
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

// Apple Intelligence writes a cleaned copy about as long as the transcript, at roughly 30 tokens a
// second on an iPhone 15 Pro (Apple's figure), so a long one can't finish in Cloud's 12 s. The rate
// here is lower so a slower or busier iPhone still finishes; the [reasoning] dev log reports the
// real one. The startup allowance covers the readiness and budget checks and loading the model.
const LOCAL_CLEANUP_TOKENS_PER_SECOND = 25;
const LOCAL_CLEANUP_STARTUP_MS = 5_000;

function localCleanupTimeoutMs(transcriptTokens: number): number {
  return Math.max(
    CLEANUP_TIMEOUT_MS,
    LOCAL_CLEANUP_STARTUP_MS + (transcriptTokens / LOCAL_CLEANUP_TOKENS_PER_SECOND) * 1000,
  );
}

const TOO_LONG_FOR_ON_DEVICE = 'This transcript is too long for On-Device cleanup.';

// Why an on-device pass can't run, or the transcript's length in tokens.
async function prepareLocalRun(text: string): Promise<{ skipReason: string } | { tokens: number }> {
  let readiness = await getLocalReasoningReadiness();
  // The cached answer outlives a fix in iOS Settings, so check again before refusing.
  if (readiness.status !== 'ready') readiness = await getLocalReasoningReadiness({ refresh: true });
  if (readiness.status !== 'ready') {
    return { skipReason: getLocalReasoningUnavailableMessage(readiness) };
  }
  const tokens = (await countLocalReasoningTokens({ prompt: text })) ?? estimateLocalTokens(text);
  return tokens > LOCAL_CLEANUP_MAX_TRANSCRIPT_TOKENS
    ? { skipReason: TOO_LONG_FOR_ON_DEVICE }
    : { tokens };
}

// Apple Intelligence's common failures say what happened. The only signal a cleanup run gets is
// its timeout, so a cancelled one took too long.
function cleanupFailureReason(error: unknown): string {
  if (error instanceof LocalReasoningError) {
    if (error.code === 'APPLE_LLM_CANCELLED') return 'Apple Intelligence took too long.';
    if (error.code === 'APPLE_LLM_RATE_LIMITED') return 'Apple Intelligence was busy.';
    if (error.code === 'APPLE_LLM_UNSUPPORTED_LANGUAGE') return UNSUPPORTED_LANGUAGE_MESSAGE;
    if (error.code === 'LOCAL_CONTEXT_LIMIT' || error.code === 'APPLE_LLM_CONTEXT_LIMIT') {
      return TOO_LONG_FOR_ON_DEVICE;
    }
  }
  return 'Cleanup failed.';
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
  // Nothing to clean. Sending empty text to the reasoning model invites it to
  // echo its own instructions ("Transcribed speech to clean…") as the result,
  // which would then be inserted as a phantom transcript.
  if (!rawText.trim()) return rawText;

  const preferred = cfg?.preferredLanguage;
  const lang = preferred && preferred !== 'auto' ? preferred : undefined;
  const hintWords = buildDictationHints(options.includeSnippetTriggers ?? false);
  const customDictionary = hintWords.length > 0 ? hintWords : undefined;

  const activeMode = useProcessingModeStore.getState().activeMode;
  // The cleanup prompt keeps the assistant's name as dictated words. Saying it gives no command:
  // the voice assistant is the keyboard's compose button.
  const agentName = isDictationCleanupContext(options.context)
    ? getDictationAgentName(cfg ?? { defaultMode: activeMode })
    : undefined;

  let timeoutMs = CLEANUP_TIMEOUT_MS;
  const snapshottedRoute = options.inferenceRoute ?? options.cleanupRoute;
  if (options.cleanupUnavailable) {
    options.onSkipped?.(options.cleanupUnavailable);
    return rawText;
  }
  const configuredRoute = snapshottedRoute ?? cfg?.inference?.cleanup;
  const requireProvider =
    options.requireProvider || (!configuredRoute && activeMode === 'providers');
  if (requireProvider && !snapshottedRoute && configuredRoute?.mode !== 'providers') {
    options.onSkipped?.('Choose a cleanup provider in AI Models. Your raw transcript is saved.');
    return rawText;
  }
  if (
    (configuredRoute?.mode === 'openwhispr' || !configuredRoute) &&
    requiresRealAccount(useAuthStore.getState().user)
  ) {
    options.onSkipped?.('Sign in to use OpenWhispr cleanup. Your raw transcript is saved.');
    return rawText;
  }
  const resolved = resolveMobileInferenceRoute({
    scope: 'cleanup',
    selection: configuredRoute ?? { mode: 'openwhispr' },
    privateContent: false,
    policy: { status: 'unmanaged' },
  });
  if (!resolved.ok) {
    options.onSkipped?.('The cleanup route is unavailable. Your raw transcript is saved.');
    return rawText;
  }
  const inferenceRoute = resolved.route;
  // Say why an on-device pass can't run, rather than retrying into a generic failure.
  if (inferenceRoute.mode === 'local') {
    const localRun = await prepareLocalRun(rawText);
    if ('skipReason' in localRun) {
      options.onSkipped?.(`${localRun.skipReason} Your raw transcript is saved.`);
      return rawText;
    }
    timeoutMs = localCleanupTimeoutMs(localRun.tokens);
  }
  // A cleanup provider route only ever comes from the provider the user saved for cleanup, so it is
  // sent there even in On-Device mode. An on-device route takes the privacy hint. A Cloud route is
  // either the user's choice or a Cloud fallback they just consented to while still in private
  // mode; hinting it would make ReasoningService demand local reasoning and fail the cleanup.
  const routing =
    inferenceRoute.mode === 'providers'
      ? { sendToChosenProvider: true }
      : inferenceRoute.mode === 'local'
        ? { isPrivateNote: useProcessingModeStore.getState().activeMode === 'private' }
        : undefined;
  const customPrompt = getActiveCustomCleanupPrompt();

  try {
    const startedAt = Date.now();
    let retryCount = 0;
    const result = await withRetry(
      async () => {
        const { signal, cancel } = createTimeoutSignal(timeoutMs);
        try {
          return await ReasoningService.processText({
            text: rawText,
            inferenceRoute,
            inferenceScope: 'cleanup',
            ...(routing ? { routing } : {}),
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
                configuredRoute?.mode === 'providers'
                  ? 'provider request failed'
                  : error instanceof Error
                    ? error.message
                    : String(error)
              }`,
            );
          }
        },
      },
    );
    if (__DEV__) {
      console.log(`[cleanup] elapsedMs=${Date.now() - startedAt} retries=${retryCount}`);
    }
    // A reasoning model can spend its whole reply thinking; an empty result
    // would otherwise replace the transcript with nothing.
    if (!result.text.trim()) {
      options.onSkipped?.('Cleanup returned no text. Your raw transcript is saved.');
      return rawText;
    }
    return result.text;
  } catch (err) {
    options.onSkipped?.(`${cleanupFailureReason(err)} Your raw transcript is saved.`);
    if (configuredRoute?.mode !== 'providers')
      console.warn('Reasoning failed after retries, using original transcription:', err);
    return rawText;
  }
}
