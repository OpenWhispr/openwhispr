import { EventEmitter, requireNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';

type EventSubscription = {
  remove(): void;
};

/** One frame of raw microphone audio: base64 little-endian PCM16, mono, at the sample rate passed to `start`. */
export interface PcmFrame {
  audio: string;
  frameNumber: number;
  timestampMs: number;
}

type LivePCMStreamingEvents = {
  'pcm-frame': (frame: PcmFrame) => void;
  'pcm-stopped': () => void;
  'pcm-error': (event: { message: string }) => void;
};

interface NativeLivePCMStreaming {
  start(sampleRate: number): Promise<void>;
  stop(): Promise<void>;
  isRecording(): boolean;
}

/** Matches the desktop realtime transport (24 kHz mono PCM16). */
export const DEFAULT_SAMPLE_RATE = 24000;

const AndroidModule =
  Platform.OS === 'android'
    ? requireNativeModule<{
        startPCM(sampleRate: number, noteId: number | null): Promise<void>;
        stopPCM(): Promise<void>;
        isPCMRecording(): boolean;
      }>('AndroidDictation')
    : null;
const NativeModule: NativeLivePCMStreaming | null =
  Platform.OS === 'ios' ? requireNativeModule('LivePCMStreaming') : null;

const NativeModuleEvents =
  (AndroidModule ?? NativeModule)
    ? new EventEmitter<LivePCMStreamingEvents>((AndroidModule ?? NativeModule) as never)
    : null;

export const LivePCMStreaming = {
  isAvailable(): boolean {
    return NativeModule !== null || AndroidModule !== null;
  },

  /**
   * Starts capturing microphone audio (iOS input conditioning on, so far-field
   * speakers stay audible) and streams it as `pcm-frame` events. Rejects if
   * capture is already running or microphone permission is denied.
   */
  async start(
    sampleRate: number = DEFAULT_SAMPLE_RATE,
    noteId?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (AndroidModule) {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (result !== PermissionsAndroid.RESULTS.GRANTED)
        throw new Error('Microphone permission is required to record a meeting.');
      if (Number(Platform.Version) >= 33)
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      if (signal?.aborted) throw new Error('Meeting cancelled.');
      return AndroidModule.startPCM(sampleRate, noteId ?? null);
    }
    if (!NativeModule) {
      throw new Error('Live microphone streaming is unavailable in this build.');
    }
    if (signal?.aborted) throw new Error('Meeting cancelled.');
    return NativeModule.start(sampleRate);
  },

  async stop(): Promise<void> {
    if (AndroidModule) return AndroidModule.stopPCM();
    if (!NativeModule) return;
    return NativeModule.stop();
  },

  isRecording(): boolean {
    return AndroidModule?.isPCMRecording() ?? NativeModule?.isRecording() ?? false;
  },
};

export function addPcmFrameListener(callback: (frame: PcmFrame) => void): EventSubscription | null {
  if (!NativeModuleEvents) return null;
  return NativeModuleEvents.addListener('pcm-frame', callback);
}

export function addPcmErrorListener(
  callback: (event: { message: string }) => void,
): EventSubscription | null {
  return Platform.OS === 'android'
    ? (NativeModuleEvents?.addListener('pcm-error', callback) ?? null)
    : null;
}

export function addPcmStopListener(callback: () => void): EventSubscription | null {
  return Platform.OS === 'android'
    ? (NativeModuleEvents?.addListener('pcm-stopped', callback) ?? null)
    : null;
}
