import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';

export interface BillingIdentity {
  userId: string;
  sessionCookie: string;
  billingUserId: string;
}

export function getBillingIdentity(): BillingIdentity | null {
  const { user, sessionCookie } = useAuthStore.getState();
  const billingUserId = useUsageStore.getState().usage?.billingUserId;
  return user && sessionCookie && billingUserId
    ? { userId: user.id, sessionCookie, billingUserId }
    : null;
}

export function isBillingIdentityCurrent(identity: BillingIdentity): boolean {
  const current = getBillingIdentity();
  return (
    current?.userId === identity.userId &&
    current.sessionCookie === identity.sessionCookie &&
    current.billingUserId === identity.billingUserId
  );
}
