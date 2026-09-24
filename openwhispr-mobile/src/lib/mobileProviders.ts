import {
  getProvidersForScope,
  resolveInferenceRoute,
  type InferenceScope,
  type ProviderDefinition,
  type RouteResolution,
} from '@shared/ai/routing';

// The iOS-first release ships the single OpenAI-compatible transport. Other
// catalog providers need their own adapters and device verification first.
export const MOBILE_PROVIDER_IDS: readonly string[] = ['openai', 'groq', 'openrouter', 'custom'];

export type MobileInferenceScope = Exclude<InferenceScope, 'meeting'>;

export function getMobileProvidersForScope(scope: MobileInferenceScope): ProviderDefinition[] {
  return getProvidersForScope(scope).filter((provider) =>
    MOBILE_PROVIDER_IDS.includes(provider.id),
  );
}

// Names a provider the way the settings screens do.
export function providerDisplayName(providerId: string): string {
  if (providerId === 'custom') return 'Custom server';
  return (
    getMobileProvidersForScope('cleanup').find((provider) => provider.id === providerId)?.name ??
    providerId
  );
}

export function resolveMobileInferenceRoute(
  input: Parameters<typeof resolveInferenceRoute>[0],
): RouteResolution {
  const { selection } = input;
  if (selection.mode === 'providers' && !MOBILE_PROVIDER_IDS.includes(selection.providerId ?? '')) {
    return { ok: false, code: 'PROVIDER_UNSUPPORTED' };
  }
  return resolveInferenceRoute(input);
}
