import { AndroidDictation } from '../../modules/android-dictation/src';
import { modelPath, modelReady } from './models';
import { LocalTextModel } from './LocalTextModel';
import { withAndroidInference } from './inferenceQueue';
import { tokenTimingsToWhisperSegments } from '@/android/transcription/parakeetSegments';
import type { TranscriptionResponse } from '@/types';
import i18n from './strings';
import Constants from 'expo-constants';
import {
  canTranscribeMeetings,
  meetingSpeechModel,
  selectedSpeechModel,
  type AndroidSpeechModelId,
} from './speechSelection';
import { speechModelCoversRecording, speechModelSupportsLanguages } from './speechCapabilities';
import { getPreferredTranscriptionLanguages } from '@/lib/transcriptionLanguage';

const diagnostics = __DEV__ || Constants.expoConfig?.extra?.openWhispr?.isDevelopment === true;

let generation = 0;
export const LocalSpeechModel = {
  async transcribe(
    uri: string,
    options: {
      language?: string;
      wordTimestamps?: boolean;
      androidModel?: AndroidSpeechModelId;
      signal?: AbortSignal;
    },
  ): Promise<TranscriptionResponse> {
    const job = generation;
    // Word timings mean a meeting, which uses a meeting model whatever dictation uses.
    const model =
      options.androidModel ??
      (options.wordTimestamps
        ? ((await meetingSpeechModel(
            options.language && options.language !== 'auto' ? [options.language] : undefined,
          )) ?? selectedSpeechModel())
        : selectedSpeechModel());
    return withAndroidInference(async () => {
      if (job !== generation || options.signal?.aborted) throw new Error(i18n.t('cancelled'));
      if (options.wordTimestamps && !canTranscribeMeetings(model))
        throw new Error(i18n.t('meetingSpeechNeeded'));
      const languages =
        options.language && options.language !== 'auto'
          ? [options.language]
          : getPreferredTranscriptionLanguages();
      // A meeting needs every language. Anything else here is a recording to transcribe whole:
      // the model detects its language, so one listed language it knows is enough. Dictation
      // checks the full list before it records (ensureAndroidModels).
      const usable = options.wordTimestamps
        ? speechModelSupportsLanguages(model, languages)
        : speechModelCoversRecording(model, languages);
      if (!usable)
        throw new Error(
          i18n.t(model === 'parakeet-v3' ? 'unsupportedLanguage' : 'moonshineEnglishOnly'),
        );
      if (!(await modelReady(model))) throw new Error(i18n.t('speechDownloadNeeded'));
      await LocalTextModel.release();
      if (model === 'parakeet-v3') await AndroidDictation!.releaseMoonshine();
      else await AndroidDictation!.releaseParakeet();
      if (job !== generation || options.signal?.aborted) throw new Error(i18n.t('cancelled'));
      // The native engine decodes compressed uploads and owns its temporary PCM file.
      const cancel = () => {
        if (model === 'parakeet-v3') AndroidDictation!.cancelParakeet();
        else AndroidDictation!.cancelMoonshine();
      };
      options.signal?.addEventListener('abort', cancel, { once: true });
      const result = await (async () =>
        model === 'parakeet-v3'
          ? await AndroidDictation!.transcribeParakeet(uri, modelPath(model))
          : await AndroidDictation!.transcribeMoonshine(uri, modelPath(model), model))().finally(
        () => options.signal?.removeEventListener('abort', cancel),
      );
      if (job !== generation || options.signal?.aborted) throw new Error(i18n.t('cancelled'));
      if (diagnostics)
        console.log(`[android-speech] model=${model} elapsedMs=${result.processingMs}`);
      return {
        text: result.text,
        duration: result.duration,
        processingMs: result.processingMs,
        provider: 'local',
        endpoint: model,
        ...(options.wordTimestamps && result.tokenTimings
          ? { segments: tokenTimingsToWhisperSegments(result.tokenTimings) }
          : {}),
      };
    });
  },
  cancel() {
    generation++;
    AndroidDictation?.cancelParakeet();
    AndroidDictation?.cancelMoonshine();
  },
};
