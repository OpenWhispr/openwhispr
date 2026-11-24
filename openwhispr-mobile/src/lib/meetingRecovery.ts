import 'expo-sqlite/localStorage/install';
import { AppState, type AppStateStatus } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Network from 'expo-network';
import type { Note } from '@/data';
import { notesRepository } from '@/data';
import { canTransition } from '@/lib/diarization/transcriptionStatus';
import { tryParseNoteTimestamp } from '@/lib/parseNoteTimestamp';
import { Sentry } from '@/lib/sentry';
import {
  clearPendingBackfill,
  isManagedMeetingAudioUri,
  meetingRecordingUri,
} from '@/lib/transcriptAudio';
import { useNotesStore } from '@/store/useNotesStore';
import type { TranscriptionStatus } from '@/types';
import { LivePCMStreaming } from '../../modules/live-pcm-streaming/src';

export const MEETING_RESUME_MARKER_PREFIX = 'meetingResumeAttempted:';

const RUNTIME_STARTED_AT_MS = Date.now();

// In a fresh process nothing is running a meeting pipeline, so a meeting note in
// any of these states was orphaned when its previous process died.
const ORPHANED_STATUSES: ReadonlySet<string> = new Set(['recording', 'transcribing', 'diarizing']);

/** A recording this old is past any Retry worth keeping it for. */
export const STALE_RECORDING_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** True when segments are saved for the note. */
  hasTranscript(noteId: number): boolean;
  /** Reopens the note as done with its saved segments. Synchronous so a short background launch still lands it. */
  keepTranscript(noteId: number): void;
  /** Title and AI summary for a note whose transcript was kept. */
  finishNotes(noteId: number): Promise<void>;
  /** Fixes the header of a recording cut off by a kill; false when it is missing or unusable. */
  repairRecording(uri: string): Promise<boolean>;
  recordingUri(noteId: number): string;
  /** Points a note with no recording path at its recording. */
  linkRecording(noteId: number, uri: string): void;
  /** Labels the saved segments from the recording. */
  labelSpeakers(noteId: number): Promise<boolean>;
  hasSpeakerLabels(noteId: number): boolean;
  /** Deletes the recording and any pending-backfill sidecar, and clears the link. */
  discardRecording(noteId: number): Promise<void>;
  /** Null when the age can't be read. */
  recordingAgeMs(uri: string): Promise<number | null>;
  /** Note ids with a pending-backfill sidecar on disk. */
  listPendingBackfills(): Promise<number[]>;
  /** Any note, including ones created in this runtime; null when it is gone. */
  getNote(noteId: number): Note | null;
  recordingExists(noteId: number): Promise<boolean>;
  deletePendingBackfill(noteId: number): Promise<void>;
  /** True when this launch's repair pointed the note back at a recording nothing linked. */
  wasRelinked(noteId: number): boolean;
  isOnline(): Promise<boolean>;
  /** Transcribes what a done meeting's sidecar still owes; never throws. */
  resumeBackfill(noteId: number): Promise<void>;
}

const attempt = async (
  deps: Pick<MeetingRecoveryDeps, 'reportError'>,
  noteId: number,
  work: () => Promise<unknown> | unknown,
): Promise<void> => {
  try {
    await work();
  } catch (error) {
    deps.reportError(error, noteId);
  }
};

/**
 * Settled meetings whose recording is still on disk: drops sidecars nothing can use, deletes
 * stale and leftover recordings, and returns the notes whose owed backfill can be resumed.
 */
