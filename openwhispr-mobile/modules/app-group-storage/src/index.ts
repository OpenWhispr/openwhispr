import { EventEmitter, requireNativeModule } from 'expo';
import { Platform } from 'react-native';

type EventSubscription = {
  remove(): void;
};

interface AppGroupStorageModule {
  setItem(key: string, value: string): boolean;
  getItem(key: string): string | null;
  removeItem(key: string): boolean;
  setKeyboardStatus(status: string, detail?: string | null): void;
  markKeyboardTiming(name: string): void;
  analyzeSpeechActivity(fileUri: string): Promise<SpeechActivityAnalysis>;
  convertRecordingToWav(fileUri: string): Promise<RecordingConversionResult>;
  getActiveInputModes(): string[];
  returnToPreviousApp(): void;
  startNativeRecording(): boolean;
  stopNativeRecording(): void;
  endProcessingTask(): void;
  armWarmMic(): void;
}

export interface SpeechActivityAnalysis {
  durationMs: number;
  analyzedMs: number;
  speechActivityMs: number;
  speechRatio: number;
  peakDb: number;
  averageDb: number;
  noiseFloorDb: number;
  thresholdDb: number;
  noSpeechLikely: boolean;
  reason?: string;
  confidence: number;
}

export interface RecordingConversionResult {
  fileUri: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes?: number;
}

type AppGroupStorageEvents = {
  onRecordingStopped: (event: {
    fileUri: string;
    fileName?: string;
    mimeType?: string;
    recordingFormat?: string;
    jobId?: string;
    fileSizeBytes?: number;
    recordingDurationMs?: number;
  }) => void;
  onRecordingError: (event: { message: string }) => void;
  onBackgroundRecordingStarted: () => void;
  onKeyboardStatusChanged: (event: {
    status?: string;
    error?: string;
    updatedAtMs?: string;
    jobId?: string;
    hasPendingTranscript?: boolean;
    hasOrphanedRawTranscript?: boolean;
    trigger?: string;
  }) => void;
  onAgentAction: () => void;
};

const NativeModule: AppGroupStorageModule | null =
  Platform.OS === 'ios' ? requireNativeModule('AppGroupStorage') : null;

const NativeModuleEvents = NativeModule
  ? new EventEmitter<AppGroupStorageEvents>(NativeModule as any)
  : null;

export const AppGroupStorage = {
  setItem(key: string, value: string): boolean {
    if (!NativeModule) return false;
    return NativeModule.setItem(key, value);
  },

  getItem(key: string): string | null {
    if (!NativeModule) return null;
    return NativeModule.getItem(key);
  },

  removeItem(key: string): boolean {
    if (!NativeModule) return false;
    return NativeModule.removeItem(key);
  },

  setKeyboardStatus(status: string, detail?: string | null): void {
    if (!NativeModule) return;
    NativeModule.setKeyboardStatus(status, detail ?? null);
  },

  markKeyboardTiming(name: string): void {
    if (!NativeModule) return;
    NativeModule.markKeyboardTiming(name);
  },

  async analyzeSpeechActivity(fileUri: string): Promise<SpeechActivityAnalysis | null> {
    if (!NativeModule) return null;
    try {
      return await NativeModule.analyzeSpeechActivity(fileUri);
    } catch (error) {
      if (__DEV__) {
        console.warn('[app-group-storage] speech activity analysis failed:', error);
      }
      return null;
    }
  },

  async convertRecordingToWav(fileUri: string): Promise<RecordingConversionResult | null> {
    if (!NativeModule) return null;
    try {
      return await NativeModule.convertRecordingToWav(fileUri);
    } catch (error) {
      if (__DEV__) {
        console.warn('[app-group-storage] recording WAV conversion failed:', error);
      }
      return null;
    }
  },

  /**
   * Returns the iOS user's currently installed keyboard languages as locale
   * tags (e.g. ['en-US', 'he-IL', 'emoji']). Empty array on platforms or
   * builds where the native module is unavailable.
   */
  getActiveInputModes(): string[] {
    if (!NativeModule) return [];
    try {
      return NativeModule.getActiveInputModes();
    } catch {
      return [];
    }
  },

  returnToPreviousApp(): void {
    if (!NativeModule) return;
    NativeModule.returnToPreviousApp();
  },

  startNativeRecording(): boolean {
    if (!NativeModule) return false;
    return NativeModule.startNativeRecording();
  },

  stopNativeRecording(): void {
    if (!NativeModule) return;
    NativeModule.stopNativeRecording();
  },

  endProcessingTask(): void {
    if (!NativeModule) return;
    NativeModule.endProcessingTask();
  },

  /**
   * Warms the dictation mic after the user grants microphone access. The native
   * side never warms without permission (warming is what raises the system
   * prompt), so a fresh grant would otherwise go unnoticed until the next
   * foreground and leave the keyboard reporting "not ready".
   */
  armWarmMic(): void {
    if (!NativeModule) return;
    NativeModule.armWarmMic();
  },
};

export function addRecordingStoppedListener(
  callback: (event: {
    fileUri: string;
    fileName?: string;
    mimeType?: string;
    recordingFormat?: string;
    jobId?: string;
    fileSizeBytes?: number;
    recordingDurationMs?: number;
  }) => void,
): EventSubscription | null {
  if (!NativeModuleEvents) return null;
  return NativeModuleEvents.addListener('onRecordingStopped', callback);
}

