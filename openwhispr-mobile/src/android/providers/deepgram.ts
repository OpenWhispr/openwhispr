import type { PlatformTranscriptionProvider } from '@/lib/mobileProviders';
import { liveAdapter } from './liveAdapter';
import { noSpeech, promptTerms, uploadFile } from './http';

const NAME = 'Deepgram';
const MODEL = 'nova-3';

/** Nova-3 takes a language, or "multi" to detect it. */
function languageParam(language: string | undefined): string {
  return language && language !== 'auto' ? language : 'multi';
}

/** Deepgram pre-recorded transcription: the recording's bytes in, one transcript out. */
export const deepgramProvider: PlatformTranscriptionProvider = {
  id: 'deepgram',
  name: NAME,
  endpoint: 'https://api.deepgram.com/v1',
  models: [
    { id: MODEL, name: 'Nova-3' },
    { id: 'nova-3-medical', name: 'Nova-3 Medical' },
    // Deepgram's pick for languages Nova-3 doesn't cover.
    { id: 'nova-2', name: 'Nova-2' },
  ],
  async transcribe({ apiKey, modelId, audioUri, mimeType, language, prompt, signal }) {
    const model = modelId || MODEL;
    const params = new URLSearchParams({ model, smart_format: 'true', punctuate: 'true' });
    // Nova-3 takes "multi" to detect the language; older models detect it with detect_language.
    if (language && language !== 'auto') params.set('language', language);
    else if (model.startsWith('nova-3')) params.set('language', 'multi');
    else params.set('detect_language', 'true');
    for (const term of promptTerms(prompt, 100)) params.append('keyterm', term);
    const body = (await uploadFile(
      NAME,
      `https://api.deepgram.com/v1/listen?${params}`,
      audioUri,
      { Authorization: `Token ${apiKey}`, 'Content-Type': mimeType || 'audio/wav' },
      signal,
    )) as {
      metadata?: { duration?: number };
      results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
    };
    const text = body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
    if (!text) throw noSpeech();
    return { text, duration: body.metadata?.duration ?? 0 };
  },
};

type DeepgramMessage = {
  type?: string;
  is_final?: boolean;
  from_finalize?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: {
      transcript?: string;
      words?: {
        word?: string;
        punctuated_word?: string;
        start?: number;
        end?: number;
        speaker?: number;
      }[];
    }[];
  };
  description?: string;
};

/** A finished result split where the speaker changes, one line per speaker. */
export function speakerRuns(
  words: {
    word?: string;
    punctuated_word?: string;
    start?: number;
    end?: number;
    speaker?: number;
  }[],
): { text: string; startMs: number; endMs: number; speaker: string }[] {
  if (!words.length || words.some((word) => typeof word.speaker !== 'number')) return [];
  const runs: { text: string; startMs: number; endMs: number; speaker: string }[] = [];
  for (const word of words) {
    const text = word.punctuated_word ?? word.word ?? '';
    const speaker = String(word.speaker);
    const startMs = Math.round((word.start ?? 0) * 1000);
    const endMs = Math.round((word.end ?? word.start ?? 0) * 1000);
    const last = runs[runs.length - 1];
    if (last && last.speaker === speaker) {
      last.text += ` ${text}`;
      last.endMs = endMs;
    } else runs.push({ text, startMs, endMs, speaker });
  }
  return runs;
}

/**
 * A live Deepgram Nova-3 socket that speaks the OpenAI Realtime events the meeting transport
 * uses. The key rides in the WebSocket subprotocol, as Deepgram accepts from a browser.
 */
export function deepgramLiveSocket(apiKey: string, sampleRate: number, language?: string) {
  const params = new URLSearchParams({
    model: MODEL,
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    // A speaker per word (Deepgram's live diarizer; a small add-on on the key's bill).
    diarize: 'true',
    language: languageParam(language),
  });
  return liveAdapter({
    url: `wss://api.deepgram.com/v1/listen?${params}`,
    protocols: ['token', apiKey],
    keepAlive: { everyMs: 3000, message: JSON.stringify({ type: 'KeepAlive' }) },
    commit: JSON.stringify({ type: 'Finalize' }),
    close: JSON.stringify({ type: 'CloseStream' }),
    translate(raw, emit) {
      const message = raw as DeepgramMessage;
      if (message.type === 'Error') {
        emit.error(message.description ?? 'Deepgram error');
        return;
      }
      if (message.type !== 'Results') return;
      const alternative = message.channel?.alternatives?.[0];
      const text = alternative?.transcript ?? '';
      if (message.is_final || message.from_finalize) {
        const runs = speakerRuns(alternative?.words ?? []);
        if (runs.length) {
          for (const run of runs) emit.final(run.text, run.startMs, run.endMs, run.speaker);
          return;
        }
        const startMs = Math.round((message.start ?? 0) * 1000);
        emit.final(text, startMs, startMs + Math.round((message.duration ?? 0) * 1000));
      } else emit.partial(text);
    },
  });
}
