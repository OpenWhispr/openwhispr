import * as FileSystem from 'expo-file-system/legacy';
import { AppState } from 'react-native';
import { requiresRealAccount } from '@/lib/accountAccess';
import { captureDictationContext, recordDictationCompleted } from '@/lib/productEvents';
import { countSpokenWords } from '@/lib/wordCount';
import { useAuthStore } from '@/store/useAuthStore';
import {
  useTranscriptStore,
  type AddTranscriptInput,
  type FailedTranscriptInput,
} from '@/store/useTranscriptStore';
import type { KeyboardTone, TranscriptionProvider } from '@/types';
import { AppGroupStorage } from '../../modules/app-group-storage/src';

/** The keyboard's folder in the App Group container (DirectDictationStore.folderName). */
export const KEYBOARD_DIRECT_FOLDER = 'direct-dictations';
/** A pending dictation this old won't be resumed by the keyboard (resumeWindowMs). */
const RESUME_WINDOW_MS = 10 * 60 * 1000;
// Direct capture writes mono Int16 PCM at 16 kHz.
const PCM_BYTES_PER_SECOND = 16_000 * 2;
const FAILED_MESSAGE = "Couldn't transcribe. Tap to retry.";

/** One dictation the keyboard handled (plugins/keyboard-extension/ios/DirectDictationStore.swift). */
interface DirectDictationRecord {
  jobId: string;
  status: 'pending' | 'completed' | 'failed';
  userId: string;
  startedAtMs: number;
  completedAtMs?: number | null;
  durationMs?: number;
  tone?: string;
  text?: string | null;
  originalText?: string | null;
  cleanupApplied?: boolean | null;
  /** "cloud", "parakeet-v2" or "parakeet-v3"; none on records from before Local existed. */
  engine?: string;
}

export interface OutboxFiles {
  list(): Promise<string[]>;
  read(name: string): Promise<string | null>;
  size(name: string): Promise<number | null>;
  remove(name: string): Promise<void>;
  uri(name: string): string;
}

export interface OutboxDeps {
  /** Null when the App Group container can't be reached. */
  files: OutboxFiles | null;
  now: () => number;
  /** The signed-in real account; null for a guest, an anonymous session or nobody. */
  userId: () => string | null;
  hasTranscript: (jobId: string) => Promise<boolean>;
  addTranscript: (input: AddTranscriptInput, mayWrite: () => boolean) => Promise<void>;
  addFailedTranscript: (input: FailedTranscriptInput, mayWrite: () => boolean) => Promise<void>;
  recordCompleted: (input: {
    captureId: string;
    words: number | null;
    occurredAt: number;
    provider: TranscriptionProvider;
  }) => void;
  /** Wraps a raw 16 kHz take in a WAV file beside it; false when it couldn't. */
  wrapPcmAsWav: (pcmName: string, wavName: string) => Promise<boolean>;
}

export interface OutboxResult {
  completed: number;
  failed: number;
  dropped: number;
}

function parseRecord(json: string | null): DirectDictationRecord | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<DirectDictationRecord>;
    if (
      typeof value.jobId !== 'string' ||
      typeof value.userId !== 'string' ||
      typeof value.startedAtMs !== 'number' ||
      !['pending', 'completed', 'failed'].includes(value.status as string)
    ) {
      return null;
    }
    return value as DirectDictationRecord;
  } catch {
    return null;
  }
}

// A take recorded for the keyboard's own Local engine. It must never reach the network, so its
// failed row is marked localOnly: Retry then stays On-Device whatever mode is on. Only "cloud" (or
// no engine, from before Local existed) is Cloud: an engine this build doesn't know stays local.
function isLocalTake(record: DirectDictationRecord): boolean {
  return record.engine != null && record.engine !== 'cloud';
}

function durationSeconds(record: DirectDictationRecord): number | undefined {
  return record.durationMs ? record.durationMs / 1000 : undefined;
}

