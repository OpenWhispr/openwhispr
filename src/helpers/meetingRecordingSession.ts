import type { StartRecordingArgs, TranscriptSegment } from "../stores/meetingRecordingStore";
import type { MeetingAutoEndRestartRequest, NoteItem } from "../types/electron";

export function createMeetingRecordingSessionId(
  randomUUID: () => string = () => crypto.randomUUID()
): string {
  return randomUUID();
}

export function canStopMeetingRecordingSession(
  activeSessionId: string | null,
  expectedSessionId?: string | null
): boolean {
  return expectedSessionId == null || activeSessionId === expectedSessionId;
}

export function requestMeetingRecordingAutoEnd(
  payload: { sessionId?: unknown } | null | undefined,
  stopRecording: (sessionId: string) => Promise<{ stopped: boolean }> | { stopped: boolean },
  // Always called once the stop settles. `stopped` is false when the recording
  // ended without a persisted result — the caller still has to tell the user,
  // because no restart card will be offered for it.
  onStopSettled: (sessionId: string, stopped: boolean) => Promise<unknown> | unknown,
  onError: (error: unknown, sessionId: string) => void
): boolean {
  const sessionId = payload?.sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) return false;

  void Promise.resolve(stopRecording(sessionId))
    .then((result) => onStopSettled(sessionId, result.stopped))
    .catch((error) => onError(error, sessionId));
  return true;
}

interface MeetingAutoEndRestartState {
  recordingNoteId: number | null;
  recordingNoteTitle: string | null;
  recordingFolderId: number | null;
  sessionDiarizationEnabled: boolean;
  sessionExpectedCount: number;
  userTouchedStepper: boolean;
  segments: TranscriptSegment[];
}

export interface MeetingAutoEndRestartContext {
  sessionId: string;
  args: StartRecordingArgs;
}

export function createMeetingAutoEndRestartContext(
  sessionId: string,
  activeSessionId: string | null,
  state: MeetingAutoEndRestartState
): MeetingAutoEndRestartContext | null {
  if (activeSessionId !== sessionId) return null;

  return {
    sessionId,
    args: {
      noteId: state.recordingNoteId,
      noteTitle: state.recordingNoteTitle,
      folderId: state.recordingFolderId,
      seedSegments: state.segments,
      diarizationEnabled: state.sessionDiarizationEnabled,
      expectedCount: state.sessionExpectedCount,
      expectedCountIsExplicit: state.userTouchedStepper,
      autoEndEligible: true,
    },
  };
}

type MeetingAutoEndRestartNote = Pick<NoteItem, "transcript" | "deleted_at">;

export type MeetingAutoEndRestartSeed =
  { ok: true; seedSegments: TranscriptSegment[] } | { ok: false; reason: "note-missing" };

// The live segments the renderer holds are the pre-diarization copy: background
// speaker identification writes its enrichment to the note, never back into the
// store. Reseeding from the store would overwrite those labels at the next stop,
// so the note is the source of truth — and reading it is also what catches a
// note deleted during the restart window, which must not be resurrected.
export function resolveMeetingAutoEndRestartSeed(
  noteId: number | null,
  note: MeetingAutoEndRestartNote | null | undefined,
  parseSegments: (transcript: string) => TranscriptSegment[],
  liveSegments: TranscriptSegment[]
): MeetingAutoEndRestartSeed {
  if (noteId == null) return { ok: true, seedSegments: liveSegments };
  if (!note || note.deleted_at) return { ok: false, reason: "note-missing" };
  return { ok: true, seedSegments: note.transcript ? parseSegments(note.transcript) : [] };
}

export interface MeetingAutoEndRestartDeps {
  getActiveSessionId: () => string | null;
  getLatestSegments: () => TranscriptSegment[];
  getNote: (noteId: number) => Promise<MeetingAutoEndRestartNote | null | undefined>;
  parseSegments: (transcript: string) => TranscriptSegment[];
  startRecording: (args: StartRecordingArgs) => Promise<boolean>;
}

export type MeetingAutoEndRestartOutcome =
  | { status: "started" }
  | {
      status: "aborted";
      reason: "no-context" | "already-recording" | "note-missing" | "start-refused";
    };

// Every abort is named rather than swallowed: main closes the card and reports
// success the moment it hands the restart to this renderer, so a drop here is
// invisible to the user unless the caller tells them.
export async function runMeetingAutoEndRestart(
  request: MeetingAutoEndRestartRequest,
  context: MeetingAutoEndRestartContext | null,
  deps: MeetingAutoEndRestartDeps
): Promise<MeetingAutoEndRestartOutcome> {
  if (!context || context.sessionId !== request.sessionId) {
    return { status: "aborted", reason: "no-context" };
  }
  if (deps.getActiveSessionId() !== null) {
    return { status: "aborted", reason: "already-recording" };
  }

  const args: StartRecordingArgs = { ...context.args, seedSegments: deps.getLatestSegments() };
  const note = args.noteId == null ? null : await deps.getNote(args.noteId);
  const seed = resolveMeetingAutoEndRestartSeed(
    args.noteId,
    note,
    deps.parseSegments,
    args.seedSegments ?? []
  );
  if (!seed.ok) return { status: "aborted", reason: "note-missing" };

  // Re-checked after the note read: a manual recording can win the race across
  // that await, and starting here would adopt the auto-ended note under it.
  if (deps.getActiveSessionId() !== null) {
    return { status: "aborted", reason: "already-recording" };
  }

  const started = await deps.startRecording({ ...args, seedSegments: seed.seedSegments });
  return started ? { status: "started" } : { status: "aborted", reason: "start-refused" };
}

