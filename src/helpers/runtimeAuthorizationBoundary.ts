import type { ManagedEnterpriseLocalModelSelection } from "../types/enterpriseIdentity";
import type { PolicyState } from "../stores/policyStore";
import { usePolicyStore } from "../stores/policyStore";
import {
  getManagedLocalModelRuntimeLock,
  useEnterpriseIdentityStore,
} from "../stores/enterpriseIdentityStore";
import { isPolicyActionAllowed } from "../stores/policyRules";
import { MANAGED_LOCAL_MODEL_BINDINGS_KEY } from "../components/onboarding/managedLocalModels";

export type RuntimeAuthorizationDomain = "reasoning" | "transcription";

export interface RuntimeAuthorizationSnapshot {
  identity: {
    accountId: string | null;
    workspaceId: string | null;
    authGeneration: number | null;
    configGeneration: number | null;
  };
  managedLock: {
    managed: boolean;
    selection: ManagedEnterpriseLocalModelSelection | null;
  };
  policy: Pick<PolicyState, "accountId" | "authGeneration" | "status" | "policy" | "appVersion">;
}

export interface RuntimeAuthorizationGuard {
  readonly domains: readonly RuntimeAuthorizationDomain[];
  isCurrent(): boolean;
  assertCurrent(): void;
}

export interface RuntimeAuthorizationLease extends RuntimeAuthorizationGuard {
  dispose(): void;
}

export class RuntimeAuthorizationBoundaryError extends Error {
  readonly code = "AUTHORIZATION_BOUNDARY_CHANGED";
  readonly status = 499;

  constructor() {
    super("Authorization changed while the operation was active");
    this.name = "AbortError";
  }
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

function normalizePolicy(
  domain: RuntimeAuthorizationDomain,
  state: RuntimeAuthorizationSnapshot["policy"]
): unknown {
  const shared = {
    accountId: state.accountId,
    authGeneration: state.authGeneration,
    status: state.status,
    actionAllowed: isPolicyActionAllowed(state),
  };
  if (state.status !== "managed" || !state.policy) return shared;

  if (domain === "transcription") {
    return {
      ...shared,
      allowedModes: sorted(state.policy.transcription.allowedModes),
      allowedByokProviders: sorted(state.policy.transcription.allowedByokProviders),
    };
  }

  return {
    ...shared,
    allowedModes: sorted(state.policy.llm.allowedModes),
    allowedByokProviders: sorted(state.policy.llm.allowedByokProviders),
    allowedEnterpriseProviders: sorted(state.policy.llm.allowedEnterpriseProviders),
    agentEnabled: state.policy.features.agentEnabled,
    webSearchEnabled: state.policy.features.webSearchEnabled,
    screenContextEnabled: state.policy.features.screenContextEnabled !== false,
  };
}

export function buildRuntimeAuthorizationSignature(
  domain: RuntimeAuthorizationDomain,
  snapshot: RuntimeAuthorizationSnapshot
): string {
  return JSON.stringify({
    domain,
    identity: snapshot.identity,
    managedLock: {
      managed: snapshot.managedLock.managed,
      provider: snapshot.managedLock.selection?.provider ?? null,
      modelId: snapshot.managedLock.selection?.modelId ?? null,
    },
    policy: normalizePolicy(domain, snapshot.policy),
  });
}

export function getRuntimeAuthorizationSignature(domain: RuntimeAuthorizationDomain): string {
  const enterprise = useEnterpriseIdentityStore.getState();
  const policy = usePolicyStore.getState();
  return buildRuntimeAuthorizationSignature(domain, {
    identity: {
      accountId: enterprise.accountId,
      workspaceId: enterprise.workspaceId,
      authGeneration: enterprise.authGeneration,
      configGeneration: enterprise.config?.generation ?? null,
    },
    managedLock: getManagedLocalModelRuntimeLock(domain),
    policy,
  });
}

function normalizeDomains(
  domains: RuntimeAuthorizationDomain | readonly RuntimeAuthorizationDomain[]
): RuntimeAuthorizationDomain[] {
  return (Array.isArray(domains) ? [...domains] : [domains]).sort();
}

function currentSignature(domains: readonly RuntimeAuthorizationDomain[]): string {
  return domains.map(getRuntimeAuthorizationSignature).join("\n");
}

export function captureRuntimeAuthorizationGuard(
  domains: RuntimeAuthorizationDomain | readonly RuntimeAuthorizationDomain[]
): RuntimeAuthorizationGuard {
  const normalizedDomains = normalizeDomains(domains);
  const signature = currentSignature(normalizedDomains);
  return {
    domains: normalizedDomains,
    isCurrent: () => currentSignature(normalizedDomains) === signature,
    assertCurrent: () => {
      if (currentSignature(normalizedDomains) !== signature) {
        throw new RuntimeAuthorizationBoundaryError();
      }
    },
  };
}

export function subscribeRuntimeAuthorizationBoundary(
  domains: RuntimeAuthorizationDomain | readonly RuntimeAuthorizationDomain[],
  onChanged: () => void
): () => void {
  const normalizedDomains = normalizeDomains(domains);
  let signature = currentSignature(normalizedDomains);
  const check = (): void => {
    const nextSignature = currentSignature(normalizedDomains);
    if (nextSignature === signature) return;
    signature = nextSignature;
    onChanged();
  };
  const unsubscribeEnterprise = useEnterpriseIdentityStore.subscribe(check);
  const unsubscribePolicy = usePolicyStore.subscribe(check);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === MANAGED_LOCAL_MODEL_BINDINGS_KEY) check();
  };
  const eventTarget = typeof window === "undefined" ? null : window;
  eventTarget?.addEventListener("openwhispr-managed-local-model-binding", check);
  eventTarget?.addEventListener("storage", onStorage);
  return () => {
    unsubscribeEnterprise();
    unsubscribePolicy();
    eventTarget?.removeEventListener("openwhispr-managed-local-model-binding", check);
    eventTarget?.removeEventListener("storage", onStorage);
  };
}

export function captureRuntimeAuthorizationLease(
  domains: RuntimeAuthorizationDomain | readonly RuntimeAuthorizationDomain[],
  onChanged: () => void
): RuntimeAuthorizationLease {
  const guard = captureRuntimeAuthorizationGuard(domains);
  let invalidated = false;
  const unsubscribe = subscribeRuntimeAuthorizationBoundary(domains, () => {
    if (invalidated) return;
    invalidated = true;
    onChanged();
  });
  const isCurrent = (): boolean => !invalidated && guard.isCurrent();
  return {
    domains: guard.domains,
    isCurrent,
    assertCurrent: () => {
      if (!isCurrent()) throw new RuntimeAuthorizationBoundaryError();
    },
    dispose: unsubscribe,
  };
}
