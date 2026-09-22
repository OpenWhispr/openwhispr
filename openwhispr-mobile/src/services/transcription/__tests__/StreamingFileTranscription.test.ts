const mockCredentialListeners = new Set<(reference: string | null) => void>();
jest.mock('@/services/providers/ProviderCredentials', () => ({
  subscribeProviderCredentialChanges: (listener: (reference: string | null) => void) => {
    mockCredentialListeners.add(listener);
    return () => mockCredentialListeners.delete(listener);
  },
}));
afterEach(() => expect(mockCredentialListeners.size).toBe(0));
import { Buffer } from 'buffer';
import type { InferenceRoute } from '@shared/ai/routing';
import { transcribeStreamingFile } from '../StreamingFileTranscription';
import type { RealtimeProviderProtocol } from '../RealtimeProviderProtocol';
import type { WebSocketLike } from '../RealtimeMeetingWsService';

function wavFixture(pcm: Uint8Array): string {
  const bytes = Buffer.alloc(44 + pcm.length);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + pcm.length, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(pcm.length, 40);
  Buffer.from(pcm).copy(bytes, 44);
  return bytes.toString('base64');
}

test('replays WAV PCM as binary frames and collects normalized final turns', async () => {
  const sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  const socket: WebSocketLike = {
    readyState: 0,
    send: (data) => {
      sent.push(data);
      if (typeof data === 'string' && data.includes('Finalize'))
        socket.onmessage?.({ data: JSON.stringify({ type: 'provider.finished' }) });
    },
    close: jest.fn(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  const protocol: RealtimeProviderProtocol = {
    providerId: 'deepgram',
    connection: { url: 'wss://fixture', protocols: [], waitForReadyEvent: false },
    onOpenMessages: [],
    encodeAudio: (bytes) => bytes,
    finalizeMessages: [JSON.stringify({ type: 'Finalize' })],
    normalize: (message) => [message],
  };
  const route = {
    mode: 'providers',
    scope: 'dictation',
    providerId: 'deepgram',
    modelId: 'nova-3',
    endpoint: 'https://api.deepgram.com/v1',
    credentialRef: 'provider.deepgram',
  } satisfies Extract<InferenceRoute, { mode: 'providers' }>;
  const promise = transcribeStreamingFile(
    { route, audioUri: 'file:///audio.m4a' },
    {
      transcode: async () => ({ uri: 'file:///audio.wav', durationMs: 500 }),
      readBase64: async () => wavFixture(new Uint8Array([1, 2, 3, 4])),
      cleanup: async () => undefined,
      protocolFactory: async () => protocol,
      socketFactory: () => socket,
      delay: async () => undefined,
    },
  );
  for (let index = 0; index < 10 && socket.onopen === null; index += 1) {
    await Promise.resolve();
  }
  socket.readyState = 1;
  socket.onopen?.();
  await Promise.resolve();
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'one',
      transcript: 'streamed transcript',
    }),
  });

  await expect(promise).resolves.toEqual({ text: 'streamed transcript', duration: 0.5 });
  expect(Buffer.from(sent[0] as Uint8Array)).toEqual(Buffer.from([1, 2, 3, 4]));
  expect(sent).toContain(JSON.stringify({ type: 'Finalize' }));
});

