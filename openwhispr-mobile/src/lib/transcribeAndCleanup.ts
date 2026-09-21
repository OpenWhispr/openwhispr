import {
  TranscriptionService,
  isLocalModelMissingError,
} from '@/services/transcription/TranscriptionService';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { useConfigStore } from '@/store/useConfigStore';
import { getActiveCustomCleanupPrompt } from '@/store/useCustomPromptsStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useSnippetsStore } from '@/store/useSnippetsStore';
import { cleanupTranscript, AGENT_ACTION_TIMEOUT_MS } from './cleanupTranscript';
import {
  getDictationAgentName,
  isDictationAgentApplicable,
  detectAgentMention,
} from './dictationAgent';
import { isDictationContext } from './dictationHints';
import { isNoSpeechError } from './permissions';
import { withRetry, type RetryOptions } from './retry';
import { expandSnippets } from './snippets';
import { isUsageLimitError } from './usageLimitError';
import type { KeyboardTone, TranscriptionRequest, TranscriptionResponse } from '@/types';

type ProcessingStage = 'transcribing' | 'cleaning';

export interface DictationProcessingLifecycle {
  onStage?: (stage: ProcessingStage, details?: { fusedCleanup?: boolean }) => void;
  onTranscribeDone?: (result: TranscriptionResponse) => void;
  onCleanupDone?: (result: TranscriptionResponse) => void;
  onRawTranscript?: (text: string, result: TranscriptionResponse) => void;
  onFusedCleanupFallback?: (error: unknown) => void;
  // Polled after transcription completes, before the (cloud-only) cleanup pass.
  // When it returns true the cleanup call is skipped and the raw transcript is
  // returned — the caller discards it. Lets a keyboard cancel avoid paying for
  // cleanup of a result the user already abandoned.
  shouldCancel?: () => boolean;
}

export interface DictationProcessingResult {
  text: string;
  originalText: string;
  transcription: TranscriptionResponse;
  cleanupApplied: boolean;
  fusedCleanup: boolean;
}

// The transcript before any cleanup pass: returned for local/private transcripts
// (cleanup is cloud-only) and when a cancel short-circuits cleanup.
function rawTranscriptResult(transcription: TranscriptionResponse): DictationProcessingResult {
  const originalText = transcription.originalText || transcription.text;
  return {
    text: originalText,
    originalText,
    transcription,
    cleanupApplied: false,
    fusedCleanup: false,
  };
}

function cleanupToneForRequest(request: TranscriptionRequest): KeyboardTone | undefined {
  if (request.requestContext !== 'keyboard') return undefined;
  if (!request.keyboardTone || request.keyboardTone === 'default') return undefined;
  return request.keyboardTone;
}

function cleanupContextForRequest(
  requestContext: TranscriptionRequest['requestContext'],
): 'keyboard' | 'recording' | undefined {
  if (requestContext === 'keyboard') return 'keyboard';
  if (requestContext === 'recording') return 'recording';
  return undefined;
}

// A failed transcription is only worth retrying when the failure is transient:
// a dropped connection or a 5xx server blip. Deterministic failures — auth,
// oversized audio, rate limits (4xx), a missing on-device model, no speech, or
// the fused-cleanup-unavailable signal (which must fall back, not retry) — won't
// recover from a retry and have to surface immediately.
function isRetryableTranscriptionError(error: unknown): boolean {
  if (TranscriptionService.isFusedCleanupUnavailableError(error)) return false;
  if (isLocalModelMissingError(error)) return false;
  if (isNoSpeechError(error)) return false;
  if (isUsageLimitError(error)) return false;

  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: number }).status
      : undefined;
  if (status === undefined) return true; // network error, no HTTP response
  return status >= 500 && status !== 501; // 501 signals endpoint-unavailable, not transient
}

function transcriptionRetry(lifecycle: DictationProcessingLifecycle): RetryOptions {
  return {
    maxRetries: 2,
    initialDelay: 1000,
    // Stop the moment the user abandons the dictation; don't burn backoff time
    // retrying a result they've already cancelled.
    shouldRetry: (error) => !lifecycle.shouldCancel?.() && isRetryableTranscriptionError(error),
    onRetry: (attempt, error, delayMs) => {
      if (__DEV__) {
        console.warn(
          `[transcribeAndCleanup] transcription failed; retry ${attempt} in ${delayMs}ms`,
          error,
        );
      }
    },
  };
}

