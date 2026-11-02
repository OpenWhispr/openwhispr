import { useCallback } from 'react';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { accountRequiredForCloud, showAccountRequiredAlert } from '@/lib/accountAccess';
import { getTranscriptionProvider } from '@/lib/inferenceRouting';
import { buildUsageGateParams, SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';

/**
 * The checks the Record tab runs before a cloud dictation: an account, then the cloud
 * transcription paywall. Anything not transcribed in the cloud runs straight away.
 */
export function useCloudTranscriptionGate(): (run: () => void) => void {
  const user = useAuthStore((s) => s.user);
  const usage = useUsageStore((s) => s.usage);
  const { register: registerSuperwallGate } = useSuperwallGate();

  return useCallback(
    (run: () => void): void => {
      // Read when the mic is pressed, as the recording reads it when it starts.
      if (getTranscriptionProvider('dictation') !== 'cloud') {
        run();
        return;
      }
      if (accountRequiredForCloud(user)) {
        showAccountRequiredAlert('recording');
        return;
      }
      registerSuperwallGate({
        placement: SUPERWALL_PLACEMENTS.cloudTranscriptionStart,
        params: usage ? buildUsageGateParams(usage) : undefined,
        requiresAccount: false,
        feature: run,
      }).catch(() => {});
    },
    [registerSuperwallGate, usage, user],
  );
}
