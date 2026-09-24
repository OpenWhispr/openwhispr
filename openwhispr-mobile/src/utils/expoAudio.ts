import { Platform } from 'react-native';
import { RecordingPresets, IOSOutputFormat, AudioQuality, type RecordingOptions } from 'expo-audio';

let expoAudioModule: typeof import('expo-audio') | null = null;
let expoAudioError: Error | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  expoAudioModule = require('expo-audio');
} catch (error) {
  expoAudioError = error as Error;
  if (__DEV__) {
    console.warn(
      '[expo-audio] Native module unavailable. Recording features will be disabled in this environment.',
      expoAudioError?.message ?? error,
    );
  }
}

export function getExpoAudioModule() {
  return expoAudioModule;
}

export function isExpoAudioAvailable() {
  return expoAudioModule != null;
}

export function getExpoAudioError() {
  return expoAudioError;
}

export function getDefaultRecorderOptions(): RecordingOptions {
  if (Platform.OS === 'ios') {
    return {
      ...RecordingPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
      extension: '.wav',
      sampleRate: 16000,
      numberOfChannels: 1,
      bitRate: 256000,
      ios: {
        ...RecordingPresets.HIGH_QUALITY.ios,
        extension: '.wav',
        sampleRate: 16000,
        outputFormat: IOSOutputFormat.LINEARPCM,
        audioQuality: AudioQuality.MAX,
        linearPCMBitDepth: 16,
        linearPCMIsBigEndian: false,
        linearPCMIsFloat: false,
      },
    };
  }
  return { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };
}
