import { observeTranscriptScope } from '@/lib/transcriptScope';
import i18n from './strings';
import { useBubbleResult } from './bubbleResult';
import { useEffect } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import {
  AndroidDictation,
  dictationEvents,
  type Recording,
} from '../../modules/android-dictation/src';
import {
  AndroidCleanupError,
  createAndroidJob,
  processAndroidAudio,
  type AndroidJob,
} from './pipeline';
import { useConfigStore } from '@/store/useConfigStore';
import { router } from 'expo-router';
import { usePracticeSession } from './practiceSession';

const discard = (audio: Recording | null) => {
  if (audio) void FileSystem.deleteAsync(audio.uri, { idempotent: true }).catch(() => undefined);
};

/** The bubble dictates only: talking over highlighted text replaces it. */
function dictationJob(selection: string): AndroidJob {
  return createAndroidJob(
    'dictate',
    useConfigStore.getState().config?.androidTranslationTarget?.label ?? 'Spanish',
    selection,
  );
}

export function useBubblePipeline() {
  useEffect(() => {
    if (!dictationEvents || !AndroidDictation) return;
    const native = AndroidDictation;
    let job: AndroidJob | null = null;
    let jobError = '';
    let controller: AbortController | null = null;
    // A recording whose transcription failed, kept so the bubble's Retry can send it again.
    let kept: Recording | null = null;
    const dropKept = () => {
      discard(kept);
      kept = null;
    };
    const prepare = (selection: string) => {
      controller?.abort();
      controller = new AbortController();
      job = null;
      jobError = '';
      try {
        job = dictationJob(selection);
      } catch (error) {
        jobError = (error as Error).message;
      }
    };
    const run = async (audio: Recording) => {
      const current = controller;
      if (!current) {
        discard(audio);
        return;
      }
      let keep = false;
      try {
        if (!job) throw new Error(jobError);
        const text = await processAndroidAudio(audio, job, current.signal, () =>
          native.setStatus('processing'),
        );
        if (current.signal.aborted) return;
        const inserted = await native.insert(text);
        if (current.signal.aborted) return;
        if (!inserted) {
          // The words are safe in Home; the bubble offers to open them.
          useBubbleResult.getState().setResult(text, i18n.t('insertionFailed'));
          void native.setStatus('recover');
        } else {
          useBubbleResult.setState({ error: '' });
          usePracticeSession.getState().complete(job.mode);
          void native.setStatus('success');
        }
      } catch (error) {
        if (current.signal.aborted) return;
        if (error instanceof AndroidCleanupError) {
          useBubbleResult.getState().setResult(error.transcript, i18n.t('cleanupRecovery'));
          void native.setStatus('recover');
          return;
        }
        const message = (error as Error).message;
        useBubbleResult.getState().setResult('', message);
        // Silence has nothing worth sending again; anything else keeps the recording for Retry.
        keep = !audio.noSpeech && message !== i18n.t('noSpeech');
        void native.setStatus(keep ? 'retry-kept' : 'retry');
      } finally {
        if (keep) kept = audio;
        else discard(audio);
      }
    };
    const stopObserving = observeTranscriptScope(() => {
      controller?.abort();
      job = null;
      dropKept();
      useBubbleResult.getState().dismiss();
    });
    const start = dictationEvents.addListener('onStart', ({ selection }) => {
      dropKept();
      prepare(selection);
    });
    const recording = dictationEvents.addListener('onRecording', (audio) => {
      void run(audio);
    });
    const retry = dictationEvents.addListener('onRetry', ({ selection }) => {
      const audio = kept;
      kept = null;
      if (!audio) {
        void native.setStatus('retry');
        return;
      }
      prepare(selection);
      void run(audio);
    });
    const dismiss = dictationEvents.addListener('onDismiss', dropKept);
    const failure = dictationEvents.addListener('onError', ({ message }) => {
      useBubbleResult.getState().setResult('', message);
    });
    const cancel = dictationEvents.addListener('onCancel', () => {
      controller?.abort();
      dropKept();
    });
    const recover = dictationEvents.addListener('onOpenResult', () =>
      router.navigate('/(tabs)/(record)'),
    );
    return () => {
      stopObserving();
      controller?.abort();
      dropKept();
      start.remove();
      recording.remove();
      retry.remove();
      dismiss.remove();
      cancel.remove();
      failure.remove();
      recover.remove();
    };
  }, []);
}
