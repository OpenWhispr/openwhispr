import { BackgroundUploader } from '../../modules/background-uploader/src';
import { AppGroupStorage } from '../../modules/app-group-storage/src';
import { snapshotTranscriptionJob, type TranscriptionJobRoute } from './inferenceRouting';
import type { InferenceSelection } from '@shared/ai/routing';
import { resolveMobileInferenceRoute } from '@/lib/mobileProviders';

const STORAGE_KEY = 'keyboard_inference_route';

export function snapshotKeyboardInferenceRoute(jobId: string): TranscriptionJobRoute {
  const route = snapshotTranscriptionJob('dictation');
  AppGroupStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, jobId, route }));
  return route;
}

function decodeProviderRoute(
  value: unknown,
  scope: 'dictation' | 'upload' | 'cleanup' | 'agent',
): TranscriptionJobRoute['inferenceRoute'] {
  if (!value || typeof value !== 'object')
    throw new Error('The original provider route is unavailable.');
  const fields = value as Record<string, unknown>;
  if (fields.mode !== 'providers' || fields.scope !== scope)
    throw new Error('Invalid provider route.');
  const selection: InferenceSelection = { mode: 'providers' };
  for (const key of ['providerId', 'modelId', 'endpoint', 'credentialRef'] as const) {
    if (fields[key] !== undefined && typeof fields[key] !== 'string')
      throw new Error('Invalid provider route.');
    selection[key] = fields[key] as string | undefined;
  }
  const result = resolveMobileInferenceRoute({
    scope,
    selection,
    privateContent: false,
    policy: { status: 'unmanaged' },
  });
  if (!result.ok || result.route.mode !== 'providers')
    throw new Error('The original provider route is unavailable.');
  return result.route;
}

function readRoute(jobId: string, storageKey: string): TranscriptionJobRoute | undefined {
  const raw = AppGroupStorage.getItem(storageKey);
  if (!raw) return undefined;
  try {
    const snapshot = JSON.parse(raw) as {
      version?: unknown;
      jobId?: unknown;
      route?: Record<string, unknown>;
    };
    if (snapshot.jobId !== jobId) return undefined;
    if (snapshot.version !== 1 || !snapshot.route) throw new Error('Invalid route version.');
    const value = snapshot.route;
    if (value.provider !== 'byok' && value.provider !== 'cloud' && value.provider !== 'local')
      throw new Error('Invalid provider route.');
    const route: TranscriptionJobRoute = { provider: value.provider };
    if (value.provider === 'byok') {
      const scope = (value.inferenceRoute as Record<string, unknown> | undefined)?.scope;
      if (scope !== 'dictation' && scope !== 'upload') throw new Error('Invalid speech scope.');
      route.inferenceRoute = decodeProviderRoute(value.inferenceRoute, scope);
    }
    for (const scope of ['cleanup', 'agent'] as const) {
      const field = scope === 'cleanup' ? 'cleanupRoute' : 'agentRoute';
      const stage = value[field];
      if (stage) {
        if (typeof stage !== 'object' || stage === null) throw new Error('Invalid text route.');
        const saved = stage as Record<string, unknown>;
        if (saved.scope !== scope) throw new Error('Invalid text scope.');
        route[field] =
          saved.mode === 'providers'
            ? decodeProviderRoute(stage, scope)
            : saved.mode === 'local' || saved.mode === 'openwhispr'
              ? { mode: saved.mode, scope }
              : undefined;
        if (!route[field]) throw new Error('Invalid text route.');
      }
    }
    if (value.cleanupUnavailable)
      route.cleanupUnavailable = 'Cleanup is unavailable. Your raw transcript is saved.';
    if (value.agentUnavailable)
      route.agentUnavailable = 'The voice assistant is unavailable. Your raw transcript is saved.';
    for (const scope of ['cleanup', 'agent'] as const) {
      const field = scope === 'cleanup' ? 'cleanupRoute' : 'agentRoute';
      const unavailable = scope === 'cleanup' ? 'cleanupUnavailable' : 'agentUnavailable';
      if (!route[field] && !route[unavailable]) {
        if (route.provider === 'byok')
          route[unavailable] =
            `${scope === 'cleanup' ? 'Cleanup' : 'The voice assistant'} is unavailable. Your raw transcript is saved.`;
        else route[field] = { mode: route.provider === 'local' ? 'local' : 'openwhispr', scope };
      }
    }
    return route;
  } catch {
    throw new Error('The original keyboard provider route is unavailable. Record again.');
  }
}

export function readKeyboardInferenceRoute(jobId: string): TranscriptionJobRoute | undefined {
  return readRoute(jobId, `keyboard_upload_route.${jobId}`) ?? readRoute(jobId, STORAGE_KEY);
}

export function readKeyboardProviderResult(
  jobId: string,
): { text: string; route: TranscriptionJobRoute } | undefined {
  const key = `keyboard_provider_result.${jobId}`;
  const raw = AppGroupStorage.getItem(key);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const route = readRoute(jobId, key);
    if (
      value.version !== 1 ||
      value.jobId !== jobId ||
      typeof value.text !== 'string' ||
      !route ||
      route.provider !== 'byok'
    )
      throw new Error('Invalid provider result.');
    return { text: value.text, route };
  } catch {
    throw new Error('The original keyboard provider result route is unavailable.');
  }
}

export function clearKeyboardProviderRecovery(jobId: string): void {
  if (BackgroundUploader.clearProviderRecovery(jobId)) return;
  for (const key of ['keyboard_provider_result', 'keyboard_upload_route', 'keyboard_upload_audio'])
    AppGroupStorage.removeItem(`${key}.${jobId}`);
}

export interface ProviderRecoveryJob {
  jobId: string;
  audioUri?: string;
  route?: TranscriptionJobRoute;
  result?: { text: string; route: TranscriptionJobRoute };
  requestContext: 'keyboard' | 'recording' | 'file';
  error?: string;
}

export function listPendingProviderRecoveryJobs(): ProviderRecoveryJob[] {
  const jobIds = new Set(BackgroundUploader.listProviderRecoveryJobIds());
  const legacyJobId = AppGroupStorage.getItem('keyboard_recording_job_id');
  if (
    legacyJobId &&
    ['keyboard_upload_audio', 'keyboard_upload_route', 'keyboard_provider_result'].some((key) =>
      AppGroupStorage.getItem(`${key}.${legacyJobId}`),
    )
  )
    jobIds.add(legacyJobId);
  return [...jobIds].map((jobId): ProviderRecoveryJob => {
    const job: ProviderRecoveryJob = {
      jobId,
      audioUri: AppGroupStorage.getItem(`keyboard_upload_audio.${jobId}`) ?? undefined,
      requestContext: 'keyboard',
    };
    try {
      job.result = readKeyboardProviderResult(jobId);
      job.route = job.result?.route ?? readKeyboardInferenceRoute(jobId);
      const raw =
        AppGroupStorage.getItem(`keyboard_provider_result.${jobId}`) ??
        AppGroupStorage.getItem(`keyboard_upload_route.${jobId}`);
      const context = raw ? (JSON.parse(raw) as Record<string, unknown>).requestContext : undefined;
      job.requestContext =
        context === 'keyboard' || context === 'recording' || context === 'file'
          ? context
          : job.route?.inferenceRoute?.scope === 'upload'
            ? 'file'
            : 'keyboard';
      if (!job.route)
        job.error = 'The original provider route is unavailable. The recording is retained.';
    } catch {
      job.error =
        'The original provider recovery metadata is unavailable. The recording is retained.';
    }
    return job;
  });
}
