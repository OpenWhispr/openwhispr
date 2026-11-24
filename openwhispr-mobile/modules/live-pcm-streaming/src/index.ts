import { EventEmitter, requireNativeModule } from 'expo';
import { Platform } from 'react-native';

type EventSubscription = {
  remove(): void;
};

/** One frame of raw microphone audio: base64 little-endian PCM16, mono, at the sample rate passed to `start`. */
export interface PcmFrame {
  audio: string;
  frameNumber: number;
  timestampMs: number;
}

/**
 * Whether the microphone is delivering audio. iOS stops capture for calls,
 * Siri, alarms and route changes; the module restarts itself and reports both
 * edges so the recording can show it and keep its clock honest.
 */
export interface CaptureStateEvent {
  state: 'capturing' | 'interrupted';
  /** 'interruption' | 'stalled' | 'interruptionEnded' | 'configurationChange' | 'mediaServicesReset' | 'watchdog' */
  reason: string;
  /** Audio captured so far, in ms. */
  capturedMs: number;
}

export interface StartOptions {
  /** file:// URI to record 16 kHz mono WAV into. */
  recordingUri?: string;
}

type LivePCMStreamingEvents = {
  'pcm-frame': (frame: PcmFrame) => void;
  'capture-state': (event: CaptureStateEvent) => void;
  'recording-failed': () => void;
};

interface NativeLivePCMStreaming {
  start(sampleRate: number, options: StartOptions): Promise<void>;
  stop(): Promise<void>;
  isRecording(): boolean;
  repairRecording(uri: string): Promise<boolean>;
}

/** Matches the desktop realtime transport (24 kHz mono PCM16). */
export const DEFAULT_SAMPLE_RATE = 24000;

const NativeModule: NativeLivePCMStreaming | null =
  Platform.OS === 'ios' ? requireNativeModule('LivePCMStreaming') : null;

const NativeModuleEvents = NativeModule
  ? new EventEmitter<LivePCMStreamingEvents>(NativeModule as any)
  : null;

export const LivePCMStreaming = {
  isAvailable(): boolean {
    return NativeModule !== null;
  },

  /**
   * Starts capturing microphone audio (iOS input conditioning on, so far-field
   * speakers stay audible) and streams it as `pcm-frame` events. Rejects if
   * capture is already running or microphone permission is denied.
   *
   * With `recordingUri`, also records the audio to that WAV file. A file that
   * can't be opened or written never fails capture: `recording-failed` fires
   * once and streaming carries on.
   */
  async start(sampleRate: number = DEFAULT_SAMPLE_RATE, options?: StartOptions): Promise<void> {
    if (!NativeModule) {
      throw new Error('LivePCMStreaming is only available on iOS');
    }
    return NativeModule.start(sampleRate, options ?? {});
  },

  /** Resolves once capture has stopped and the recording file, if any, is complete. */
  async stop(): Promise<void> {
    if (!NativeModule) return;
    return NativeModule.stop();
  },

  isRecording(): boolean {
    return NativeModule?.isRecording() ?? false;
  },

  /** Rewrites a recording's header from its real size. False when the file is missing or too short. */
  async repairRecording(uri: string): Promise<boolean> {
    if (!NativeModule) return false;
    return NativeModule.repairRecording(uri);
  },
};

export function addPcmFrameListener(callback: (frame: PcmFrame) => void): EventSubscription | null {
  if (!NativeModuleEvents) return null;
  return NativeModuleEvents.addListener('pcm-frame', callback);
}

export function addCaptureStateListener(
  callback: (event: CaptureStateEvent) => void,
): EventSubscription | null {
  if (!NativeModuleEvents) return null;
  return NativeModuleEvents.addListener('capture-state', callback);
}

/** The recording file stopped (or never started); the stream is unaffected. Fires at most once per `start`. */
export function addRecordingFailedListener(callback: () => void): EventSubscription | null {
  if (!NativeModuleEvents) return null;
  return NativeModuleEvents.addListener('recording-failed', callback);
}
