import { useSyncExternalStore } from "react";
import type { ManagedEnterpriseLocalModelSelection } from "../types/enterpriseIdentity";
import { useEnterpriseIdentityStore } from "../stores/enterpriseIdentityStore";
import {
  isCurrentManagedLocalModelBinding,
  getManagedLocalModelBindingSnapshot,
  managedLocalModelCategory,
  readManagedLocalModelBinding,
  subscribeManagedLocalModelBindings,
  type ManagedLocalModelCategory,
} from "../components/onboarding/managedLocalModels";

export function useManagedLocalModelSelection(
  category: ManagedLocalModelCategory
): ManagedEnterpriseLocalModelSelection | null | undefined {
  useSyncExternalStore(
    subscribeManagedLocalModelBindings,
    getManagedLocalModelBindingSnapshot,
    getManagedLocalModelBindingSnapshot
  );
  const accountId = useEnterpriseIdentityStore((state) => state.accountId);
  const workspaceId = useEnterpriseIdentityStore((state) => state.workspaceId);
  const authGeneration = useEnterpriseIdentityStore((state) => state.authGeneration);
  const status = useEnterpriseIdentityStore((state) => state.status);
  const config = useEnterpriseIdentityStore((state) => state.config);
  if (
    status !== "ready" ||
    !accountId ||
    !workspaceId ||
    authGeneration == null ||
    !config?.localModels
  ) {
    return undefined;
  }
  const identity = {
    accountId,
    workspaceId,
    authGeneration,
    configGeneration: config.generation,
  };
  const approved = config.localModels.selections.filter(
    (selection) => managedLocalModelCategory(selection) === category
  );
  if (approved.length === 0) return undefined;
  const binding = readManagedLocalModelBinding(identity, category);
  if (!isCurrentManagedLocalModelBinding(binding, identity, category, approved)) return null;
  return { provider: binding.provider, model: binding.model };
}
