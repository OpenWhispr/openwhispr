function createMeetingTranscriptionLifecycle({
  start,
  stop,
  abort = stop,
  onAbortRequested = () => {},
  onError = () => {},
  isStartAuthorized = () => true,
}) {
  const authorizationChangedResult = () => ({
    success: false,
    reason: "authorization-changed",
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
  });
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

  const isOwnedSession = (expectedSessionId, ownerWebContents) => {
    if (typeof expectedSessionId !== "string" || expectedSessionId.length === 0) return false;
    const session = sessions.get(expectedSessionId);
    return session?.ownerWebContents === ownerWebContents;
  };

  const cancelQueuedSessions = (matchesAuthorizationBinding = () => true) => {
    let canceledCount = 0;
    for (const session of sessions.values()) {
      if (
        session.state !== "queued" ||
        !matchesAuthorizationBinding(session.authorizationBinding)
      ) {
        continue;
      }
      session.authorizationRevoked = true;
      session.abortController.abort();
      canceledCount += 1;
      removeSession(session);
    }
    return canceledCount;
  };

  const stopSession = (expectedSessionId) => {
    const session = resolveSession(expectedSessionId);
    if (!session) {
      return Promise.resolve({ success: false, reason: "stale-session" });
    }
    if (session.abortPromise) return session.abortPromise;
    if (session.stopPromise) return session.stopPromise;

    session.stopRequested = true;
    session.state = "stopping";
    session.stopPromise = enqueue(async () => {
      try {
        if (!session.startSucceeded) {
          return session.abortRequested ? authorizationChangedResult() : { success: true };
        }
        const result = await stop(session.sessionId, session.abortController.signal);
        return session.abortRequested ? authorizationChangedResult() : result;
      } finally {
        removeSession(session);
      }
    });
    return session.stopPromise;
  };

  const abortSession = (expectedSessionId) => {
    const session = resolveSession(expectedSessionId);
    if (!session) {
      return Promise.resolve({ success: false, reason: "stale-session" });
    }
    if (session.abortPromise) return session.abortPromise;

    session.abortRequested = true;
    session.state = "aborting";
    session.abortController.abort();
    onAbortRequested(session.sessionId);
    if (session.stopPromise) {
      const abortPromise = Promise.resolve().then(() => abort(session.sessionId));
      session.abortPromise = abortPromise;
      const stopTail = operationTail;
      operationTail = Promise.allSettled([stopTail, abortPromise]).then(() => undefined);
      void abortPromise.then(
        () => removeSession(session),
        () => removeSession(session)
      );
      return abortPromise;
    }
    session.abortPromise = enqueue(async () => {
      try {
        return await abort(session.sessionId);
      } finally {
        removeSession(session);
      }
    });
    return session.abortPromise;
  };

  const startSession = ({ sessionId, ownerWebContents, options, authorizationBinding = null }) => {
    const operationInProgress = [...sessions.values()].some(
      (session) => session.state !== "stopping" && session.state !== "aborting"
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
      abortRequested: false,
      authorizationRevoked: false,
      authorizationBinding,
      abortController: new AbortController(),
      stopPromise: null,
      abortPromise: null,
      ownerLossHandler: null,
    };
    sessions.set(sessionId, session);

    const startPromise = enqueue(async () => {
      if (session.authorizationRevoked || !isStartAuthorized(session.authorizationBinding)) {
        removeSession(session);
        return authorizationChangedResult();
      }
      if (session.abortRequested) {
        removeSession(session);
        return authorizationChangedResult();
      }
      if (session.stopRequested) {
        removeSession(session);
        return { success: false, error: "Start canceled", reason: "canceled", sessionId };
      }

      session.state = "starting";
      try {
        const result = await start({
          sessionId,
          ownerWebContents,
          options,
          authorizationBinding: session.authorizationBinding,
        });
        session.startSucceeded = result?.success === true;
        if (!session.startSucceeded) {
          removeSession(session);
        } else if (!session.stopRequested && !session.abortRequested) {
          session.state = "active";
        }
        return result;
      } catch (error) {
        removeSession(session);
        throw error;
      }
    });

    const handleOwnerLoss = () => {
      void abortSession(sessionId).catch((error) => {
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

  return { abortSession, cancelQueuedSessions, isOwnedSession, startSession, stopSession };
}

module.exports = createMeetingTranscriptionLifecycle;
