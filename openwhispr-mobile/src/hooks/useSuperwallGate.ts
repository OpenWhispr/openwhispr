import { createContext, useContext } from 'react';
import type { AffiliateOffer } from '@/lib/affiliateOffer';
import type { PaywallState } from 'expo-superwall';
import {
  isTransactionalSuperwallPlacement,
  type SuperwallAttributes,
  type SuperwallPlacement,
} from '@/lib/superwall';

export type SuperwallPurchaseCompletion = 'purchased' | 'restored';

export type RegisterSuperwallGateOptions = {
  placement: SuperwallPlacement;
  /** Verified app-owned offer from an explicit Account submission; never sent to Superwall. */
  creatorOffer?: AffiliateOffer;
  params?: Partial<SuperwallAttributes> & Record<string, unknown>;
  feature?: () => void;
  onAccessGrantedWithoutPurchase?: () => void;
  onPurchaseComplete?: (completion: SuperwallPurchaseCompletion) => void;
  requiresAccount?: boolean;
  /** Cancels the optional onboarding offer when its screen is left. */
  signal?: AbortSignal;
};

type SuperwallGateContextValue = {
  register: (options: RegisterSuperwallGateOptions) => Promise<boolean>;
  state: PaywallState;
  /** False until the SDK's configure round trip completes; true when Superwall is off in this build. */
  isConfigured: boolean;
};

// Default mirrors DisabledSuperwallGateProvider's fail-open semantics so a
// screen rendered without a provider (tests) never swallows a pass-through
// feature; transactional placements still fail closed.
export const SuperwallGateContext = createContext<SuperwallGateContextValue>({
  register: async ({ placement, feature, onAccessGrantedWithoutPurchase, requiresAccount }) => {
    if (requiresAccount ?? isTransactionalSuperwallPlacement(placement)) return false;
    feature?.();
    onAccessGrantedWithoutPurchase?.();
    return true;
  },
  state: { status: 'idle' },
  isConfigured: true,
});

export function useSuperwallGate(): SuperwallGateContextValue {
  return useContext(SuperwallGateContext);
}
