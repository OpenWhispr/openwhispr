import type { Diarizer } from './diarizer';
import { FluidAudioDiarizer } from './fluidAudioDiarizer';

/** Returns the active on-device diarizer. Swap this one line to change engines. */
export const getDiarizer = (): Diarizer => FluidAudioDiarizer;
