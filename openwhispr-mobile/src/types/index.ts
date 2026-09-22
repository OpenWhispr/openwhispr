export type ProcessingMode = 'cloud' | 'private';
export type TranscriptionProvider = 'local' | 'cloud';
export type KeyboardTone = 'default' | 'formal' | 'casual' | 'very_casual' | 'excited';
// Currently only the two wired modes are exposed. When SOON modes (providers,
// self-hosted, enterprise) get wired in, widen this union and add matching
// entries to `BASE` + `SCOPE_MODES` in lib/inferenceModes.ts.
export type InferenceMode = 'openwhispr' | 'local';

export interface UserConfig {
  defaultMode: ProcessingMode;
  cleanupEnabled?: boolean;
  autoGenerateNoteTitle?: boolean;
  autoLearnCorrections?: boolean;
  preferredLanguage?: string;
  languages?: string[];
  cloudBackupEnabled?: boolean;
  usageAnalyticsEnabled?: boolean;
  voiceProfilePromptDismissedAt?: string;
  // One-time Parakeet nudges on the Home banner: pick a language to unlock the
  // faster on-device model / download the faster model for a qualifying language.
  parakeetAutoLanguageNudgeDismissedAt?: string;
  parakeetUpgradeNudgeDismissedAt?: string;
  keyboardTone?: KeyboardTone;
  // Apple Foundation Models local generation for notes. Default on; users can
  // disable it from AI Models.
  appleLocalIntelligenceEnabled?: boolean;
  // Dictation agent (cloud-only, default on)
  dictationAgentEnabled?: boolean;
  dictationAgentName?: string;
  dictationAgentShareContext?: boolean;
}

export function inferenceToProcessingMode(mode: InferenceMode): ProcessingMode {
  return mode === 'local' ? 'private' : 'cloud';
}

export function processingToInferenceMode(mode: ProcessingMode): InferenceMode {
  return mode === 'private' ? 'local' : 'openwhispr';
}

export interface Transcript {
  id: string;
  text: string;
  originalText?: string;
  reasonedText?: string;
  createdAt: number;
  updatedAt: number;
  audioUrl?: string;
  audioFileName?: string;
  audioMimeType?: string;
  duration?: number;
  provider: TranscriptionProvider;
  status?: 'completed' | 'failed';
  errorMessage?: string;
  requestContext?: 'keyboard' | 'recording' | 'file';
  keyboardTone?: KeyboardTone;
  jobId?: string;
  retryCount?: number;
}

export interface ReasoningRequest {
  text: string;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  // When systemPrompt is omitted, the API resolves a localized cleanup prompt
  // from these fields via openwhispr-api/lib/prompts.ts.
  language?: string;
  locale?: string;
  customDictionary?: string[];
  // Keyboard dictation tone. Sent only for keyboard cleanup with a non-default
  // tone; the API appends a matching instruction in cleanup mode.
  tone?: KeyboardTone;
  // User's custom cleanup prompt, sent as a TEMPLATE: the API substitutes
  // {{agentName}} and still appends language, dictionary and tone. Goes out
  // with promptMode "cleanup", which pins cleanup semantics and disables the
  // server's agent-name detection — cleanupTranscript gates it on its own
  // detection. Ignored when systemPrompt (a raw action-mode override) is set.
  customPrompt?: string;
  // When set, the backend enters Action Mode (dictation agent).
  agentName?: string;
  routing?: ReasoningRoutingOptions;
}

export interface ReasoningResponse {
  text: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ReasoningRoutingOptions {
  isPrivateNote?: boolean;
  allowCloudFallback?: boolean;
}

export type LocalReasoningStatus =
  | 'ready'
  | 'disabled'
  | 'unavailable'
  | 'appleIntelligenceOff'
  | 'modelNotReady';

export interface LocalReasoningReadiness {
  status: LocalReasoningStatus;
  contextSize?: number;
  tokenCounting?: boolean;
}

export type LocalReasoningErrorCode =
  | 'APPLE_LLM_GUARDRAIL'
  | 'APPLE_LLM_CONTEXT_LIMIT'
  | 'APPLE_LLM_RATE_LIMITED'
  | 'APPLE_LLM_UNAVAILABLE'
  | 'APPLE_LLM_FAILED'
  | 'LOCAL_CONTEXT_LIMIT'
  | 'LOCAL_REASONING_UNAVAILABLE';

export interface MeetingActionItem {
  text: string;
  owner?: string | null;
}

export interface StructuredMeetingNotes {
  summary: string;
  keyDiscussionPoints: string[];
  decisions: string[];
  actionItems: MeetingActionItem[];
  followUps: string[];
}

export interface TranscriptionRequest {
  audioUri: string;
  provider: TranscriptionProvider;
  language?: string;
  fileName?: string;
  mimeType?: string;
  jobId?: string;
  clientTranscriptionId?: string;
  requestContext?: 'keyboard' | 'recording' | 'file';
  // Per-job snapshot of the keyboard tone taken at record-start. Threaded to
  // cleanup; never re-read live. Only set for keyboard dictation.
  keyboardTone?: KeyboardTone;
  timeoutSeconds?: number;
}

export interface TranscriptionResponse {
  text: string;
  originalText?: string;
  duration: number;
  provider: TranscriptionProvider;
  endpoint?: string;
  cleanupApplied?: boolean;
  fusedCleanup?: boolean;
  processingMs?: number;
  cleanupMs?: number;
  uploadMs?: number;
  bodyBuildMs?: number;
  fileSizeBytes?: number;
  mimeType?: string;
  serverTiming?: Record<string, string | number | boolean | null>;
  /** Present only when word timestamps were requested (meeting path). t0/t1 in centiseconds. */
  segments?: WhisperSegment[];
}

/** Raw whisper.rn segment. t0/t1 are CENTISECONDS (hundredths of a second). */
export interface WhisperSegment {
  text: string;
  t0: number;
  t1: number;
}

// Auth types
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  emailVerified: boolean;
}

// Note types
export type NoteType = 'personal' | 'meeting' | 'upload';
export type { Note, Folder, Action, NoteUpdate, ActionUpdate } from '@/data';
export type { TranscriptionStatus } from '@/lib/diarization/diarizer';

// Dictionary types
export type DictionaryWords = string[];

// Referral types
export interface ReferralStats {
  referralCode: string;
  referralLink: string;
  totalReferrals: number;
  completedReferrals: number;
  totalMonthsEarned: number;
  referrals: ReferralEntry[];
}

export interface ReferralEntry {
  id: string;
  email: string;
  name: string;
  status: 'pending' | 'completed' | 'rewarded';
  created_at: string;
  words_used: number;
}

export interface ReferralInvite {
  id: string;
  recipientEmail: string;
  status: 'sent' | 'opened' | 'converted' | 'failed';
  sentAt: string;
}
