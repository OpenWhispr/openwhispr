import { Sentry } from '@/lib/sentry';

type GoogleCalendarTelemetryTags = Record<string, string | number | boolean | null | undefined>;

const compactTags = (tags: GoogleCalendarTelemetryTags): GoogleCalendarTelemetryTags =>
  Object.fromEntries(Object.entries(tags).filter(([, value]) => value != null));

export function captureGoogleCalendarException(
  error: unknown,
  operation: string,
  tags: GoogleCalendarTelemetryTags = {},
): void {
  Sentry.captureException(error, {
    tags: compactTags({
      feature: 'google-calendar',
      google_calendar_operation: operation,
      ...tags,
    }),
  });
}

export function addGoogleCalendarBreadcrumb(
  message: string,
  data: Record<string, string | number | boolean | null | undefined> = {},
): void {
  Sentry.addBreadcrumb({
    category: 'google-calendar',
    level: 'info',
    message,
    data: compactTags(data),
  });
}