async function sweepSettledRecordings(
  notes: Note[],
  /** Sidecars this removes leave the set. */
  pendingBackfills: Set<number>,
  deps: MeetingRecoveryDeps,
): Promise<number[]> {
  for (const noteId of [...pendingBackfills]) {
    await attempt(deps, noteId, async () => {
      if (!deps.getNote(noteId) || !(await deps.recordingExists(noteId))) {
        await deps.deletePendingBackfill(noteId);
        pendingBackfills.delete(noteId);
      }
    });
  }

  const backfills: number[] = [];
  for (const note of notes) {
    if (note.noteType !== 'meeting') continue;
    // Only settled notes: a recording, transcribing or diarizing note may be a meeting this
    // launch is running, and orphans are recovered below.
    if (note.transcriptionStatus !== 'done' && note.transcriptionStatus !== 'failed') continue;
    if (!isManagedMeetingAudioUri(note.id, note.sourceFile)) continue;
    const owes = note.transcriptionStatus === 'done' && pendingBackfills.has(note.id);
    await attempt(deps, note.id, async () => {
      if (note.transcriptionStatus === 'failed' || owes) {
        const ageMs = await deps.recordingAgeMs(deps.recordingUri(note.id));
        if (ageMs != null && ageMs > STALE_RECORDING_MS) {
          await deps.discardRecording(note.id);
          return;
        }
      }
      if (owes) {
        backfills.push(note.id);
        return;
      }
      // A Stop pressed while the session was still connecting can leave a recording nothing
      // linked; this launch's repair linked it again, and a done transcript no longer needs it.
      if (
        note.transcriptionStatus === 'done' &&
        deps.wasRelinked(note.id) &&
        deps.hasTranscript(note.id)
      ) {
        await deps.discardRecording(note.id);
      }
      // Next task: listProcessedRecordings — every other done note with a linked recording is
      // discarded here. Notes in `pendingBackfills` must stay excluded: their recording is owed.
    });
  }
  return backfills;
}

/** Repairs a killed meeting's recording and links it; true when the note has a usable recording. */
async function repairOrphanRecording(note: Note, deps: MeetingRecoveryDeps): Promise<boolean> {
  const uri = deps.recordingUri(note.id);
  let repaired = false;
  try {
    repaired = await deps.repairRecording(uri);
  } catch (error) {
    deps.reportError(error, note.id);
  }
  if (!repaired) return false;
  if (note.sourceFile !== uri) {
    try {
      deps.linkRecording(note.id, uri);
    } catch (error) {
      deps.reportError(error, note.id);
      return false;
    }
  }
  return true;
}

/** After a kept transcript: speakers from the recording, then the recording goes, then the notes. */
async function finishKeptMeeting(
  noteId: number,
  hasRecording: boolean,
  pendingBackfills: ReadonlySet<number>,
  deps: MeetingRecoveryDeps,
): Promise<void> {
  if (hasRecording) {
    // A kill after the labels were written leaves them; labelling again only redoes the work.
    if (!deps.hasSpeakerLabels(noteId))
      await attempt(deps, noteId, () => deps.labelSpeakers(noteId));
    if (pendingBackfills.has(noteId)) {
      // The recording still owes audio; offline it waits for the next launch.
      if (await deps.isOnline().catch(() => false)) {
        await attempt(deps, noteId, () => deps.resumeBackfill(noteId));
      }
    } else {
      await attempt(deps, noteId, () => deps.discardRecording(noteId));
    }
  }
  await attempt(deps, noteId, () => deps.finishNotes(noteId));
}

async function recoverOrphan(
  note: Note,
  pendingBackfills: ReadonlySet<number>,
  deps: MeetingRecoveryDeps,
): Promise<void> {
  const markerKey = `${MEETING_RESUME_MARKER_PREFIX}${note.id}`;
  const alreadyAttempted = deps.storage.getItem(markerKey) != null;
  // A killed meeting's recording was never linked or closed; one stopped normally was linked
  // at Stop with a complete header.
  const hasRecording =
    note.transcriptionStatus === 'recording'
      ? await repairOrphanRecording(note, deps)
      : isManagedMeetingAudioUri(note.id, note.sourceFile);
  // Segments saved before the note left recording/transcribing/diarizing are a cloud meeting's
  // live transcript: the on-device pipeline only starts on a note without segments (Retry is
  // offered only then) and writes its segments in the same step that ends it done.
  const hasTranscript = deps.hasTranscript(note.id);

  if (hasTranscript) {
    let kept = false;
    try {
      deps.keepTranscript(note.id);
      kept = true;
    } catch (error) {
      deps.reportError(error, note.id);
    }
    if (kept) {
      // After the keep: the note is already done, so a background launch killed
      // while waiting loses only the labels, title and summary.
      await deps.waitUntilActive();
      await finishKeptMeeting(note.id, hasRecording, pendingBackfills, deps);
      return;
    }
  }

  try {
    if (canTransition(note.transcriptionStatus as TranscriptionStatus, 'failed')) {
      deps.markFailed(note.id);
    }
  } catch (error) {
    deps.reportError(error, note.id);
    deps.storage.removeItem(markerKey);
    return;
  }

  // Never over saved segments: a resume transcribes the whole file again and replaces them.
  if (!hasRecording || hasTranscript || alreadyAttempted) {
    if (alreadyAttempted) deps.storage.removeItem(markerKey);
    return;
  }

  // Before the marker: the note is already failed, so a background launch
  // killed while waiting leaves it failed with Retry and no stale marker.
  await deps.waitUntilActive();
  deps.storage.setItem(markerKey, '1');
  try {
    // Sequential on purpose: each resume runs ASR (and on-device, diarization).
    await deps.resume(note.id);
  } catch (error) {
    deps.reportError(error, note.id);
  }
  deps.storage.removeItem(markerKey);
}

