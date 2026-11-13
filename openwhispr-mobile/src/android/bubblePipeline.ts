import { observeTranscriptScope } from '@/lib/transcriptScope';
import i18n from './strings';
import { useBubbleResult } from './bubbleResult';
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
import { usePracticeSession } from './practiceSession';
import { bootAppData } from './appData';
import { useAccountData } from './accountData';
import { runHeadlessStartup } from './headlessStartup';

const discard = (audio: Recording | null) => {
  if (audio) void FileSystem.deleteAsync(audio.uri, { idempotent: true }).catch(() => undefined);
};

/** The bubble dictates only: talking over highlighted text replaces it. */
async function dictationJob(selection: string): Promise<AndroidJob> {
  // The bubble can run before the app is opened; its data must be loaded first.
  await bootAppData();
  const { error, blocked } = useAccountData.getState();
  if (error || blocked) throw new Error(error ?? i18n.t('bootError'));
  return createAndroidJob(
    'dictate',
    useConfigStore.getState().config?.androidTranslationTarget?.label ?? 'Spanish',
    selection,
  );
}

let started = false;

/**
 * Wires the bubble's events to transcription and insertion, once per JS runtime: the app and the
 * bubble's headless task both start it. Then tells the bubble it is listening.
 */
export function startBubblePipeline(): void {
  if (started || !dictationEvents || !AndroidDictation) return;
  started = true;
  const native = AndroidDictation;
  let job: Promise<AndroidJob> | null = null;
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
    job = dictationJob(selection);
    // Reported when the recording arrives; a dictation cancelled before then has nothing to report.
    job.catch(() => undefined);
  };
  const run = async (audio: Recording) => {
    const current = controller;
    const pending = job;
    if (!current || !pending) {
      discard(audio);
      return;
    }
    let keep = false;
    try {
      const prepared = await pending;
      if (current.signal.aborted) return;
      const text = await processAndroidAudio(audio, prepared, current.signal, () =>
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
        usePracticeSession.getState().complete(prepared.mode);
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
  observeTranscriptScope(() => {
    controller?.abort();
    job = null;
    dropKept();
    useBubbleResult.getState().dismiss();
  });
  dictationEvents.addListener('onStart', ({ selection }) => {
    dropKept();
    prepare(selection);
  });
  dictationEvents.addListener('onRecording', (audio) => {
    void run(audio);
  });
  dictationEvents.addListener('onRetry', ({ selection }) => {
    const audio = kept;
    kept = null;
    if (!audio) {
      void native.setStatus('retry');
      return;
    }
    prepare(selection);
    void run(audio);
  });
  dictationEvents.addListener('onDismiss', dropKept);
  dictationEvents.addListener('onError', ({ message }) => {
    useBubbleResult.getState().setResult('', message);
  });
  dictationEvents.addListener('onCancel', () => {
    controller?.abort();
    dropKept();
  });
  void native.pipelineReady();
}

/**
 * The bubble's headless task: runs while a dictation is in flight with no app on screen. It never
 * settles; the bubble ends it once the dictation does.
 */
export function bubblePipelineTask(): Promise<void> {
  runHeadlessStartup();
  startBubblePipeline();
  return new Promise<void>(() => undefined);
}