/**
 * Brings the keyboard's own dictations into History and the word counters. Usage needs nothing:
 * the server counted the words of a Cloud take, and a Local take uses no plan. A Local take that
 * failed or was cut off becomes a row that retries On-Device; nothing here uploads anything.
 */
export async function drainKeyboardDirectOutbox(
  deps: OutboxDeps = defaultOutboxDeps(),
  isActive: () => boolean = () => true,
): Promise<OutboxResult> {
  const result: OutboxResult = { completed: 0, failed: 0, dropped: 0 };
  const { files } = deps;
  const userId = deps.userId();
  // Signed out: a record may be the next account's, so it waits.
  if (!files || !userId) return result;

  const mayWrite = (): boolean => isActive() && deps.userId() === userId;
  const names = await files.list();
  const removeJob = async (jobId: string): Promise<void> => {
    const suffixes = ['pcm', 'body', 'm4a', 'partial.m4a', 'wav'];
    await Promise.all(suffixes.map((suffix) => files.remove(`${jobId}.${suffix}`)));
    // Keep the manifest discoverable until all its files have been removed.
    await files.remove(`${jobId}.json`);
  };

  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const record = parseRecord(await files.read(name));
    if (!mayWrite()) break;
    if (!record || name !== `${record.jobId}.json`) continue;

    if (record.userId !== userId) {
      await removeJob(record.jobId);
      result.dropped += 1;
      continue;
    }
    // The keyboard may still send it when it next appears.
    if (record.status === 'pending' && deps.now() - record.startedAtMs < RESUME_WINDOW_MS) continue;

    const imported = await deps.hasTranscript(record.jobId);
    if (!mayWrite()) break;
    if (imported) {
      await removeJob(record.jobId);
      continue;
    }

    const provider: TranscriptionProvider = isLocalTake(record) ? 'local' : 'cloud';
    if (record.status === 'completed' && record.text) {
      const occurredAt = record.completedAtMs ?? record.startedAtMs;
      await deps.addTranscript(
        {
          id: record.jobId,
          jobId: record.jobId,
          text: record.text,
          originalText: record.originalText ?? record.text,
          provider,
          requestContext: 'keyboard',
          keyboardTone: (record.tone ?? 'default') as KeyboardTone,
          duration: durationSeconds(record),
          createdAt: occurredAt,
        },
        mayWrite,
      );
      if (!mayWrite()) break;
      deps.recordCompleted({
        captureId: record.jobId,
        words: countSpokenWords(record.originalText ?? record.text),
        occurredAt,
        provider,
      });
      await removeJob(record.jobId);
      result.completed += 1;
      continue;
    }

    // Failed, or pending past the keyboard's window: a row the user can retry, if the audio is
    // there. A keyboard killed before encoding left only its raw take, which becomes a WAV.
    const audio = await retryableAudio(record.jobId, files, deps);
    if (!mayWrite()) break;
    if (audio === 'retry') continue;
    if (!audio) {
      await removeJob(record.jobId);
      result.dropped += 1;
      continue;
    }
    await deps.addFailedTranscript(
      {
        id: record.jobId,
        jobId: record.jobId,
        audioUrl: files.uri(audio.name),
        audioFileName: audio.name,
        audioMimeType: audio.mimeType,
        duration: durationSeconds(record) ?? audio.duration,
        provider,
        ...(provider === 'local' ? { localOnly: true } : {}),
        requestContext: 'keyboard',
        keyboardTone: (record.tone ?? 'default') as KeyboardTone,
        errorMessage: FAILED_MESSAGE,
        createdAt: record.startedAtMs,
      },
      mayWrite,
    );
    if (!mayWrite()) break;
    await removeJob(record.jobId);
    result.failed += 1;
  }
  return result;
}

