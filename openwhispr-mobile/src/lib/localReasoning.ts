import { AppleLLM } from '@/lib/appleLLM';
import type {
  LocalReasoningErrorCode,
  LocalReasoningReadiness,
  ReasoningRoutingOptions,
  UserConfig,
} from '@/types';
import type { ProcessingMode } from '@/types';

export const LOCAL_CONTEXT_FALLBACK_SIZE = 4096;
export const LOCAL_OUTPUT_TOKEN_RESERVE = 900;
export const LOCAL_CONTEXT_SAFETY_TOKENS = 300;
export const LOCAL_TOKEN_CHAR_RATIO = 3.5;

let cachedReadiness: Promise<LocalReasoningReadiness> | null = null;

export class LocalReasoningError extends Error {
  code: LocalReasoningErrorCode;
  readiness?: LocalReasoningReadiness;

  constructor(
    code: LocalReasoningErrorCode,
    message: string,
    options?: { readiness?: LocalReasoningReadiness },
  ) {
    super(message);
    this.name = 'LocalReasoningError';
    this.code = code;
    this.readiness = options?.readiness;
  }
}

export function clearLocalReasoningReadinessCache(): void {
  cachedReadiness = null;
}

export async function getLocalReasoningReadiness(options?: {
  refresh?: boolean;
}): Promise<LocalReasoningReadiness> {
  if (!isAppleLocalIntelligenceEnabled()) {
    return { status: 'disabled', tokenCounting: false };
  }

  if (!options?.refresh && cachedReadiness) return cachedReadiness;

  cachedReadiness = (async () => {
    try {
      const availability = await AppleLLM.getAvailability();
      switch (availability.status) {
        case 'available':
          return {
            status: 'ready',
            contextSize: availability.contextSize,
            tokenCounting: availability.tokenCounting === true,
          };
        case 'appleIntelligenceNotEnabled':
          return {
            status: 'appleIntelligenceOff',
            contextSize: availability.contextSize,
            tokenCounting: availability.tokenCounting === true,
          };
        case 'modelNotReady':
          return {
            status: 'modelNotReady',
            contextSize: availability.contextSize,
            tokenCounting: availability.tokenCounting === true,
          };
        default:
          return {
            status: 'unavailable',
            contextSize: availability.contextSize,
            tokenCounting: availability.tokenCounting === true,
          };
      }
    } catch {
      return { status: 'unavailable', tokenCounting: false };
    }
  })();

  return cachedReadiness;
}

export function isLocalReasoningRequired(options: ReasoningRoutingOptions = {}): boolean {
  if (options.isPrivateNote) return true;
  if (getActiveMode() === 'private') return true;
  return !getAuthUser();
}

export function isAppleLocalIntelligenceEnabled(config = getUserConfig()): boolean {
  return config?.appleLocalIntelligenceEnabled ?? true;
}

function getActiveMode(): ProcessingMode {
  try {
    const { useProcessingModeStore } =
      require('@/store/useProcessingModeStore') as typeof import('@/store/useProcessingModeStore');
    return useProcessingModeStore.getState().activeMode;
  } catch {
    return 'cloud';
  }
}

// Lazy require to break a module cycle (localReasoning ← useNotesStore ← … ←
// useAuthStore). If the store can't be resolved, treat the caller as
// signed-out — the privacy-safe default, since routing still gates on Apple
// Intelligence readiness before anything runs on-device.
function getAuthUser(): unknown {
  try {
    const { useAuthStore } =
      require('@/store/useAuthStore') as typeof import('@/store/useAuthStore');
    return useAuthStore.getState().user;
  } catch {
    return undefined;
  }
}

function getUserConfig(): UserConfig | null {
  try {
    const { useConfigStore } =
      require('@/store/useConfigStore') as typeof import('@/store/useConfigStore');
    return useConfigStore.getState().config;
  } catch {
    return null;
  }
}

export async function shouldUseLocalReasoning(
  options: ReasoningRoutingOptions = {},
): Promise<boolean> {
  if (!isLocalReasoningRequired(options)) return false;
  const readiness = await getLocalReasoningReadiness();
  return readiness.status === 'ready';
}

export function getLocalInputTokenBudget(
  readiness?: Pick<LocalReasoningReadiness, 'contextSize'>,
): number {
  const contextSize = readiness?.contextSize ?? LOCAL_CONTEXT_FALLBACK_SIZE;
  return Math.max(256, contextSize - LOCAL_OUTPUT_TOKEN_RESERVE - LOCAL_CONTEXT_SAFETY_TOKENS);
}

export function estimateLocalTokens(text: string): number {
  return Math.ceil(text.length / LOCAL_TOKEN_CHAR_RATIO);
}

export async function countLocalReasoningTokens(input: {
  instructions?: string;
  prompt: string;
}): Promise<number | null> {
  try {
    return await AppleLLM.countTokens(input);
  } catch {
    return null;
  }
}

export async function fitsLocalReasoningBudget(input: {
  instructions?: string;
  prompt: string;
  readiness?: LocalReasoningReadiness;
  budget?: number;
}): Promise<boolean> {
  const budget = input.budget ?? getLocalInputTokenBudget(input.readiness);
  const nativeCount = await countLocalReasoningTokens({
    instructions: input.instructions,
    prompt: input.prompt,
  });
  const count =
    nativeCount ??
    estimateLocalTokens([input.instructions, input.prompt].filter(Boolean).join('\n\n'));
  return count < budget;
}

export function getLocalReasoningUnavailableMessage(readiness?: LocalReasoningReadiness): string {
  switch (readiness?.status) {
    case 'disabled':
      return 'Local Apple Intelligence is turned off in Account settings.';
    case 'appleIntelligenceOff':
      return 'Apple Intelligence is turned off, so this note cannot be enhanced on-device.';
    case 'modelNotReady':
      return 'Apple Intelligence is still preparing its local model. Try again later.';
    case 'unavailable':
    default:
      return 'Local Apple Intelligence is unavailable on this device.';
  }
}

export function toLocalReasoningError(error: unknown): LocalReasoningError {
  if (error instanceof LocalReasoningError) return error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  const message = error instanceof Error ? error.message : 'Local AI failed.';

  switch (code) {
    case 'APPLE_LLM_GUARDRAIL':
    case 'APPLE_LLM_CONTEXT_LIMIT':
    case 'APPLE_LLM_RATE_LIMITED':
    case 'APPLE_LLM_UNAVAILABLE':
    case 'APPLE_LLM_FAILED':
      return new LocalReasoningError(code, message);
    default:
      return new LocalReasoningError('APPLE_LLM_FAILED', message);
  }
}

export function isLocalContextLimitError(error: unknown): boolean {
  if (error instanceof LocalReasoningError) {
    return error.code === 'APPLE_LLM_CONTEXT_LIMIT' || error.code === 'LOCAL_CONTEXT_LIMIT';
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'APPLE_LLM_CONTEXT_LIMIT'
  );
}
