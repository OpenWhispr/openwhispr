import {
  deriveCloudMeetingStatus,
  initialCloudMeetingSession,
  isCaptureStalled,
  trackCaptureGrowth,
} from '../meetingCapture';

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

describe('initialCloudMeetingSession', () => {
  it('starts every recording from nothing, its stall clock at the start time', () => {
    expect(initialCloudMeetingSession(10_000)).toEqual({
      started: false,
      failed: false,
      capturing: true,
      stalled: false,
      reconnecting: false,
      error: null,
      partialText: '',
      utterances: [],
      elapsedSeconds: 0,
      capturedSeconds: 0,
      droppedSeconds: 0,
      interruptions: 0,
      reconnects: 0,
      utteranceCount: 0,
      clock: { lastCapturedMs: 0, lastGrowthAtMs: 10_000 },
    });
  });
});

describe('trackCaptureGrowth', () => {
  it('records growth from a fresh session and flags a stall once it stops', () => {
    const fresh = initialCloudMeetingSession(10_000).clock;
    const grown = trackCaptureGrowth(fresh, 200, 16_000);
    expect(grown).toEqual({
      clock: { lastCapturedMs: 200, lastGrowthAtMs: 16_000 },
      stalled: false,
    });
    expect(trackCaptureGrowth(grown.clock, 200, 20_999).stalled).toBe(false);
    expect(trackCaptureGrowth(grown.clock, 200, 21_000).stalled).toBe(true);
  });

  it("misses a new session's growth when the last session's baseline is kept", () => {
    const carried = { lastCapturedMs: 600_000, lastGrowthAtMs: 10_000 };
    expect(trackCaptureGrowth(carried, 200, 16_000).stalled).toBe(true);
  });
});
