import { useEffect, useState } from "react";
import {
  holdManagedLocalModelLock,
  type ManagedLocalModelIdentity,
} from "../components/onboarding/managedLocalModels";
import {
  selectManagedLocalModelContext,
  useEnterpriseIdentityStore,
} from "../stores/enterpriseIdentityStore";

export function useManagedLocalModelIdentity(): ManagedLocalModelIdentity | null {
  return useEnterpriseIdentityStore(
    (state) => selectManagedLocalModelContext(state)?.identity ?? null
  );
}

export function useManagedLocalModelLock(
  eligible: boolean,
  reconcile: () => Promise<void>,
  onReconcileError?: (error: unknown) => void
): boolean {
  const [ownsLock, setOwnsLock] = useState(false);

  useEffect(() => {
    if (!eligible) {
      setOwnsLock(false);
      return;
    }
    let mounted = true;
    const lifetime = holdManagedLocalModelLock({
      onOwnershipChange: (ownsLock) => {
        if (mounted) setOwnsLock(ownsLock);
      },
      onReconcileError,
      reconcile,
    });
    return () => {
      mounted = false;
      lifetime.release();
    };
  }, [eligible, onReconcileError, reconcile]);

  return ownsLock;
}
