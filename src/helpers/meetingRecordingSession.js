export function createMeetingRecordingSessionId(randomUUID = () => crypto.randomUUID()) {
  return randomUUID();
}

export function canStopMeetingRecordingSession(activeSessionId, expectedSessionId) {
  return expectedSessionId == null || activeSessionId === expectedSessionId;
}

export function requestMeetingRecordingAutoEnd(payload, stopRecording) {
  const sessionId = payload?.sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) return false;

  void Promise.resolve(stopRecording(sessionId)).catch(() => undefined);
  return true;
}

export function isMeetingAutoEndEligible(note) {
  return note?.note_type === "meeting";
}

export function createMeetingRecordingStopBarrier() {
  let pendingStop = null;

  const waitForPendingStop = () => pendingStop ?? Promise.resolve();
  const runStop = (operation) => {
    if (pendingStop) return pendingStop;

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

export function createMeetingRecordingStartCoordinator() {
  let activeStart = null;
  const pendingStarts = [];

  const startNext = () => {
    if (activeStart || pendingStarts.length === 0) return;

    const state = pendingStarts.shift();
    activeStart = state;
    const operation = {
      sessionId: state.sessionId,
      isCurrent: () => activeStart === state && !state.canceled,
      isCanceled: () => state.canceled,
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

  const runStart = (sessionId, start) => {
    let resolveStart;
    let rejectStart;
    const startPromise = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    let settleStart;
    const settled = new Promise((resolve) => {
      settleStart = resolve;
    });

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
    });
    startNext();
    return startPromise;
  };

  const cancelActiveStart = (expectedSessionId) => {
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
}) {
  try {
    await stopBarrier.runStop(async () => {
      await cleanup();
      await stopMain();
    });
  } finally {
    releaseSession();
  }
}
