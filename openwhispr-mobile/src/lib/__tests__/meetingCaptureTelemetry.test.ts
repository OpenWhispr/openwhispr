import { Sentry } from '@/lib/sentry';
import {
  reportCaptureInterrupted,
  reportMeetingFinished,
  reportSessionEnded,
} from '@/lib/meetingCaptureTelemetry';
import type { CaptureCoverage } from '@/lib/notes/meetingCapture';

jest.mock('@/lib/sentry', () => ({
  Sentry: { captureMessage: jest.fn(), addBreadcrumb: jest.fn(), captureException: jest.fn() },
}));

const captureMessage = Sentry.captureMessage as jest.Mock;
const addBreadcrumb = Sentry.addBreadcrumb as jest.Mock;

const complete: CaptureCoverage = {
  recordedSeconds: 600,
  elapsedSeconds: 600,
  missingSeconds: 0,
  isPartial: false,
};
const partial: CaptureCoverage = {
  recordedSeconds: 500,
  elapsedSeconds: 600,
  missingSeconds: 100,
  isPartial: true,
};
const finished = (coverage: CaptureCoverage): Parameters<typeof reportMeetingFinished>[0] => ({
  path: 'cloud',
  coverage,
  interruptions: 2,
  reconnects: 1,
  droppedSeconds: 4,
});

const allNumbers = (record: Record<string, unknown>): boolean =>
  Object.values(record).every((value) => typeof value === 'number');

beforeEach(() => jest.clearAllMocks());

describe('meetingCaptureTelemetry', () => {
  it('reports an interruption with its reason and no free text', () => {
    reportCaptureInterrupted({ path: 'cloud', reason: 'stalled', capturedSeconds: 42 });
    expect(captureMessage).toHaveBeenCalledWith(
      'meeting_capture_interrupted',
      expect.objectContaining({
        tags: { feature: 'meeting-capture', path: 'cloud', reason: 'stalled' },
        extra: { capturedSeconds: 42 },
      }),
    );
  });

  it('reports an ended session with its reason', () => {
    reportSessionEnded({ path: 'cloud', reason: 'error', capturedSeconds: 7 });
    expect(captureMessage).toHaveBeenCalledWith(
      'meeting_session_ended',
      expect.objectContaining({
        tags: { feature: 'meeting-capture', path: 'cloud', reason: 'error' },
        extra: { capturedSeconds: 7 },
      }),
    );
  });

  it('reports a partial meeting as a warning', () => {
    reportMeetingFinished(finished(partial));
    expect(captureMessage).toHaveBeenCalledWith(
      'meeting_capture_partial',
      expect.objectContaining({
        level: 'warning',
        tags: { feature: 'meeting-capture', path: 'cloud' },
        extra: {
          recordedSeconds: 500,
          elapsedSeconds: 600,
          missingSeconds: 100,
          interruptions: 2,
          reconnects: 1,
          droppedSeconds: 4,
        },
      }),
    );
  });

  it('only leaves a breadcrumb for a complete meeting', () => {
    reportMeetingFinished(finished(complete));
    expect(captureMessage).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
  });

  it('never includes text fields', () => {
    reportCaptureInterrupted({ path: 'local', reason: 'interrupted', capturedSeconds: 1 });
    reportSessionEnded({ path: 'cloud', reason: 'token_refused', capturedSeconds: 1 });
    reportMeetingFinished(finished(partial));
    reportMeetingFinished(finished(complete));
    for (const [, options] of captureMessage.mock.calls) {
      expect(allNumbers(options.extra)).toBe(true);
    }
    expect(allNumbers(addBreadcrumb.mock.calls[0][0].data)).toBe(true);
  });

  it('never throws into the recording flow', () => {
    captureMessage.mockImplementationOnce(() => {
      throw new Error('sentry down');
    });
    expect(() =>
      reportCaptureInterrupted({ path: 'cloud', reason: 'stalled', capturedSeconds: 1 }),
    ).not.toThrow();
  });
});
