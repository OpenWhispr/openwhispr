import { isProviderJobActive } from '@/lib/providerJobActivity';
import { AppGroupStorage } from '../../modules/app-group-storage/src';
import { create } from 'zustand';
import {
  listPendingProviderRecoveryJobs,
  clearKeyboardProviderRecovery,
} from '@/lib/keyboardInferenceRoute';
import { AudioTools } from '../../modules/audio-tools/src';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { getPreferredTranscriptionLanguage } from '@/lib/transcriptionLanguage';
import { toFriendlyTranscriptionErrorMessage } from '@/lib/transcriptionErrors';
import {
  deleteManagedTranscriptAudio,
  garbageCollectTranscriptAudio,
  isManagedTranscriptAudioUri,
  isWavAudioFile,
  retainTranscriptAudio,
  RETAINED_AUDIO_MAX_AGE_MS,
  transcriptAudioExists,
} from '@/lib/transcriptAudio';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { snapshotTextInference, snapshotTranscriptionJob } from '@/lib/inferenceRouting';
import { logTranscriptionCompleted } from '@/lib/appsflyer';
import type { KeyboardTone, Transcript, TranscriptionProvider } from '../types';
import { StorageService } from '../services/storage/StorageService';

export type AddTranscriptInput = Omit<Transcript, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
};

export type FailedTranscriptInput = {
  id?: string;
  audioUrl: string;
  audioFileName?: string;
  audioMimeType?: string;
  duration?: number;
  provider: TranscriptionProvider;
  inferenceRoute?: Transcript['inferenceRoute'];
  cleanupRoute?: Transcript['cleanupRoute'];
  agentRoute?: Transcript['agentRoute'];
  cleanupUnavailable?: string;
  agentUnavailable?: string;
  requestContext?: Transcript['requestContext'];
  keyboardTone?: KeyboardTone;
  jobId?: string;
  errorMessage: string;
};

interface TranscriptState {
  transcripts: Transcript[];
  currentTranscript: Transcript | null;
  isLoading: boolean;
  // True once the stored history has been read. Every write persists the whole
  // list, so a write before the first read would replace history with one row.
  isLoaded: boolean;
  error: string | null;

  loadTranscripts: () => Promise<void>;
  addTranscript: (transcript: AddTranscriptInput) => Promise<void>;
  addFailedTranscript: (transcript: FailedTranscriptInput) => Promise<void>;
  retryTranscript: (id: string) => Promise<Transcript>;
  updateTranscript: (id: string, updates: Partial<Transcript>) => Promise<void>;
  deleteTranscript: (id: string) => Promise<void>;
  setCurrentTranscript: (transcript: Transcript | null) => void;
  clearTranscripts: () => Promise<void>;
}

export function createTranscriptId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const normalizeTranscript = (transcript: Transcript): Transcript => ({
  ...transcript,
  status: transcript.status ?? 'completed',
  retryCount: transcript.retryCount ?? 0,
});

const ensureRetainedAudio = async (
  transcriptId: string,
  audioUrl?: string,
  audioFileName?: string,
  audioMimeType?: string,
): Promise<string | undefined> => {
  if (!audioUrl) return undefined;
  if (isManagedTranscriptAudioUri(audioUrl)) return audioUrl;
  return retainTranscriptAudio(audioUrl, { transcriptId, audioFileName, audioMimeType });
};

const RETRY_JOB_ID = /^(.+)-retry-\d+$/;

// Shared so a write that has to wait for history and the app's own startup load
// read storage once.
let inFlightLoad: Promise<void> | null = null;
// History reads and the storage step of each write run one at a time, so a reload
// can't collect audio a write is about to point at or replace a list it just saved.
let historyQueue: Promise<unknown> = Promise.resolve();
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const run = historyQueue.then(operation, operation);
  historyQueue = run.catch(() => undefined);
  return run;
}

