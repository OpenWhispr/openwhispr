import { useUsageLimitRecoveryCore } from '@/android/hooks/useUsageLimitRecoveryCore';

export function useUsageLimitRecovery() {
  return useUsageLimitRecoveryCore('Turn on Local Mode');
}
