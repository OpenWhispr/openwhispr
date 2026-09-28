import type { Speaker } from '@/data/types';
import { lockSpeaker, type SpeakerState } from './speakerState';

type SpeakerRowPatch = Pick<
  Speaker,
  'displayName' | 'speakerStatus' | 'speakerLocked' | 'speakerLockSource'
>;

export const speakerRowToState = (row: Speaker): SpeakerState => ({
  displayName: row.displayName,
  speakerStatus: row.speakerStatus ?? undefined,
  speakerLocked: row.speakerLocked === 1,
  speakerLockSource: row.speakerLockSource ?? undefined,
});

export const speakerStateToRowPatch = (state: SpeakerState): SpeakerRowPatch => ({
  displayName: state.displayName ?? null,
  speakerStatus: state.speakerStatus ?? null,
  speakerLocked: state.speakerLocked ? 1 : 0,
  speakerLockSource: state.speakerLockSource ?? null,
});

export const buildRenameSpeakerPatch = (row: Speaker, displayName: string): Partial<Speaker> => {
  const trimmed = displayName.trim();
  if (!trimmed) return {};
  return speakerStateToRowPatch(lockSpeaker(speakerRowToState(row), { displayName: trimmed }));
};

export const buildMergeTargetPatch = (target: Speaker): Partial<Speaker> =>
  speakerStateToRowPatch(lockSpeaker(speakerRowToState(target)));
