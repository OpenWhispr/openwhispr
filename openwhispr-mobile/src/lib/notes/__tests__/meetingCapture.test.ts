import { deriveCloudMeetingStatus, isCaptureStalled } from '../meetingCapture';

describe('deriveCloudMeetingStatus', () => {
  it('ranks error over connecting over interrupted over reconnecting over live', () => {
    expect(
      deriveCloudMeetingStatus({
        started: false,
        failed: false,
        capturing: true,
        reconnecting: false,
      }),
    ).toBe('connecting');
    expect(
      deriveCloudMeetingStatus({
        started: true,
        failed: true,
        capturing: true,
        reconnecting: true,
      }),
    ).toBe('error');
    expect(
      deriveCloudMeetingStatus({
        started: true,
        failed: false,
        capturing: false,
        reconnecting: true,
      }),
    ).toBe('interrupted');
    expect(
      deriveCloudMeetingStatus({
        started: true,
        failed: false,
        capturing: true,
        reconnecting: true,
      }),
    ).toBe('reconnecting');
    expect(
      deriveCloudMeetingStatus({
        started: true,
        failed: false,
        capturing: true,
        reconnecting: false,
      }),
    ).toBe('live');
  });
});

describe('isCaptureStalled', () => {
  it('is true once the captured clock has not grown for CAPTURE_STALL_MS', () => {
    expect(isCaptureStalled(1_000, 5_999)).toBe(false);
    expect(isCaptureStalled(1_000, 6_000)).toBe(true);
  });
});
