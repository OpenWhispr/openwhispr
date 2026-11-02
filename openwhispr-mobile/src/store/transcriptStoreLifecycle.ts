import type { Transcript } from '@/types';
import { StorageService } from '@/services/storage/StorageService';
import { garbageCollectTranscriptAudio } from '@/lib/transcriptAudio';
import type { FailedTranscriptInput, TranscriptState } from './createTranscriptStore';

export interface TranscriptAccess {
  owner: string | null;
  get: () => TranscriptState;
  set: (state: Partial<TranscriptState>) => void;
  assertCurrent: () => void;
  isCurrent: () => boolean;
  readHistory: () => Promise<Transcript[]>;
  saveHistory: (rows: Transcript[]) => Promise<void>;
  clearHistory: () => Promise<void>;
  otherAudio: () => string[];
  collectAudio: (keepUris: string[]) => Promise<void>;
}

export interface TranscriptRetryLifecycle {
  assertActive: () => void;
  requestSignal: { signal?: AbortSignal };
  identity: (current: Transcript) => { clientTranscriptionId?: string };
  connect: () => void;
  handleError: (error: unknown) => void;
  dispose: () => void;
}

export interface TranscriptLifecycleContext<ExtraState extends object> {
  set: (state: Partial<TranscriptState>) => void;
  get: () => TranscriptState & ExtraState;
  resetLoad: () => void;
}

export interface TranscriptLifecycle<ExtraState extends object> {
  extraState: ExtraState;
  protectNewerLoad: boolean;
  context: () => TranscriptAccess;
  failedIdentity: (input: FailedTranscriptInput & { clientTranscriptionId?: string }) => {
    clientTranscriptionId?: string;
  };
  afterFailedSave: (audioUrl: string) => void;
  privateRetryMessage: (scope: 'dictation' | 'upload') => string | null;
  beginRetry: (access: TranscriptAccess, externalSignal?: AbortSignal) => TranscriptRetryLifecycle;
}

export function createDefaultTranscriptLifecycle({
  set,
  get,
}: TranscriptLifecycleContext<Record<never, never>>): TranscriptLifecycle<Record<never, never>> {
  const access: TranscriptAccess = {
    owner: null,
    get,
    set,
    assertCurrent: () => undefined,
    isCurrent: () => true,
    readHistory: () => StorageService.getTranscripts(),
    saveHistory: (rows) => StorageService.saveTranscripts(rows),
    clearHistory: () => StorageService.clearTranscripts(),
    otherAudio: () => [],
    collectAudio: (keepUris) => garbageCollectTranscriptAudio(keepUris),
  };
  return {
    extraState: {},
    protectNewerLoad: false,
    context: () => access,
    failedIdentity: () => ({}),
    afterFailedSave: () => undefined,
    privateRetryMessage: (scope) =>
      scope === 'dictation'
        ? 'This recording used a remote provider. Change Dictation from On-Device in Account → AI Models to retry its original route.'
        : null,
    beginRetry: () => ({
      assertActive: () => undefined,
      requestSignal: {},
      identity: () => ({}),
      connect: () => undefined,
      handleError: () => undefined,
      dispose: () => undefined,
    }),
  };
}
