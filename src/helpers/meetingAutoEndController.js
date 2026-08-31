// Fallback mode: both channels must stay quiet this long before stopping.
const SILENCE_WINDOW_MS = 60_000;
// Fallback mode after the tracked meeting app exits — a much stronger signal.
const FAST_SILENCE_MS = 10_000;
// A mic release must stay uncontradicted this long before it stops a recording.
// The OS reports a release for things that are not the call ending: a device
// flap emits MIC_STOP and MIC_START in one reconcile pass, an app rebuilds its
// input unit when screen share starts, and an app that drops the mic on mute
// looks identical to one that left the call. Without a dwell time each of those
// ends a live recording, and the stop is irreversible. A flap has no gap at all,
// so a few seconds absorbs it while keeping the stop prompt.
const OWNERSHIP_CONFIRM_MS = 5_000;
// An external mic hold shorter than this (Siri, a permission prompt, the Sound
// settings input meter) is incidental — it must not arm the mic-ignoring
// ownership path on what is really an in-person recording.
const OWNERSHIP_MIN_ACTIVE_MS = 30_000;
// A tick gap longer than this means the machine slept; silence accumulated
// before the gap is stale and must not stop the recording on wake.
const TICK_GAP_MS = 5_000;

// Two evidence sources decide "the meeting is over":
//
//   ownership — an external app held the mic and released it. Stop only once the
//     release has held for OWNERSHIP_CONFIRM_MS with the SYSTEM channel also
//     quiet throughout (remote voices still playing means the call is live, e.g.
//     an app that releases the mic on mute). The mic channel is deliberately
//     ignored here so room noise after the call cannot mask the end.
//   fallback — ownership is unreliable, or no external app ever held the mic
//     this session. Both channels quiet for the silence window stops; a tracked
//     meeting app exiting shortens the window.
//
// Tick-driven and timer-free: every input updates state and re-evaluates; the
// owner calls tick() about once a second. This keeps sleep handling correct.
const createMeetingAutoEndController = ({ now = Date.now, onStop }) => {
  let session = null;
  let lastSeenAt = null;

  const isLive = (sessionId) =>
    session !== null && session.sessionId === sessionId && session.eligible && !session.stopped;

  const observeClock = () => {
    const nowMs = now();
    const gap = lastSeenAt === null ? 0 : nowMs - lastSeenAt;
    lastSeenAt = nowMs;
    if (gap > TICK_GAP_MS && session) {
      session.quietSince = nowMs;
      session.fastArmAt = null;
      session.ownershipQuietSince = null;
      if (session.externalMicActive) {
        // Ownership observed before sleep is stale. Count it again from wake so
        // a release delivered with the first resumed poll cannot stop at once.
        session.externalMicActiveSince = nowMs;
      } else {
        session.mode = "fallback";
        session.externalMicActiveSince = null;
      }
    }
    return nowMs;
  };

  const stop = (reason) => {
    const { sessionId } = session;
    session.stopped = true;
    onStop(sessionId, reason);
  };

  const evaluate = () => {
    if (!session || !session.eligible || session.stopped) return;
    const nowMs = now();

    // A session the user explicitly restarted carries a grace period: they have
    // just told us the meeting is still live, so hold every stop path and keep
    // the quiet clocks reset, so the grace expiring cannot stop instantly.
    if (nowMs < session.suppressUntil) {
      session.quietSince = nowMs;
      session.fastArmAt = null;
      session.ownershipQuietSince = null;
      return;
    }

    if (session.mode === "ownership") {
      // Any contradicting evidence — the mic coming back, or remote audio
      // resuming — restarts the window rather than merely deferring the stop.
      if (session.externalMicActive || session.systemActive) {
        session.ownershipQuietSince = null;
        return;
      }
      if (session.ownershipQuietSince === null) session.ownershipQuietSince = nowMs;
      if (nowMs - session.ownershipQuietSince >= OWNERSHIP_CONFIRM_MS) stop("mic-released");
      return;
    }

    if (session.micActive || session.systemActive) return;
    const fastArmed = session.fastArmAt !== null;
    const quietStart = fastArmed
      ? Math.max(session.quietSince, session.fastArmAt)
      : session.quietSince;
    const windowMs = fastArmed ? FAST_SILENCE_MS : SILENCE_WINDOW_MS;
    if (nowMs - quietStart >= windowMs) stop(fastArmed ? "process-exit" : "silence");
  };

  const beginSession = ({
    sessionId,
    eligible,
    reliable,
    externalMicActive,
    micActive = false,
    systemActive = false,
    suppressUntil = 0,
  }) => {
    const nowMs = now();
    lastSeenAt = nowMs;
    const ownership = eligible && reliable && externalMicActive;
    session = {
      sessionId,
      eligible: eligible === true,
      mode: ownership ? "ownership" : "fallback",
      externalMicActive: ownership,
      externalMicActiveSince: ownership ? nowMs : null,
      micActive,
      systemActive,
      quietSince: nowMs,
      fastArmAt: null,
      ownershipQuietSince: null,
      suppressUntil,
      stopped: false,
    };
    evaluate();
  };

  const handleExternalMicState = ({ sessionId, reliable, externalMicActive }) => {
    const nowMs = observeClock();
    if (!isLive(sessionId)) return;

    if (!reliable) {
      session.mode = "fallback";
      session.externalMicActive = false;
      session.externalMicActiveSince = null;
      session.quietSince = nowMs;
      session.fastArmAt = null;
      evaluate();
      return;
    }

    if (externalMicActive) {
      if (!session.externalMicActive) session.externalMicActiveSince = nowMs;
      session.externalMicActive = true;
      session.mode = "ownership";
      session.fastArmAt = null;
      evaluate();
      return;
    }

    if (session.mode === "ownership" && session.externalMicActive) {
      session.externalMicActive = false;
      const heldMs = nowMs - session.externalMicActiveSince;
      session.externalMicActiveSince = null;
      if (heldMs < OWNERSHIP_MIN_ACTIVE_MS) {
        session.mode = "fallback";
        session.quietSince = nowMs;
      }
    }
    evaluate();
  };

  const handleAudioActivity = ({ sessionId, micActive, systemActive }) => {
    const nowMs = observeClock();
    if (!isLive(sessionId)) return;
    const micBecameActive = micActive && !session.micActive;
    const systemBecameActive = systemActive && !session.systemActive;
    const wasQuiet = !session.micActive && !session.systemActive;
    session.micActive = micActive;
    session.systemActive = systemActive;

    if (session.mode === "fallback" && (micBecameActive || systemBecameActive)) {
      session.fastArmAt = null;
    }
    if (!wasQuiet && !micActive && !systemActive) session.quietSince = nowMs;
    evaluate();
  };

  const handleMeetingProcessExit = ({ sessionId }) => {
    const nowMs = observeClock();
    if (!isLive(sessionId) || session.mode !== "fallback") return;
    session.fastArmAt = nowMs;
    evaluate();
  };

  const endSession = (sessionId) => {
    if (!session || session.sessionId !== sessionId) return;
    session = null;
  };

  const tick = () => {
    observeClock();
    evaluate();
  };

  return {
    beginSession,
    handleExternalMicState,
    handleAudioActivity,
    handleMeetingProcessExit,
    endSession,
    tick,
  };
};

module.exports = createMeetingAutoEndController;
module.exports.SILENCE_WINDOW_MS = SILENCE_WINDOW_MS;
module.exports.FAST_SILENCE_MS = FAST_SILENCE_MS;
module.exports.OWNERSHIP_MIN_ACTIVE_MS = OWNERSHIP_MIN_ACTIVE_MS;
module.exports.OWNERSHIP_CONFIRM_MS = OWNERSHIP_CONFIRM_MS;
module.exports.TICK_GAP_MS = TICK_GAP_MS;
