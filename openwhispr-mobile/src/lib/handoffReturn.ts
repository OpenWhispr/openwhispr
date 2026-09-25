import { AppGroupStorage, type ReturnOutcome } from '../../modules/app-group-storage/src';
import { useHandoffStore } from '@/store/useHandoffStore';

/**
 * Upper bound on a return. Native always resolves (the observer wait is 2 s),
 * but a hung open completion must not strand the user on "Returning…".
 */
export const RETURN_OUTCOME_TIMEOUT_MS = 5_000;

export function applyReturnOutcome(outcome: ReturnOutcome | undefined): void {
  if (!outcome || outcome.status === 'skipped') return;
  const hostName = outcome.status === 'no_target' ? null : outcome.hostName;
  useHandoffStore.getState().setReturnState('manual', hostName);
}

export async function returnToHost(
  openHost: () => Promise<ReturnOutcome> = () => AppGroupStorage.returnToPreviousApp(),
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ReturnOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'no_target' }), RETURN_OUTCOME_TIMEOUT_MS);
  });
  try {
    applyReturnOutcome(await Promise.race([openHost(), timedOut]));
  } finally {
    clearTimeout(timer);
  }
}
