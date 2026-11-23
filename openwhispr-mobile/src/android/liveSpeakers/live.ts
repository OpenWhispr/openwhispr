import { Buffer } from 'buffer';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { meetingAudioDirectory } from '@/lib/meetingAudioStorage';
import type {
  RealtimeMeetingDeps,
  WebSocketLike,
} from '@/services/transcription/createRealtimeMeetingWs';
import { modelPath, modelReady } from '@/android/models';
import { createLineClock, type LineSpan } from './lineClock';
import { createLiveSpeakers } from './liveSpeakers';
import { prefetchSpeakerModel } from './speakerModel';

export const MODEL = 'meeting-speakers';
const SAMPLE_RATE = 24000; // MeetingCaptureService only records meetings at 24 kHz.
export const log = (message: string) => console.info(message);

export const meetingWavUri = (noteId: number): string | null => {
  const directory = meetingAudioDirectory();
  return directory ? `${directory}meeting-${noteId}.wav` : null;
};

export interface LiveSpeakerResult {
  labels: Record<string, string>;
  spans: Record<string, LineSpan>;
  providerLabelled: boolean;
}

/**
 * Speaker labels for one live meeting: wraps the meeting's sockets to keep each line on the WAV's
 * clock, counts the captured audio, and labels lines as they finish. Start it before the
 * transport so it sees the first audio frame.
 */
export function startLiveSpeakers(options: {
  noteId: number;
  expectedSpeakers?: number;
  onChange(labels: Record<string, string>): void;
}) {
  const wav = meetingWavUri(options.noteId);
  const speakers = createLiveSpeakers(
    {
      embed: (startMs, endMs) => {
        if (!wav || !AndroidDictation) return Promise.reject(new Error('No meeting audio.'));
        return AndroidDictation.speakerEmbedding(wav, modelPath(MODEL), startMs, endMs);
      },
      modelReady: () => modelReady(MODEL),
      log,
    },
    { maxSpeakers: options.expectedSpeakers || undefined, onChange: options.onChange },
  );
  const clock = createLineClock({ sampleRate: SAMPLE_RATE, onLine: speakers.line });
  const { addPcmFrameListener } =
    require('../../../modules/live-pcm-streaming/src/index.android') as typeof import('../../../modules/live-pcm-streaming/src/index.android');
  const frames = addPcmFrameListener((frame) => {
    clock.captured(Buffer.byteLength(frame.audio, 'base64'));
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    frames?.remove();
    speakers.stop();
    AndroidDictation?.releaseSpeakerEmbedder();
  };
  return {
    /** The meeting deps with every leg's socket wrapped (the default socket when none is given). */
    wrap(deps: RealtimeMeetingDeps = {}): RealtimeMeetingDeps {
      return {
        ...deps,
        wsFactory: clock.wrapFactory(
          deps.wsFactory as ((url: string, protocols: string[]) => WebSocketLike) | undefined,
        ),
      };
    },
    labels: speakers.labels,
    /** Lets the last lines' voiceprints land before the meeting saves. */
    drain: (timeoutMs = 4000) => speakers.drain(timeoutMs),
    result(): LiveSpeakerResult {
      return {
        labels: speakers.labels(),
        spans: speakers.spans(),
        providerLabelled: speakers.providerLabelled(),
      };
    },
    stop,
  };
}

/** Speaker labelling for a live meeting's hook; also fetches the model for the next one. */
export function startSpeakers(
  noteId: number | undefined,
  onChange: (labels: Record<string, string>) => void,
): ReturnType<typeof startLiveSpeakers> | null {
  void prefetchSpeakerModel();
  if (noteId == null) return null;
  try {
    return startLiveSpeakers({ noteId, onChange });
  } catch (error) {
    log(`[live-speakers] not started: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Settles labelling once the meeting has stopped: the last voiceprints, then the result. */
export async function finishSpeakers(
  live: ReturnType<typeof startLiveSpeakers> | null,
): Promise<LiveSpeakerResult | null> {
  if (!live) return null;
  try {
    await live.drain();
    return live.result();
  } finally {
    live.stop();
  }
}
