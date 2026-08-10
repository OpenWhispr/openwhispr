import type { NoteItem } from "../types/electron";

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
  stopRecording: (sessionId: string) => unknown,
  onError: (error: unknown, sessionId: string) => void
): boolean {
  const sessionId = payload?.sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) return false;

  // A rejected stop means the recording is still running while main already
  // considers the countdown expired — surface it instead of swallowing it.
  void Promise.resolve(stopRecording(sessionId)).catch((error) => onError(error, sessionId));
  return true;
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