async function shouldAttemptFusedCloudCleanup(request: TranscriptionRequest): Promise<boolean> {
  if (request.provider !== 'cloud') {
    return false;
  }
  // A non-default keyboard tone must use the serial path: tone is injected via
  // /api/reason, which only the serial cleanup pass calls.
  if (
    request.requestContext === 'keyboard' &&
    request.keyboardTone &&
    request.keyboardTone !== 'default'
  ) {
    return false;
  }
  // Same for a custom cleanup prompt: it is injected via /api/reason, and the
  // fused /api/transcribe cleanup accepts flags only.
  if (getActiveCustomCleanupPrompt() !== undefined) {
    return false;
  }
  if (!TranscriptionService.canAttemptFusedCloudCleanup()) {
    return false;
  }

  const cfg = useConfigStore.getState().config;
  const cleanupEnabled = cfg?.cleanupEnabled ?? true;
  if (!cleanupEnabled) {
    return false;
  }

  // Large/undecodable audio is uploaded as chunks, which the fused
  // transcribe+clean endpoint can't process (cleanup needs the full
  // transcript). Fall back to serial transcribe (chunked) + a separate cleanup
  // pass on the stitched text.
  if (await TranscriptionService.requestNeedsChunking(request)) {
    return false;
  }

  return true;
}

async function runSerialTranscribeAndCleanup(
  request: TranscriptionRequest,
  lifecycle: DictationProcessingLifecycle,
): Promise<DictationProcessingResult> {
  lifecycle.onStage?.('transcribing', { fusedCleanup: false });
  const transcription = await withRetry(
    () => TranscriptionService.transcribe(request),
    transcriptionRetry(lifecycle),
  );
  lifecycle.onTranscribeDone?.(transcription);

  const originalText = transcription.text;
  lifecycle.onRawTranscript?.(originalText, transcription);

  // Cleanup runs only when the transcription itself went to the cloud.
  // Local/private transcripts must never leave the device — not even for the
  // cleanup pass. (transcription.provider, not request.provider, so the
  // local-model-missing → cloud fallback still gets cleaned.)
  if (transcription.provider !== 'cloud') {
    return rawTranscriptResult(transcription);
  }

  // Cancelled while transcribing: skip the cloud cleanup call entirely. The
  // caller discards this result, so cleaning it would only waste cloud spend.
  if (lifecycle.shouldCancel?.()) {
    return rawTranscriptResult(transcription);
  }

  lifecycle.onStage?.('cleaning', { fusedCleanup: false });
  // Tone applies only to keyboard dictation; snippet triggers to dictation
  // contexts (recording/keyboard) — never to file uploads.
  const finalText = await cleanupTranscript(originalText, {
    tone: cleanupToneForRequest(request),
    includeSnippetTriggers: isDictationContext(request.requestContext),
    context: cleanupContextForRequest(request.requestContext),
  });
  const cleanupApplied = finalText !== originalText;
  const cleanedTranscription: TranscriptionResponse = {
    ...transcription,
    text: finalText,
    originalText,
    cleanupApplied,
    fusedCleanup: false,
  };
  lifecycle.onCleanupDone?.(cleanedTranscription);

  return {
    text: finalText,
    originalText,
    transcription: cleanedTranscription,
    cleanupApplied,
    fusedCleanup: false,
  };
}

