import { Sentry } from '@/lib/sentry';
import { AppGroupStorage } from '../../modules/app-group-storage/src';

export type CaptureLeaseOwner = 'meeting-cloud' | 'meeting-local';

/** Never rejects: a failed acquire is reported to Sentry and capture goes ahead. */
export async function acquireCaptureLease(owner: CaptureLeaseOwner): Promise<void> {
  try {
    await AppGroupStorage.acquireCaptureLease(owner);
  } catch (error) {
    // A meeting must still record if the keyboard's warm mic can't be parked.
    Sentry.captureException(error, { tags: { feature: 'meeting-capture-lease' } });
  }
}

/** Idempotent. Call only after the capture has fully stopped. */
export function releaseCaptureLease(owner: CaptureLeaseOwner): void {
  AppGroupStorage.releaseCaptureLease(owner);
}
