function createMeetingTranscriptionLifecycle({ start, stop, onError = () => {} }) {
  let operationTail = Promise.resolve();
  const sessions = new Map();

  const enqueue = (operation) => {
    const pending = operationTail.then(operation, operation);
    operationTail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  };

  const detachOwnerListeners = (session) => {
    if (!session.ownerLossHandler) return;

    session.ownerWebContents?.removeListener?.("destroyed", session.ownerLossHandler);
    session.ownerWebContents?.removeListener?.("render-process-gone", session.ownerLossHandler);
    session.ownerLossHandler = null;
  };

  const removeSession = (session) => {
    detachOwnerListeners(session);
    if (sessions.get(session.sessionId) === session) {
      sessions.delete(session.sessionId);
    }
  };

  const resolveSession = (expectedSessionId) => {
    if (expectedSessionId != null) return sessions.get(expectedSessionId) ?? null;
    return sessions.values().next().value ?? null;
  };

  const stopSession = (expectedSessionId) => {
    const session = resolveSession(expectedSessionId);
    if (!session) {
      return Promise.resolve({ success: false, reason: "stale-session" });
    }
    if (session.stopPromise) return session.stopPromise;

    session.stopRequested = true;
    session.state = "stopping";
    session.stopPromise = enqueue(async () => {
      try {
        if (!session.startSucceeded) return { success: true };
        return await stop(session.sessionId);
      } finally {
        removeSession(session);
      }
    });
    return session.stopPromise;
  };

  const startSession = ({ sessionId, ownerWebContents, options }) => {
    const operationInProgress = [...sessions.values()].some(
      (session) => session.state !== "stopping"
    );
    if (operationInProgress || sessions.has(sessionId)) {
      return Promise.resolve({ success: false, error: "Operation in progress" });
    }

    const session = {
      sessionId,
      ownerWebContents,
      state: "queued",
      startSucceeded: false,
      stopRequested: false,
      stopPromise: null,
      ownerLossHandler: null,
    };
    sessions.set(sessionId, session);

    const startPromise = enqueue(async () => {
      if (session.stopRequested) {
        removeSession(session);
        return { success: false, error: "Start canceled", reason: "canceled", sessionId };
      }

      session.state = "starting";
      try {
        const result = await start({ sessionId, ownerWebContents, options });
        session.startSucceeded = result?.success === true;
        if (!session.startSucceeded) {
          removeSession(session);
        } else if (!session.stopRequested) {
          session.state = "active";
        }
        return result;
      } catch (error) {
        removeSession(session);
        throw error;
      }
    });

    const handleOwnerLoss = () => {
      void stopSession(sessionId).catch((error) => {
        onError(error, sessionId);
      });
    };
    session.ownerLossHandler = handleOwnerLoss;
    ownerWebContents?.once?.("destroyed", handleOwnerLoss);
    ownerWebContents?.once?.("render-process-gone", handleOwnerLoss);

    if (ownerWebContents?.isDestroyed?.()) {
      handleOwnerLoss();
    }

    return startPromise;
  };

  return { startSession, stopSession };
}

module.exports = createMeetingTranscriptionLifecycle;
