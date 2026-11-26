import { AppGroupStorage } from '@/android/shared/modules/app-group-storage/index';
import type { ProviderRecoveryJob } from '@/android/lib/keyboardInferenceRoute';

export function attachKeyboardRecoveryOwner(job: ProviderRecoveryJob, jobId: string): void {
  const originalRoute = AppGroupStorage.getItem(`keyboard_upload_route.${jobId}`);
  const historyOwner = originalRoute
    ? (JSON.parse(originalRoute) as Record<string, unknown>).historyOwner
    : undefined;
  if (typeof historyOwner === 'string') job.historyOwner = historyOwner;
}
