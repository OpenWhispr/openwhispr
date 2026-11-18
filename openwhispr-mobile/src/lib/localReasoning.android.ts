import { androidCopy } from './androidCopy';
import type { LocalReasoningReadiness, ReasoningRoutingOptions } from '@/types';

const upstream: typeof import('./localReasoning') = require('./localReasoning.ts');

export type LocalReasoningError = import('./localReasoning').LocalReasoningError;
export const {
  LocalReasoningError,
  LOCAL_CONTEXT_FALLBACK_SIZE,
  LOCAL_OUTPUT_TOKEN_RESERVE,
  LOCAL_CONTEXT_SAFETY_TOKENS,
  LOCAL_TOKEN_CHAR_RATIO,
  LOCAL_CLEANUP_MAX_TRANSCRIPT_TOKENS,
  UNSUPPORTED_LANGUAGE_MESSAGE,
  clearLocalReasoningReadinessCache,
  isAppleLocalIntelligenceEnabled,
  getLocalInputTokenBudget,
  estimateLocalTokens,
  canRunLocalReasoning,
  isLocalReasoningUnsupported,
  getLocalReasoningLanguageNote,
  isLocalOutputLimitError,
} = upstream;

export const getLocalReasoningReadiness: typeof upstream.getLocalReasoningReadiness = async () => {
  // Resolve lazily to keep LocalTextModel's error-helper import cycle safe.
  const { androidTextReadiness } =
    require('@/android/LocalTextModel') as typeof import('@/android/LocalTextModel');
  return androidTextReadiness();
};

export function isLocalReasoningRequired(options: ReasoningRoutingOptions = {}): boolean {
  if (options.isPrivateNote) return true;
  try {
    const { useProcessingModeStore } =
      require('@/store/useProcessingModeStore') as typeof import('@/store/useProcessingModeStore');
    if (useProcessingModeStore.getState().activeMode === 'private') return true;
  } catch {
    // During store initialization, retain the upstream signed-out privacy default.
  }
  return upstream.isLocalReasoningRequired(options);
}

export async function shouldUseLocalReasoning(
  options: ReasoningRoutingOptions = {},
): Promise<boolean> {
  if (!isLocalReasoningRequired(options)) return false;
  return (await getLocalReasoningReadiness()).status === 'ready';
}

// Android currently estimates tokens; it must never ask the Apple engine.
export const countLocalReasoningTokens: typeof upstream.countLocalReasoningTokens = async () =>
  null;

export const countLocalInputTokens: typeof upstream.countLocalInputTokens = async (input) =>
  estimateLocalTokens([input.instructions, input.prompt].filter(Boolean).join('\n\n'));

export const fitsLocalReasoningBudget: typeof upstream.fitsLocalReasoningBudget = async (input) => {
  const budget = input.budget ?? getLocalInputTokenBudget(input.readiness);
  return (await countLocalInputTokens(input)) < budget;
};

export async function fitsLocalCleanupOutput(text: string): Promise<boolean> {
  return estimateLocalTokens(text) <= LOCAL_CLEANUP_MAX_TRANSCRIPT_TOKENS;
}

export function getLocalReasoningUnavailableMessage(_readiness?: LocalReasoningReadiness): string {
  return androidCopy(
    'workflowSettings.localModelNeeded',
    'Download a local text model in Account → Models to use on-device AI.',
  );
}

export function toLocalReasoningError(error: unknown): LocalReasoningError {
  if (error instanceof LocalReasoningError) return error;
  const result = upstream.toLocalReasoningError(error);
  // Cancellation keeps precedence over a native error code.
  if (result.code === 'APPLE_LLM_CANCELLED') return result;
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
  if (code === 'LOCAL_CONTEXT_LIMIT' || code === 'LOCAL_REASONING_FAILED') {
    return new LocalReasoningError(code, result.message);
  }
  return result.code === 'APPLE_LLM_FAILED' && code !== 'APPLE_LLM_FAILED'
    ? new LocalReasoningError('LOCAL_REASONING_FAILED', result.message)
    : result;
}

export function isLocalContextLimitError(error: unknown): boolean {
  return (
    upstream.isLocalContextLimitError(error) ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      String(error.code) === 'LOCAL_CONTEXT_LIMIT')
  );
}
