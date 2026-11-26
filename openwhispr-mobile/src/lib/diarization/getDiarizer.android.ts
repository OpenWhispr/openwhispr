import type { Diarizer } from '@/android/shared/lib/diarization/diarizer';
import { AndroidDiarizer } from '@/android/diarization/androidDiarizer';

export const getDiarizer = (): Diarizer => AndroidDiarizer;
