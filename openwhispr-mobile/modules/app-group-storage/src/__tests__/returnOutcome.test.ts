import { parseReturnOutcome } from '../returnOutcome';

describe('parseReturnOutcome', () => {
  it('keeps the host name for opened and failed', () => {
    expect(parseReturnOutcome({ status: 'opened', hostName: 'Slack' })).toEqual({
      status: 'opened',
      hostName: 'Slack',
    });
    expect(parseReturnOutcome({ status: 'failed', hostName: ' Messages ' })).toEqual({
      status: 'failed',
      hostName: 'Messages',
    });
  });

  it('treats a missing or blank host name as unknown', () => {
    expect(parseReturnOutcome({ status: 'failed' })).toEqual({ status: 'failed', hostName: null });
    expect(parseReturnOutcome({ status: 'opened', hostName: '  ' })).toEqual({
      status: 'opened',
      hostName: null,
    });
  });

  it('passes skipped and no_target through', () => {
    expect(parseReturnOutcome({ status: 'skipped' })).toEqual({ status: 'skipped' });
    expect(parseReturnOutcome({ status: 'no_target' })).toEqual({ status: 'no_target' });
  });

  // An unreadable result must fall back to the swipe screen, never to "Returning…".
  it.each([undefined, null, 'opened', 42, {}, { status: 'weird' }])(
    'maps %p to no_target',
    (raw) => {
      expect(parseReturnOutcome(raw)).toEqual({ status: 'no_target' });
    },
  );
});
