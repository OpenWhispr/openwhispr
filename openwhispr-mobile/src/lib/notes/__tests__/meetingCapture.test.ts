import {
  captureCoverage,
  deriveCloudMeetingStatus,
  initialCloudMeetingSession,
  isCaptureStalled,
  isCloudMeetingCapturing,
  isCloudMeetingRecordingAudio,
  partialCaptureMessage,
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

describe('deriveCloudMeetingStatus before the first connection', () => {
  const base = { started: true, failed: false, capturing: true, reconnecting: false };

  it('stays connecting until the first connection, then goes live', () => {
    expect(deriveCloudMeetingStatus({ ...base, connected: false })).toBe('connecting');
    expect(deriveCloudMeetingStatus({ ...base, connected: true })).toBe('live');
  });

  it('shows a failed first attempt as reconnecting and a stopped mic as interrupted', () => {
    expect(deriveCloudMeetingStatus({ ...base, connected: false, reconnecting: true })).toBe(
      'reconnecting',
    );
    expect(deriveCloudMeetingStatus({ ...base, connected: false, capturing: false })).toBe(
      'interrupted',
    );
  });
});

describe('isCloudMeetingRecordingAudio', () => {
  it('reads as recording while connecting only once capture has started', () => {
    expect(isCloudMeetingRecordingAudio('connecting', false)).toBe(false);
    expect(isCloudMeetingRecordingAudio('connecting', true)).toBe(true);
    expect(isCloudMeetingRecordingAudio('live', true)).toBe(true);
    expect(isCloudMeetingRecordingAudio('reconnecting', true)).toBe(true);
    expect(isCloudMeetingRecordingAudio('interrupted', true)).toBe(false);
    expect(isCloudMeetingRecordingAudio('error', true)).toBe(false);
  });
});

describe('isCloudMeetingCapturing', () => {
  it('is false only once the mic stopped or the session ended', () => {
    expect(isCloudMeetingCapturing('connecting')).toBe(true);
    expect(isCloudMeetingCapturing('live')).toBe(true);
    expect(isCloudMeetingCapturing('reconnecting')).toBe(true);
    expect(isCloudMeetingCapturing('interrupted')).toBe(false);
    expect(isCloudMeetingCapturing('error')).toBe(false);
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

describe('captureCoverage', () => {
  it('measures what was recorded against how long the meeting ran', () => {
    expect(captureCoverage(540_000, 3_660_000)).toEqual({
      recordedSeconds: 540,
      elapsedSeconds: 3660,
      missingSeconds: 3120,
      isPartial: true,
    });
  });

  it('is partial once 30 s or more is missing', () => {
    expect(captureCoverage(3_650_000, 3_660_000).isPartial).toBe(false);
    expect(captureCoverage(3_630_000, 3_660_000).isPartial).toBe(true);
  });

  it('never reports negative missing time', () => {
    expect(captureCoverage(3_700_000, 3_660_000).missingSeconds).toBe(0);
  });
});

describe('partialCaptureMessage', () => {
  it('says how much of the meeting was recorded', () => {
    expect(partialCaptureMessage(captureCoverage(540_000, 3_660_000))).toBe(
      'OpenWhispr recorded 9 min of this 61 min meeting. The rest was missed while the microphone or the connection was interrupted.',
    );
  });

  it('rounds recorded minutes down and elapsed minutes up so they never read equal', () => {
    expect(partialCaptureMessage(captureCoverage(1_770_000, 1_800_000))).toContain(
      'recorded 29 min of this 30 min meeting',
    );
    expect(partialCaptureMessage(captureCoverage(10_000, 50_000))).toContain(
      'recorded under 1 min of this 1 min meeting',
    );
    const cases: [number, number][] = [
      [1_770_000, 1_800_000],
      [1_789_000, 1_830_000],
      [3_570_000, 3_600_000],
      [59_000, 89_000],
      [119_000, 150_000],
      [540_000, 3_660_000],
    ];
    for (const [recordedMs, elapsedMs] of cases) {
      const coverage = captureCoverage(recordedMs, elapsedMs);
      expect(coverage.isPartial).toBe(true);
      const match = partialCaptureMessage(coverage).match(
        /recorded (under 1|\d+) min of this (\d+) min/,
      );
      const recorded = match?.[1] === 'under 1' ? 0 : Number(match?.[1]);
      expect(Number(match?.[2])).toBeGreaterThan(recorded);
    }
  });

  it('says under 1 min when less than a minute was recorded', () => {
    expect(partialCaptureMessage(captureCoverage(20_000, 90_000))).toContain(
      'recorded under 1 min of this 2 min meeting',
    );
  });
});
