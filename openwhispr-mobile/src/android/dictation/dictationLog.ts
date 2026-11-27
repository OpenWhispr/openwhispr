import { errorCode, safeError, type DebugFields } from '@/android/lib/debugLog';

/**
 * Debug-log helpers for the dictation paths (Settings › Analytics › Debug logging).
 *
 * The bubble's run id reaches processAndroidAudio with the recording; the services under it get
 * the request's job id instead, so `bindRun` remembers which run a job id belongs to and
 * `runFor` reads it back. Kept small: a dictation's lines need it only while it runs.
 */
const MAX_BOUND = 32;
const runs = new Map<string, string>();

export function bindRun(jobId: string | undefined, run: string | undefined): void {
  if (!jobId || !run) return;
  runs.delete(jobId);
  runs.set(jobId, run);
  if (runs.size > MAX_BOUND) runs.delete(runs.keys().next().value as string);
}

export function runFor(jobId: string | undefined): string | undefined {
  return jobId ? runs.get(jobId) : undefined;
}

/** The run a recording carries: the bubble's (onRecording) or a Home / practice take's. */
export function recordingRun(recording: unknown): string | undefined {
  const run = (recording as { run?: unknown } | null)?.run;
  return typeof run === 'string' && run ? run : undefined;
}

/**
 * An error as log fields. An HTTP failure is logged as its class and status only: its message
 * can carry the response body (TranscriptionApiError, the fused-cleanup error), which may echo
 * what was said.
 */
export function failureFields(error: unknown): DebugFields {
  try {
    const status = (error as { status?: unknown } | null)?.status;
    const hasBody = typeof (error as { body?: unknown } | null)?.body === 'string';
    const name = error instanceof Error ? error.name : typeof error;
    const httpStatus = typeof status === 'number' ? status : undefined;
    return {
      error:
        httpStatus !== undefined || hasBody
          ? `${name}: HTTP ${httpStatus ?? '?'}`
          : safeError(error),
      code: errorCode(error),
      status: httpStatus,
      aborted: (error as { name?: unknown } | null)?.name === 'AbortError' || undefined,
    };
  } catch {
    return { error: 'unknown' };
  }
}

/** Where a text route runs, as log fields: its mode, and a provider route's provider and model. */
export function routeFields(route: unknown): { mode: string; provider?: string; model?: string } {
  const value = route as { mode?: unknown; providerId?: unknown; modelId?: unknown } | undefined;
  const text = (field: unknown) => (typeof field === 'string' ? field : undefined);
  return {
    mode: text(value?.mode) ?? 'none',
    provider: text(value?.providerId),
    model: text(value?.modelId),
  };
}
