import type { TranscriptionStatus } from './diarizer';

/** Legal next-statuses per status. The orchestrator routes every status write through assertTransition. */
export const TRANSCRIPTION_TRANSITIONS: Record<
  TranscriptionStatus,
  readonly TranscriptionStatus[]
> = {
  idle: ['recording', 'transcribing'],
  recording: ['transcribing', 'failed', 'idle'],
  transcribing: ['diarizing', 'done', 'failed'], // 'done' = cloud realtime path (skips diarizing)
  diarizing: ['done', 'failed'],
  done: ['transcribing'], // re-diarize
  failed: ['transcribing', 'recording'], // retry
};

export const canTransition = (from: TranscriptionStatus, to: TranscriptionStatus): boolean =>
  TRANSCRIPTION_TRANSITIONS[from].includes(to);

export const assertTransition = (from: TranscriptionStatus, to: TranscriptionStatus): void => {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal transcription status transition: ${from} -> ${to}`);
  }
};
