import { useEffect, useState } from "react";
import {
  selectEffectiveManagedLocalModels,
  useEnterpriseIdentityStore,
} from "../stores/enterpriseIdentityStore";
import type { ManagedEnterpriseLocalModelSelection } from "../types/enterpriseIdentity";
import {
  MANAGED_LOCAL_MODEL_BINDINGS_KEY,
  resolveManagedLocalModelLockSnapshot,
} from "../components/onboarding/managedLocalModels";

export interface ManagedLocalModelLock {
  managed: boolean;
  selection: ManagedEnterpriseLocalModelSelection | null;
}

export function useManagedLocalModelLock(
  category: "transcription" | "reasoning"
): ManagedLocalModelLock {
  const accountId = useEnterpriseIdentityStore((state) => state.accountId);
  const workspaceId = useEnterpriseIdentityStore((state) => state.workspaceId);
  const localModels = useEnterpriseIdentityStore(selectEffectiveManagedLocalModels);
  const localModelsKnown = useEnterpriseIdentityStore((state) => state.lastKnownLocalModelsKnown);
  const failClosed = useEnterpriseIdentityStore((state) => state.failClosed);
  const [, setRevision] = useState(0);
  useEffect(() => {
    const refresh = (): void => setRevision((revision) => revision + 1);
    const refreshFromStorage = (event: StorageEvent): void => {
      if (event.key === MANAGED_LOCAL_MODEL_BINDINGS_KEY) refresh();
    };
    window.addEventListener("openwhispr-managed-local-model-binding", refresh);
    window.addEventListener("storage", refreshFromStorage);
    return () => {
      window.removeEventListener("openwhispr-managed-local-model-binding", refresh);
      window.removeEventListener("storage", refreshFromStorage);
    };
  }, []);

  return resolveManagedLocalModelLockSnapshot(
    { accountId, workspaceId, localModels, localModelsKnown, failClosed },
    category
  );
}
