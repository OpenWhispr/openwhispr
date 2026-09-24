import * as SecureStore from 'expo-secure-store';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { isSecureHttpEndpoint, normalizeBaseUrl } from '@/lib/providerEndpoints';
import modelCatalog from '@/config/providerCatalog.json';

export interface ProviderCredential {
  apiKey: string;
}

export interface ProviderCredentialStatus {
  reference: string;
  isConfigured: boolean;
}

type CredentialState = 'pending' | 'active' | 'removed';
type CredentialRegistry = Record<string, CredentialState>;
type CredentialChangeListener = (reference: string | null) => void;

const REGISTRY_KEY = 'openwhispr.provider-credentials.registry.v1';
const CREDENTIAL_PREFIX = 'openwhispr.provider-credentials.v1.';
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};
// Every built-in slot a key could have been saved under. Reset deletes these
// even when the registry is unreadable, since the registry is then no guide.
const BUILT_IN_REFERENCES: readonly string[] = [
  ...new Set([
    ...modelCatalog.cloudProviders.map((provider) => provider.id),
    ...modelCatalog.transcriptionProviders.map((provider) => provider.id),
    'openrouter',
  ]),
].map((providerId) => `provider.${providerId}`);
const changeListeners = new Set<CredentialChangeListener>();
let pendingOperation: Promise<unknown> = Promise.resolve();

function validateReference(reference: string): void {
  if (!/^(provider\.[a-z][a-z0-9-]*|custom\.[a-f0-9]{64})$/.test(reference)) {
    throw new Error('Invalid credential reference');
  }
}

function serialize<T>(operation: () => Promise<T>, errorMessage: string): Promise<T> {
  const result = pendingOperation.then(operation).catch(() => {
    // Native storage errors may include their arguments; do not forward them to telemetry/UI.
    throw new Error(errorMessage);
  });
  pendingOperation = result.catch(() => undefined);
  return result;
}

function notifyCredentialChange(reference: string | null): void {
  for (const listener of changeListeners) {
    try {
      listener(reference);
    } catch {
      // A consumer must not prevent erasing credentials or other cache invalidations.
    }
  }
}

export function subscribeProviderCredentialChanges(listener: CredentialChangeListener): () => void {
  changeListeners.add(listener);
  return (): void => {
    changeListeners.delete(listener);
  };
}

async function readRegistry(): Promise<CredentialRegistry> {
  const raw = await SecureStore.getItemAsync(REGISTRY_KEY, SECURE_OPTIONS);
  if (raw === null) return {};
  // A registry we cannot trust must not lock the user out of saving or
  // resetting; entries it referenced are simply re-entered by the user.
  try {
    const parsed: unknown = JSON.parse(raw);
    const registry = objectValue(parsed);
    if (!registry) return {};
    for (const [reference, state] of Object.entries(registry)) {
      validateReference(reference);
      if (state !== 'pending' && state !== 'active' && state !== 'removed') return {};
    }
    return registry as CredentialRegistry;
  } catch {
    return {};
  }
}

async function writeRegistry(registry: CredentialRegistry): Promise<void> {
  await SecureStore.setItemAsync(REGISTRY_KEY, JSON.stringify(registry), SECURE_OPTIONS);
}

function parseCredential(value: unknown): ProviderCredential {
  const apiKey = objectValue(value)?.apiKey;
  if (typeof apiKey === 'string' && apiKey.trim()) return { apiKey: apiKey.trim() };
  throw new Error('Invalid provider credential');
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function getProviderCredentialReference(
  providerId: string,
  endpoint?: string,
): Promise<string> {
  if (providerId !== 'custom') {
    const reference = `provider.${providerId}`;
    validateReference(reference);
    return reference;
  }
  try {
    const normalized = normalizeBaseUrl(endpoint ?? '');
    const parsed = new URL(normalized);
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !isSecureHttpEndpoint(normalized)
    ) {
      throw new Error('Invalid endpoint');
    }
    const canonicalEndpoint = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    return `custom.${await digestStringAsync(CryptoDigestAlgorithm.SHA256, canonicalEndpoint)}`;
  } catch {
    throw new Error('Invalid provider endpoint');
  }
}

export async function setProviderCredential(
  reference: string,
  credential: ProviderCredential,
): Promise<void> {
  validateReference(reference);
  const validatedCredential = parseCredential(credential);
  await serialize(async (): Promise<void> => {
    const registry = await readRegistry();
    // Register before storing a secret so an interrupted write cannot orphan a Keychain item.
    registry[reference] = 'pending';
    await writeRegistry(registry);
    notifyCredentialChange(reference);
    await SecureStore.setItemAsync(
      `${CREDENTIAL_PREFIX}${reference}`,
      JSON.stringify(validatedCredential),
      SECURE_OPTIONS,
    );
    registry[reference] = 'active';
    await writeRegistry(registry);
  }, 'Unable to save provider credential');
}

export async function getProviderCredential(reference: string): Promise<ProviderCredential | null> {
  validateReference(reference);
  return serialize(async (): Promise<ProviderCredential | null> => {
    const registry = await readRegistry();
    if (registry[reference] !== 'active') return null;
    const raw = await SecureStore.getItemAsync(`${CREDENTIAL_PREFIX}${reference}`, SECURE_OPTIONS);
    return raw === null ? null : parseCredential(JSON.parse(raw));
  }, 'Unable to read provider credential');
}

export async function getProviderCredentialStatus(
  reference: string,
): Promise<ProviderCredentialStatus> {
  return { reference, isConfigured: (await getProviderCredential(reference)) !== null };
}

export async function removeProviderCredential(reference: string): Promise<void> {
  validateReference(reference);
  await serialize(async (): Promise<void> => {
    const registry = await readRegistry();
    registry[reference] = 'removed';
    await writeRegistry(registry);
    notifyCredentialChange(reference);
    await SecureStore.deleteItemAsync(`${CREDENTIAL_PREFIX}${reference}`, SECURE_OPTIONS);
    delete registry[reference];
    if (Object.keys(registry).length) await writeRegistry(registry);
    else await SecureStore.deleteItemAsync(REGISTRY_KEY, SECURE_OPTIONS);
  }, 'Unable to remove provider credential');
}

export async function clearProviderCredentials(): Promise<void> {
  await serialize(async (): Promise<void> => {
    const registry = await readRegistry();
    const references = Object.keys(registry);
    for (const reference of references) registry[reference] = 'removed';
    if (references.length) await writeRegistry(registry);
    notifyCredentialChange(null);
    const targets = [...new Set([...references, ...BUILT_IN_REFERENCES])];
    const results = await Promise.allSettled(
      targets.map((reference) =>
        SecureStore.deleteItemAsync(`${CREDENTIAL_PREFIX}${reference}`, SECURE_OPTIONS),
      ),
    );
    // Keep tombstones until every deletion succeeds so reset can be retried after an app restart.
    if (results.some((result) => result.status === 'rejected')) throw new Error('Deletion failed');
    await SecureStore.deleteItemAsync(REGISTRY_KEY, SECURE_OPTIONS);
  }, 'Unable to clear provider credentials');
}
