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

/** Matches the desktop realtime transport (24 kHz mono PCM16). */
export const DEFAULT_SAMPLE_RATE = 24000;

const AndroidModule = requireNativeModule<{
  startPCM(sampleRate: number, noteId: number | null, audioNamespace: string): Promise<void>;
  stopPCM(): Promise<void>;
  isPCMRecording(): boolean;
}>('AndroidDictation');
const NativeModuleEvents = new EventEmitter<LivePCMStreamingEvents>(AndroidModule as never);

export const LivePCMStreaming = {
  isAvailable(): boolean {
    return true;
  },

  /**
   * Starts capturing Android microphone audio to a durable meeting file and streams it as `pcm-frame` events. Rejects if
   * capture is already running or microphone permission is denied.
   */
  async start(
    sampleRate: number = DEFAULT_SAMPLE_RATE,
    noteId?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const { meetingAudioContext } =
      require('../../../src/lib/meetingAudioStorage') as typeof import('../../../src/lib/meetingAudioStorage');
    const audio = meetingAudioContext();
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    if (result !== PermissionsAndroid.RESULTS.GRANTED)
      throw new Error('Microphone permission is required to record a meeting.');
    if (Number(Platform.Version) >= 33)
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    if (signal?.aborted || !audio.isCurrent()) throw new Error('Meeting cancelled.');
    return AndroidModule.startPCM(sampleRate, noteId ?? null, audio.namespace);
  },

  async stop(): Promise<void> {
    return AndroidModule.stopPCM();
  },

  isRecording(): boolean {
    return AndroidModule.isPCMRecording() ?? false;
  },
};

export function addPcmFrameListener(callback: (frame: PcmFrame) => void): EventSubscription | null {
  return NativeModuleEvents.addListener('pcm-frame', callback);
}

export function addPcmErrorListener(
  callback: (event: { message: string }) => void,
): EventSubscription | null {
  return NativeModuleEvents.addListener('pcm-error', callback);
}

export function addPcmStopListener(callback: () => void): EventSubscription | null {
  return NativeModuleEvents.addListener('pcm-stopped', callback);
}
