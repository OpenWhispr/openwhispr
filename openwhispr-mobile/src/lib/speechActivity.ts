import { AppGroupStorage, type SpeechActivityAnalysis } from '../../modules/app-group-storage/src';
import { NO_SPEECH_ERROR_MESSAGE } from './permissions';

export type SpeechActivityContext = 'keyboard' | 'recording';

export async function analyzeSpeechActivity(
  audioUri: string,
  context: SpeechActivityContext,
): Promise<SpeechActivityAnalysis | null> {
  const analysis = await AppGroupStorage.analyzeSpeechActivity(audioUri);
  if (__DEV__ && analysis) {
    console.log(
      `[speech-activity] context=${context} noSpeech=${analysis.noSpeechLikely ? '1' : '0'} reason=${
        analysis.reason ?? 'unknown'
      } durationMs=${Math.round(analysis.durationMs)} speechMs=${Math.round(
        analysis.speechActivityMs,
      )} peakDb=${analysis.peakDb.toFixed(1)} noiseFloorDb=${analysis.noiseFloorDb.toFixed(
        1,
      )} thresholdDb=${analysis.thresholdDb.toFixed(1)}`,
    );
  }
  return analysis;
}

export function createNoSpeechError(): Error {
  return new Error(NO_SPEECH_ERROR_MESSAGE);
}

export function serializeSpeechActivityMetrics(
  analysis: SpeechActivityAnalysis,
): Record<string, string> {
  return {
    vad_duration_ms: String(Math.round(analysis.durationMs)),
    vad_analyzed_ms: String(Math.round(analysis.analyzedMs)),
    vad_speech_ms: String(Math.round(analysis.speechActivityMs)),
    vad_speech_ratio: analysis.speechRatio.toFixed(4),
    vad_peak_db: analysis.peakDb.toFixed(1),
    vad_average_db: analysis.averageDb.toFixed(1),
    vad_noise_floor_db: analysis.noiseFloorDb.toFixed(1),
    vad_threshold_db: analysis.thresholdDb.toFixed(1),
    vad_no_speech: analysis.noSpeechLikely ? '1' : '0',
    vad_reason: analysis.reason ?? 'unknown',
    vad_confidence: analysis.confidence.toFixed(2),
  };
}
