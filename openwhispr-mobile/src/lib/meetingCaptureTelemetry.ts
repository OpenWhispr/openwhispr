import { Sentry } from '@/lib/sentry';
import type { CaptureCoverage } from '@/lib/notes/meetingCapture';

export type MeetingPath = 'cloud' | 'local';

const FEATURE = 'meeting-capture';

// Counts, durations and reason codes only: no transcript, title, error text or path may reach
// Sentry, and a telemetry failure must never break a recording.
function safely(report: () => void): void {
  try {
    report();
  } catch {
    // Reporting is best effort.
  }
}

export function reportCaptureInterrupted(input: {
  path: MeetingPath;
  reason: string;
  capturedSeconds: number;
}): void {
  safely(() =>
    Sentry.captureMessage('meeting_capture_interrupted', {
      level: 'warning',
      tags: { feature: FEATURE, path: input.path, reason: input.reason },
      extra: { capturedSeconds: input.capturedSeconds },
    }),
  );
}

export function reportSessionEnded(input: {
  path: 'cloud';
  reason: 'token_refused' | 'error';
  capturedSeconds: number;
}): void {
  safely(() =>
    Sentry.captureMessage('meeting_session_ended', {
      level: 'error',
      tags: { feature: FEATURE, path: input.path, reason: input.reason },
      extra: { capturedSeconds: input.capturedSeconds },
    }),
  );
}

export function reportMeetingFinished(input: {
  path: MeetingPath;
  coverage: CaptureCoverage;
  interruptions: number;
  reconnects: number;
  droppedSeconds: number;
}): void {
  const { coverage } = input;
  const numbers = {
    recordedSeconds: coverage.recordedSeconds,
    elapsedSeconds: coverage.elapsedSeconds,
    missingSeconds: coverage.missingSeconds,
    interruptions: input.interruptions,
    reconnects: input.reconnects,
    droppedSeconds: input.droppedSeconds,
  };
  safely(() => {
    if (coverage.isPartial) {
      Sentry.captureMessage('meeting_capture_partial', {
        level: 'warning',
        tags: { feature: FEATURE, path: input.path },
        extra: numbers,
      });
      return;
    }
    // A complete meeting is the normal case: context for a later error, not an event.
    Sentry.addBreadcrumb({
      category: FEATURE,
      message: 'meeting_capture_complete',
      level: 'info',
      data: numbers,
    });
  });
}
