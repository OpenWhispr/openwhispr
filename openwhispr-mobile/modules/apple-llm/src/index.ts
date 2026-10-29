import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';
import type {
  AppleLLMAvailability,
  AppleLLMGenerateMeetingNotesResponse,
  AppleLLMGenerateTextRequest,
  AppleLLMGenerateTextResponse,
  AppleLLMTokenCountRequest,
} from './index.types';

interface NativeAppleLLM {
  getAvailability(): Promise<AppleLLMAvailability>;
  countTokens(request: AppleLLMTokenCountRequest): Promise<number | null>;
  generateText(
    request: AppleLLMGenerateTextRequest & { requestId?: string },
  ): Promise<AppleLLMGenerateTextResponse>;
  // Missing on binaries built before it shipped; an OTA update can run this code there.
  cancelGeneration?(requestId: string): void;
  generateMeetingNotes(
    request: AppleLLMGenerateTextRequest,
  ): Promise<AppleLLMGenerateMeetingNotesResponse>;
}

// iOS-only. Returns null off-iOS or when the native module is not linked
// (Expo Go, stale dev client), so callers can surface a local-unavailable path.
const NativeModule: NativeAppleLLM | null = (() => {
  if (Platform.OS !== 'ios') return null;
  try {
    return requireNativeModule('AppleLLM');
  } catch {
    return null;
  }
})();

let requestSequence = 0;

// Hermes has no DOMException global, so cancellations use a plain Error that
// callers recognise by name, as they would a fetch AbortError.
function abortError(): Error {
  const error = new Error('Apple Foundation Models request cancelled.');
  error.name = 'AbortError';
  return error;
}

export const AppleLLM = {
  isAvailable(): boolean {
    return NativeModule !== null;
  },

  async getAvailability(): Promise<AppleLLMAvailability> {
    if (!NativeModule) {
      return {
        status: Platform.OS === 'ios' ? 'unavailable' : 'unsupportedOS',
        tokenCounting: false,
      };
    }
    return NativeModule.getAvailability();
  },

  async countTokens(request: AppleLLMTokenCountRequest): Promise<number | null> {
    return NativeModule ? NativeModule.countTokens(request) : null;
  },

  async generateText(
    request: AppleLLMGenerateTextRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<AppleLLMGenerateTextResponse> {
    if (!NativeModule) {
      throw new Error('Apple Foundation Models are not linked in this build.');
    }
    const { signal } = options;
    if (!signal) return NativeModule.generateText(request);
    if (signal.aborted) throw abortError();

    requestSequence += 1;
    // The time keeps an id unique across JS reloads, which restart the counter but not native.
    const requestId = `apple-llm-${Date.now()}-${requestSequence}`;
    // Settle on abort without waiting for native: an older binary can't stop the
    // run, and a newer one reports the cancellation only once the model yields.
    return new Promise<AppleLLMGenerateTextResponse>((resolve, reject) => {
      const onAbort = (): void => {
        NativeModule.cancelGeneration?.(requestId);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      NativeModule.generateText({ ...request, requestId })
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener('abort', onAbort);
        });
    });
  },

  async generateMeetingNotes(
    request: AppleLLMGenerateTextRequest,
  ): Promise<AppleLLMGenerateMeetingNotesResponse> {
    if (!NativeModule) {
      throw new Error('Apple Foundation Models are not linked in this build.');
    }
    return NativeModule.generateMeetingNotes(request);
  },
};

export type {
  AppleLLMAvailability,
  AppleLLMAvailabilityStatus,
  AppleLLMGenerateMeetingNotesResponse,
  AppleLLMGenerateTextRequest,
  AppleLLMGenerateTextResponse,
  AppleLLMMeetingActionItem,
  AppleLLMMeetingNotes,
  AppleLLMTokenCountRequest,
} from './index.types';
