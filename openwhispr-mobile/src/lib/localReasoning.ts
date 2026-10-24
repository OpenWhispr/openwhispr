import { Platform } from 'react-native';
import { AppleLLM, type AppleLLMAvailability } from '@/lib/appleLLM';
import type {
  LocalReasoningErrorCode,
  LocalReasoningReadiness,
  ProcessingMode,
  ReasoningRoutingOptions,
  UserConfig,
} from '@/types';

export const LOCAL_CONTEXT_FALLBACK_SIZE = 4096;
export const LOCAL_OUTPUT_TOKEN_RESERVE = 900;
export const LOCAL_CONTEXT_SAFETY_TOKENS = 300;
export const LOCAL_TOKEN_CHAR_RATIO = 3.5;

// Local requests pass LOCAL_OUTPUT_TOKEN_RESERVE as maximumResponseTokens, and Apple Intelligence
// stops there without an error. A larger context (iOS 27's 8,192) grows the input budget, not this
// reserve. Cleanup writes back about as many tokens as it reads, so a transcript whose cleaned copy
// might not fit would come back cut short. The margin covers the punctuation and capitals cleanup
// adds.
export const LOCAL_CLEANUP_MAX_TRANSCRIPT_TOKENS = Math.floor(LOCAL_OUTPUT_TOKEN_RESERVE * 0.8);

const LANGUAGE_SETTINGS = 'Settings → General → Language & Region';

// A generation refused for its language: the text's, which can be in any language, or the iPhone's.
export const UNSUPPORTED_LANGUAGE_MESSAGE = `Apple Intelligence doesn't support this language. If it's your iPhone's, choose another in ${LANGUAGE_SETTINGS}.`;

let cachedReadiness: Promise<LocalReasoningReadiness> | null = null;

export class LocalReasoningError extends Error {
  // On-device failures are refusals, limits, unavailability or a cancellation:
  // a retry gets the same answer, and a timed-out run would time out again.
  readonly retryable = false;
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
  if (Platform.OS === 'android') {
    const { androidTextReadiness } = await import('@/android/LocalTextModel');
    return androidTextReadiness();
  }
  if (!isAppleLocalIntelligenceEnabled()) {
    return { status: 'disabled', tokenCounting: false };
  }

  if (!options?.refresh && cachedReadiness) return cachedReadiness;

