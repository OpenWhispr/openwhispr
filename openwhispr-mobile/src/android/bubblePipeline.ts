import { observeFieldLearning } from './dictionary/fieldLearning';
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
  assistantRoute,
  createAndroidJob,
  processAndroidAudio,
  type AndroidJob,
  type DictationMode,
} from './pipeline';
import { bubbleFailure, bubbleMode } from './bubbleOutcome';
import { snapshotTranscriptionJob } from '@/lib/inferenceRouting';
import { requiresRealAccount } from '@/android/lib/accountAccess';
import { useAuthStore } from '@/android/store/useAuthStore';
import { useConfigStore } from '@/android/store/useConfigStore';
import { usePracticeSession } from './practiceSession';
import { bootAppData } from './appData';
import { useAccountData } from './accountData';
import { runHeadlessStartup } from './headlessStartup';
import { dlog } from '@/android/lib/debugLog';
import { failureFields } from './dictation/dictationLog';

const discard = (audio: Recording | null) => {
  if (audio) void FileSystem.deleteAsync(audio.uri, { idempotent: true }).catch(() => undefined);
};

const translateTarget = () =>
  useConfigStore.getState().config?.androidTranslationTarget?.label ?? 'Spanish';

/**
 * A tap dictates (talking over highlighted text replaces it); the hold menu picks Assistant (write),
 * Translate, or Edit selection, which arrive as the onStart event's mode.
 */
async function dictationJob(
  selection: string,
  mode: DictationMode,
  app: string | undefined,
  run?: string,
): Promise<AndroidJob> {
  // The bubble can run before the app is opened; its data must be loaded first.
  await bootAppData();
  const { error, blocked } = useAccountData.getState();
  if (error || blocked) {
    dlog.warn('pipe', 'job.blocked', { run, why: error ? 'account_error' : 'blocked' });
    throw new Error(error ?? i18n.t('bootError'));
  }
  return createAndroidJob(mode, translateTarget(), selection, app, run);
}

/** Why the Assistant can't run right now, for the menu's greyed row: "" when it can. */
function assistantBlock(): '' | 'sign-in' | 'unavailable' {
  try {
    const assistant = assistantRoute(snapshotTranscriptionJob('dictation', ['cleanup', 'agent']));
    if (assistant.unavailable) return 'unavailable';
    if (assistant.route?.mode === 'openwhispr' && requiresRealAccount(useAuthStore.getState().user))
      return 'sign-in';
    return '';
  } catch {
    return 'unavailable';
  }
}

let sentMenu = '';
/**
 * Tells the bubble what its hold menu shows; it keeps the values for its next start. Runs on every
 * config or sign-in change, so only a changed menu reaches the bubble.
 */
export function syncBubbleMenu(): void {
  const context = { translateTarget: translateTarget(), assistantBlock: assistantBlock() };
  const key = JSON.stringify(context);
  if (key === sentMenu) return;
  sentMenu = key;
  AndroidDictation?.setMenuContext?.(context);
}

// Home's "A meeting is recording" copy, loaded on use: Home's strings register their own bundle.
function meetingRecordingCopy(fallback: string): string {
  try {
    const { HOME_NAMESPACE } = require('./home/strings') as typeof import('./home/strings');
    return i18n.t('meetingRecording', { ns: HOME_NAMESPACE });
  } catch {
    return fallback;
  }
}

