import {
  AppGroupStorage,
  NO_RETURN_TARGET,
  type ReturnOutcome,
} from '../../modules/app-group-storage/src';
import { useHandoffStore, type HandoffReturnState } from '@/store/useHandoffStore';

/**
 * Upper bound on a return, in case native never resolves. Native settles every
 * return within its own 4.5 s deadline (`ReturnTargetResolver.returnDeadline`),
 * and this has to outlast it with room for a busy main thread on a cold launch,
 * or the user gets the swipe screen instead of native's real outcome.
 */
export const RETURN_OUTCOME_TIMEOUT_MS = 6_000;

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
    timer = setTimeout(() => resolve(NO_RETURN_TARGET), RETURN_OUTCOME_TIMEOUT_MS);
  });
  try {
    applyReturnOutcome(await Promise.race([openHost(), timedOut]));
  } finally {
    clearTimeout(timer);
  }
}

export type HandoffView = 'no_speech' | 'transcribing' | 'returning' | 'back_to_host' | 'swipe';

export function selectHandoffView(input: {
  noSpeech: boolean;
  transcribing: boolean;
  returnState: HandoffReturnState;
  returnHostName: string | null;
}): HandoffView {
  if (input.noSpeech) return 'no_speech';
  if (input.transcribing) return 'transcribing';
  if (input.returnState === 'returning') return 'returning';
  return input.returnHostName ? 'back_to_host' : 'swipe';
}