export function addRecordingErrorListener(
  callback: (event: { message: string }) => void,
): EventSubscription | null {
  if (!NativeModuleEvents) return null;
  return NativeModuleEvents.addListener('onRecordingError', callback);
}

export function addBackgroundRecordingStartedListener(
  callback: () => void,
): EventSubscription | null {
  if (!NativeModuleEvents) return null;
  return NativeModuleEvents.addListener('onBackgroundRecordingStarted', callback);
}

export function addKeyboardStatusChangedListener(
  callback: (event: {
    status?: string;
    error?: string;
    updatedAtMs?: string;
    jobId?: string;
    hasPendingTranscript?: boolean;
    hasOrphanedRawTranscript?: boolean;
    trigger?: string;
  }) => void,
): EventSubscription | null {
  if (!NativeModuleEvents) return null;
  return NativeModuleEvents.addListener('onKeyboardStatusChanged', callback);
}

/**
 * Fired when the keyboard posts a one-shot agent action (regenerate). The event
 * is a poke: the payload lives in `keyboard_agent_action` / `_at_ms`, which the
 * listener reads via getItem, mirroring the background-recording-started event.
 */
export function addAgentActionListener(callback: () => void): EventSubscription | null {
  if (!NativeModuleEvents) return null;
  return NativeModuleEvents.addListener('onAgentAction', callback);
}

export const APP_GROUP_KEYS = {
  KEYBOARD_PENDING_TRANSCRIPT: 'keyboard_pending_transcript',
  KEYBOARD_PENDING_TRANSCRIPT_JOB_ID: 'keyboard_pending_transcript_job_id',
  KEYBOARD_ORPHANED_RAW_TRANSCRIPT: 'keyboard_orphaned_raw_transcript',
  KEYBOARD_ORPHANED_RAW_TRANSCRIPT_JOB_ID: 'keyboard_orphaned_raw_transcript_job_id',
  KEYBOARD_RECORDING_JOB_ID: 'keyboard_recording_job_id',
  KEYBOARD_RECORDING_FORMAT: 'keyboard_recording_format',
  KEYBOARD_COMPRESSED_AUDIO_UNSUPPORTED: 'keyboard_compressed_audio_unsupported',
  KEYBOARD_COMPRESSED_AUDIO_UNSUPPORTED_AT_MS: 'keyboard_compressed_audio_unsupported_at_ms',
  KEYBOARD_RECORDING_ACTIVE: 'keyboard_recording_active',
  KEYBOARD_AUDIO_LEVEL: 'keyboard_audio_level',
  KEYBOARD_STOP_REQUESTED: 'keyboard_stop_requested',
  KEYBOARD_CANCEL_REQUESTED: 'keyboard_cancel_requested',
  KEYBOARD_SHOWN_AT_MS: 'keyboard_shown_at_ms',
  KEYBOARD_HANDOFF_INTENT_AT_MS: 'keyboard_handoff_intent_at_ms',
  KEYBOARD_TRANSCRIPTION_STATUS: 'keyboard_transcription_status',
  KEYBOARD_TRANSCRIPTION_ERROR: 'keyboard_transcription_error',
  KEYBOARD_TRANSCRIPTION_STATUS_UPDATED_AT_MS: 'keyboard_transcription_status_updated_at_ms',
  KEYBOARD_DICTATION_TONE: 'keyboard_dictation_tone',
  KEYBOARD_RECORDING_TONE: 'keyboard_recording_tone',
  KEYBOARD_RECORDING_TONE_JOB_ID: 'keyboard_recording_tone_job_id',
  KEYBOARD_TONE_APPLICABLE: 'keyboard_tone_applicable',
  BACKGROUND_SESSION_READY: 'background_session_ready',
  // Agent mode — config mirrors (app → keyboard; persisted across launches like tone keys)
  KEYBOARD_AGENT_ENABLED: 'keyboard_agent_enabled',
  KEYBOARD_AGENT_APPLICABLE: 'keyboard_agent_applicable',
  KEYBOARD_AGENT_NAME: 'keyboard_agent_name',
  KEYBOARD_AGENT_SHARE_CONTEXT: 'keyboard_agent_share_context',
  // Agent mode — one-shot / per-job keys (cleared on app launch)
  KEYBOARD_AGENT_REQUEST: 'keyboard_agent_request',
  KEYBOARD_AGENT_JOB: 'keyboard_agent_job',
  KEYBOARD_AGENT_RESULT: 'keyboard_agent_result',
  KEYBOARD_AGENT_ACTION: 'keyboard_agent_action',
  KEYBOARD_AGENT_ACTION_AT_MS: 'keyboard_agent_action_at_ms',
  // App-side only: bookkeeping for the Full Access probe (see keyboardFullAccessProbe).
  // The keyboard never reads it; it lives here because the probe's whole subject
  // is whether this container is reachable from the extension.
  KEYBOARD_FULL_ACCESS_PROBE: 'keyboard_full_access_probe',
  /**
   * Build identity (marketing+build, e.g. "1.4.0+42") stamped by the same
   * keyboard write as KEYBOARD_SHOWN_AT_MS — proof of WHICH build last held
   * Full Access. Written by the extension, read by the probe.
   */
  KEYBOARD_SHOWN_VERSION: 'keyboard_shown_version',
} as const;
