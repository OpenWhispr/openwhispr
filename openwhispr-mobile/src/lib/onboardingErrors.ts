import { Sentry } from '@/lib/sentry';

/** A failure whose message is written for the user, such as Cloud needing an account. */
export class OnboardingError extends Error {}

// Anything else is a native or storage failure whose message would read as noise on screen,
// so the user gets the step's fallback and the error goes to Sentry.
export function describeOnboardingError(cause: unknown, fallback: string): string {
  if (cause instanceof OnboardingError) return cause.message;
  Sentry.captureException(cause);
  return fallback;
}
