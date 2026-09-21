import { create } from 'zustand';
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
  requestContext?: Transcript['requestContext'];
  keyboardTone?: KeyboardTone;
  jobId?: string;
  errorMessage: string;
};

interface TranscriptState {
  transcripts: Transcript[];
  currentTranscript: Transcript | null;
  isLoading: boolean;
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

export const useTranscriptStore = create<TranscriptState>((set, get) => ({
  transcripts: [],
  currentTranscript: null,
  isLoading: false,
  error: null,

  loadTranscripts: async () => {
    set({ isLoading: true, error: null });
    try {
      const now = Date.now();
      const loaded = (await StorageService.getTranscripts()).map(normalizeTranscript);

      // Expire retained audio for failed rows past the retention window: drop the
      // uri so the row becomes non-retryable, and let the GC below delete the file.
      let mutated = false;
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
      set({ transcripts, isLoading: false });

      // Reclaim every managed file no surviving row still points at — expired
      // audio (cleared above) plus orphans from interrupted captures.
      const keepUris = transcripts
        .map((transcript) => transcript.audioUrl)
        .filter((uri): uri is string => isManagedTranscriptAudioUri(uri));
      await garbageCollectTranscriptAudio(keepUris).catch((error) => {
        if (__DEV__) {
          console.warn('[transcripts] audio garbage collection failed:', error);
        }
      });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  addTranscript: async (transcript) => {
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
      const transcripts = [
        ...get().transcripts.filter((existing) => existing.id !== newTranscript.id),
        newTranscript,
      ];
      await StorageService.saveTranscripts(transcripts);
      set({ transcripts, isLoading: false });
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
    }
  },

  addFailedTranscript: async (transcript) => {
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
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  retryTranscript: async (id) => {
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

    const provider = useProcessingModeStore.getState().activeMode === 'private' ? 'local' : 'cloud';
    const retryCount = (current.retryCount ?? 0) + 1;
    const startedAt = Date.now();
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
        language: getPreferredTranscriptionLanguage(),
        fileName,
        mimeType,
        jobId: `${current.jobId ?? id}-retry-${startedAt}`,
        requestContext: current.requestContext ?? 'recording',
        keyboardTone: current.requestContext === 'keyboard' ? current.keyboardTone : undefined,
      });

      const updated: Transcript = {
        ...current,
        text: processed.text,
        originalText: processed.originalText,
        duration: processed.transcription.duration,
        provider: processed.transcription.provider,
        // Retry succeeded: the row is completed and no longer retryable.
        audioUrl: undefined,
        status: 'completed',
        errorMessage: undefined,
        retryCount,
        updatedAt: Date.now(),
      };
      const transcripts = get().transcripts.map((t) => (t.id === id ? updated : t));
      await StorageService.saveTranscripts(transcripts);
      set({ transcripts, isLoading: false });
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
        provider,
        status: 'failed',
        errorMessage: toFriendlyTranscriptionErrorMessage(error),
        retryCount,
        updatedAt: Date.now(),
      };
      const transcripts = get().transcripts.map((t) => (t.id === id ? updated : t));
      await StorageService.saveTranscripts(transcripts);
      set({ transcripts, isLoading: false });
      throw error;
    } finally {
      await AudioTools.cleanup(tempUris).catch((cleanupError) => {
        if (__DEV__) {
          console.warn('[transcripts] failed to clean up retry temp audio:', cleanupError);
        }
      });
    }
  },

  updateTranscript: async (id, updates) => {
    const transcripts = get().transcripts.map((t) =>
      t.id === id ? { ...t, ...updates, updatedAt: Date.now() } : t,
    );

    set({ isLoading: true, error: null });
    try {
      await StorageService.saveTranscripts(transcripts);
      set({ transcripts, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  deleteTranscript: async (id) => {
    const target = get().transcripts.find((t) => t.id === id);
    const transcripts = get().transcripts.filter((t) => t.id !== id);

    set({ isLoading: true, error: null });
    try {
      await StorageService.saveTranscripts(transcripts);
      await deleteManagedTranscriptAudio(target?.audioUrl);
      set({ transcripts, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  setCurrentTranscript: (transcript) => {
    set({ currentTranscript: transcript });
  },

  clearTranscripts: async () => {
    const current = get().transcripts;
    set({ isLoading: true, error: null });
    try {
      await StorageService.clearTranscripts();
      await Promise.all(current.map((t) => deleteManagedTranscriptAudio(t.audioUrl)));
      set({ transcripts: [], isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },
}));
