import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { randomUUID } from '@/lib/uuid';
import {
  getProviderCredential,
  subscribeProviderCredentialChanges,
} from '@/services/providers/ProviderCredentials';
import type { WebSocketLike } from '@/services/transcription/RealtimeMeetingWsService';

interface SocketEvent {
  id: string;
  type: string;
  data?: string;
}
interface NativeTinfoil {
  prepare(id: string): void;
  request(
    input: Omit<TinfoilRequest, 'signal' | 'credentialRef'> & { id: string },
  ): Promise<{ status: number; body: string }>;
  openSocket(id: string, apiKey: string, model: string): Promise<void>;
  send(id: string, data: string): Promise<void>;
  cancel(id: string): void;
  addListener(name: 'socket', listener: (event: SocketEvent) => void): { remove(): void };
}
export interface TinfoilRequest {
  credentialRef?: string;
  apiKey: string;
  path: '/v1/chat/completions' | '/v1/audio/transcriptions' | '/v1/models';
  body?: string;
  fileUri?: string;
  fileName?: string;
  mimeType?: string;
  parameters?: Record<string, string>;
  signal?: AbortSignal;
  routeSnapshot?: string;
}

function nativeTransport(): NativeTinfoil {
  const native =
    Platform.OS === 'ios' ? requireOptionalNativeModule<NativeTinfoil>('TinfoilTransport') : null;
  if (!native) throw new Error('Tinfoil requires an iOS build with the attested native transport.');
  return native;
}

function cancelledError(): Error {
  const error = new Error('Request cancelled.');
  error.name = 'AbortError';
  return error;
}

async function verifyCurrentCredential(reference: string, apiKey: string): Promise<void> {
  const credential = await getProviderCredential(reference);
  if (!credential?.apiKey || credential.apiKey.trim() !== apiKey.trim()) {
    throw new Error('Tinfoil credential changed. Retry with the current credential.');
  }
}

export async function requestTinfoil(
  input: TinfoilRequest,
): Promise<{ status: number; body: string }> {
  const native = nativeTransport();
  const id = randomUUID();
  const { signal, credentialRef = 'provider.tinfoil', ...request } = input;
  if (signal?.aborted) throw cancelledError();
  let cancelled = false;
  let rejectCancelled: (reason: Error) => void = (): void => undefined;
  const cancellation = new Promise<never>((_resolve, reject): void => {
    rejectCancelled = reject;
  });
  const cancel = (): void => {
    cancelled = true;
    native.cancel(id);
    rejectCancelled(cancelledError());
  };
  const unsubscribe = subscribeProviderCredentialChanges((reference): void => {
    if (reference === null || reference === credentialRef) cancel();
  });
  signal?.addEventListener('abort', cancel, { once: true });
  const execute = async (): Promise<{ status: number; body: string }> => {
    await verifyCurrentCredential(credentialRef, request.apiKey);
    if (cancelled || signal?.aborted) throw cancelledError();
    native.prepare(id);
    const response = await native.request({ ...request, id });
    if (cancelled || signal?.aborted) throw cancelledError();
    return response;
  };
  try {
    return await Promise.race([execute(), cancellation]);
  } finally {
    signal?.removeEventListener('abort', cancel);
    unsubscribe();
  }
}

export function createTinfoilWebSocket(
  apiKey: string,
  model: string,
  credentialRef = 'provider.tinfoil',
): WebSocketLike {
  const native = nativeTransport();
  const id = randomUUID();
  let closed = false;
  let subscription: { remove(): void } | undefined;
  let unsubscribe = (): void => undefined;
  const socket: WebSocketLike = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (data): void => {
      if (closed || socket.readyState !== 1) throw new Error('Tinfoil connection is not open.');
      if (typeof data !== 'string') throw new Error('Tinfoil realtime requires JSON frames.');
      native.send(id, data).catch((): void => {
        if (!closed) socket.onerror?.();
        finish(1006);
      });
    },
    close: (): void => finish(1000),
  };
  function finish(code: number): void {
    if (closed) return;
    closed = true;
    socket.readyState = 3;
    native.cancel(id);
    subscription?.remove();
    unsubscribe();
    socket.onclose?.({ code });
  }
  unsubscribe = subscribeProviderCredentialChanges((reference): void => {
    if (reference === null || reference === credentialRef) finish(1008);
  });
  subscription = native.addListener('socket', (event): void => {
    if (event.id !== id || closed) return;
    if (event.type === 'open') {
      socket.readyState = 1;
      socket.onopen?.();
    } else if (event.type === 'message' && event.data !== undefined)
      socket.onmessage?.({ data: event.data });
    else if (event.type === 'error') socket.onerror?.();
    else if (event.type === 'close') {
      finish(Number(event.data) || 1006);
    }
  });
  verifyCurrentCredential(credentialRef, apiKey)
    .then(async (): Promise<void> => {
      if (!closed) {
        native.prepare(id);
        await native.openSocket(id, apiKey, model);
      }
    })
    .catch((): void => {
      if (!closed) {
        socket.onerror?.();
        finish(1006);
      }
    });
  return socket;
}
