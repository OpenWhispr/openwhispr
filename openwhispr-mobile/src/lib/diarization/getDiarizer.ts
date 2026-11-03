import type { Diarizer } from './diarizer';
import { FluidAudioDiarizer } from './fluidAudioDiarizer';
import { Platform } from 'react-native';

/** Select the platform's on-device speaker runtime without loading Android dependencies on iOS. */
export const getDiarizer = (): Diarizer => {
  if (Platform.OS === 'android') {
    const { AndroidDiarizer } = require('./androidDiarizer') as typeof import('./androidDiarizer');
    return AndroidDiarizer;
  }
  return FluidAudioDiarizer;
};
