import { Sentry } from '@/lib/sentry';
import { AppGroupStorage } from '../../modules/app-group-storage/src';

export type CaptureLeaseOwner = 'meeting-cloud' | 'meeting-local';

// Every meeting capture acquires and releases through this file, once each, so this is what is
// recording right now. The release follows the native stop, or a failed start. The local
// recorder's hook also releases on unmount, possibly with the recorder still running; that is
// harmless only because its provider sits at the app root and unmounts with the app.
const heldOwners = new Set<CaptureLeaseOwner>();

/** True while a meeting capture holds the lease. */
export function isCaptureLeaseHeld(): boolean {
  return heldOwners.size > 0;
}

/** Never rejects: a failed acquire is reported to Sentry and capture goes ahead. */
export async function acquireCaptureLease(owner: CaptureLeaseOwner): Promise<void> {
  try {
    await AppGroupStorage.acquireCaptureLease(owner);
    heldOwners.add(owner);
  } catch (error) {
    // A meeting must still record if the keyboard's warm mic can't be parked.
    Sentry.captureException(error, { tags: { feature: 'meeting-capture-lease' } });
  }
}

/** Idempotent. Call only after the capture has fully stopped. */
export function releaseCaptureLease(owner: CaptureLeaseOwner): void {
  heldOwners.delete(owner);
  try {
    AppGroupStorage.releaseCaptureLease(owner);
  } catch (error) {
    // Release runs in teardown paths that must finish; a native failure is reported, not thrown.
    Sentry.captureException(error, { tags: { feature: 'meeting-capture-lease' } });
  }
}
