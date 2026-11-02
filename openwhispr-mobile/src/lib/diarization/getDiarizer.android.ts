import type { Diarizer } from './diarizer';
import { AndroidDiarizer } from './androidDiarizer';

export const getDiarizer = (): Diarizer => AndroidDiarizer;
