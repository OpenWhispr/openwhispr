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
  generateText(request: AppleLLMGenerateTextRequest): Promise<AppleLLMGenerateTextResponse>;
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

  async generateText(request: AppleLLMGenerateTextRequest): Promise<AppleLLMGenerateTextResponse> {
    if (!NativeModule) {
      throw new Error('Apple Foundation Models are not linked in this build.');
    }
    return NativeModule.generateText(request);
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
