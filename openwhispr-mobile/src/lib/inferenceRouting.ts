import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import {
  type InferenceScope,
  type InferenceSelection,
  type InferenceRoute,
  type RouteErrorCode,
  resolveMobileInferenceRoute,
} from '@/lib/mobileProviders';
import type { TranscriptionProvider, TranscriptionRequest, TextInferenceSnapshot } from '@/types';

export type ProviderRoute = Extract<InferenceRoute, { mode: 'providers' }>;

export function getInferenceSelection(scope: InferenceScope): InferenceSelection | undefined {
  return useConfigStore.getState().config?.inference?.[scope];
}

export function getTranscriptionProvider(scope: InferenceScope): TranscriptionProvider {
  if (useProcessingModeStore.getState().activeMode === 'private') return 'local';
  const selection = getInferenceSelection(scope);
  if (selection?.mode === 'providers') return 'byok';
  if (selection?.mode === 'local') return 'local';
  // Bring Your Own Key mode without a dictation choice must refuse (see
  // snapshotTranscriptionJob), never quietly send the audio to Cloud. Uploads
  // without their own choice still follow Cloud.
  if (
    !selection &&
    scope === 'dictation' &&
    useProcessingModeStore.getState().activeMode === 'providers'
  )
    return 'byok';
  return 'cloud';
}

// Route refusals are configuration problems; retrying the request cannot fix them.
function routeRefusal(message: string, code?: RouteErrorCode | 'SELECTION_REQUIRED'): Error {
  return Object.assign(new Error(message), { retryable: false, code });
}

export async function resolveMobileProviderRoute(
  scope: InferenceScope,
  snapshot?: InferenceSelection,
  privateContent = false,
  allowRemoteContent = false,
): Promise<ProviderRoute> {
  const configuredSelection = snapshot ?? getInferenceSelection(scope);
  const selection = configuredSelection ? { ...configuredSelection } : undefined;
  if (!selection || selection.mode !== 'providers') {
    throw routeRefusal(
      'Choose a provider and model in AI Models before using your own key.',
      'SELECTION_REQUIRED',
    );
  }
  // Load policy only when direct provider execution is actually requested.
  const { getProviderPolicy } =
    require('@/services/providers/ProviderPolicy') as typeof import('@/services/providers/ProviderPolicy');
  const policy = await getProviderPolicy();
  const result = resolveMobileInferenceRoute({
    scope,
    selection,
    privateContent:
      !allowRemoteContent &&
      (privateContent || useProcessingModeStore.getState().activeMode === 'private'),
    policy,
  });
  if (!result.ok) {
    const messages: Record<RouteErrorCode, string> = {
      PRIVATE_CONTENT: 'Private content cannot be sent to a provider without your confirmation.',
      POLICY_UNRESOLVED: 'Organization policy is unavailable. Try again when connected.',
      POLICY_BLOCKED: 'Your organization does not allow this provider or mode.',
      PROVIDER_UNSUPPORTED: 'This provider does not support the selected workflow.',
      MODEL_UNSUPPORTED: 'Select a supported model for this provider.',
      MODEL_REQUIRED: 'Select a model in AI Models.',
      CREDENTIAL_REQUIRED: 'Add your provider credentials in AI Models.',
      ENDPOINT_INVALID: 'Use HTTPS or a private-network HTTP endpoint.',
    };
    throw routeRefusal(messages[result.code], result.code);
  }
  if (result.route.mode !== 'providers') throw routeRefusal('A provider route is required.');
  return result.route;
}

export type TranscriptionJobRoute = Pick<TranscriptionRequest, 'provider' | 'inferenceRoute'> &
  TextInferenceSnapshot;

export function snapshotTextInference(provider: TranscriptionProvider): TextInferenceSnapshot {
  const result: TextInferenceSnapshot = {};
  for (const scope of ['cleanup', 'agent'] as const) {
    const routeKey = scope === 'cleanup' ? 'cleanupRoute' : 'agentRoute';
    const errorKey = scope === 'cleanup' ? 'cleanupUnavailable' : 'agentUnavailable';
    const selection = getInferenceSelection(scope);
    if (provider === 'local') {
      result[routeKey] = { mode: 'local', scope };
    } else if (!selection && provider === 'byok') {
      result[errorKey] =
        `Choose ${scope === 'agent' ? 'a voice assistant' : 'a cleanup'} provider in AI Models. Your raw transcript is saved.`;
    } else if (selection?.mode === 'providers') {
      const resolved = resolveMobileInferenceRoute({
        scope,
        selection,
        policy: { status: 'unmanaged' },
      });
      if (resolved.ok) result[routeKey] = { ...resolved.route };
      else
        result[errorKey] =
          `Complete ${scope} provider setup in AI Models. Your raw transcript is saved.`;
    } else {
      result[routeKey] = { mode: selection?.mode ?? 'openwhispr', scope };
    }
  }
  return result;
}

export function snapshotTranscriptionJob(scope: 'dictation' | 'upload'): TranscriptionJobRoute {
  const provider = getTranscriptionProvider(scope);
  const job: TranscriptionJobRoute = { provider, ...snapshotTextInference(provider) };
  if (provider === 'byok') {
    const selection = getInferenceSelection(scope);
    if (!selection)
      throw routeRefusal('Choose a transcription provider in AI Models.', 'SELECTION_REQUIRED');
    const result = resolveMobileInferenceRoute({
      scope,
      selection,
      privateContent: false,
      policy: { status: 'unmanaged' },
    });
    if (!result.ok || result.route.mode !== 'providers')
      throw new Error('Complete provider setup in AI Models.');
    job.inferenceRoute = { ...result.route };
  }
  return job;
}
