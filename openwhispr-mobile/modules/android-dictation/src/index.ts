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
interface NativeDictation {
  getDeviceProfile(): DeviceProfile;
  getLocale(): string;
  getStatus(): BubbleStatus;
  openSettings(kind: 'overlay' | 'accessibility' | 'battery' | 'app'): void;
  setEnabled(enabled: boolean, size: number): void;
  setPractice(visible: boolean, mode: string): Promise<void>;
  setStatus(status: string): Promise<void>;
  setBubbleOptions(options: Record<string, string>): Promise<void>;
  insert(text: string): Promise<boolean>;
  startRecording(): Promise<void>;
  stopRecording(cancel: boolean): Promise<Recording>;
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
      onStart: (event: {
        selection: string;
        mode: 'dictate' | 'translate' | 'write' | 'edit';
      }) => void;
      onRecording: (event: Recording) => void;
      onError: (event: { message: string }) => void;
      onCancel: () => void;
      onOpenResult: () => void;
      onStatusChange: () => void;
      'local-meeting-stopped': (event: { noteId: number; captureId: string }) => void;
      'local-meeting-error': (event: {
        noteId: number;
        captureId: string;
        message: string;
      }) => void;
    }>(AndroidDictation as never)
  : null;
