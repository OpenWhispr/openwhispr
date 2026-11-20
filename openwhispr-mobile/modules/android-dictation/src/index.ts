import { requireNativeModule, EventEmitter } from 'expo';
import { Platform } from 'react-native';

export interface Recording {
  uri: string;
  durationMs: number;
  noSpeech: boolean;
}
export interface BubbleStatus {
  overlay: boolean;
  accessibility: boolean;
  enabled: boolean;
  batteryExempt: boolean;
  microphone: boolean;
}
export interface LocalSpeechResult {
  text: string;
  duration: number;
  processingMs: number;
  tokenTimings?: { token: string; startTime: number; endTime: number }[];
}
export interface LocalDiarizationResult {
  speakerCount: number;
  segments: { start: number; end: number; speakerId: number | null }[];
  embeddings: Record<number, number[]>;
}
export interface DeviceProfile {
  manufacturer: string;
  model: string;
  androidVersion: string;
  apiLevel: number;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  lowMemory: boolean;
  lowRamDevice: boolean;
  freeStorageBytes: number;
  cpuCores: number;
  thermalStatus: number | null;
  emulator: boolean;
}
export type BubbleStatusValue =
  | 'processing'
  | 'success'
  | 'retry'
  | 'retry-kept'
  | 'recover'
  | 'copied';
/** What the bubble's status tab says after a failed take (each with its own action). */
export type BubbleMessage =
  | 'no-speech'
  | 'offline'
  | 'out-of-words'
  | 'sign-in'
  | 'model-needed'
  | 'failed';
export interface BubbleStatusOptions {
  /** retry / retry-kept: what the status tab says. */
  message?: BubbleMessage;
}
export interface BubbleMenuContext {
  /** "Into {target}" under Translate (Settings › Translation). */
  translateTarget?: string;
  /** Why the Assistant row is greyed: "sign-in", "unavailable", or "" when it can be used. */
  assistantBlock?: '' | 'sign-in' | 'unavailable';
  /** Settings › Bubble › Hold the bubble. */
  holdAction?: 'menu' | 'nothing';
}
interface NativeDictation {
  getDeviceProfile(): DeviceProfile;
  getLocale(): string;
  getStatus(): BubbleStatus;
  openSettings(kind: 'overlay' | 'accessibility' | 'battery' | 'app'): void;
  /** Missing on builds before the sign-in redesign. */
  openEmailApp?(title: string): boolean;
  /** Turns the floating bubble on or off and remembers the choice and size across restarts. */
  setEnabled(enabled: boolean, size: number): void;
  /** Starts the bubble again when the user left it on and its permissions are still granted. */
  restoreBubble(): boolean;
  /** The bubble pipeline is listening; the bubble sends the events it held for it. */
  pipelineReady(): Promise<void>;
  setPractice(visible: boolean): Promise<void>;
  /**
   * processing · success · retry (nothing kept: Retry listens again) · retry-kept (the recording
   * is kept: Retry sends onRetry) · recover (the text is kept in the app: the bubble offers to open it)
   */
  setStatus(status: BubbleStatusValue, options?: BubbleStatusOptions): Promise<void>;
  /** Writes the text where the dictation started; `highlight` keeps edited words selected for 1.2 s. */
  insert(text: string, options?: { highlight?: boolean }): Promise<boolean>;
  /** Stores what the hold menu shows. Missing on builds before the hold menu. */
  setMenuContext?(context: BubbleMenuContext): void;
  /** Puts text on the clipboard (typing access is off, so nothing can paste). */
  copyText?(text: string): void;
  /** Shows the bubble's "Learned" tab; false when the bubble isn't on screen. */
  showLearnedTab(options: {
    words: string[];
    message: string;
    undo: string;
    undone: string;
  }): Promise<boolean>;
  startRecording(): Promise<void>;
  stopRecording(cancel: boolean): Promise<Recording>;
  /** Loudness of the in-app recording, 0..1. Missing on builds before the Home recorder. */
  getRecordingLevel?(): number;
  startLocalMeeting(noteId: number, captureId: string, audioNamespace: string): Promise<void>;
  stopLocalMeeting(noteId: number, captureId: string): Promise<void>;
  decodeAudio(uri: string): Promise<Recording>;
  prepareCloudAudio(): string;
  cancelCloudAudio(id: string): void;
  splitCloudAudio(
    uri: string,
    seconds: number,
    id: string,
  ): Promise<{
    chunks: string[];
    durationMs: number;
  }>;
  cleanupCloudAudio(uris: string[]): Promise<void>;
  prepareSampleDecode(): string;
  cancelSampleDecode(id: string): void;
  decodeSampleAudio(uri: string, id: string): Promise<Recording>;
  sha256(uri: string): Promise<string>;
  transcribeParakeet(uri: string, modelDirectory: string): Promise<LocalSpeechResult>;
  cancelParakeet(): void;
  releaseParakeet(): Promise<void>;
  transcribeMoonshine(
    uri: string,
    modelDirectory: string,
    model: 'moonshine-tiny' | 'moonshine-small',
  ): Promise<LocalSpeechResult>;
  cancelMoonshine(): void;
  releaseMoonshine(): Promise<void>;
  diarize(
    uri: string,
    modelDirectory: string,
    numberOfSpeakers: number,
  ): Promise<LocalDiarizationResult>;
  cancelDiarization(): void;
}
export const AndroidDictation =
  Platform.OS === 'android' ? requireNativeModule<NativeDictation>('AndroidDictation') : null;
export const dictationEvents = AndroidDictation
  ? new EventEmitter<{
      onStart: (event: { selection: string; mode?: string }) => void;
      onRecording: (event: Recording) => void;
      onRetry: (event: { selection: string }) => void;
      onDismiss: () => void;
      onError: (event: { message: string }) => void;
      onCancel: () => void;
      onOpenResult: () => void;
      onOpenPlans: () => void;
      onOpenSignIn: () => void;
      onOpenModels: () => void;
      onStatusChange: () => void;
      /** The field the bubble typed into changed within 45 s: its text then and now. */
      onFieldEdited: (event: { before: string; after: string }) => void;
      /** Undo on the bubble's learned tab. */
      onLearnedUndo: (event: { words: string[] }) => void;
      /** "Won't learn" was tapped: learn the words again. */
      onLearnedRedo: (event: { words: string[] }) => void;
      /** The learned tab's words were tapped: the app opens on the Dictionary. */
      onOpenDictionary: () => void;
      'local-meeting-stopped': (event: { noteId: number; captureId: string }) => void;
      'local-meeting-error': (event: {
        noteId: number;
        captureId: string;
        message: string;
      }) => void;
    }>(AndroidDictation as never)
  : null;