async function retryableAudio(
  jobId: string,
  files: OutboxFiles,
  deps: OutboxDeps,
): Promise<{ name: string; mimeType: string; duration?: number } | 'retry' | null> {
  const encoded = `${jobId}.m4a`;
  if (await files.size(encoded)) return { name: encoded, mimeType: 'audio/mp4' };
  const raw = `${jobId}.pcm`;
  const wav = `${jobId}.wav`;
  const rawBytes = await files.size(raw);
  if (!rawBytes) return null;
  if (!(await deps.wrapPcmAsWav(raw, wav))) return 'retry';
  return { name: wav, mimeType: 'audio/wav', duration: rawBytes / PCM_BYTES_PER_SECOND };
}

function directFolderPath(): string | null {
  const container = AppGroupStorage.getAppGroupContainerPath();
  return container ? `${container.replace(/\/$/, '')}/${KEYBOARD_DIRECT_FOLDER}` : null;
}

function appGroupFiles(): OutboxFiles | null {
  const path = directFolderPath();
  if (!path) return null;
  const folder = `file://${path}/`;
  return {
    list: () => FileSystem.readDirectoryAsync(folder).catch(() => [] as string[]),
    read: (name) => FileSystem.readAsStringAsync(`${folder}${name}`).catch(() => null),
    size: async (name) => {
      const info = await FileSystem.getInfoAsync(`${folder}${name}`);
      return info.exists ? info.size : null;
    },
    remove: (name) => FileSystem.deleteAsync(`${folder}${name}`, { idempotent: true }),
    uri: (name) => `${folder}${name}`,
  };
}

function defaultOutboxDeps(): OutboxDeps {
  return {
    files: appGroupFiles(),
    now: () => Date.now(),
    userId: () => {
      const { user } = useAuthStore.getState();
      return requiresRealAccount(user) ? null : (user?.id ?? null);
    },
    hasTranscript: async (jobId) => {
      const store = useTranscriptStore.getState();
      if (!store.isLoaded) await store.loadTranscripts();
      return useTranscriptStore
        .getState()
        .transcripts.some((transcript) => transcript.id === jobId || transcript.jobId === jobId);
    },
    addTranscript: (input, mayWrite) =>
      useTranscriptStore.getState().addTranscript(input, mayWrite),
    addFailedTranscript: (input, mayWrite) =>
      useTranscriptStore.getState().addFailedTranscript(input, { mayWrite, keepSourceAudio: true }),
    wrapPcmAsWav: async (pcmName, wavName) => {
      const path = directFolderPath();
      return path
        ? AppGroupStorage.wrapPcmAsWav(`${path}/${pcmName}`, `${path}/${wavName}`)
        : false;
    },
    recordCompleted: ({ captureId, words, occurredAt, provider }) =>
      recordDictationCompleted({
        context: captureDictationContext(),
        captureId,
        words,
        provider,
        source: 'keyboard',
        retranscribe: false,
        occurredAt,
      }),
  };
}

/** Drains at launch, whenever the app comes to the foreground, and when the account changes. */
export function startKeyboardDirectOutbox(): () => void {
  let lastUserId: string | null | undefined;
  let generation = 0;
  let stopped = false;
  let running = false;
  let pending = false;

  const drainOnce = (): void => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    pending = false;
    const started = generation;
    void drainKeyboardDirectOutbox(undefined, () => !stopped && generation === started)
      .catch(() => undefined)
      .finally(() => {
        running = false;
        if (pending) drainOnce();
      });
  };

  const onAuth = (): void => {
    const { user, isInitialized } = useAuthStore.getState();
    if (!isInitialized) return;
    const userId = requiresRealAccount(user) ? null : (user?.id ?? null);
    if (userId === lastUserId) return;
    lastUserId = userId;
    generation += 1;
    if (userId) drainOnce();
  };
  onAuth();
  const unsubscribe = useAuthStore.subscribe(onAuth);
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') drainOnce();
  });
  return () => {
    stopped = true;
    unsubscribe();
    appState.remove();
  };
}
