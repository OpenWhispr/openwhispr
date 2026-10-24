import { AndroidDictation } from '../../../modules/android-dictation/src';
import { downloadAndroidModel, modelPath, modelReady, removeAndroidModel } from '@/android/models';
import { withAndroidInference } from '@/android/inferenceQueue';
import { LocalTextModel } from '@/android/LocalTextModel';
import i18n from '@/android/strings';
import type { Diarizer } from './diarizer';

let generation = 0;
const model = 'meeting-speakers';

export const AndroidDiarizer: Diarizer = {
  isAvailable: () => typeof AndroidDictation?.diarize === 'function',
  isModelDownloaded: () => modelReady(model),
  downloadModel: (onProgress) => downloadAndroidModel(model, onProgress),
  deleteModel: () => removeAndroidModel(model),
  diarize(uri, numberOfSpeakers = 0) {
    const job = generation;
    const assertCurrent = () => {
      if (job !== generation) throw new Error(i18n.t('cancelled'));
    };
    return withAndroidInference(async () => {
      assertCurrent();
      if (!(await modelReady(model))) throw new Error(i18n.t('meetingModelNeeded'));
      // ASR, text generation and speaker separation share one inference queue.
      // Drop the idle weights before allocating the speaker models/audio buffers.
      await LocalTextModel.release();
      await AndroidDictation!.releaseParakeet();
      await AndroidDictation!.releaseMoonshine();
      assertCurrent();
      const result = await AndroidDictation!.diarize(uri, modelPath(model), numberOfSpeakers);
      assertCurrent();
      return result;
    });
  },
  cancel() {
    generation++;
    AndroidDictation?.cancelDiarization();
  },
};
