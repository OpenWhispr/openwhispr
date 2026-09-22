import type { BackgroundUploader as BackgroundUploaderType } from '../../../modules/background-uploader/src';

let requestSequence = 0;

function backgroundUploader(): typeof BackgroundUploaderType {
  const { BackgroundUploader } =
    require('../../../modules/background-uploader/src') as typeof import('../../../modules/background-uploader/src');
  return BackgroundUploader;
}

function requestId(): string {
  requestSequence += 1;
  return `provider-${Date.now()}-${requestSequence}`;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function nativeResponse(result: {
  status: number;
  body: string;
  url: string;
  headers: Record<string, string>;
}): Response {
  const response = new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
  Object.defineProperty(response, 'url', { value: result.url });
  return response;
}

export async function requestProviderNative(
  url: string,
  init: RequestInit,
  recovery?: { routeSnapshot?: string; recoveryAudioUri?: string },
): Promise<Response> {
  if (init.body !== undefined && typeof init.body !== 'string') {
    throw new Error('This provider request requires a supported native body type');
  }
  const id = requestId();
  const uploader = backgroundUploader();
  const abort = (): void => uploader.cancelProviderRequest(id);
  if (init.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  init.signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await uploader.requestProvider({
      requestId: id,
      url,
      method: init.method === 'GET' ? 'GET' : 'POST',
      headers: headersToRecord(init.headers),
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      routeSnapshot: recovery?.routeSnapshot,
      recoveryAudioUri: recovery?.recoveryAudioUri,
    });
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return nativeResponse(result);
  } finally {
    init.signal?.removeEventListener('abort', abort);
  }
}

export async function requestProviderFileNative(input: {
  url: string;
  fileUri: string;
  fileFieldName: string;
  fileMimeType: string;
  fileName: string;
  parameters: Record<string, string>;
  headers: Record<string, string>;
  routeSnapshot?: string;
  recoveryAudioUri?: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const id = requestId();
  const uploader = backgroundUploader();
  const abort = (): void => uploader.cancelProviderRequest(id);
  if (input.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await uploader.requestProvider({
      requestId: id,
      url: input.url,
      method: 'POST',
      headers: input.headers,
      fileUri: input.fileUri,
      fileFieldName: input.fileFieldName,
      fileMimeType: input.fileMimeType,
      fileName: input.fileName,
      parameters: input.parameters,
      routeSnapshot: input.routeSnapshot,
      recoveryAudioUri: input.recoveryAudioUri,
    });
    if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return nativeResponse(result);
  } finally {
    input.signal?.removeEventListener('abort', abort);
  }
}