/**
 * Recovers meeting notes whose process died mid-recording or mid-pipeline (e.g. iOS
 * terminated the app after a lock-screen End), and tidies settled meetings' recordings.
 *
 * - A meeting with saved segments (a cloud meeting's live transcript) is reopened as done with
 *   them; then its speakers are labelled from the recording and the recording is deleted.
 * - A killed meeting with a recording and no transcript is marked failed and resumed once
 *   through Retry. The marker is set before the resume and cleared when it settles, so a resume
 *   that itself kills the app is not retried on the next launch.
 * - Anything else is marked failed, which surfaces the note's Retry.
 * - A failed meeting's recording older than STALE_RECORDING_MS is deleted, and a done meeting
 *   that still owes audio from its recording gets it transcribed when online.
 *
 * Safe to run twice; one note's failure never stops the others.
 */
export async function recoverOrphanedMeetings(deps: MeetingRecoveryDeps): Promise<void> {
  const notes = deps.listNotes();
  let pendingBackfills = new Set<number>();
  try {
    pendingBackfills = new Set(await deps.listPendingBackfills());
  } catch (error) {
    deps.reportError(error, 0);
  }

  const backfills = await sweepSettledRecordings(notes, pendingBackfills, deps);

  const orphans = notes.filter(
    (note) =>
      note.noteType === 'meeting' &&
      note.transcriptionStatus != null &&
      ORPHANED_STATUSES.has(note.transcriptionStatus),
  );
  for (const note of orphans) {
    await attempt(deps, note.id, () => recoverOrphan(note, pendingBackfills, deps));
  }

  // Last: each is a run of network requests, and nothing above should wait behind them.
  if (backfills.length > 0 && (await deps.isOnline().catch(() => false))) {
    for (const noteId of backfills) {
      await attempt(deps, noteId, () => deps.resumeBackfill(noteId));
    }
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
 * notes can only have deleted their recording through that path). Returns the notes it linked.
 */
export async function repairMeetingRecordings(deps: MeetingRecordingRepairDeps): Promise<number[]> {
  const relinked: number[] = [];
  for (const name of await deps.listRecordingFiles()) {
    const noteId = Number(MEETING_RECORDING_FILE.exec(name)?.[1]);
    if (!noteId) continue;
    const note = deps.getNote(noteId);
    const uri = deps.recordingUri(noteId);
    if (!note) deps.deleteFile(uri);
    // A note still recording is either this launch's live meeting or a killed one, whose
    // recording recovery repairs before linking it.
    else if (
      note.noteType === 'meeting' &&
      note.sourceFile == null &&
      note.transcriptionStatus !== 'recording'
    ) {
      deps.restorePath(noteId, uri);
      relinked.push(noteId);
    }
  }
  return relinked;
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

const PENDING_BACKFILL_FILE = /^meeting-(\d+)\.backfill\.json$/;

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
};

// Fixed strings and codes only: errors here can carry file paths.
const reportRecoveryError = (error: unknown, noteId?: number): void => {
  Sentry.captureMessage('meeting-recovery-failed', {
    level: 'warning',
    tags: { feature: 'meeting-recovery', error_code: errorCode(error) },
    extra: noteId ? { noteId } : undefined,
  });
};

/** Runs the sweep once per JS runtime. Call after the notes store is initialized. */
export function startMeetingRecoveryOnce(): void {
  if (hasStarted) return;
  hasStarted = true;
  const directory = FileSystem.documentDirectory;
  // A recording found again can make its meeting resumable, so this runs first.
  const repaired: Promise<number[]> = directory
    ? repairMeetingRecordings({
        listRecordingFiles: () => FileSystem.readDirectoryAsync(directory),
        getNote: (noteId) => notesRepository.getNoteById(noteId),
        recordingUri: meetingRecordingUri,
        restorePath: (noteId, uri) => notesRepository.restoreMeetingRecordingPath(noteId, uri),
        deleteFile: (uri) => {
          FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
          // A note gone for good takes its pending-backfill sidecar with its recording.
          const noteId = Number(/meeting-(\d+)\.wav$/.exec(uri)?.[1]);
          if (noteId) clearPendingBackfill(noteId).catch(() => undefined);
        },
      }).catch((error: unknown) => {
        reportRecoveryError(error);
        return [];
      })
    : Promise.resolve([]);
  repaired
    .then((relinkedIds) => {
      const relinked = new Set(relinkedIds);
      return recoverOrphanedMeetings({
        listNotes: () =>
          notesRepository
            .getAllNotes()
            .filter((note) => createdBeforeRuntime(note, RUNTIME_STARTED_AT_MS)),
        markFailed: (noteId) => useNotesStore.getState().transitionStatus(noteId, 'failed'),
        waitUntilActive: () => waitForAppActive(AppState),
        hasTranscript: (noteId) => notesRepository.getSegments(noteId).length > 0,
        keepTranscript: (noteId) => useNotesStore.getState().keepCloudMeetingTranscript(noteId),
        finishNotes: (noteId) => useNotesStore.getState().finishRecoveredMeetingNotes(noteId),
        resume: (noteId) => useNotesStore.getState().retryMeetingTranscription(noteId),
        storage: localStorage,
        reportError: reportRecoveryError,
        repairRecording: (uri) => LivePCMStreaming.repairRecording(uri),
        recordingUri: meetingRecordingUri,
        linkRecording: (noteId, uri) => notesRepository.restoreMeetingRecordingPath(noteId, uri),
        labelSpeakers: (noteId) =>
          useNotesStore.getState().labelMeetingSpeakers(noteId, { utteranceTimed: true }),
        hasSpeakerLabels: (noteId) =>
          notesRepository.getSegments(noteId).some((segment) => !!segment.speakerLabel) &&
          notesRepository.getSpeakers(noteId).length > 0,
        discardRecording: (noteId) => useNotesStore.getState().discardMeetingRecording(noteId),
        recordingAgeMs: async (uri) => {
          const info = await FileSystem.getInfoAsync(uri);
          // modificationTime is in seconds.
          return info.exists && typeof info.modificationTime === 'number'
            ? Date.now() - info.modificationTime * 1000
            : null;
        },
        listPendingBackfills: async () =>
          directory
            ? (await FileSystem.readDirectoryAsync(directory)).flatMap((name) => {
                const noteId = Number(PENDING_BACKFILL_FILE.exec(name)?.[1]);
                return noteId ? [noteId] : [];
              })
            : [],
        getNote: (noteId) => notesRepository.getNoteById(noteId),
        // Unsure counts as there, so a sidecar is never dropped on a failed read.
        recordingExists: (noteId) =>
          FileSystem.getInfoAsync(meetingRecordingUri(noteId)).then(
            (info) => info.exists,
            () => true,
          ),
        deletePendingBackfill: clearPendingBackfill,
        wasRelinked: (noteId) => relinked.has(noteId),
        isOnline: () =>
          Network.getNetworkStateAsync().then(
            (state) => state.isConnected !== false,
            () => true,
          ),
        resumeBackfill: (noteId) => useNotesStore.getState().resumeMeetingBackfill(noteId),
      });
    })
    .catch((error: unknown) => {
      reportRecoveryError(error);
    });
}