export function isMeetingAutoEndEligible(
  note: Pick<NoteItem, "note_type"> | null | undefined
): boolean {
  return note?.note_type === "meeting";
}

export interface MeetingRecordingStopBarrier {
  runStop<T>(operation: () => Promise<T> | T): Promise<T>;
  waitForPendingStop(): Promise<unknown>;
}

export function createMeetingRecordingStopBarrier(): MeetingRecordingStopBarrier {
  let pendingStop: Promise<unknown> | null = null;

  const waitForPendingStop = (): Promise<unknown> => pendingStop ?? Promise.resolve();
  const runStop = <T>(operation: () => Promise<T> | T): Promise<T> => {
    // Concurrent callers share the in-flight stop's result.
    if (pendingStop) return pendingStop as Promise<T>;

    const stopPromise = Promise.resolve().then(operation);
    pendingStop = stopPromise;
    void stopPromise.then(
      () => {
        if (pendingStop === stopPromise) pendingStop = null;
      },
      () => {
        if (pendingStop === stopPromise) pendingStop = null;
      }
    );
    return stopPromise;
  };

  return { runStop, waitForPendingStop };
}

export interface MeetingRecordingStartOperation {
  sessionId: string;
  isCurrent(): boolean;
  markMainStartAttempted(): void;
  markCommitted(): void;
  stopMainOnce(stopMain: () => Promise<unknown> | unknown): Promise<unknown>;
}

interface PendingStart<T> {
  sessionId: string;
  start: (operation: MeetingRecordingStartOperation) => Promise<T> | T;
  resolveStart: (value: T) => void;
  rejectStart: (error: unknown) => void;
  settleStart: () => void;
  settled: Promise<void>;
  canceled: boolean;
  committed: boolean;
  mainStartAttempted: boolean;
  mainStopPromise: Promise<unknown> | null;
}

export interface MeetingRecordingStartCoordinator {
  runStart<T>(
    sessionId: string,
    start: (operation: MeetingRecordingStartOperation) => Promise<T> | T
  ): Promise<T>;
  cancelActiveStart(expectedSessionId?: string | null): Promise<void> | null;
}

export function createMeetingRecordingStartCoordinator(): MeetingRecordingStartCoordinator {
  let activeStart: PendingStart<unknown> | null = null;
  const pendingStarts: PendingStart<unknown>[] = [];

  const startNext = (): void => {
    if (activeStart || pendingStarts.length === 0) return;

    const state = pendingStarts.shift() as PendingStart<unknown>;
    activeStart = state;
    const operation: MeetingRecordingStartOperation = {
      sessionId: state.sessionId,
      isCurrent: () => activeStart === state && !state.canceled,
      markMainStartAttempted: () => {
        state.mainStartAttempted = true;
      },
      markCommitted: () => {
        state.committed = true;
      },
      stopMainOnce: (stopMain) => {
        if (!state.mainStartAttempted) return Promise.resolve();
        if (!state.mainStopPromise) {
          state.mainStopPromise = Promise.resolve().then(stopMain);
        }
        return state.mainStopPromise;
      },
    };

    void Promise.resolve()
      .then(() => state.start(operation))
      .then(
        (value) => {
          if (activeStart === state) activeStart = null;
          state.settleStart();
          state.resolveStart(value);
          startNext();
        },
        (error) => {
          if (activeStart === state) activeStart = null;
          state.settleStart();
          state.rejectStart(error);
          startNext();
        }
      );
  };

  const runStart = <T>(
    sessionId: string,
    start: (operation: MeetingRecordingStartOperation) => Promise<T> | T
  ): Promise<T> => {
    let resolveStart!: (value: T) => void;
    let rejectStart!: (error: unknown) => void;
    const startPromise = new Promise<T>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    let settleStart!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleStart = resolve;
    });

    // The queue is heterogeneous; each entry's T is only observed by its own
    // resolve/reject pair, so widening to unknown is safe.
    pendingStarts.push({
      sessionId,
      start,
      resolveStart,
      rejectStart,
      settleStart,
      settled,
      canceled: false,
      committed: false,
      mainStartAttempted: false,
      mainStopPromise: null,
    } as PendingStart<unknown>);
    startNext();
    return startPromise;
  };

  const cancelActiveStart = (expectedSessionId?: string | null): Promise<void> | null => {
    if (
      !activeStart ||
      activeStart.committed ||
      (expectedSessionId != null && activeStart.sessionId !== expectedSessionId)
    ) {
      return null;
    }

    activeStart.canceled = true;
    return activeStart.settled;
  };

  return { cancelActiveStart, runStart };
}

export async function teardownFailedMeetingRecordingSetup({
  stopBarrier,
  cleanup,
  stopMain,
  releaseSession,
}: {
  stopBarrier: MeetingRecordingStopBarrier;
  cleanup: () => Promise<unknown> | unknown;
  stopMain: () => Promise<unknown> | unknown;
  releaseSession: () => void;
}): Promise<void> {
  try {
    await stopBarrier.runStop(async () => {
      await cleanup();
      await stopMain();
    });
  } finally {
    releaseSession();
  }
}