// When the fused transcribe+clean endpoint reports cleanupApplied: true, Action
// Mode has NOT run (the fused endpoint is cleanup-only server-side). If the user
// mentioned the agent in a dictation context, make one serial /api/reason call
// so Action Mode fires. Returns the action text, or undefined on no-op/failure.
async function maybeRunAgentActionOnFusedResult(
  rawText: string,
  requestContext: TranscriptionRequest['requestContext'],
): Promise<string | undefined> {
  if (!isDictationContext(requestContext)) return undefined;

  const cfg = useConfigStore.getState().config;
  const activeMode = useProcessingModeStore.getState().activeMode;
  if (!isDictationAgentApplicable(activeMode, cfg ?? { defaultMode: activeMode })) return undefined;

  const agentName = getDictationAgentName(cfg ?? { defaultMode: activeMode });
  if (!detectAgentMention(rawText, agentName)) return undefined;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AGENT_ACTION_TIMEOUT_MS);
    try {
      const response = await ReasoningService.processText({
        text: rawText,
        agentName,
        timeoutMs: AGENT_ACTION_TIMEOUT_MS,
        signal: controller.signal,
      });
      return response.text;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // On failure, the fused text (already cleaned) is used — same failure
    // semantics as desktop: raw/pre-existing text inserts on agent error.
    console.warn('[transcribeAndCleanup] agent action call failed, using fused text:', err);
    return undefined;
  }
}

async function runTranscribeAndCleanup(
  request: TranscriptionRequest,
  lifecycle: DictationProcessingLifecycle = {},
): Promise<DictationProcessingResult> {
  if (await shouldAttemptFusedCloudCleanup(request)) {
    lifecycle.onStage?.('transcribing', { fusedCleanup: true });
    try {
      const transcription = await withRetry(
        () => TranscriptionService.transcribeWithCloudCleanup(request),
        transcriptionRetry(lifecycle),
      );
      lifecycle.onTranscribeDone?.(transcription);

      const originalText = transcription.originalText || transcription.text;
      lifecycle.onRawTranscript?.(originalText, transcription);
      if (transcription.cleanupApplied) {
        const fusedText = await maybeRunAgentActionOnFusedResult(
          originalText,
          request.requestContext,
        );
        const finalFusedText = fusedText ?? transcription.text;
        const fusedTranscription: TranscriptionResponse = {
          ...transcription,
          text: finalFusedText,
        };
        const result: DictationProcessingResult = {
          text: finalFusedText,
          originalText,
          transcription: fusedTranscription,
          cleanupApplied: true,
          fusedCleanup: true,
        };
        lifecycle.onCleanupDone?.(fusedTranscription);
        return result;
      }

      // Fused cleanup didn't apply; a separate cleanup pass would follow. Skip
      // it when the user has cancelled — the caller discards this result.
      if (lifecycle.shouldCancel?.()) {
        return rawTranscriptResult(transcription);
      }

      lifecycle.onStage?.('cleaning', { fusedCleanup: false });
      const finalText = await cleanupTranscript(originalText, {
        tone: cleanupToneForRequest(request),
        includeSnippetTriggers: isDictationContext(request.requestContext),
        context: cleanupContextForRequest(request.requestContext),
      });
      const cleanedTranscription: TranscriptionResponse = {
        ...transcription,
        text: finalText,
        originalText,
        cleanupApplied: finalText !== originalText,
        fusedCleanup: false,
      };
      lifecycle.onCleanupDone?.(cleanedTranscription);
      return {
        text: finalText,
        originalText,
        transcription: cleanedTranscription,
        cleanupApplied: finalText !== originalText,
        fusedCleanup: false,
      };
    } catch (error) {
      if (!TranscriptionService.isFusedCleanupUnavailableError(error)) {
        throw error;
      }
      lifecycle.onFusedCleanupFallback?.(error);
    }
  }

  return runSerialTranscribeAndCleanup(request, lifecycle);
}

// Single chokepoint for snippet expansion: every dictation path (fused, serial,
// local/private, cancelled) flows through here. Expand the FINAL text — and the
// mirrored transcription.text — for dictation contexts only (`recording` /
// `keyboard`); `file` uploads are left untouched, matching desktop. `originalText`
// stays the raw, unexpanded transcript.
export async function transcribeAndCleanup(
  request: TranscriptionRequest,
  lifecycle: DictationProcessingLifecycle = {},
): Promise<DictationProcessingResult> {
  const result = await runTranscribeAndCleanup(request, lifecycle);
  if (!isDictationContext(request.requestContext)) return result;

  const snippetState = useSnippetsStore.getState();
  if (!snippetState.isLoaded || snippetState.entries.length === 0) return result;

  const expanded = expandSnippets(result.text, snippetState.entries);
  if (expanded === result.text) return result;

  return {
    ...result,
    text: expanded,
    transcription: { ...result.transcription, text: expanded },
  };
}