const PIPELINE_MESSAGES = () => ({
  noSpeech: i18n.t('noSpeech'),
  speechDownloadNeeded: i18n.t('speechDownloadNeeded'),
  textDownloadNeeded: i18n.t('textDownloadNeeded'),
});

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
  // A dictation the account change cut off: it must still settle, or the bubble keeps "Writing".
  let abandoned: AbortController | null = null;
  const stopped = (current: AbortController) => {
    if (current.signal.aborted && current === abandoned) {
      dlog.warn('pipe', 'abandoned', { why: 'account_change' });
      void native.setStatus('retry', { message: 'failed' });
    }
    return current.signal.aborted;
  };
  const prepare = (
    selection: string,
    mode: DictationMode,
    app: string | undefined,
    run?: string,
  ) => {
    controller?.abort();
    controller = new AbortController();
    dlog.info('pipe', 'job.prepare', { run, mode, selection: !!selection, pkg: app || undefined });
    job = dictationJob(selection, mode, app, run);
    // Reported when the recording arrives; a dictation cancelled before then has nothing to report.
    job.catch(() => undefined);
  };
  const run = async (audio: Recording & { run?: string }) => {
    const current = controller;
    const pending = job;
    const runId = audio.run;
    if (!current || !pending) {
      // The account changed after this dictation started; there is nothing to write it into.
      dlog.warn('pipe', 'abandoned', { run: runId, why: 'no_job' });
      discard(audio);
      void native.setStatus('retry', { message: 'failed' });
      return;
    }
    let keep = false;
    try {
      const prepared = await pending;
      if (stopped(current)) return;
      dlog.info('pipe', 'job.ready', {
        run: runId,
        mode: prepared.mode,
        audio_ms: audio.durationMs,
      });
      const text = await processAndroidAudio(audio, prepared, current.signal, () =>
        native.setStatus('processing'),
      );
      if (stopped(current)) return;
      // Edited words stay highlighted a moment so the change is easy to see.
      const inserted = await native.insert(text, {
        highlight: prepared.mode === 'edit',
        run: runId,
      });
      if (stopped(current)) return;
      dlog.info('pipe', 'result', {
        run: runId,
        status: inserted ? 'success' : 'not_inserted',
        chars: text.length,
      });
      if (!inserted) {
        // The words are safe in Home; the bubble offers to open them. With typing access off
        // nothing can paste, so they also go on the clipboard and the tab offers to turn it on.
        useBubbleResult.getState().setResult(text, i18n.t('insertionFailed'));
        const typingOff = native.copyText && !native.getStatus().accessibility;
        if (typingOff) native.copyText!(text);
        void native.setStatus(typingOff ? 'copied' : 'recover');
      } else {
        useBubbleResult.setState({ error: '' });
        usePracticeSession.getState().complete(prepared.mode);
        void native.setStatus('success');
      }
    } catch (error) {
      if (stopped(current)) return;
      if (error instanceof AndroidCleanupError) {
        dlog.warn('pipe', 'result', { run: runId, status: 'recover', why: 'cleanup_warning' });
        useBubbleResult.getState().setResult(error.transcript, i18n.t('cleanupRecovery'));
        void native.setStatus('recover');
        return;
      }
      const message = (error as Error).message;
      useBubbleResult.getState().setResult('', message);
      // Each failure has its own words in the status tab. Silence, a used-up plan, signing out and a
      // missing model have nothing worth sending again; anything else keeps the recording for Retry.
      const failure = bubbleFailure(error, audio.noSpeech, PIPELINE_MESSAGES());
      keep = failure.keep;
      dlog.error('pipe', 'result', {
        ...failureFields(error),
        run: runId,
        status: keep ? 'retry_kept' : 'retry',
        reason: failure.message,
      });
      void native.setStatus(keep ? 'retry-kept' : 'retry', { message: failure.message });
    } finally {
      if (keep) kept = audio;
      else discard(audio);
    }
  };
  let owner = useAccountData.getState().owner;
  observeTranscriptScope(() => {
    const previous = owner;
    owner = useAccountData.getState().owner;
    // Account data loading for the first time (while a dictation from a restored bubble waits
    // on it) changes nothing a job holds: no job can capture a scope before there is an owner.
    if (!previous) return;
    // Only a dictation still running; one the user cancelled already settled.
    if (controller && !controller.signal.aborted) {
      abandoned = controller;
      dlog.warn('pipe', 'account_change', { why: 'running_job_abandoned' });
    }
    controller?.abort();
    job = null;
    dropKept();
    useBubbleResult.getState().dismiss();
  });
  let lastMode: DictationMode = 'dictate';
  dictationEvents.addListener('onStart', ({ selection, mode, app, run }) => {
    dropKept();
    lastMode = bubbleMode(mode, selection);
    prepare(selection, lastMode, app, run);
  });
  dictationEvents.addListener('onRecording', (audio) => {
    void run(audio);
  });
  dictationEvents.addListener('onRetry', ({ selection, app }) => {
    const audio = kept;
    kept = null;
    if (!audio) {
      void native.setStatus('retry', { message: 'failed' });
      return;
    }
    // A retried take runs in the mode it was recorded in.
    const retryRun = (audio as Recording & { run?: string }).run;
    dlog.info('pipe', 'retry', { run: retryRun, audio_ms: audio.durationMs });
    prepare(selection, bubbleMode(lastMode, selection), app, retryRun);
    void run(audio);
  });
  dictationEvents.addListener('onDismiss', dropKept);
  dictationEvents.addListener('onError', ({ message, owner, run }) => {
    dlog.warn('pipe', 'bubble_error', { run, owner: owner || undefined });
    // The microphone is the meeting's: say so, rather than the recorder's own refusal.
    useBubbleResult
      .getState()
      .setResult('', owner === 'meeting' ? meetingRecordingCopy(message) : message);
  });
  dictationEvents.addListener('onCancel', () => {
    controller?.abort();
    dropKept();
  });
  syncBubbleMenu();
  useConfigStore.subscribe(syncBubbleMenu);
  useAuthStore.subscribe(syncBubbleMenu);
  // Dictionary's C11: a word fixed in the field the bubble just typed into is learned.
  observeFieldLearning();
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
