const COUNTDOWN_MS = 60_000;
// Fallback mode: both channels must stay quiet this long before prompting.
const SILENCE_WINDOW_MS = 60_000;
// Fallback mode after the tracked meeting app exits — a much stronger signal.
const FAST_SILENCE_MS = 10_000;
// After "Keep recording": no re-prompt sooner than this, even on fresh evidence.
const KEEP_COOLDOWN_MS = 5 * 60_000;
// An external mic hold shorter than this (Siri, a permission prompt, the Sound
// settings input meter) is incidental — it must not arm the mic-ignoring
// ownership path on what is really an in-person recording.
const OWNERSHIP_MIN_ACTIVE_MS = 30_000;
// A tick gap longer than this means the machine slept; silence accumulated
// before the gap is stale and must not fire a stop.
const TICK_GAP_MS = 5_000;

// Two evidence sources decide "the meeting is over":
//
//   ownership — an external app held the mic and released it. The countdown
//     runs only while the SYSTEM channel is also quiet (remote voices still
//     playing means the call is live, e.g. an app that releases the mic on
//     mute). The mic channel is deliberately ignored here so room noise,
//     typing, or talking to a colleague after the call can't mask the end.
//   fallback — ownership is unreliable, or no external app ever held the mic
//     this session (in-person meetings). Both channels quiet for the silence
//     window prompts; a tracked meeting app exiting shortens the window.
//
// Tick-driven and timer-free: every input updates state and re-evaluates; the
// owner calls tick() about once a second. That keeps sleep handling correct — a
// timer due before sleep would fire on wake and stop the recording before any
// gap check could run.
const createMeetingAutoEndController = ({
  now = Date.now,
  onCountdown,
  onCountdownCanceled = () => {},
  onCountdownExpired = () => {},
  onStop,
}) => {
  let session = null;
  let lastSeenAt = null;

  const isLive = (sessionId) =>
    session !== null && session.sessionId === sessionId && session.eligible && !session.stopped;

  const cancelCountdown = () => {
    if (!session?.countdown) return;
    session.countdown = null;
    onCountdownCanceled(session.sessionId);
  };

  // Every entry point observes the clock first, not just tick(): after sleep,
  // the owner's monitor tick can deliver an activity change before the
  // controller's own tick runs, and that path must not fire a stale countdown.
  const observeClock = () => {
    const nowMs = now();
    const gap = lastSeenAt === null ? 0 : nowMs - lastSeenAt;
    lastSeenAt = nowMs;
    if (gap > TICK_GAP_MS && session) {
      // Slept through the gap: whatever silence accumulated is stale, and a
      // countdown that was running must not fire on wake.
      session.quietSince = nowMs;
      session.fastArmAt = null;
      cancelCountdown();
    }
    return nowMs;
  };

  const startCountdown = (reason) => {
    const expiresAt = now() + COUNTDOWN_MS;
    session.countdown = { expiresAt, reason };
    onCountdown({ sessionId: session.sessionId, expiresAt, reason });
  };

  const evaluate = () => {
    if (!session || !session.eligible || session.stopped) return;
    const nowMs = now();

    if (session.countdown) {
      if (nowMs >= session.countdown.expiresAt) {
        const { reason } = session.countdown;
        const { sessionId } = session;
        session.countdown = null;
        session.stopped = true;
        onCountdownExpired(sessionId);
        onStop(sessionId, reason);
      }
      return;
    }

    if (session.episodeConsumed || nowMs < session.keptUntil) return;

    if (session.mode === "ownership") {
      if (!session.externalMicActive && !session.systemActive) startCountdown("mic-released");
      return;
    }

    if (session.micActive || session.systemActive) return;
    const fastArmed = session.fastArmAt !== null;
    const quietStart = fastArmed
      ? Math.max(session.quietSince, session.fastArmAt)
      : session.quietSince;
    const window = fastArmed ? FAST_SILENCE_MS : SILENCE_WINDOW_MS;
    if (nowMs - quietStart >= window) startCountdown(fastArmed ? "process-exit" : "silence");
  };

  const beginSession = ({
    sessionId,
    eligible,
    reliable,
    externalMicActive,
    micActive = false,
    systemActive = false,
  }) => {
    cancelCountdown();
    const nowMs = now();
    lastSeenAt = nowMs;
    const ownership = eligible && reliable && externalMicActive;
    session = {
      sessionId,
      eligible: eligible === true,
      // Explicit state, never derived: a reliable-but-inactive report after a
      // reliability loss must not jump back into ownership mode.
      mode: ownership ? "ownership" : "fallback",
      externalMicActive: ownership,
      externalMicActiveSince: ownership ? nowMs : null,
      micActive,
      systemActive,
      quietSince: nowMs,
      fastArmAt: null,
      keptUntil: 0,
      episodeConsumed: false,
      countdown: null,
      stopped: false,
    };
    evaluate();
  };

  const handleExternalMicState = ({ sessionId, reliable, externalMicActive }) => {
    const nowMs = observeClock();
    if (!isLive(sessionId)) return;

    if (!reliable) {
      cancelCountdown();
      session.mode = "fallback";
      session.externalMicActive = false;
      session.externalMicActiveSince = null;
      session.quietSince = nowMs;
      evaluate();
      return;
    }

    if (externalMicActive) {
      cancelCountdown();
      if (!session.externalMicActive) session.externalMicActiveSince = nowMs;
      session.externalMicActive = true;
      session.mode = "ownership";
      // A new call is fresh evidence: reopen the episode after a Keep.
      session.episodeConsumed = false;
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
      } else {
        // A call that was genuinely rejoined and left again is unambiguous
        // evidence; making it wait out the keep cooldown reads as the feature
        // silently failing. The cooldown exists for silence-based nags, which
        // still honor it.
        session.keptUntil = 0;
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

    if (session.mode === "ownership") {
      // Only remote audio says the call is live; the mic channel is ignored.
      if (systemBecameActive) cancelCountdown();
    } else if (micBecameActive || systemBecameActive) {
      cancelCountdown();
      // Someone spoke — fresh evidence reopens the episode; a process exit
      // no longer describes the current situation.
      session.episodeConsumed = false;
      session.fastArmAt = null;
    }
    if (!wasQuiet && !micActive && !systemActive) session.quietSince = nowMs;
    evaluate();
  };

  const handleMeetingProcessExit = ({ sessionId }) => {
    const nowMs = observeClock();
    if (!isLive(sessionId)) return;
    if (session.mode !== "fallback" || session.countdown) return;
    session.fastArmAt = nowMs;
    // The app quitting is fresh evidence, so a kept session can prompt again —
    // but never sooner than the keep cooldown.
    session.episodeConsumed = false;
    evaluate();
  };

  const handleCountdownUnavailable = (sessionId) => {
    observeClock();
    if (!isLive(sessionId) || !session.countdown) return false;
    cancelCountdown();
    // Do not retry the same episode when the user had no chance to keep it.
    session.episodeConsumed = true;
    return true;
  };

  // Returns false once the countdown has fired: the stop is already in flight,
  // so reporting success would tell the user their recording was kept.
  // Keep is per episode: prompts resume only on fresh evidence. Renewed audio
  // or a process exit (fallback) also wait out the cooldown; a call rejoined
  // for at least OWNERSHIP_MIN_ACTIVE_MS and left again re-prompts at once. In
  // ownership mode with no further call the session is never prompted again.
  const keepRecording = (sessionId) => {
    const nowMs = observeClock();
    if (!session || session.sessionId !== sessionId || session.stopped) return false;
    cancelCountdown();
    session.episodeConsumed = true;
    session.keptUntil = nowMs + KEEP_COOLDOWN_MS;
    return true;
  };

  const endSession = (sessionId) => {
    if (!session || session.sessionId !== sessionId) return;
    cancelCountdown();
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
    handleCountdownUnavailable,
    keepRecording,
    endSession,
    tick,
  };
};

module.exports = createMeetingAutoEndController;
module.exports.COUNTDOWN_MS = COUNTDOWN_MS;
module.exports.SILENCE_WINDOW_MS = SILENCE_WINDOW_MS;
module.exports.FAST_SILENCE_MS = FAST_SILENCE_MS;
module.exports.KEEP_COOLDOWN_MS = KEEP_COOLDOWN_MS;
module.exports.OWNERSHIP_MIN_ACTIVE_MS = OWNERSHIP_MIN_ACTIVE_MS;
module.exports.TICK_GAP_MS = TICK_GAP_MS;
