import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { liveAdapter } from '../providers/liveAdapter';
import { deepgramLiveSocket, deepgramProvider } from '../providers/deepgram';
import { assemblyAiLiveSocket, assemblyAiProvider } from '../providers/assemblyai';
import { liveMeetingDeps, meetingKey } from '../providers/liveMeeting';
import { checkProviderKey } from '../settings/keyCheck';

const mockUpload = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  createUploadTask: (url: string, fileUri: string, options: object) => ({
    uploadAsync: () => mockUpload(url, fileUri, options),
    cancelAsync: jest.fn(async () => undefined),
  }),
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: require('zustand').create(() => ({ config: {} })),
}));
jest.mock('@/services/providers/ProviderCredentials', () => ({
  getProviderCredentialReference: async (id: string) => `provider.${id}`,
  getProviderCredential: async (reference: string) => ({ apiKey: `key-for-${reference}` }),
}));

/** A fake provider socket the adapter drives. */
class FakeSocket {
  readyState = 0;
  sent: (string | ArrayBuffer)[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  constructor(
    public url: string,
    public protocols?: string[],
  ) {}
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let socket: FakeSocket;
const originalWebSocket = global.WebSocket;
beforeEach(() => {
  mockUpload.mockReset();
  global.WebSocket = jest.fn((url: string, protocols?: string[]) => {
    socket = new FakeSocket(url, protocols);
    return socket;
  }) as never;
  useConfigStore.setState({ config: {} } as never);
  useProcessingModeStore.setState({ activeMode: 'cloud' });
});
afterAll(() => {
  global.WebSocket = originalWebSocket;
});

const events = (received: { data: string }[]) =>
  received.map((event) => JSON.parse(event.data) as Record<string, unknown>);

describe('live adapter', () => {
  it('turns audio appends into PCM bytes and a commit into the provider’s finish', () => {
    const adapter = liveAdapter({
      url: 'wss://x',
      commit: '{"type":"Finalize"}',
      translate: () => {},
    });
    socket.open();
    adapter.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AQIDBA==' }));
    adapter.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    expect(Array.from(new Uint8Array(socket.sent[0] as ArrayBuffer))).toEqual([1, 2, 3, 4]);
    expect(socket.sent[1]).toBe('{"type":"Finalize"}');
  });

  it('shows the newest caption, clears it when the turn finishes, and keeps the timing', () => {
    const received: { data: string }[] = [];
    const adapter = liveAdapter({
      url: 'wss://x',
      translate: (message, emit) => {
        const { kind, text } = message as { kind: string; text: string };
        if (kind === 'partial') emit.partial(text);
        else emit.final(text, 1000, 2500);
      },
    });
    adapter.onmessage = (event) => received.push(event);
    socket.receive({ kind: 'partial', text: 'hello' });
    socket.receive({ kind: 'partial', text: 'hello there' });
    socket.receive({ kind: 'final', text: 'Hello there.' });
    const types = events(received).map((event) => event.type);
    expect(types).toEqual([
      'conversation.item.input_audio_transcription.delta',
      'conversation.item.input_audio_transcription.completed',
      'conversation.item.input_audio_transcription.delta',
      'conversation.item.input_audio_transcription.completed',
      'input_audio_buffer.speech_started',
      'input_audio_buffer.speech_stopped',
      'conversation.item.input_audio_transcription.completed',
    ]);
    const last = events(received).at(-1)!;
    expect(last.transcript).toBe('Hello there.');
    expect(events(received)[4].audio_start_ms).toBe(1000);
  });
});

describe('Deepgram', () => {
  it('streams Nova-3 at the meeting rate, with the key in the subprotocol', () => {
    deepgramLiveSocket('dg-key', 24000, 'de');
    expect(socket.protocols).toEqual(['token', 'dg-key']);
    expect(socket.url).toContain('model=nova-3');
    expect(socket.url).toContain('sample_rate=24000');
    expect(socket.url).toContain('language=de');
  });

  it('reads interim and final results', () => {
    const received: { data: string }[] = [];
    const adapter = deepgramLiveSocket('dg-key', 24000);
    adapter.onmessage = (event) => received.push(event);
    socket.receive({
      type: 'Results',
      is_final: false,
      channel: { alternatives: [{ transcript: 'hi' }] },
    });
    socket.receive({
      type: 'Results',
      is_final: true,
      start: 1.5,
      duration: 1,
      channel: { alternatives: [{ transcript: 'Hi all.' }] },
    });
    const final = events(received).at(-1)!;
    expect(final.transcript).toBe('Hi all.');
    expect(
      events(received).find((event) => event.type === 'input_audio_buffer.speech_stopped'),
    ).toMatchObject({ audio_end_ms: 2500 });
  });

  it('transcribes an upload with Nova-3 and the dictionary as key terms', async () => {
    mockUpload.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        metadata: { duration: 4.2 },
        results: { channels: [{ alternatives: [{ transcript: 'Ship it on Friday.' }] }] },
      }),
    });
    await expect(
      deepgramProvider.transcribe({
        apiKey: 'dg-key',
        modelId: 'nova-3',
        audioUri: 'file:///a.wav',
        mimeType: 'audio/wav',
        prompt: 'OpenWhispr, Gizmo',
      }),
    ).resolves.toEqual({ text: 'Ship it on Friday.', duration: 4.2 });
    const [url, , options] = mockUpload.mock.calls[0];
    expect(url).toContain('language=multi');
    expect(url).toContain('keyterm=OpenWhispr');
    expect(url).toContain('keyterm=Gizmo');
    expect(options.headers.Authorization).toBe('Token dg-key');
  });

  it('reports a refused key the way the other providers do', async () => {
    mockUpload.mockResolvedValue({ status: 401, body: '{}' });
    await expect(
      deepgramProvider.transcribe({ apiKey: 'bad', modelId: 'nova-3', audioUri: 'file:///a.wav' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
  });
});

describe('AssemblyAI', () => {
  it('keeps only the formatted copy of a finished turn', () => {
    const received: { data: string }[] = [];
    const adapter = assemblyAiLiveSocket('tmp-token', 24000);
    expect(socket.url).toContain('token=tmp-token');
    expect(socket.url).toContain('sample_rate=24000');
    adapter.onmessage = (event) => received.push(event);
    socket.receive({ type: 'Turn', transcript: 'hello every', end_of_turn: false });
    socket.receive({ type: 'Turn', transcript: 'hello everyone', end_of_turn: true });
    socket.receive({
      type: 'Turn',
      transcript: 'Hello, everyone.',
      end_of_turn: true,
      turn_is_formatted: true,
      words: [{ start: 200 }, { end: 1400 }],
    });
    const finals = events(received).filter(
      (event) =>
        event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript,
    );
    expect(finals).toHaveLength(1);
    expect(finals[0].transcript).toBe('Hello, everyone.');
  });

  it('uploads, asks for a Universal transcript, and polls until it is done', async () => {
    jest.useFakeTimers();
    mockUpload.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ upload_url: 'https://cdn/a' }),
    });
    const responses = [
      { id: 't1' },
      { status: 'processing' },
      { status: 'completed', text: 'All set.', audio_duration: 3 },
    ];
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => responses.shift(),
    })) as never;
    const result = assemblyAiProvider.transcribe({
      apiKey: 'aai-key',
      modelId: 'universal',
      audioUri: 'file:///a.wav',
      language: 'en',
    });
    await jest.advanceTimersByTimeAsync(1500);
    await expect(result).resolves.toEqual({ text: 'All set.', duration: 3 });
    const create = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(create).toMatchObject({
      audio_url: 'https://cdn/a',
      speech_model: 'universal',
      language_code: 'en',
    });
    jest.useRealTimers();
  });
});

