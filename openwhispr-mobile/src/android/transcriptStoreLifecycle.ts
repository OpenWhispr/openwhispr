import {
  captureTranscriptScope,
  isTranscriptScopeCurrent,
  observeTranscriptScope,
} from '@/lib/transcriptScope';
import { abortError } from '@/services/providers/NativeProviderTransport';
import { StorageService } from '@/services/storage/StorageService';
import {
  garbageCollectTranscriptAudio,
  releaseTranscriptAudio,
} from '@/lib/transcriptAudio.android';
import type {
  TranscriptLifecycle,
  TranscriptLifecycleContext,
} from '@/store/transcriptStoreLifecycle';

export interface AndroidTranscriptExtension {
  reset: () => void;
}

export function createAndroidTranscriptLifecycle({
  set,
  get,
  resetLoad,
}: TranscriptLifecycleContext<AndroidTranscriptExtension>): TranscriptLifecycle<AndroidTranscriptExtension> {
  let generation = 0;
  let observing = false;
  return {
    extraState: {
      reset: () => {
        generation += 1;
        resetLoad();
        set({
          transcripts: [],
          currentTranscript: null,
          isLoading: false,
          isLoaded: false,
          error: null,
        });
      },
    },
    protectNewerLoad: true,
    context: () => {
      if (!observing) {
        observing = true;
        observeTranscriptScope(() => get().reset());
      }
      const scope = captureTranscriptScope();
      const epoch = generation;
      const current = () => epoch === generation && isTranscriptScopeCurrent(scope);
      const assertCurrent = () => {
        if (!current()) throw abortError('The account changed. Please try again.');
      };
      const owner = scope?.key ?? null;
      return {
        owner,
        isCurrent: current,
        assertCurrent,
        get: () => {
          assertCurrent();
          return get();
        },
        set: (value) => {
          if (current()) set(value);
        },
        readHistory: () => StorageService.getTranscripts(owner),
        saveHistory: (rows) => StorageService.saveTranscripts(rows, owner),
        clearHistory: () => StorageService.clearTranscripts(owner),
        otherAudio: () => (owner === null ? [] : StorageService.getAllTranscriptAudio()),
        collectAudio: (keepUris) =>
          owner === null
            ? garbageCollectTranscriptAudio(keepUris)
            : garbageCollectTranscriptAudio(keepUris, {
                isCurrent: current,
                currentKeepUris: () => StorageService.getAllTranscriptAudio(),
              }),
      };
    },
    failedIdentity: (input) => ({ clientTranscriptionId: input.clientTranscriptionId }),
    afterFailedSave: (audioUrl) => releaseTranscriptAudio(audioUrl),
    privateRetryMessage: () =>
      'This recording used a remote provider. Turn off Local Mode in Account → AI Models to retry its original route.',
    beginRetry: (access, externalSignal) => {
      const controller = new AbortController();
      const signal = controller.signal;
      const abort = () => controller.abort();
      let stopObserving = () => {};
      return {
        assertActive: () => {
          access.assertCurrent();
          if (signal.aborted || externalSignal?.aborted)
            throw abortError('Transcription cancelled.');
        },
        requestSignal: { signal },
        identity: (current) => ({
          clientTranscriptionId: current.clientTranscriptionId ?? current.jobId ?? current.id,
        }),
        connect: () => {
          externalSignal?.addEventListener('abort', abort, { once: true });
          stopObserving = observeTranscriptScope(abort);
        },
        handleError: (error) => {
          if (signal.aborted || (error as Error)?.name === 'AbortError') {
            access.set({ isLoading: false });
            throw abortError('Transcription cancelled.');
          }
        },
        dispose: () => {
          stopObserving();
          externalSignal?.removeEventListener('abort', abort);
          access.set({ isLoading: false });
        },
      };
    },
  };
}