test('credential deletion closes streamed-file replay before another audio frame or finalize', async () => {
  const sent: unknown[] = [];
  const socket: WebSocketLike = {
    readyState: 0,
    send: (value) => sent.push(value),
    close: jest.fn(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  const cleanup = jest.fn(async () => undefined);
  const protocol: RealtimeProviderProtocol = {
    providerId: 'deepgram',
    connection: { url: 'wss://fixture', protocols: [], waitForReadyEvent: false },
    onOpenMessages: [],
    encodeAudio: (bytes) => bytes,
    finalizeMessages: ['finalize'],
    normalize: (event) => [event],
  };
  const result = transcribeStreamingFile(
    {
      route: {
        mode: 'providers',
        scope: 'dictation',
        providerId: 'deepgram',
        modelId: 'nova-3',
        endpoint: 'https://api.deepgram.com/v1',
        credentialRef: 'provider.deepgram',
      },
      audioUri: 'file://audio',
    },
    {
      transcode: async () => ({ uri: 'file://converted', durationMs: 1000 }),
      readBase64: async () => wavFixture(new Uint8Array(6400)),
      cleanup,
      protocolFactory: async () => protocol,
      socketFactory: () => socket,
      delay: async () => {
        mockCredentialListeners.forEach((listener) => listener('provider.deepgram'));
      },
    },
  );
  for (let index = 0; index < 20 && !socket.onopen; index++) await Promise.resolve();
  socket.readyState = 1;
  socket.onopen?.();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  await Promise.resolve();
  expect(sent).toHaveLength(1);
  expect(sent).not.toContain('finalize');
  expect(socket.close).toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledWith(['file://converted']);
});

async function streamingCompletionFixture(onFinalize?: (socket: WebSocketLike) => void): Promise<{
  result: Promise<{ text: string; duration: number }>;
  socket: WebSocketLike;
  cleanup: jest.Mock;
}> {
  const socket: WebSocketLike = {
    readyState: 0,
    send: (value) => {
      if (value === 'finalize') onFinalize?.(socket);
    },
    close: jest.fn(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  const cleanup = jest.fn(async () => undefined);
  const protocol: RealtimeProviderProtocol = {
    providerId: 'deepgram',
    connection: { url: 'wss://fixture', protocols: [], waitForReadyEvent: false },
    onOpenMessages: [],
    encodeAudio: (bytes) => bytes,
    finalizeMessages: ['finalize'],
    normalize: (event) => [event],
  };
  const result = transcribeStreamingFile(
    {
      route: {
        mode: 'providers',
        scope: 'dictation',
        providerId: 'deepgram',
        modelId: 'nova-3',
        endpoint: 'https://api.deepgram.com/v1',
        credentialRef: 'provider.deepgram',
      },
      audioUri: 'file://audio',
    },
    {
      transcode: async () => ({ uri: 'file://converted', durationMs: 1000 }),
      readBase64: async () => wavFixture(new Uint8Array([1, 2])),
      cleanup,
      protocolFactory: async () => protocol,
      socketFactory: () => socket,
      delay: async () => undefined,
    },
  );
  for (let index = 0; index < 20 && !socket.onopen; index++) await Promise.resolve();
  return { result, socket, cleanup };
}
test('waits for the provider completion event and includes late trailing text', async () => {
  jest.useFakeTimers();
  try {
    const { result, socket } = await streamingCompletionFixture((connection) => {
      setTimeout(() => {
        connection.onmessage?.({
          data: JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            transcript: 'late trailing text',
          }),
        });
        connection.onmessage?.({ data: JSON.stringify({ type: 'provider.finished' }) });
      }, 2500);
    });
    socket.readyState = 1;
    socket.onopen?.();
    let settled = false;
    result.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(1500);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1500);
    await expect(result).resolves.toMatchObject({ text: 'late trailing text' });
  } finally {
    jest.useRealTimers();
  }
});
test.each(['connect', 'finalize'])(
  'times out incomplete %s instead of returning partial text',
  async (stage) => {
    jest.useFakeTimers();
    try {
      const { result, socket, cleanup } = await streamingCompletionFixture();
      const rejected = result.catch((error: unknown): unknown => error);
      if (stage === 'finalize') {
        socket.readyState = 1;
        socket.onopen?.();
        socket.onmessage?.({
          data: JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            transcript: 'partial output',
          }),
        });
      }
      await jest.advanceTimersByTimeAsync(31000);
      expect(await rejected).toEqual(
        expect.objectContaining({
          message: expect.stringContaining(
            stage === 'connect' ? 'connection timed out' : 'did not confirm completion',
          ),
        }),
      );
      expect(socket.close).toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  },
);

test('rejects an early provider disconnect rather than accepting partial output', async () => {
  const { result, socket, cleanup } = await streamingCompletionFixture((connection) =>
    connection.onclose?.({ code: 1006 }),
  );
  socket.readyState = 1;
  socket.onopen?.();
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'partial output',
    }),
  });
  await expect(result).rejects.toThrow('closed before completion');
  expect(socket.close).toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalled();
});
