import { canTransition, assertTransition, TRANSCRIPTION_TRANSITIONS } from '../transcriptionStatus';

describe('transcription status transitions', () => {
  it('allows the happy path recording -> transcribing -> diarizing -> done', () => {
    expect(canTransition('recording', 'transcribing')).toBe(true);
    expect(canTransition('transcribing', 'diarizing')).toBe(true);
    expect(canTransition('diarizing', 'done')).toBe(true);
  });
  it('allows fail from any active state', () => {
    expect(canTransition('transcribing', 'failed')).toBe(true);
    expect(canTransition('diarizing', 'failed')).toBe(true);
  });
  it('allows re-run from a terminal state (re-diarize / retry)', () => {
    expect(canTransition('done', 'transcribing')).toBe(true);
    expect(canTransition('failed', 'transcribing')).toBe(true);
  });
  it('allows the cloud shortcut transcribing -> done (skips diarizing)', () => {
    expect(canTransition('transcribing', 'done')).toBe(true);
  });
  it('rejects an illegal jump and assertTransition throws', () => {
    expect(canTransition('idle', 'done')).toBe(false);
    expect(canTransition('recording', 'done')).toBe(false);
    expect(() => assertTransition('idle', 'done')).toThrow(/Illegal/);
  });
  it('every status has a transition entry', () => {
    expect(Object.keys(TRANSCRIPTION_TRANSITIONS).sort()).toEqual([
      'diarizing',
      'done',
      'failed',
      'idle',
      'recording',
      'transcribing',
    ]);
  });
});
