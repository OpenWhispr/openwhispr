import 'expo-sqlite/localStorage/install';
import type { InferencePolicy, ScopePolicy } from '@/lib/mobileProviders';
import { api, BASE_URL } from '@/lib/apiClient';
import { useAuthStore } from '@/store/useAuthStore';

interface PolicyShape {
  version: 1;
  transcription: ScopePolicy;
  llm: ScopePolicy;
  features: { agentEnabled: boolean };
}
interface PolicyData {
  managed: boolean;
  policy: PolicyShape | null;
  policyUpdatedAt: string | null;
}
interface PolicyCache {
  data: PolicyData | null;
  requiresManagedPolicy: boolean;
}
type AuthState = ReturnType<typeof useAuthStore.getState>;
interface PolicyIdentity {
  accountId: string;
  user: AuthState['user'];
  sessionCookie: string | null;
}
interface InFlightPolicy {
  identity: PolicyIdentity;
  promise: Promise<InferencePolicy>;
}

const POLICY_MODES = new Set(['openwhispr', 'providers', 'local', 'self-hosted', 'enterprise']);
const snapshots = new Map<string, PolicyCache>();
const inFlight = new Map<string, InFlightPolicy>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScope(value: unknown): ScopePolicy | null {
  if (!isRecord(value)) return null;
  const { allowedModes, allowedByokProviders } = value;
  if (
    !Array.isArray(allowedModes) ||
    !allowedModes.every(
      (mode: unknown): mode is string => typeof mode === 'string' && POLICY_MODES.has(mode),
    ) ||
    !Array.isArray(allowedByokProviders) ||
    !allowedByokProviders.every(
      (provider: unknown): provider is string =>
        typeof provider === 'string' && provider.length > 0,
    )
  )
    return null;
  return { allowedModes: [...allowedModes], allowedByokProviders: [...allowedByokProviders] };
}

function parsePolicy(value: unknown): PolicyShape | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.features)) return null;
  const transcription = parseScope(value.transcription);
  const llm = parseScope(value.llm);
  if (!transcription || !llm || typeof value.features.agentEnabled !== 'boolean') return null;
  return {
    version: 1,
    transcription,
    llm,
    features: { agentEnabled: value.features.agentEnabled },
  };
}

function parsePolicyData(value: unknown): PolicyData | null {
  if (!isRecord(value) || typeof value.managed !== 'boolean') return null;
  const policy = value.policy == null ? null : parsePolicy(value.policy);
  if (value.managed) {
    if (
      !policy ||
      typeof value.policyUpdatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.policyUpdatedAt))
    )
      return null;
    return { managed: true, policy, policyUpdatedAt: value.policyUpdatedAt };
  }
  if ((value.policy != null && !policy) || value.policyUpdatedAt != null) return null;
  return { managed: false, policy, policyUpdatedAt: null };
}

function getApiOrigin(): string {
  return new URL(BASE_URL).origin;
}

function cacheKey(accountId: string): string {
  return `openwhispr.provider-policy.v1.${encodeURIComponent(getApiOrigin())}.${encodeURIComponent(accountId)}`;
}

function readCache(accountId: string): PolicyCache {
  const existing = snapshots.get(accountId);
  if (existing) return existing;
  try {
    const raw = localStorage.getItem(cacheKey(accountId));
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      parsed.accountId === accountId &&
      parsed.apiOrigin === getApiOrigin() &&
      typeof parsed.requiresManagedPolicy === 'boolean'
    ) {
      const data = parsePolicyData(parsed.data);
      if (data || parsed.requiresManagedPolicy) {
        const cached = { data, requiresManagedPolicy: parsed.requiresManagedPolicy };
        snapshots.set(accountId, cached);
        return cached;
      }
    }
  } catch {
    // An unreadable cache never grants permission; a verified network response can still resolve it.
  }
  return { data: null, requiresManagedPolicy: false };
}

function writeCache(accountId: string, cached: PolicyCache): void {
  snapshots.set(accountId, cached);
  try {
    localStorage.setItem(
      cacheKey(accountId),
      JSON.stringify({
        version: 1,
        accountId,
        apiOrigin: getApiOrigin(),
        ...cached,
      }),
    );
  } catch {
    // Keep the verified session snapshot if device persistence is unavailable.
  }
}

function identityIsCurrent(identity: PolicyIdentity): boolean {
  const current = useAuthStore.getState();
  return (
    !current.isGuest &&
    current.user === identity.user &&
    current.user?.id === identity.accountId &&
    current.sessionCookie === identity.sessionCookie
  );
}

function toInferencePolicy(data: PolicyData): InferencePolicy {
  if (!data.managed) return { status: 'unmanaged' };
  if (!data.policy) return { status: 'pending' };
  return {
    status: 'managed',
    transcription: data.policy.transcription,
    llm: data.policy.llm,
    agentEnabled: data.policy.features.agentEnabled,
  };
}

function fallbackPolicy(accountId: string): InferencePolicy {
  const cached = readCache(accountId);
  if (!cached.data || (cached.requiresManagedPolicy && !cached.data.managed))
    return { status: 'pending' };
  return toInferencePolicy(cached.data);
}

function markManagedPolicyRequired(accountId: string): void {
  const cached = readCache(accountId);
  if (!cached.data?.managed) writeCache(accountId, { ...cached, requiresManagedPolicy: true });
}

async function fetchPolicy(identity: PolicyIdentity): Promise<InferencePolicy> {
  const controller = new AbortController();
  const timeout = setTimeout((): void => controller.abort(), 10_000);
  try {
    const response = await api.get<unknown>('/api/workspace-policy', {
      headers: { 'x-openwhispr-policy-version': '1' },
      signal: controller.signal,
    });
    if (!identityIsCurrent(identity)) return { status: 'pending' };
    const rawData = isRecord(response) ? response.data : null;
    const data = parsePolicyData(rawData);
    if (!data) {
      if (isRecord(rawData) && rawData.managed === true)
        markManagedPolicyRequired(identity.accountId);
      return fallbackPolicy(identity.accountId);
    }
    const current = readCache(identity.accountId).data;
    // Match desktop: last-good managed policies do not expire during an outage, and
    // a lagging server replica cannot roll a policy back to an older revision.
    if (
      current?.managed &&
      data.managed &&
      current.policyUpdatedAt &&
      data.policyUpdatedAt &&
      Date.parse(data.policyUpdatedAt) < Date.parse(current.policyUpdatedAt)
    ) {
      return toInferencePolicy(current);
    }
    writeCache(identity.accountId, { data, requiresManagedPolicy: false });
    return toInferencePolicy(data);
  } catch (error: unknown) {
    if (!identityIsCurrent(identity)) return { status: 'pending' };
    if (isRecord(error) && error.code === 'POLICY_UNRESOLVABLE')
      markManagedPolicyRequired(identity.accountId);
    return fallbackPolicy(identity.accountId);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getProviderPolicy(): Promise<InferencePolicy> {
  const current = useAuthStore.getState();
  if (current.isGuest || !current.user) return { status: 'unmanaged' };
  const identity: PolicyIdentity = {
    accountId: current.user.id,
    user: current.user,
    sessionCookie: current.sessionCookie,
  };
  const pending = inFlight.get(identity.accountId);
  if (
    pending &&
    pending.identity.user === identity.user &&
    pending.identity.sessionCookie === identity.sessionCookie
  )
    return pending.promise;
  const promise = fetchPolicy(identity).finally((): void => {
    if (inFlight.get(identity.accountId)?.promise === promise) inFlight.delete(identity.accountId);
  });
  inFlight.set(identity.accountId, { identity, promise });
  return promise;
}