export const useTranscriptStore = create<TranscriptState>((set, get) => {
  const ensureLoaded = async (): Promise<void> => {
    if (!get().isLoaded) await get().loadTranscripts();
    if (!get().isLoaded) throw new Error('Transcript history is unavailable. Try again.');
  };

  const readHistory = async (): Promise<void> => {
    set({ isLoading: true, error: null });
    try {
      const now = Date.now();
      const loaded = (await StorageService.getTranscripts()).map(normalizeTranscript);
      const pendingJobs = listPendingProviderRecoveryJobs();
      const activeKeyboardJobId = AppGroupStorage.getItem('keyboard_recording_job_id');
      const recoveredJobIds: string[] = [];
      for (const job of pendingJobs) {
        // The keyboard handoff owns insertion and cleanup for its active job.
        if (
          job.jobId === activeKeyboardJobId ||
          isProviderJobActive(job.jobId) ||
          job.error ||
          !job.route
        )
          continue;
        // A retry saves its recovery entry as `<job id>-retry-<ms>`. One killed
        // mid-request belongs to the row it was retrying, which still has its audio.
        const retriedKey = RETRY_JOB_ID.exec(job.jobId)?.[1];
        const retriedIndex = retriedKey
          ? loaded.findIndex((row) => row.id === retriedKey || row.jobId === retriedKey)
          : -1;
        if (retriedIndex >= 0) {
          const retried = loaded[retriedIndex];
          if (job.result) {
            loaded[retriedIndex] = {
              ...retried,
              ...job.route,
              text: job.result.text,
              originalText: job.result.text,
              updatedAt: now,
              status: 'completed',
              audioUrl: undefined,
              cleanupWarning:
                'Recovered the raw transcript after an interruption. Cleanup was not repeated.',
              errorMessage: undefined,
              retryCount: (retried.retryCount ?? 0) + 1,
            };
          }
        } else if (!loaded.some((row) => row.id === job.jobId || row.jobId === job.jobId)) {
          if (!job.result && !job.audioUri) continue;
          loaded.push({
            ...job.route,
            id: job.jobId,
            jobId: job.jobId,
            text: job.result?.text ?? '',
            originalText: job.result?.text,
            createdAt: now,
            updatedAt: now,
            requestContext: job.requestContext,
            status: job.result ? 'completed' : 'failed',
            audioUrl: job.result ? undefined : job.audioUri,
            cleanupWarning: job.result
              ? 'Recovered the raw transcript after an interruption. Cleanup was not repeated.'
              : undefined,
            errorMessage: job.result
              ? undefined
              : 'The provider upload was interrupted. Retry uses the original provider.',
            retryCount: 0,
          });
        }
        recoveredJobIds.push(job.jobId);
      }

      // Expire retained audio for failed rows past the retention window: drop the
      // uri so the row becomes non-retryable, and let the GC below delete the file.
      let mutated = recoveredJobIds.length > 0;
      const transcripts = loaded.map((transcript) => {
        if (
          transcript.status === 'failed' &&
          isManagedTranscriptAudioUri(transcript.audioUrl) &&
          now - transcript.updatedAt > RETAINED_AUDIO_MAX_AGE_MS
        ) {
          mutated = true;
          return { ...transcript, audioUrl: undefined };
        }
        return transcript;
      });
      if (mutated) {
        await StorageService.saveTranscripts(transcripts);
      }
      set({ transcripts, isLoading: false, isLoaded: true });
      for (const jobId of recoveredJobIds) clearKeyboardProviderRecovery(jobId);

      // Reclaim every managed file no surviving row still points at — expired
      // audio (cleared above) plus orphans from interrupted captures.
      const keepUris = transcripts
        .map((transcript) => transcript.audioUrl)
        .filter((uri): uri is string => isManagedTranscriptAudioUri(uri));
      for (const job of pendingJobs) {
        if (!recoveredJobIds.includes(job.jobId) && isManagedTranscriptAudioUri(job.audioUri)) {
          keepUris.push(job.audioUri!);
        }
      }
      const pendingJobId = activeKeyboardJobId;
      const pendingAudio =
        pendingJobId && AppGroupStorage.getItem(`keyboard_upload_audio.${pendingJobId}`);
      if (
        pendingAudio &&
        isManagedTranscriptAudioUri(pendingAudio) &&
        !keepUris.includes(pendingAudio)
      )
        keepUris.push(pendingAudio);
      await garbageCollectTranscriptAudio(keepUris).catch((error) => {
        if (__DEV__) {
          console.warn('[transcripts] audio garbage collection failed:', error);
        }
      });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  };

  return {
    transcripts: [],
    currentTranscript: null,
    isLoading: false,
    isLoaded: false,
    error: null,

    loadTranscripts: () => {
      inFlightLoad ??= exclusive(readHistory).finally(() => {
        inFlightLoad = null;
      });
      return inFlightLoad;
    },

    addTranscript: async (transcript) => {
      await ensureLoaded();
      const id = transcript.id ?? createTranscriptId();
      const now = Date.now();
      const newTranscript: Transcript = {
        ...transcript,
        id,
        // A completed transcript is never retried, so it has no use for its audio.
        audioUrl: undefined,
        status: 'completed',
        errorMessage: undefined,
        retryCount: transcript.retryCount ?? 0,
        createdAt: now,
        updatedAt: now,
      };

      set({ isLoading: true, error: null });
      try {
        await exclusive(async () => {
          const transcripts = [
            ...get().transcripts.filter((existing) => existing.id !== newTranscript.id),
            newTranscript,
          ];
          await StorageService.saveTranscripts(transcripts);
          set({ transcripts, isLoading: false });
        });
        if (newTranscript.jobId) clearKeyboardProviderRecovery(newTranscript.jobId);
        if (newTranscript.text.trim()) {
          logTranscriptionCompleted({
            source: newTranscript.requestContext ?? 'recording',
            provider: newTranscript.provider,
          });
        }
        // Release any retained copy (e.g. a previously-failed row with the same id
        // whose retry just succeeded) once the completed state is persisted.
        // Best-effort: deletion is idempotent and a leftover file is only waste.
        await deleteManagedTranscriptAudio(transcript.audioUrl).catch((cleanupError) => {
          if (__DEV__) {
            console.warn('[transcripts] failed to release retained audio:', cleanupError);
          }
        });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
        throw error;
      }
    },

    addFailedTranscript: async (transcript) => {
      await ensureLoaded();
      return exclusive(async () => {
        const id = transcript.id ?? createTranscriptId();
        const now = Date.now();
        const audioUrl = await ensureRetainedAudio(
          id,
          transcript.audioUrl,
          transcript.audioFileName,
          transcript.audioMimeType,
        );
        if (!audioUrl) {
          throw new Error('Audio file not found');
        }

        const failedTranscript: Transcript = {
          id,
          text: '',
          createdAt: now,
          updatedAt: now,
          audioUrl,
          audioFileName: transcript.audioFileName,
          audioMimeType: transcript.audioMimeType,
          duration: transcript.duration,
          provider: transcript.provider,
          inferenceRoute: transcript.inferenceRoute,
          cleanupRoute: transcript.cleanupRoute,
          agentRoute: transcript.agentRoute,
          cleanupUnavailable: transcript.cleanupUnavailable,
          agentUnavailable: transcript.agentUnavailable,
          status: 'failed',
          errorMessage: transcript.errorMessage,
          requestContext: transcript.requestContext,
          keyboardTone: transcript.keyboardTone,
          jobId: transcript.jobId,
          retryCount: 0,
        };

        set({ isLoading: true, error: null });
        try {
          const transcripts = [
            ...get().transcripts.filter((existing) => existing.id !== id),
            failedTranscript,
          ];
          await StorageService.saveTranscripts(transcripts);
          set({ transcripts, isLoading: false });
          if (failedTranscript.jobId) clearKeyboardProviderRecovery(failedTranscript.jobId);
        } catch (error) {
          set({ error: (error as Error).message, isLoading: false });
          throw error;
        }
      });
    },

    retryTranscript: async (id) => {
      await ensureLoaded();
      const current = get().transcripts.find((t) => t.id === id);
      if (!current) throw new Error('Transcript not found');
      if (!current.audioUrl) throw new Error('Audio file not found');

      if (!(await transcriptAudioExists(current.audioUrl))) {
        const message = 'Audio file not found';
        await get().updateTranscript(id, {
          status: 'failed',
          errorMessage: message,
          retryCount: (current.retryCount ?? 0) + 1,
        });
        throw new Error(message);
      }

      if (current.provider === 'byok' && !current.inferenceRoute) {
        throw new Error('The original provider route is unavailable. Start a new transcription.');
      }
      const { activeMode } = useProcessingModeStore.getState();
      // Provider recordings keep their original route. Cloud and On-Device
      // recordings follow the current mode, including the provider it now selects.
      const rerouted =
        current.provider !== 'byok' && activeMode === 'providers'
          ? snapshotTranscriptionJob(current.requestContext === 'file' ? 'upload' : 'dictation')
          : undefined;
      const provider =
        rerouted?.provider ??
        (current.provider === 'byok' ? 'byok' : activeMode === 'private' ? 'local' : 'cloud');
      const inferenceRoute = rerouted ? rerouted.inferenceRoute : current.inferenceRoute;
      const textRoutes =
        rerouted ?? (provider === current.provider ? current : snapshotTextInference(provider));
      if (provider !== 'local' && activeMode === 'private') {
        throw new Error(
          'This recording used a remote provider. Leave private mode to retry its original route.',
        );
      }
      const retryCount = (current.retryCount ?? 0) + 1;
      const retryJobId = `${current.jobId ?? id}-retry-${Date.now()}`;
      const tempUris: string[] = [];
      let audioUri = current.audioUrl;
      let fileName = current.audioFileName;
      let mimeType = current.audioMimeType;

      set({ isLoading: true, error: null });
      try {
        if (provider === 'local' && !isWavAudioFile(current) && AudioTools.isAvailable()) {
          const transcoded = await AudioTools.transcodeToWav(current.audioUrl);
          audioUri = transcoded.uri;
          fileName = `${id}-retry.wav`;
          mimeType = 'audio/wav';
          tempUris.push(transcoded.uri);
        }

        const processed = await transcribeAndCleanup({
          audioUri,
          provider,
          inferenceRoute,
          cleanupRoute:
            textRoutes.cleanupRoute ??
            (provider !== 'byok'
              ? { mode: provider === 'local' ? 'local' : 'openwhispr', scope: 'cleanup' }
              : undefined),
          agentRoute:
            textRoutes.agentRoute ??
            (provider !== 'byok'
              ? { mode: provider === 'local' ? 'local' : 'openwhispr', scope: 'agent' }
              : undefined),
          cleanupUnavailable:
            textRoutes.cleanupUnavailable ??
            (provider === 'byok' && !textRoutes.cleanupRoute
              ? 'The original cleanup route is unavailable. Your raw transcript is saved.'
              : undefined),
          agentUnavailable:
            textRoutes.agentUnavailable ??
            (provider === 'byok' && !textRoutes.agentRoute
              ? 'The original agent route is unavailable. Your raw transcript is saved.'
              : undefined),
          language: getPreferredTranscriptionLanguage(),
          fileName,
          mimeType,
          jobId: retryJobId,
          requestContext: current.requestContext ?? 'recording',
          keyboardTone: current.requestContext === 'keyboard' ? current.keyboardTone : undefined,
        });

        const updated: Transcript = {
          ...current,
          text: processed.text,
          originalText: processed.originalText,
          duration: processed.transcription.duration,
          provider: processed.transcription.provider,
          inferenceRoute: processed.transcription.inferenceRoute,
          cleanupRoute: processed.transcription.cleanupRoute,
          agentRoute: processed.transcription.agentRoute,
          cleanupUnavailable: processed.transcription.cleanupUnavailable,
          agentUnavailable: processed.transcription.agentUnavailable,
          cleanupWarning: processed.transcription.cleanupWarning,
          // Retry succeeded: the row is completed and no longer retryable.
          audioUrl: undefined,
          status: 'completed',
          errorMessage: undefined,
          retryCount,
          updatedAt: Date.now(),
        };
        await exclusive(async () => {
          const transcripts = get().transcripts.map((t) => (t.id === id ? updated : t));
          await StorageService.saveTranscripts(transcripts);
          set({ transcripts, isLoading: false });
        });
        if (updated.text.trim()) {
          logTranscriptionCompleted({
            source: updated.requestContext ?? 'recording',
            provider: updated.provider,
          });
        }
        // Release the retained audio once the completed state is persisted, the
        // same way a first-pass success does.
        await deleteManagedTranscriptAudio(current.audioUrl).catch((cleanupError) => {
          if (__DEV__) {
            console.warn('[transcripts] failed to release retained audio:', cleanupError);
          }
        });
        return updated;
      } catch (error) {
        const updated: Transcript = {
          ...current,
          // A rerouted Cloud or On-Device recording keeps its own route, so the next
          // retry follows the current mode instead of staying on this provider.
          ...(rerouted
            ? {}
            : {
                provider,
                inferenceRoute,
                cleanupRoute: textRoutes.cleanupRoute,
                agentRoute: textRoutes.agentRoute,
                cleanupUnavailable: textRoutes.cleanupUnavailable,
                agentUnavailable: textRoutes.agentUnavailable,
              }),
          status: 'failed',
          errorMessage: toFriendlyTranscriptionErrorMessage(error),
          retryCount,
          updatedAt: Date.now(),
        };
        await exclusive(async () => {
          const transcripts = get().transcripts.map((t) => (t.id === id ? updated : t));
          await StorageService.saveTranscripts(transcripts);
          set({ transcripts, isLoading: false });
        });
        throw error;
      } finally {
        // The row keeps its own audio and result, so the retry's recovery entry is
        // never needed once the retry settles.
        clearKeyboardProviderRecovery(retryJobId);
        await AudioTools.cleanup(tempUris).catch((cleanupError) => {
          if (__DEV__) {
            console.warn('[transcripts] failed to clean up retry temp audio:', cleanupError);
          }
        });
      }
    },

    updateTranscript: async (id, updates) => {
      set({ isLoading: true, error: null });
      try {
        await ensureLoaded();
        await exclusive(async () => {
          const transcripts = get().transcripts.map((t) =>
            t.id === id ? { ...t, ...updates, updatedAt: Date.now() } : t,
          );
          await StorageService.saveTranscripts(transcripts);
          set({ transcripts, isLoading: false });
        });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },

    deleteTranscript: async (id) => {
      set({ isLoading: true, error: null });
      try {
        await ensureLoaded();
        await exclusive(async () => {
          const target = get().transcripts.find((t) => t.id === id);
          const transcripts = get().transcripts.filter((t) => t.id !== id);
          await StorageService.saveTranscripts(transcripts);
          await deleteManagedTranscriptAudio(target?.audioUrl);
          set({ transcripts, isLoading: false });
        });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },

    setCurrentTranscript: (transcript) => {
      set({ currentTranscript: transcript });
    },

    clearTranscripts: async () => {
      set({ isLoading: true, error: null });
      try {
        await ensureLoaded();
        await exclusive(async () => {
          const current = get().transcripts;
          await StorageService.clearTranscripts();
          await Promise.all(current.map((t) => deleteManagedTranscriptAudio(t.audioUrl)));
          set({ transcripts: [], isLoading: false });
        });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },
  };
});
