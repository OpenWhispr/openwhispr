import {
  isLocked,
  canAutoRelabel,
  applyProvisional,
  applyConfirmed,
  applySuggested,
  lockSpeaker,
  mergeSpeakerState,
  type SpeakerState,
} from '../speakerState';

const base: SpeakerState = { speakerStatus: 'provisional' };

describe('isLocked / canAutoRelabel', () => {
  it('treats speakerLocked as locked', () => {
    expect(isLocked({ speakerLocked: true })).toBe(true);
    expect(canAutoRelabel({ speakerLocked: true })).toBe(false);
  });
  it('treats lockSource "user" as locked even without the flag', () => {
    expect(isLocked({ speakerLockSource: 'user' })).toBe(true);
  });
  it('an unlocked provisional speaker can be auto-relabeled', () => {
    expect(canAutoRelabel(base)).toBe(true);
  });
  it('a non-user lock source without the flag is NOT locked', () => {
    expect(isLocked({ speakerLockSource: 'diarization' })).toBe(false);
    expect(canAutoRelabel({ speakerLockSource: 'diarization' })).toBe(true);
  });
});

describe('apply* transitions', () => {
  it('applyConfirmed sets confirmed + applies patch on an unlocked speaker', () => {
    const next = applyConfirmed(base, { displayName: 'Alice' });
    expect(next.speakerStatus).toBe('confirmed');
    expect(next.displayName).toBe('Alice');
  });
  it('applySuggested is a NO-OP on a locked speaker (never overrides)', () => {
    const locked = lockSpeaker(base, { displayName: 'Alice' });
    const next = applySuggested(locked, { displayName: 'Bob' });
    expect(next.displayName).toBe('Alice');
    expect(next.speakerStatus).toBe('locked');
  });
  it('applyConfirmed preserves a lock instead of overwriting it', () => {
    const locked = lockSpeaker(base, { displayName: 'Alice' });
    const next = applyConfirmed(locked, { displayName: 'Bob' });
    expect(next.displayName).toBe('Alice');
    expect(next.speakerLocked).toBe(true);
  });
  it('applyProvisional is a NO-OP on a locked speaker', () => {
    const locked = lockSpeaker(base, { displayName: 'Alice' });
    const next = applyProvisional(locked, { displayName: 'Bob' });
    expect(next.displayName).toBe('Alice');
    expect(next.speakerStatus).toBe('locked');
  });
});

describe('lockSpeaker', () => {
  it('locks with user source and applies patch', () => {
    const next = lockSpeaker(base, { displayName: 'Carol' });
    expect(next).toMatchObject({
      speakerLocked: true,
      speakerStatus: 'locked',
      speakerLockSource: 'user',
      displayName: 'Carol',
    });
  });
});

describe('mergeSpeakerState', () => {
  it('preserves every field of a locked existing speaker', () => {
    const existing = lockSpeaker(base, { displayName: 'Alice' });
    const merged = mergeSpeakerState(existing, { displayName: 'Bob', speakerStatus: 'suggested' });
    expect(merged.displayName).toBe('Alice');
    expect(merged.speakerStatus).toBe('locked');
    expect(merged.speakerLocked).toBe(true);
    expect(merged.speakerLockSource).toBe('user');
  });
  it('enriches an unlocked speaker from incoming (incoming wins, undefined ignored)', () => {
    const merged = mergeSpeakerState(
      { speakerStatus: 'provisional', displayName: 'Speaker 1' },
      { displayName: 'Alice', speakerLockSource: undefined },
    );
    expect(merged.displayName).toBe('Alice');
  });
});
