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
import { isLocalModelKey, type LocalModelKey } from '@/lib/localModelCatalog';
import { cloudAccessFor, unsetSelection, workflowSelection } from '@/lib/aiWorkflows';
import type { CloudAccess } from '@/lib/inferenceModes';

export type ProviderRoute = Extract<InferenceRoute, { mode: 'providers' }>;

export function getInferenceSelection(scope: InferenceScope): InferenceSelection | undefined {
  return useConfigStore.getState().config?.inference?.[scope];
}

// The on-device model the user picked for a workflow; undefined means Automatic.
export function getPickedLocalModel(scope: 'dictation' | 'upload'): LocalModelKey | undefined {
  const selection = getInferenceSelection(scope);
  return selection?.mode === 'local' && isLocalModelKey(selection.modelId)
    ? selection.modelId
    : undefined;
}

// Required lazily: the auth store loads the auth client, which routing doesn't otherwise need.
function currentCloudAccess(): CloudAccess {
  const { useAuthStore } = require('@/store/useAuthStore') as typeof import('@/store/useAuthStore');
  return cloudAccessFor(useAuthStore.getState().user);
}

export function getTranscriptionProvider(scope: InferenceScope): TranscriptionProvider {
  const { activeMode } = useProcessingModeStore.getState();
  // Local Mode keeps dictation on this iPhone. Uploads run what is saved for them, or with nothing
  // saved or Cloud held automatically, OpenWhispr Cloud when there is a session (workflowSelection).
  if (activeMode === 'private' && scope !== 'upload') return 'local';
  const selection =
    activeMode === 'private'
      ? workflowSelection(
          useConfigStore.getState().config,
          'upload',
          activeMode,
          currentCloudAccess(),
        )
      : getInferenceSelection(scope);
  if (selection?.mode === 'providers') return 'byok';
  if (selection?.mode === 'local') return 'local';
  // Bring Your Own Key mode without a dictation choice must refuse (see
  // snapshotTranscriptionJob), never quietly send the audio to Cloud. Uploads
  // without their own choice still follow Cloud.
  if (!selection && scope === 'dictation' && activeMode === 'providers') return 'byok';
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

type TextScope = 'cleanup' | 'agent';

// Dictation and uploads take only the cleanup route. A keyboard recording also takes the voice
// assistant's, since the same snapshot serves a wand job.
export function snapshotTextInference(
  provider: TranscriptionProvider,
  scopes: readonly TextScope[] = ['cleanup'],
): TextInferenceSnapshot {
  const result: TextInferenceSnapshot = {};
  const { activeMode } = useProcessingModeStore.getState();
  const cloudAccess = provider === 'local' ? currentCloudAccess() : 'none';
  for (const scope of scopes) {
    const routeKey = scope === 'cleanup' ? 'cleanupRoute' : 'agentRoute';
    const errorKey = scope === 'cleanup' ? 'cleanupUnavailable' : 'agentUnavailable';
    const selection = getInferenceSelection(scope);
    // A transcript made on this iPhone leaves it for cleanup only for the mode saved for cleanup,
    // or in Local Mode with nothing saved, for OpenWhispr Cloud when the account can
    // (unsetSelection). Cloud cleaning it is a separate pass that needs a signed-in account, so
    // without one it stays here (cloudCleanupNeedsAccount).
    const localCleanup =
      scope === 'cleanup' && !selection && activeMode === 'private'
        ? unsetSelection('cleanup', activeMode, cloudAccess)
        : selection;
    const cleanupMode = localCleanup?.mode ?? 'local';
    // The voice assistant runs its own selection, wherever the spoken instruction was transcribed.
    if (
      provider === 'local' &&
      scope === 'cleanup' &&
      (cleanupMode === 'local' || (cleanupMode === 'openwhispr' && cloudAccess !== 'account'))
    ) {
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

export function snapshotTranscriptionJob(
  scope: 'dictation' | 'upload',
  textScopes?: readonly TextScope[],
): TranscriptionJobRoute {
  const provider = getTranscriptionProvider(scope);
  const job: TranscriptionJobRoute = { provider, ...snapshotTextInference(provider, textScopes) };
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
