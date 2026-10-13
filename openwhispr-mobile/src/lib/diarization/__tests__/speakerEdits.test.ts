import type { Speaker } from '@/data/types';
import {
  buildMergeTargetPatch,
  buildRenameSpeakerPatch,
  speakerRowToState,
  speakerStateToRowPatch,
} from '../speakerEdits';

const speaker = (overrides: Partial<Speaker>): Speaker =>
  ({
    id: 1,
    noteId: 7,
    speakerLabel: 'SPEAKER_00',
    displayName: null,
    profileId: null,
    color: null,
    sortOrder: 0,
    speakerStatus: 'provisional',
    speakerLocked: 0,
    speakerLockSource: null,
    clientId: null,
    remoteId: null,
    deletedAt: null,
    pendingSync: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Speaker;

describe('speakerEdits', () => {
  it('rename forces a user lock and is idempotent on an already locked row', () => {
    const patch = buildRenameSpeakerPatch(
      speaker({
        displayName: 'Alice',
        speakerStatus: 'locked',
        speakerLocked: 1,
        speakerLockSource: 'user',
      }),
      ' Alice Cooper ',
    );

    expect(patch).toEqual({
      displayName: 'Alice Cooper',
      speakerStatus: 'locked',
      speakerLocked: 1,
      speakerLockSource: 'user',
    });
  });

  it('converts SQLite lock ints to speakerState booleans and back', () => {
    const state = speakerRowToState(
      speaker({ displayName: 'Bob', speakerLocked: 1, speakerLockSource: 'user' }),
    );

    expect(state).toEqual({
      displayName: 'Bob',
      speakerStatus: 'provisional',
      speakerLocked: true,
      speakerLockSource: 'user',
    });
    expect(speakerStateToRowPatch({ ...state, speakerLocked: false })).toEqual({
      displayName: 'Bob',
      speakerStatus: 'provisional',
      speakerLocked: 0,
      speakerLockSource: 'user',
    });
  });

  it('merge target patch preserves display fields and locks through speakerState', () => {
    const target = speaker({
      displayName: 'Carol',
      profileId: 42,
      color: '#123456',
      speakerStatus: 'confirmed',
      speakerLocked: 0,
      speakerLockSource: null,
    });

    const patch = buildMergeTargetPatch(target);

    expect(patch).toEqual({
      displayName: 'Carol',
      speakerStatus: 'locked',
      speakerLocked: 1,
      speakerLockSource: 'user',
    });
    expect(patch).not.toHaveProperty('profileId');
    expect(patch).not.toHaveProperty('color');
  });

  it('returns an empty rename patch for blank input', () => {
    expect(buildRenameSpeakerPatch(speaker({ displayName: 'Alice' }), '   ')).toEqual({});
  });
});