  cachedReadiness = (async () => {
    try {
      const availability = await AppleLLM.getAvailability();
      const languageReadiness = languageReadinessFor(availability);
      if (languageReadiness) return languageReadiness;
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
        case 'deviceNotEligible':
          return { status: 'unsupportedDevice', tokenCounting: false };
        case 'unsupportedOS':
          return { status: 'unsupportedOS', tokenCounting: false };
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

// iOS has no availability reason for a language Apple Intelligence doesn't support; it reports
// Apple Intelligence as off. So the language explains only that. A model still downloading means
// Apple Intelligence is on, an ineligible iPhone stays one, and Apple Intelligence that runs is
// never stopped.
function languageReadinessFor(availability: AppleLLMAvailability): LocalReasoningReadiness | null {
  if (
    availability.status !== 'appleIntelligenceNotEnabled' &&
    availability.status !== 'unavailable'
  ) {
    return null;
  }
  if (availability.localeSupported !== false) return null;
  return {
    status: 'unsupportedLanguage',
    deviceLanguage: availability.deviceLanguage,
    tokenCounting: false,
  };
}

// A private note, or no account to reach Cloud with, keeps note formatting on this iPhone. Local
// Mode doesn't: note formatting follows its own selection, and notes made there are private.
export function isLocalReasoningRequired(options: ReasoningRoutingOptions = {}): boolean {
  if (options.isPrivateNote) return true;
  if (Platform.OS === 'android' && getActiveMode() === 'private') return true;
  return !getAuthUser();
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

export function isAppleLocalIntelligenceEnabled(config = getUserConfig()): boolean {
  return config?.appleLocalIntelligenceEnabled ?? true;
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
  if (Platform.OS !== 'ios') return null;
  try {
    return await AppleLLM.countTokens(input);
  } catch {
    return null;
  }
}

export async function countLocalInputTokens(input: {
  instructions?: string;
  prompt: string;
}): Promise<number> {
  return (
    (await countLocalReasoningTokens(input)) ??
    estimateLocalTokens([input.instructions, input.prompt].filter(Boolean).join('\n\n'))
  );
}

export async function fitsLocalReasoningBudget(input: {
  instructions?: string;
  prompt: string;
  readiness?: LocalReasoningReadiness;
  budget?: number;
}): Promise<boolean> {
  const budget = input.budget ?? getLocalInputTokenBudget(input.readiness);
  const count = await countLocalInputTokens({
    instructions: input.instructions,
    prompt: input.prompt,
  });
  return count < budget;
}

export async function fitsLocalCleanupOutput(text: string): Promise<boolean> {
  const tokens = (await countLocalReasoningTokens({ prompt: text })) ?? estimateLocalTokens(text);
  return tokens <= LOCAL_CLEANUP_MAX_TRANSCRIPT_TOKENS;
}

// This iPhone runs Apple Intelligence, even if it is turned off in Settings, still preparing its
// model, or kept off by its language. Disabled in AI Models or unavailable says nothing about the
// device either way.
export function canRunLocalReasoning(readiness?: LocalReasoningReadiness | null): boolean {
  return (
    readiness?.status === 'ready' ||
    readiness?.status === 'appleIntelligenceOff' ||
    readiness?.status === 'modelNotReady' ||
    readiness?.status === 'unsupportedLanguage'
  );
}

// Unlike Apple Intelligence being off or still downloading, nothing in Settings fixes these.
export function isLocalReasoningUnsupported(readiness?: LocalReasoningReadiness | null): boolean {
  return readiness?.status === 'unsupportedDevice' || readiness?.status === 'unsupportedOS';
}

// What keeps Apple Intelligence off when the language does, in one sentence.
export function getLocalReasoningLanguageNote(readiness: LocalReasoningReadiness): string {
  return readiness.deviceLanguage
    ? `Apple Intelligence doesn't support ${readiness.deviceLanguage}, your iPhone's language.`
    : "Apple Intelligence doesn't support your iPhone's language.";
}

export function getLocalReasoningUnavailableMessage(readiness?: LocalReasoningReadiness): string {
  if (Platform.OS === 'android')
    return 'Download a local text model in Account → Models to use on-device AI.';
  switch (readiness?.status) {
    case 'unsupportedDevice':
      return 'On-Device AI needs an iPhone with Apple Intelligence (iPhone 15 Pro or later).';
    case 'unsupportedOS':
      return 'On-Device AI needs iOS 26 or later on an iPhone with Apple Intelligence.';
    case 'disabled':
      return 'Local Apple Intelligence is turned off in AI Models.';
    // Apple Intelligence also needs Siri set to the iPhone's language, and iOS then offers only a
    // Siri page; the app can't read Siri's language to tell.
    case 'appleIntelligenceOff':
      return "Apple Intelligence is turned off, so this can't run on-device. Turn it on in Settings → Apple Intelligence & Siri. If that page shows only Siri, set Siri to the same language as your iPhone.";
    case 'modelNotReady':
      return 'Apple Intelligence is still downloading its model. Check Settings → Apple Intelligence & Siri, and keep your iPhone on Wi-Fi and charging.';
    case 'unsupportedLanguage':
      return `${getLocalReasoningLanguageNote(readiness)} Choose a supported one in ${LANGUAGE_SETTINGS}.`;
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
  if (error instanceof Error && error.name === 'AbortError') {
    return new LocalReasoningError('APPLE_LLM_CANCELLED', message);
  }

  switch (code) {
    case 'APPLE_LLM_UNSUPPORTED_LANGUAGE':
      return new LocalReasoningError(code, UNSUPPORTED_LANGUAGE_MESSAGE);
    case 'LOCAL_CONTEXT_LIMIT':
    case 'LOCAL_REASONING_FAILED':
    case 'APPLE_LLM_GUARDRAIL':
    case 'APPLE_LLM_CONTEXT_LIMIT':
    case 'APPLE_LLM_OUTPUT_LIMIT':
    case 'APPLE_LLM_RATE_LIMITED':
    case 'APPLE_LLM_UNAVAILABLE':
    case 'APPLE_LLM_FAILED':
    case 'APPLE_LLM_CANCELLED':
      return new LocalReasoningError(code, message);
    default:
      return new LocalReasoningError(
        Platform.OS === 'android' ? 'LOCAL_REASONING_FAILED' : 'APPLE_LLM_FAILED',
        message,
      );
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
    ['APPLE_LLM_CONTEXT_LIMIT', 'LOCAL_CONTEXT_LIMIT'].includes(
      String((error as { code?: unknown }).code),
    )
  );
}

// FoundationModels throws decodingFailure (a ParsingError on iOS 27) when guided generation's
// output can't be decoded. That is most often the output cap cutting it off mid-structure, but
// malformed output reads the same; either way, less material per run is what helps.
export function isLocalOutputLimitError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'APPLE_LLM_OUTPUT_LIMIT'
  );
}