describe('live meetings on a key', () => {
  it('uses OpenWhispr Cloud with no key saved for meetings, and the phone in Local Mode', () => {
    expect(liveMeetingDeps()).toEqual({});
    useConfigStore.setState({
      config: {
        inference: { meeting: { mode: 'providers', providerId: 'deepgram', modelId: 'nova-3' } },
      },
    } as never);
    useProcessingModeStore.setState({ activeMode: 'private' });
    expect(meetingKey()).toBeNull();
  });

  it('opens a Deepgram socket with the saved key for every leg', async () => {
    useConfigStore.setState({
      config: {
        inference: { meeting: { mode: 'providers', providerId: 'deepgram', modelId: 'nova-3' } },
      },
    } as never);
    const deps = liveMeetingDeps('en');
    const secret = await deps.fetchClientSecret!();
    expect(secret).toBe('key-for-provider.deepgram');
    deps.wsFactory!('wss://api.openai.com/v1/realtime', [
      'realtime',
      `openai-insecure-api-key.${secret}`,
    ]);
    expect(socket.protocols).toEqual(['token', 'key-for-provider.deepgram']);
  });

  it('mints an OpenAI Realtime secret on the phone with the user’s key', async () => {
    useConfigStore.setState({
      config: {
        inference: {
          meeting: { mode: 'providers', providerId: 'openai', modelId: 'gpt-4o-transcribe' },
        },
      },
    } as never);
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ value: 'ek_1' }),
    })) as never;
    const deps = liveMeetingDeps('fr');
    expect(deps.wsFactory).toBeUndefined();
    await expect(deps.fetchClientSecret!()).resolves.toBe('ek_1');
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(init.headers.Authorization).toBe('Bearer key-for-provider.openai');
    expect(JSON.parse(init.body).session.audio.input.transcription).toEqual({
      model: 'gpt-4o-transcribe',
      language: 'fr',
    });
  });
});

describe('key check for the speech providers', () => {
  it('sends Deepgram’s Token scheme and AssemblyAI’s bare key', async () => {
    const fetcher = jest.fn(
      async (_url: string, _init: RequestInit) => ({ status: 200 }) as Response,
    );
    await checkProviderKey('deepgram', 'dg', fetcher as never);
    await checkProviderKey('assemblyai', 'aai', fetcher as never);
    expect((fetcher.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe(
      'Token dg',
    );
    expect(fetcher.mock.calls[1][0]).toBe('https://api.assemblyai.com/v2/transcript?limit=1');
    expect((fetcher.mock.calls[1][1].headers as Record<string, string>).Authorization).toBe('aai');
  });

  it('falls back to Deepgram’s projects when the token endpoint is missing', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ status: 200 });
    await expect(checkProviderKey('deepgram', 'dg', fetcher as never)).resolves.toEqual({
      state: 'connected',
    });
    expect(fetcher.mock.calls[1][0]).toBe('https://api.deepgram.com/v1/projects');
  });
});
