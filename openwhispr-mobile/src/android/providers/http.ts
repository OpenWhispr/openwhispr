import * as FileSystem from 'expo-file-system/legacy';
import { ProviderExecutionError } from '@/services/providers/ProviderExecutionError';

/** The provider failure for an HTTP status, in the same codes the OpenAI-compatible client uses. */
export function statusError(name: string, status: number): ProviderExecutionError {
  if (status === 401 || status === 403)
    return new ProviderExecutionError('INVALID_CREDENTIAL', `${name} rejected the key.`, {
      status,
    });
  if (status === 402)
    return new ProviderExecutionError(
      'PROVIDER_QUOTA_EXCEEDED',
      `${name} reports a billing or quota problem for this key.`,
      { status },
    );
  if (status === 429)
    return new ProviderExecutionError(
      'PROVIDER_RATE_LIMITED',
      `${name} is rate limited. Try again later.`,
      { status },
    );
  if (status >= 500)
    return new ProviderExecutionError(
      'PROVIDER_UNAVAILABLE',
      `${name} is temporarily unavailable.`,
      {
        status,
        retryable: true,
      },
    );
  return new ProviderExecutionError(
    'PROVIDER_REQUEST_FAILED',
    `${name} refused the request (${status}).`,
    {
      status,
    },
  );
}

export const noSpeech = () => new ProviderExecutionError('NO_SPEECH', 'No speech detected');

export function networkError(name: string): ProviderExecutionError {
  return new ProviderExecutionError('PROVIDER_NETWORK_ERROR', `Unable to reach ${name}.`, {
    retryable: true,
  });
}

/** Sends a recording's bytes as the request body, cancelled with the signal. */
export async function uploadFile(
  name: string,
  url: string,
  fileUri: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const task = FileSystem.createUploadTask(url, fileUri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers,
  });
  const cancel = () => void task.cancelAsync().catch(() => undefined);
  signal?.addEventListener('abort', cancel);
  try {
    const result = await task.uploadAsync().catch(() => {
      throw networkError(name);
    });
    if (!result) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    if (result.status < 200 || result.status >= 300) throw statusError(name, result.status);
    return JSON.parse(result.body) as unknown;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export async function requestJson(name: string, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init).catch((error: unknown) => {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw networkError(name);
  });
  if (!response.ok) throw statusError(name, response.status);
  return (await response.json()) as unknown;
}

/** Dictionary hints arrive as the comma-separated prompt the OpenAI-compatible client sends. */
export function promptTerms(prompt: string | undefined, limit: number): string[] {
  return (prompt ?? '')
    .split(/[,\n]/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, limit);
}
