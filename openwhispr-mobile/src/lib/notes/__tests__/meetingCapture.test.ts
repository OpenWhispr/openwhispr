import {
  captureCoverage,
  deriveCloudMeetingStatus,
  initialCloudMeetingSession,
  isCaptureStalled,
  isCloudMeetingCapturing,
  isCloudMeetingRecordingAudio,
  formatClock,
  meetingBarState,
  meetingCaptureAlert,
  meetingStartFailureFrom,
  meetingStartFailureNotice,
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

describe('deriveCloudMeetingStatus after the live stream ended', () => {
  const base = { started: true, failed: false, capturing: true, reconnecting: false };

  it('reads as recording only, whether or not the stream ever connected', () => {
    expect(deriveCloudMeetingStatus({ ...base, streamEnded: true })).toBe('recording-only');
    expect(deriveCloudMeetingStatus({ ...base, connected: false, streamEnded: true })).toBe(
      'recording-only',
    );
    expect(deriveCloudMeetingStatus({ ...base, reconnecting: true, streamEnded: true })).toBe(
      'recording-only',
    );
  });

  it('still shows a stopped mic and an ended session over it', () => {
    expect(deriveCloudMeetingStatus({ ...base, capturing: false, streamEnded: true })).toBe(
      'interrupted',
    );
    expect(deriveCloudMeetingStatus({ ...base, failed: true, streamEnded: true })).toBe('error');
  });
});

describe('isCloudMeetingRecordingAudio', () => {
  it('reads as recording while connecting only once capture has started', () => {
    expect(isCloudMeetingRecordingAudio('connecting', false)).toBe(false);
    expect(isCloudMeetingRecordingAudio('connecting', true)).toBe(true);
    expect(isCloudMeetingRecordingAudio('live', true)).toBe(true);
    expect(isCloudMeetingRecordingAudio('reconnecting', true)).toBe(true);
    expect(isCloudMeetingRecordingAudio('recording-only', true)).toBe(true);
    expect(isCloudMeetingRecordingAudio('interrupted', true)).toBe(false);
    expect(isCloudMeetingRecordingAudio('error', true)).toBe(false);
  });
});

describe('isCloudMeetingCapturing', () => {
  it('is false only once the mic stopped or the session ended', () => {
    expect(isCloudMeetingCapturing('connecting')).toBe(true);
    expect(isCloudMeetingCapturing('live')).toBe(true);
    expect(isCloudMeetingCapturing('reconnecting')).toBe(true);
    expect(isCloudMeetingCapturing('recording-only')).toBe(true);
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
      streamEnded: false,
      error: null,
      partialText: '',
      utterances: [],
      capturedSeconds: 0,
      droppedSeconds: 0,
      interruptions: 0,
      reconnects: 0,
      utteranceCount: 0,
      startFailure: null,
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

describe('meetingCaptureAlert', () => {
  const MIN = 60_000;
  const PARTIAL = "Part of this meeting wasn't recorded";
  const UNTRANSCRIBED = "Part of this meeting wasn't transcribed";
  const LATER =
    'which is transcribed from audio saved on this device the next time OpenWhispr is open with a connection.';

  // Mic gap (40 of 61 min recorded) x owed audio saved (12 min) x owed audio not saved (20 min).
  const alertFor = (micGap: boolean, owed: boolean, unsaved: boolean) =>
    meetingCaptureAlert({
      elapsedMs: 61 * MIN,
      capturedMs: micGap ? 40 * MIN : 61 * MIN,
      missedMs: 0,
      owedMs: owed ? 12 * MIN : 0,
      unsavedMs: unsaved ? 20 * MIN : 0,
    });

  it('says nothing for a meeting that was recorded and transcribed', () => {
    expect(alertFor(false, false, false)).toBeNull();
  });

  it('says how much is still to be transcribed when the microphone kept recording', () => {
    expect(alertFor(false, true, false)).toEqual({
      title: "Part of this meeting isn't transcribed yet",
      message:
        'OpenWhispr has transcribed 49 min of this 61 min meeting so far. Audio still saved on this device is transcribed the next time OpenWhispr is open with a connection.',
    });
  });

  it('says how much was recorded when the microphone stopped', () => {
    expect(alertFor(true, false, false)).toEqual({
      title: PARTIAL,
      message:
        'OpenWhispr recorded 40 min of this 61 min meeting. The rest was missed while the microphone or the connection was interrupted.',
    });
  });

  it('says what was recorded and what of it is still owed when the microphone also stopped', () => {
    expect(alertFor(true, true, false)).toEqual({
      title: PARTIAL,
      message: `OpenWhispr recorded 40 min of this 61 min meeting. The rest was missed while the microphone was interrupted. The transcript is still missing 12 min of the recording, ${LATER}`,
    });
  });

  it('counts audio it could not save for later as recorded, and says it could not be transcribed', () => {
    expect(alertFor(false, false, true)).toEqual({
      title: UNTRANSCRIBED,
      message:
        'OpenWhispr recorded this 61 min meeting. OpenWhispr could not transcribe 20 min of the recording.',
    });
  });

  it('says both what could not be transcribed and what is still owed', () => {
    expect(alertFor(false, true, true)).toEqual({
      title: UNTRANSCRIBED,
      message: `OpenWhispr recorded this 61 min meeting. OpenWhispr could not transcribe 20 min of the recording. The transcript is still missing 12 min of the recording, ${LATER}`,
    });
  });

  it('keeps the microphone sentence beside what could not be transcribed', () => {
    expect(alertFor(true, false, true)).toEqual({
      title: PARTIAL,
      message:
        'OpenWhispr recorded 40 min of this 61 min meeting. The rest was missed while the microphone was interrupted. OpenWhispr could not transcribe 20 min of the recording.',
    });
  });

  it('says all three when the microphone stopped and part of the recording is lost and owed', () => {
    expect(alertFor(true, true, true)).toEqual({
      title: PARTIAL,
      message: `OpenWhispr recorded 40 min of this 61 min meeting. The rest was missed while the microphone was interrupted. OpenWhispr could not transcribe 20 min of the recording. The transcript is still missing 12 min of the recording, ${LATER}`,
    });
  });

  it('says under 1 min for a short stretch it could not save, once enough is missing', () => {
    expect(
      meetingCaptureAlert({
        elapsedMs: 61 * MIN,
        capturedMs: 60 * MIN + 45_000,
        missedMs: 0,
        owedMs: 0,
        unsavedMs: 40_000,
      }),
    ).toEqual({
      title: UNTRANSCRIBED,
      message:
        'OpenWhispr recorded this 61 min meeting. OpenWhispr could not transcribe under 1 min of the recording.',
    });
  });

  it('stays quiet when under half a minute could not be transcribed', () => {
    expect(
      meetingCaptureAlert({
        elapsedMs: 61 * MIN,
        capturedMs: 61 * MIN,
        missedMs: 0,
        owedMs: 0,
        unsavedMs: 20_000,
      }),
    ).toBeNull();
  });

  it('keeps the plain partial alert for audio the stream dropped with no recording', () => {
    expect(
      meetingCaptureAlert({
        elapsedMs: 61 * MIN,
        capturedMs: 61 * MIN,
        missedMs: 52 * MIN,
        owedMs: 0,
        unsavedMs: 0,
      }),
    ).toEqual({
      title: PARTIAL,
      message:
        'OpenWhispr recorded 9 min of this 61 min meeting. The rest was missed while the microphone or the connection was interrupted.',
    });
  });
});

describe('meetingBarState', () => {
  const base = { phase: 'recording', path: 'local', capturing: true, cloudStatus: 'live' } as const;

  it('labels the local path by capture', () => {
    expect(meetingBarState(base)).toEqual({
      label: 'RECORDING',
      recordingAudio: true,
      showClock: true,
      showStop: true,
    });
    expect(meetingBarState({ ...base, capturing: false })).toMatchObject({
      label: 'NOT RECORDING',
      recordingAudio: false,
    });
  });

  it('uses the existing cloud status labels and recording dot', () => {
    const cloud = { ...base, phase: 'cloud-recording', path: 'cloud' } as const;
    expect(meetingBarState({ ...cloud, cloudStatus: 'reconnecting' })).toMatchObject({
      label: 'RECONNECTING',
      recordingAudio: true,
    });
    expect(meetingBarState({ ...cloud, cloudStatus: 'connecting' })).toMatchObject({
      label: 'CONNECTING',
      recordingAudio: false,
    });
    expect(
      meetingBarState({ ...cloud, cloudStatus: 'connecting', captureStarted: true }),
    ).toMatchObject({ recordingAudio: true });
    expect(meetingBarState({ ...cloud, cloudStatus: 'recording-only' })).toMatchObject({
      label: 'RECORDING ONLY',
      recordingAudio: true,
    });
    expect(meetingBarState({ ...cloud, cloudStatus: 'interrupted' }).label).toBe('NOT RECORDING');
    expect(meetingBarState({ ...cloud, cloudStatus: 'error' }).label).toBe('DISCONNECTED');
  });

  it('has no clock or Stop while processing', () => {
    expect(meetingBarState({ ...base, phase: 'processing' })).toEqual({
      label: 'FINISHING…',
      recordingAudio: false,
      showClock: false,
      showStop: false,
    });
  });
});

describe('formatClock', () => {
  it('formats mm:ss and h:mm:ss', () => {
    expect(formatClock(65)).toBe('01:05');
    expect(formatClock(3599)).toBe('59:59');
    expect(formatClock(3600)).toBe('1:00:00');
    expect(formatClock(3725)).toBe('1:02:05');
  });
});

const codedError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

describe('meetingStartFailureFrom', () => {
  it('keeps the native code and the message', () => {
    expect(
      meetingStartFailureFrom(codedError('MIC_UNAVAILABLE', 'Session activation failed')),
    ).toEqual({ code: 'MIC_UNAVAILABLE', message: 'Session activation failed' });
  });

  it('has no code for an error without one, or a code that is not a string', () => {
    expect(meetingStartFailureFrom(new Error('Token request failed'))).toEqual({
      code: null,
      message: 'Token request failed',
    });
    expect(meetingStartFailureFrom(Object.assign(new Error('x'), { code: 7 }))).toEqual({
      code: null,
      message: 'x',
    });
  });

  it('reads a thrown non-error as its text', () => {
    expect(meetingStartFailureFrom('lease refused')).toEqual({
      code: null,
      message: 'lease refused',
    });
  });
});

describe('meetingStartFailureNotice', () => {
  const CALL_MESSAGE = "Can't record during a call. End the call, then try again.";

  it('says a call holds the microphone when the session refused to activate', () => {
    expect(
      meetingStartFailureNotice({ code: 'MIC_UNAVAILABLE', message: 'Session activation failed' }),
    ).toEqual({ kind: 'message', message: CALL_MESSAGE });
  });

  it('reads an older build that only reports the activation failure as a call too', () => {
    expect(
      meetingStartFailureNotice({
        code: 'PCM_START_FAILED',
        message: 'The operation couldn’t be completed. Session activation failed',
      }),
    ).toEqual({ kind: 'message', message: CALL_MESSAGE });
  });

  it('shows the microphone access alert when permission was denied', () => {
    expect(
      meetingStartFailureNotice({
        code: 'MIC_PERMISSION_DENIED',
        message: 'Microphone permission was not granted',
      }),
    ).toEqual({ kind: 'mic-permission' });
  });

  it('gives the reason for any other failure', () => {
    expect(
      meetingStartFailureNotice({
        code: 'PCM_START_FAILED',
        message: 'Microphone input format is unavailable',
      }),
    ).toEqual({
      kind: 'message',
      message: "Couldn't start recording. Microphone input format is unavailable.",
    });
    expect(meetingStartFailureNotice({ code: null, message: 'Token refused.' })).toEqual({
      kind: 'message',
      message: "Couldn't start recording. Token refused.",
    });
  });

  it('says only that recording did not start when there is no reason', () => {
    expect(meetingStartFailureNotice({ code: null, message: '  ' })).toEqual({
      kind: 'message',
      message: "Couldn't start recording.",
    });
  });
});
