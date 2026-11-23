import type { PlatformTranscriptionProvider } from '@/lib/mobileProviders';
import { ProviderExecutionError } from '@/services/providers/ProviderExecutionError';
import { liveAdapter } from './liveAdapter';
import { noSpeech, promptTerms, requestJson, uploadFile } from './http';

const NAME = 'AssemblyAI';
const API = 'https://api.assemblyai.com/v2';
const POLL_MS = 1000;
const POLL_LIMIT_MS = 10 * 60 * 1000;

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    });
  });

/** AssemblyAI pre-recorded (Universal): upload the file, ask for a transcript, poll until done. */
export const assemblyAiProvider: PlatformTranscriptionProvider = {
  id: 'assemblyai',
  name: NAME,
  endpoint: API,
  // AssemblyAI's Nov 17, 2026 lineup: STT 3.7 first, Universal-2 for its other languages.
  models: [
    { id: 'assemblyai-stt-3-7', name: 'AssemblyAI STT 3.7' },
    { id: 'universal-2', name: 'Universal-2' },
  ],
  async transcribe({ apiKey, modelId, audioUri, language, prompt, signal }) {
    const auth = { Authorization: apiKey };
    const { upload_url: audioUrl } = (await uploadFile(
      NAME,
      `${API}/upload`,
      audioUri,
      { ...auth, 'Content-Type': 'application/octet-stream' },
      signal,
    )) as { upload_url: string };
    const terms = promptTerms(prompt, 100);
    const { id } = (await requestJson(NAME, `${API}/transcript`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_url: audioUrl,
        // STT 3.7 covers 32 languages; Universal-2 takes over for the rest of its 99.
        speech_models:
          modelId === 'universal-2'
            ? ['universal-2']
            : [modelId || 'assemblyai-stt-3-7', 'universal-2'],
        ...(language && language !== 'auto'
          ? { language_code: language }
          : { language_detection: true }),
        ...(terms.length ? { keyterms_prompt: terms } : {}),
      }),
      signal,
    })) as { id: string };
    const started = Date.now();
    for (;;) {
      const transcript = (await requestJson(NAME, `${API}/transcript/${id}`, {
        headers: auth,
        signal,
      })) as { status: string; text?: string | null; audio_duration?: number; error?: string };
      if (transcript.status === 'completed') {
        const text = transcript.text?.trim() ?? '';
        if (!text) throw noSpeech();
        return { text, duration: transcript.audio_duration ?? 0 };
      }
      if (transcript.status === 'error')
        throw new ProviderExecutionError(
          'PROVIDER_REQUEST_FAILED',
          transcript.error ?? `${NAME} couldn't transcribe this audio.`,
        );
      if (Date.now() - started > POLL_LIMIT_MS)
        throw new ProviderExecutionError('PROVIDER_UNAVAILABLE', `${NAME} took too long.`, {
          retryable: true,
        });
      await wait(POLL_MS, signal);
    }
  },
};

/** A short-lived streaming token, so the key itself never goes in a WebSocket URL. */
export async function assemblyAiStreamingToken(apiKey: string): Promise<string> {
  const { token } = (await requestJson(
    NAME,
    'https://streaming.assemblyai.com/v3/token?expires_in_seconds=600',
    { headers: { Authorization: apiKey } },
  )) as { token: string };
  return token;
}

type AssemblyMessage = {
  type?: string;
  transcript?: string;
  end_of_turn?: boolean;
  turn_is_formatted?: boolean;
  words?: { start?: number; end?: number }[];
  /** "A", "B"…, or "PENDING" for a turn too short to attribute. */
  speaker_label?: string;
  error?: string;
};

/** A live Universal-Streaming (v3) socket that speaks the meeting transport's Realtime events. */
export function assemblyAiLiveSocket(
  token: string,
  sampleRate: number,
  model = 'assemblyai-stt-3-7-realtime',
) {
  const params = new URLSearchParams({
    // Named explicitly: with none, the socket falls back to the retiring Universal-Streaming.
    speech_model: model,
    sample_rate: String(sampleRate),
    encoding: 'pcm_s16le',
    format_turns: 'true',
    // A speaker per turn (a small streaming add-on on the key's bill).
    speaker_labels: 'true',
    token,
  });
  return liveAdapter({
    url: `wss://streaming.assemblyai.com/v3/ws?${params}`,
    commit: JSON.stringify({ type: 'ForceEndpoint' }),
    close: JSON.stringify({ type: 'Terminate' }),
    translate(raw, emit) {
      const message = raw as AssemblyMessage;
      if (message.error) {
        emit.error(message.error);
        return;
      }
      if (message.type !== 'Turn') return;
      const text = message.transcript ?? '';
      // A finished turn arrives twice; the formatted copy is the one kept.
      if (message.end_of_turn && message.turn_is_formatted) {
        const words = message.words ?? [];
        emit.final(
          text,
          words[0]?.start ?? null,
          words[words.length - 1]?.end ?? null,
          message.speaker_label ?? null,
        );
        // A turn that ends after ForceEndpoint is its answer; otherwise this does nothing.
        emit.committed();
      } else if (!message.end_of_turn) emit.partial(text);
    },
  });
}
