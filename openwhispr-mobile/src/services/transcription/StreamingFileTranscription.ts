import { createProviderCredentialScope } from '@/services/providers/ProviderCredentialScope';
import { Buffer } from 'buffer';
import type { InferenceRoute } from '@shared/ai/routing';
import type { RealtimeProviderProtocol } from './RealtimeProviderProtocol';
import type { WebSocketLike } from './RealtimeMeetingWsService';

type ProviderRoute = Extract<InferenceRoute, { mode: 'providers' }>;

export interface StreamingFileInput {
  route: ProviderRoute;
  audioUri: string;
  language?: string;
  signal?: AbortSignal;
}

export interface StreamingFileDependencies {
  transcode(uri: string): Promise<{ uri: string; durationMs: number }>;
  readBase64(uri: string): Promise<string>;
  cleanup(uris: string[]): Promise<void>;
  protocolFactory(route: ProviderRoute): Promise<RealtimeProviderProtocol>;
  socketFactory(url: string, protocols: string[]): WebSocketLike;
  delay(milliseconds: number): Promise<void>;
}

function pcmFromWav(base64: string): Uint8Array {
  const wav = Buffer.from(base64, 'base64');
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Audio conversion returned an invalid WAV file.');
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === 'data') {
      if (dataStart + size > wav.length)
        throw new Error('Audio conversion returned a truncated WAV file.');
      return new Uint8Array(wav.subarray(dataStart, dataStart + size));
    }
    offset = dataStart + size + (size % 2);
  }
  throw new Error('Audio conversion returned a WAV file without PCM data.');
}

function defaultDependencies(input: StreamingFileInput): StreamingFileDependencies {
  const { AudioTools } =
    require('../../../modules/audio-tools/src') as typeof import('../../../modules/audio-tools/src');
  const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
  return {
    transcode: (uri) => AudioTools.transcodeToWav(uri),
    readBase64: (uri) =>
      FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }),
    cleanup: (uris) => AudioTools.cleanup(uris),
    protocolFactory: async (route) => {
      const { createRealtimeProviderProtocol } =
        require('./RealtimeProviderProtocol') as typeof import('./RealtimeProviderProtocol');
      const { getProviderCredential } =
        require('@/services/providers/ProviderCredentials') as typeof import('@/services/providers/ProviderCredentials');
      const { requestProviderNative } =
        require('@/services/providers/NativeProviderTransport') as typeof import('@/services/providers/NativeProviderTransport');
      return createRealtimeProviderProtocol(
        route,
        { language: input.language, sampleRate: 16000, signal: input.signal, manualCommit: true },
        { getCredential: getProviderCredential, request: requestProviderNative },
      );
    },
    socketFactory: (url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike,
    delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

const CONNECTION_TIMEOUT_MS = 30_000;
const FINALIZATION_TIMEOUT_MS = 30_000;

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise): void => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Connection failures can arrive before playback begins awaiting finalization.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export async function transcribeStreamingFile(
  input: StreamingFileInput,
  injected?: StreamingFileDependencies,
): Promise<{ text: string; duration: number }> {
  const scope = createProviderCredentialScope(input.route.credentialRef, input.signal);
  const dependencies = injected ?? defaultDependencies({ ...input, signal: scope.signal });
  try {
    return await scope.run(async () => {
      const converted = await dependencies.transcode(input.audioUri);
      let socket: WebSocketLike | undefined;
      const abort = (): void => socket?.close();
      try {
        scope.assertActive();
        const protocol = await scope.run(() => dependencies.protocolFactory(input.route));
        scope.assertActive();
        socket = protocol.connection.socketFactory
          ? protocol.connection.socketFactory()
          : dependencies.socketFactory(protocol.connection.url, protocol.connection.protocols);
        const connection = socket;
        const finalTurns: string[] = [];
        const ready = deferred();
        const finished = deferred();
        const failed = deferred();
        let finalizing = false;
        let complete = false;
        let connectionError: Error | undefined;
        const fail = (error: Error): void => {
          connectionError = error;
          ready.reject(error);
          finished.reject(error);
          failed.reject(error);
        };
        const assertConnected = (): void => {
          scope.assertActive();
          if (connectionError) throw connectionError;
          if (connection.readyState !== 1)
            throw new Error('Streaming transcription connection closed.');
        };
        const wait = async <T>(operation: () => Promise<T>): Promise<T> =>
          scope.run(() =>
            Promise.race([
              operation(),
              failed.promise.then(() => {
                throw new Error('Streaming transcription failed.');
              }),
            ]),
          );
        const waitWithTimeout = async (
          promise: Promise<void>,
          milliseconds: number,
          message: string,
        ): Promise<void> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await wait(() =>
              Promise.race([
                promise,
                new Promise<never>((_resolve, reject): void => {
                  timer = setTimeout(() => reject(new Error(message)), milliseconds);
                }),
              ]),
            );
          } finally {
            if (timer) clearTimeout(timer);
          }
        };
        scope.signal.addEventListener('abort', abort, { once: true });
        connection.onopen = (): void => {
          if (scope.signal.aborted) return;
          try {
            for (const message of protocol.onOpenMessages) connection.send(message);
            if (!protocol.connection.waitForReadyEvent) ready.resolve();
          } catch {
            fail(new Error('Unable to configure streaming transcription.'));
          }
        };
        connection.onerror = (): void =>
          fail(new Error('Streaming transcription connection failed.'));
        connection.onclose = (): void => {
          if (!complete) fail(new Error('Streaming transcription closed before completion.'));
        };
        connection.onmessage = ({ data }): void => {
          if (scope.signal.aborted || connectionError || complete) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            return;
          }
          for (const event of protocol.normalize(parsed)) {
            const normalized = event as { type?: string; transcript?: string };
            if (normalized.type === 'provider.ready') ready.resolve();
            if (
              normalized.type === 'conversation.item.input_audio_transcription.completed' &&
              normalized.transcript?.trim()
            )
              finalTurns.push(normalized.transcript.trim());
            if (normalized.type === 'error') fail(new Error('Streaming transcription failed.'));
            if (normalized.type === 'provider.finished' && finalizing) {
              complete = true;
              finished.resolve();
            }
          }
        };
        await waitWithTimeout(
          ready.promise,
          CONNECTION_TIMEOUT_MS,
          'Streaming transcription connection timed out.',
        );
        const pcm = pcmFromWav(await wait(() => dependencies.readBase64(converted.uri)));
        const frameBytes = 16000 * 2 * 0.1;
        for (let offset = 0; offset < pcm.length; offset += frameBytes) {
          assertConnected();
          connection.send(protocol.encodeAudio(pcm.subarray(offset, offset + frameBytes)));
          await wait(() => dependencies.delay(100));
        }
        assertConnected();
        finalizing = true;
        for (const message of protocol.finalizeMessages) connection.send(message);
        await waitWithTimeout(
          finished.promise,
          FINALIZATION_TIMEOUT_MS,
          'Streaming transcription did not confirm completion.',
        );
        scope.assertActive();
        if (connectionError) throw connectionError;
        const text = finalTurns.join(' ').trim();
        if (!text) throw new Error(`${input.route.providerId} returned an empty transcription.`);
        return { text, duration: converted.durationMs / 1000 };
      } finally {
        scope.signal.removeEventListener('abort', abort);
        if (socket) {
          socket.onopen = null;
          socket.onmessage = null;
          socket.onerror = null;
          socket.onclose = null;
          socket.close();
        }
        await dependencies.cleanup([converted.uri]);
      }
    });
  } finally {
    scope.dispose();
  }
}
