export type AppleLLMAvailabilityStatus =
  | 'available'
  | 'deviceNotEligible'
  | 'appleIntelligenceNotEnabled'
  | 'modelNotReady'
  | 'unsupportedOS'
  | 'unavailable';

export interface AppleLLMAvailability {
  status: AppleLLMAvailabilityStatus;
  contextSize?: number;
  tokenCounting?: boolean;
  // Whether Apple Intelligence supports the iPhone's language, and that language's English name.
  // Missing from binaries built before they shipped, and localeSupported also while the model
  // lists no languages.
  localeSupported?: boolean;
  deviceLanguage?: string;
}

export interface AppleLLMTokenCountRequest {
  instructions?: string;
  prompt: string;
}

export interface AppleLLMGenerateTextRequest {
  instructions: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AppleLLMGenerateTextResponse {
  text: string;
  model: 'apple-foundation-models';
}

export interface AppleLLMMeetingActionItem {
  text: string;
  owner?: string | null;
}

export interface AppleLLMMeetingNotes {
  summary: string;
  keyDiscussionPoints: string[];
  decisions: string[];
  actionItems: AppleLLMMeetingActionItem[];
  followUps: string[];
}

export type AppleLLMGenerateMeetingNotesResponse = AppleLLMMeetingNotes;
