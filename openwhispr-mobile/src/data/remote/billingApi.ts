import { api } from '@/lib/apiClient';
import type { UsageInfo } from '@/data/remote/usageApi';

type StripeSessionResponse = {
  url: string;
  provider: 'stripe';
};

function isStripeSessionResponse(response: unknown): response is StripeSessionResponse {
  return (
    response !== null &&
    typeof response === 'object' &&
    'url' in response &&
    typeof response.url === 'string' &&
    response.url.trim().length > 0 &&
    'provider' in response &&
    response.provider === 'stripe'
  );
}

export async function createStripeBillingPortalSession(): Promise<string> {
  const response = await api.post<unknown>('/api/stripe/portal');
  if (!isStripeSessionResponse(response)) {
    throw new Error('Invalid Stripe billing portal response');
  }
  return response.url;
}

export async function reconcileMobileBilling(platform: 'ios' | 'android'): Promise<UsageInfo> {
  return api.post<UsageInfo>('/api/billing/reconcile', { platform });
}
