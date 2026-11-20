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
import type { KeyboardTone } from '@/types';
import { AppGroupStorage } from '../../modules/app-group-storage/src';

/** The keyboard's folder in the App Group container (DirectDictationStore.folderName). */
export const KEYBOARD_DIRECT_FOLDER = 'direct-dictations';
/** A pending dictation this old won't be resumed by the keyboard (resumeWindowMs). */
const RESUME_WINDOW_MS = 10 * 60 * 1000;
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
}

export interface OutboxFiles {
  list(): Promise<string[]>;
  read(name: string): Promise<string | null>;
  exists(name: string): Promise<boolean>;
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
  addTranscript: (input: AddTranscriptInput) => Promise<void>;
  addFailedTranscript: (input: FailedTranscriptInput) => Promise<void>;
  recordCompleted: (input: { captureId: string; words: number | null; occurredAt: number }) => void;
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

function durationSeconds(record: DirectDictationRecord): number | undefined {
  return record.durationMs ? record.durationMs / 1000 : undefined;
}

/**
 * Brings the keyboard's own dictations into History and the word counters. Usage needs nothing:
 * the server counted the words when it transcribed them.
 */
export async function drainKeyboardDirectOutbox(
  deps: OutboxDeps = defaultOutboxDeps(),
): Promise<OutboxResult> {
  const result: OutboxResult = { completed: 0, failed: 0, dropped: 0 };
  const { files } = deps;
  const userId = deps.userId();
  // Signed out: a record may be the next account's, so it waits.
  if (!files || !userId) return result;

  const names = await files.list();
  const removeJob = async (jobId: string, keepAudio = false) => {
    const suffixes = keepAudio ? ['json', 'pcm', 'body'] : ['json', 'pcm', 'body', 'm4a', 'wav'];
    await Promise.all(suffixes.map((suffix) => files.remove(`${jobId}.${suffix}`)));
  };

  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const record = parseRecord(await files.read(name));
    if (!record) continue;

    if (record.userId !== userId) {
      await removeJob(record.jobId);
      result.dropped += 1;
      continue;
    }
    // The keyboard may still send it when it next appears.
    if (record.status === 'pending' && deps.now() - record.startedAtMs < RESUME_WINDOW_MS) continue;

    if (await deps.hasTranscript(record.jobId)) {
      await removeJob(record.jobId);
      continue;
    }

    if (record.status === 'completed' && record.text) {
      const occurredAt = record.completedAtMs ?? record.startedAtMs;
      await deps.addTranscript({
        id: record.jobId,
        jobId: record.jobId,
        text: record.text,
        originalText: record.originalText ?? record.text,
        provider: 'cloud',
        requestContext: 'keyboard',
        keyboardTone: (record.tone ?? 'default') as KeyboardTone,
        duration: durationSeconds(record),
        createdAt: occurredAt,
      });
      deps.recordCompleted({
        captureId: record.jobId,
        words: countSpokenWords(record.originalText ?? record.text),
        occurredAt,
      });
      await removeJob(record.jobId);
      result.completed += 1;
      continue;
    }

    // Failed, or pending past the keyboard's window: a row the user can retry, if the audio is
    // there. A keyboard killed before encoding left only its raw take, which becomes a WAV.
    const audio = await retryableAudio(record.jobId, files, deps);
    if (!audio) {
      await removeJob(record.jobId);
      result.dropped += 1;
      continue;
    }
    await deps.addFailedTranscript({
      id: record.jobId,
      jobId: record.jobId,
      audioUrl: files.uri(audio.name),
      audioFileName: audio.name,
      audioMimeType: audio.mimeType,
      duration: durationSeconds(record),
      provider: 'cloud',
      requestContext: 'keyboard',
      keyboardTone: (record.tone ?? 'default') as KeyboardTone,
      errorMessage: FAILED_MESSAGE,
      createdAt: record.startedAtMs,
    });
    // History moved the audio into its own folder.
    await removeJob(record.jobId, true);
    if (audio.name.endsWith('.wav')) await files.remove(`${record.jobId}.m4a`);
    result.failed += 1;
  }
  return result;
}

async function retryableAudio(
  jobId: string,
  files: OutboxFiles,
  deps: OutboxDeps,
): Promise<{ name: string; mimeType: string } | null> {
  const encoded = `${jobId}.m4a`;
  if (await files.exists(encoded)) return { name: encoded, mimeType: 'audio/mp4' };
  const raw = `${jobId}.pcm`;
  const wav = `${jobId}.wav`;
  if ((await files.exists(raw)) && (await deps.wrapPcmAsWav(raw, wav))) {
    return { name: wav, mimeType: 'audio/wav' };
  }
  return null;
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
    exists: async (name) => (await FileSystem.getInfoAsync(`${folder}${name}`)).exists,
    remove: (name) =>
      FileSystem.deleteAsync(`${folder}${name}`, { idempotent: true }).catch(() => undefined),
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
    addTranscript: (input) => useTranscriptStore.getState().addTranscript(input),
    addFailedTranscript: (input) => useTranscriptStore.getState().addFailedTranscript(input),
    wrapPcmAsWav: async (pcmName, wavName) => {
      const path = directFolderPath();
      return path
        ? AppGroupStorage.wrapPcmAsWav(`${path}/${pcmName}`, `${path}/${wavName}`)
        : false;
    },
    recordCompleted: ({ captureId, words, occurredAt }) =>
      recordDictationCompleted({
        context: captureDictationContext(),
        captureId,
        words,
        provider: 'cloud',
        source: 'keyboard',
        retranscribe: false,
        occurredAt,
      }),
  };
}

let draining: Promise<OutboxResult> | null = null;

// One drain at a time: launch, foreground and sign-in can all ask at once.
function drainOnce(): void {
  if (draining) return;
  draining = drainKeyboardDirectOutbox()
    .catch(() => ({ completed: 0, failed: 0, dropped: 0 }))
    .finally(() => {
      draining = null;
    });
}

/** Drains at launch, whenever the app comes to the foreground, and when the account changes. */
export function startKeyboardDirectOutbox(): () => void {
  let lastUserId: string | null | undefined;
  const onAuth = () => {
    const { user, isInitialized } = useAuthStore.getState();
    if (!isInitialized) return;
    const userId = requiresRealAccount(user) ? null : (user?.id ?? null);
    if (userId === lastUserId) return;
    lastUserId = userId;
    if (userId) drainOnce();
  };
  onAuth();
  const unsubscribe = useAuthStore.subscribe(onAuth);
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') drainOnce();
  });
  return () => {
    unsubscribe();
    appState.remove();
  };
}
