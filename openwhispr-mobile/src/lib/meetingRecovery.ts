import 'expo-sqlite/localStorage/install';
import { AppState, type AppStateStatus } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import type { Note } from '@/data';
import { notesRepository } from '@/data';
import { canTransition } from '@/lib/diarization/transcriptionStatus';
import { tryParseNoteTimestamp } from '@/lib/parseNoteTimestamp';
import { Sentry } from '@/lib/sentry';
import { isManagedMeetingAudioUri } from '@/lib/transcriptAudio';
import { useNotesStore } from '@/store/useNotesStore';
import type { TranscriptionStatus } from '@/types';

export const MEETING_RESUME_MARKER_PREFIX = 'meetingResumeAttempted:';

const RUNTIME_STARTED_AT_MS = Date.now();

// In a fresh process nothing is running a meeting pipeline, so a meeting note in
// any of these states was orphaned when its previous process died.
const ORPHANED_STATUSES: ReadonlySet<string> = new Set(['recording', 'transcribing', 'diarizing']);

export interface MeetingRecoveryDeps {
  listNotes(): Note[];
  markFailed(noteId: number): void;
  /** Settles once a resume can run without iOS suspending it. */
  waitUntilActive(): Promise<void>;
  resume(noteId: number): Promise<void>;
  storage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  reportError(error: unknown, noteId: number): void;
}

/**
 * Recovers meeting notes whose process died mid-recording or mid-pipeline (e.g. iOS
 * terminated the app after a lock-screen End). Each orphan is marked failed, which
 * surfaces the note's Retry button; one with its recording still on disk is also
 * resumed, once. The marker is set before the resume and cleared when it settles,
 * so a resume that itself kills the app is not retried on the next launch.
 */
export async function recoverOrphanedMeetings(deps: MeetingRecoveryDeps): Promise<void> {
  const orphans = deps
    .listNotes()
    .filter(
      (note) =>
        note.noteType === 'meeting' &&
        note.transcriptionStatus != null &&
        ORPHANED_STATUSES.has(note.transcriptionStatus),
    );

  for (const note of orphans) {
    const markerKey = `${MEETING_RESUME_MARKER_PREFIX}${note.id}`;
    const alreadyAttempted = deps.storage.getItem(markerKey) != null;
    const resumable =
      note.transcriptionStatus !== 'recording' &&
      isManagedMeetingAudioUri(note.id, note.sourceFile) &&
      !alreadyAttempted;

    try {
      if (canTransition(note.transcriptionStatus as TranscriptionStatus, 'failed')) {
        deps.markFailed(note.id);
      }
    } catch (error) {
      deps.reportError(error, note.id);
      deps.storage.removeItem(markerKey);
      continue;
    }

    if (!resumable) {
      if (alreadyAttempted) deps.storage.removeItem(markerKey);
      continue;
    }

    // Before the marker: the note is already failed, so a background launch
    // killed while waiting leaves it failed with Retry and no stale marker.
    await deps.waitUntilActive();
    deps.storage.setItem(markerKey, '1');
    try {
      // Sequential on purpose: each resume runs on-device ASR + diarization.
      await deps.resume(note.id);
    } catch (error) {
      deps.reportError(error, note.id);
    }
    deps.storage.removeItem(markerKey);
  }
}

const MEETING_RECORDING_FILE = /^meeting-(\d+)\.wav$/;

export interface MeetingRecordingRepairDeps {
  /** File names in the directory meeting recordings are saved to. */
  listRecordingFiles(): Promise<string[]>;
  getNote(noteId: number): Note | null;
  recordingUri(noteId: number): string;
  restorePath(noteId: number, uri: string): void;
  deleteFile(uri: string): void;
}

/**
 * Sync pulls used to erase a meeting's recording path, leaving the note with no playback
 * or Retry and its recording on disk with nothing pointing at it. Points each such note
 * back at its recording, and deletes recordings whose note is gone for good (hard-deleted
 * notes can only have deleted their recording through that path).
 */
export async function repairMeetingRecordings(deps: MeetingRecordingRepairDeps): Promise<void> {
  for (const name of await deps.listRecordingFiles()) {
    const noteId = Number(MEETING_RECORDING_FILE.exec(name)?.[1]);
    if (!noteId) continue;
    const note = deps.getNote(noteId);
    const uri = deps.recordingUri(noteId);
    if (!note) deps.deleteFile(uri);
    else if (note.noteType === 'meeting' && note.sourceFile == null) deps.restorePath(noteId, uri);
  }
}

interface AppStateLike {
  currentState: AppStateStatus;
  addEventListener(type: 'change', listener: (state: AppStateStatus) => void): { remove(): void };
}

/**
 * Resolves once the app is foreground-active. A background launch (a finished
 * background upload, a Live Activity button) would otherwise start an on-device
 * pipeline that iOS suspends moments later.
 */
export function waitForAppActive(appState: AppStateLike): Promise<void> {
  if (appState.currentState === 'active') return Promise.resolve();
  return new Promise((resolve) => {
    const subscription = appState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      subscription.remove();
      resolve();
    });
  });
}

/**
 * A note created during this JS runtime has a live pipeline, so it is never an
 * orphan. SQLite stamps `created_at` to the second, so the cutoff is the start of
 * the second the runtime started in.
 */
export function createdBeforeRuntime(
  note: Pick<Note, 'createdAt'>,
  runtimeStartedAtMs: number,
): boolean {
  // The column defaults to datetime('now'), so a missing or unreadable stamp is
  // legacy data; recovering it beats leaving it stuck mid-pipeline.
  const createdAt = tryParseNoteTimestamp(note.createdAt);
  if (!createdAt) return true;
  const cutoffMs = Math.floor(runtimeStartedAtMs / 1000) * 1000;
  return createdAt.getTime() < cutoffMs;
}

let hasStarted = false;

/** Runs the sweep once per JS runtime. Call after the notes store is initialized. */
export function startMeetingRecoveryOnce(): void {
  if (hasStarted) return;
  hasStarted = true;
  const directory = FileSystem.documentDirectory;
  // A recording found again can make its meeting resumable, so this runs first.
  const repaired = directory
    ? repairMeetingRecordings({
        listRecordingFiles: () => FileSystem.readDirectoryAsync(directory),
        getNote: (noteId) => notesRepository.getNoteById(noteId),
        recordingUri: (noteId) => `${directory}meeting-${noteId}.wav`,
        restorePath: (noteId, uri) => notesRepository.restoreMeetingRecordingPath(noteId, uri),
        deleteFile: (uri) => {
          FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
        },
      }).catch((error) => {
        Sentry.captureException(error, { tags: { feature: 'meeting-recovery' } });
      })
    : Promise.resolve();
  repaired
    .then(() =>
      recoverOrphanedMeetings({
        listNotes: () =>
          notesRepository
            .getAllNotes()
            .filter((note) => createdBeforeRuntime(note, RUNTIME_STARTED_AT_MS)),
        markFailed: (noteId) => useNotesStore.getState().transitionStatus(noteId, 'failed'),
        waitUntilActive: () => waitForAppActive(AppState),
        resume: (noteId) => useNotesStore.getState().retryMeetingTranscription(noteId),
        storage: localStorage,
        reportError: (error, noteId) =>
          Sentry.captureException(error, {
            tags: { feature: 'meeting-recovery' },
            extra: { noteId },
          }),
      }),
    )
    .catch((error) => {
      Sentry.captureException(error, { tags: { feature: 'meeting-recovery' } });
    });
}
