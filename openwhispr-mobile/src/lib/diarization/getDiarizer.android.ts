import type { Diarizer } from './diarizer';
import { AndroidDiarizer } from '@/android/diarization/androidDiarizer';

export const getDiarizer = (): Diarizer => AndroidDiarizer;
