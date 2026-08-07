const COUNTDOWN_MS = 60_000;

const createMeetingAutoEndController = ({
  now = Date.now,
  setTimeout = global.setTimeout,
  clearTimeout = global.clearTimeout,
  onCountdown,
  onCountdownCanceled = () => {},
  onStop,
}) => {
  let currentSession = null;
  let countdownTimer = null;
  let countdownVisible = false;

  const cancelCountdown = () => {
    const sessionId = currentSession?.sessionId;
    if (countdownTimer !== null) {
      clearTimeout(countdownTimer);
      countdownTimer = null;
    }
    if (countdownVisible && sessionId) {
      countdownVisible = false;
      onCountdownCanceled(sessionId);
    }
  };

  const startCountdown = () => {
    const { sessionId } = currentSession;
    const expiresAt = now() + COUNTDOWN_MS;

    currentSession.state = "countdown";
    countdownVisible = true;
    countdownTimer = setTimeout(() => {
      if (
        !currentSession ||
        currentSession.sessionId !== sessionId ||
        currentSession.state !== "countdown"
      ) {
        return;
      }

      countdownTimer = null;
      currentSession.stopped = true;
      onStop(sessionId);
    }, COUNTDOWN_MS);
    onCountdown({ sessionId, expiresAt });
  };

  const beginSession = ({ sessionId, eligible, reliable, externalMicActive }) => {
    cancelCountdown();
    currentSession = {
      sessionId,
      eligible,
      state: eligible && reliable && externalMicActive ? "armed" : "inactive",
      stopped: false,
    };
  };

  const handleExternalMicState = ({ sessionId, reliable, externalMicActive }) => {
    if (
      !currentSession ||
      currentSession.sessionId !== sessionId ||
      !currentSession.eligible ||
      currentSession.state === "disabled" ||
      currentSession.stopped
    ) {
      return;
    }

    if (!reliable) {
      cancelCountdown();
      currentSession.state = "inactive";
      return;
    }

    if (externalMicActive) {
      cancelCountdown();
      currentSession.state = "armed";
      return;
    }

    if (currentSession.state === "armed") {
      startCountdown();
    }
  };

  const keepRecording = (sessionId) => {
    if (!currentSession || currentSession.sessionId !== sessionId) return;

    cancelCountdown();
    currentSession.state = "disabled";
  };

  const endSession = (sessionId) => {
    if (!currentSession || currentSession.sessionId !== sessionId) return;

    cancelCountdown();
    currentSession = null;
  };

  return { beginSession, handleExternalMicState, keepRecording, endSession };
};

module.exports = createMeetingAutoEndController;
