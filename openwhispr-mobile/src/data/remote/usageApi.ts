import { api } from '@/lib/apiClient';

export interface UsageInfo {
  billingUserId: string;
  wordsUsed: number;
  wordsRemaining: number;
  limit: number;
  plan: string;
  status: string;
  isSubscribed: boolean;
  isTrial: boolean;
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
  billingInterval: 'monthly' | 'annual' | null;
  resetAt: string;
  entitlementSources?: {
    personal: boolean;
    provider: boolean;
    workspaceIds: string[];
  };
}

export async function fetchUsage(): Promise<UsageInfo> {
  return api.get<UsageInfo>('/api/usage');
}
