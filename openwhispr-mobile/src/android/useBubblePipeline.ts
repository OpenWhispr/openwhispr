import i18n from './strings';
import { useBubbleResult } from './bubbleResult';
import { useEffect } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import { AndroidDictation, dictationEvents } from '../../modules/android-dictation/src';
import {
  AndroidCleanupError,
  createAndroidJob,
  processAndroidAudio,
  type AndroidJob,
} from './pipeline';
import { useConfigStore } from '@/store/useConfigStore';
import { useTranslation } from 'react-i18next';
import { router } from 'expo-router';
import { usePracticeSession } from './practiceSession';

export function useBubblePipeline() {
  const { t } = useTranslation();
  const target = useConfigStore((s) => s.config?.androidTranslationTarget?.label ?? 'Spanish');
  useEffect(() => {
    AndroidDictation?.setBubbleOptions({
      dictate: t('dictate'),
      translate: t('translateInto', { language: target }),
      write: t('write'),
      edit: t('editSelection'),
      hold: t('bubbleHold'),
      chooseAction: t('chooseAction'),
      cancelOrClose: t('cancelOrClose'),
      recover: t('recoverDictation'),
      processing: t('processing'),
      success: t('inserted'),
      selectToEdit: t('selectToEdit'),
    }).catch(() => undefined);
  }, [target, t]);
  useEffect(() => {
    if (!dictationEvents || !AndroidDictation) return;
    const native = AndroidDictation;
    let job: AndroidJob | null = null;
    let jobError = '';
    let controller: AbortController | null = null;
    const start = dictationEvents.addListener('onStart', ({ selection, mode }) => {
      controller?.abort();
      controller = new AbortController();
      job = null;
      jobError = '';
      try {
        job = createAndroidJob(
          mode,
          useConfigStore.getState().config?.androidTranslationTarget?.label ?? 'Spanish',
          selection,
        );
      } catch (error) {
        jobError = (error as Error).message;
      }
    });
    const recording = dictationEvents.addListener('onRecording', async (audio) => {
      const current = controller;
      if (!current) {
        await FileSystem.deleteAsync(audio.uri, { idempotent: true }).catch(() => undefined);
        return;
      }
      try {
        if (!job) throw new Error(jobError);
        const text = await processAndroidAudio(audio, job, current.signal, () =>
          native.setStatus('processing'),
        );
        if (current.signal.aborted) return;
        const inserted = await native.insert(text);
        if (current.signal.aborted) return;
        if (!inserted) useBubbleResult.getState().setResult(text, i18n.t('insertionFailed'));
        else {
          useBubbleResult.setState({ error: '' });
          usePracticeSession.getState().complete(job.mode);
        }
        void native.setStatus(inserted ? 'success' : 'error');
      } catch (error) {
        if (!current.signal.aborted) {
          useBubbleResult
            .getState()
            .setResult(
              error instanceof AndroidCleanupError ? error.transcript : '',
              error instanceof AndroidCleanupError
                ? i18n.t('cleanupRecovery')
                : (error as Error).message,
            );
          void native.setStatus('error');
        }
      } finally {
        await FileSystem.deleteAsync(audio.uri, { idempotent: true }).catch(() => undefined);
      }
    });
    const failure = dictationEvents.addListener('onError', ({ message }) => {
      useBubbleResult.getState().setResult('', message);
    });
    const cancel = dictationEvents.addListener('onCancel', () => controller?.abort());
    const recover = dictationEvents.addListener('onOpenResult', () =>
      router.navigate('/(tabs)/(record)'),
    );
    return () => {
      controller?.abort();
      start.remove();
      recording.remove();
      cancel.remove();
      failure.remove();
      recover.remove();
    };
  }, []);
}
