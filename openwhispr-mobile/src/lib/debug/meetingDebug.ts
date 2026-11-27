import { ROTATION_MS } from '@/services/transcription/realtimeReconnect';
import type { DiarizationResult } from '@/lib/diarization/diarizer';

// Development-build aids for the meeting device checks. A release build ignores all of it:
// the override is never stored there and the rotation interval is always ROTATION_MS.

export const DEBUG_ROTATION_CHOICES_MS: readonly (number | null)[] = [null, 2 * 60_000, 3 * 60_000];

let rotationOverrideMs: number | null = null;

/** Held in memory only, so a relaunch always starts on the real interval. */
export function setDebugRotationMs(valueMs: number | null): void {
  rotationOverrideMs = __DEV__ && valueMs !== null && valueMs > 0 ? valueMs : null;
}

export function getDebugRotationMs(): number | null {
  return __DEV__ ? rotationOverrideMs : null;
}

/** How long a realtime session runs before the meeting rolls into a fresh one. */
export function meetingRotationMs(): number {
  return getDebugRotationMs() ?? ROTATION_MS;
}

export interface SpeakerPassTimingDeps {
  transcodeToWav(inputUri: string): Promise<{ uri: string; durationMs: number }>;
  diarize(wavUri: string): Promise<DiarizationResult>;
  cleanup(uris: string[]): Promise<void>;
  now(): number;
}

export interface SpeakerPassTiming {
  audioMs: number;
  transcodeMs: number;
  diarizeMs: number;
  speakerCount: number;
  turnCount: number;
}

/**
 * Runs the speaker pass on any audio file and times it, so its cost for a long meeting can
 * be measured on a phone without recording one. The converted copy is always removed.
 */
export async function timeSpeakerPass(
  inputUri: string,
  deps: SpeakerPassTimingDeps,
): Promise<SpeakerPassTiming> {
  const transcodeStartedAt = deps.now();
  const wav = await deps.transcodeToWav(inputUri);
  const diarizeStartedAt = deps.now();
  try {
    const result = await deps.diarize(wav.uri);
    return {
      audioMs: wav.durationMs,
      transcodeMs: diarizeStartedAt - transcodeStartedAt,
      diarizeMs: deps.now() - diarizeStartedAt,
      speakerCount: result.speakerCount,
      turnCount: result.segments.length,
    };
  } finally {
    await deps.cleanup([wav.uri]).catch(() => undefined);
  }
}
