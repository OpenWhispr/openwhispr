// The macOS tap helper writes a chunk every period whatever the audio is, so a
// gap this long means delivery stopped rather than the call going quiet.
const STALL_MS = 6_000;
// Chunks still arriving but silent for this long, after the call was audible at
// least once. Warning only: a genuinely quiet call looks exactly the same.
const GONE_QUIET_MS = 180_000;
// Enough to ride out a route change and its aftershocks without looping if the
// device is simply gone.
const MAX_RESTARTS = 3;
// A tick gap longer than this means the machine slept or the main process
// blocked. Delivery evidence from before the gap says nothing about now, and
// node runs the timers phase before the poll phase, so the tick after a block
// lands before the stdout data it should have been judging.
const TICK_GAP_MS = 5_000;

// The system-audio tap is built once and never follows the machine afterwards,
// so a route change or a disappearing device can stop capture with the helper
// process still alive and the UI still showing a live recording. Nothing else
// notices: the helper does not exit, and silence is indistinguishable from a
// quiet call, which is what made openwhispr#1990 invisible mid-meeting.
//
// Two triggers are trusted enough to restart capture:
//
//   delivery: no chunk at all for STALL_MS. Only meaningful where the platform
//     guarantees a chunk per period (the macOS tap); the loopback helpers may
//     legitimately go idle, so the caller opts in via watchesDelivery.
//   device: the helper reported that the device it was pinned to changed or
//     went away. Decisive, and faster than waiting for the stall window.
//
// Going quiet is reported but never restarts anything, because restarting a
// working capture costs real audio and a silent call is not a fault.
//
// Tick-driven like meetingAutoEndController: every input updates state and the
// owner calls tick() on an interval, so there is no timer to leak per session.
const createMeetingSystemAudioWatchdog = ({ now = Date.now, onInterrupted }) => {
  let session = null;
  let capture = null;
  // Bumped on every attach and detach. A restart suspended between its two
  // halves compares against the value it started with, so a meeting that ends
  // mid-restart cannot leave an orphan helper holding a process tap.
  let generation = 0;
  let lastTickAt = null;

  const notify = (reason, recovering) => {
    onInterrupted?.({
      systemAudioStrategy: session.systemAudioStrategy,
      reason,
      recovering,
    });
  };

  // Capture is attached when it starts, which happens before the session is
  // armed. start() must therefore never drop it, and detaching is teardown's
  // job alone: an earlier draft cleared it from the arming path and shipped a
  // watchdog that warned about stalls it could not actually recover from.
  const attachCapture = ({ stop, start }) => {
    generation += 1;
    capture = { generation, stop, start };
  };

  const detachCapture = () => {
    generation += 1;
    capture = null;
  };

  const runRestart = async () => {
    if (!capture) {
      return;
    }
    const target = capture;
    await target.stop().catch(() => {});
    if (generation !== target.generation) {
      return;
    }
    await target.start();
    if (generation !== target.generation) {
      // The session ended while the helper was coming back up.
      await target.stop().catch(() => {});
    }
  };

  const requestRestart = (reason) => {
    if (!session || session.restartInFlight || session.recoveryFailed) {
      return;
    }

    if (session.restarts >= MAX_RESTARTS) {
      // Latched, so a later device event cannot restart the count at zero and
      // hand out another three attempts. The give-up report supersedes the
      // quiet one, which would otherwise arrive later saying less.
      session.recoveryFailed = true;
      session.quietReported = true;
      notify(reason, false);
      return;
    }

    const active = session;
    active.restarts += 1;
    active.restartInFlight = true;
    notify(reason, true);

    Promise.resolve()
      .then(runRestart)
      .catch(() => {})
      .finally(() => {
        if (session !== active) {
          return;
        }
        active.restartInFlight = false;
        // Give the fresh capture a clean window even if the restart threw; the
        // next tick judges it on its own evidence either way.
        const at = now();
        active.lastChunkAt = at;
        if (active.lastAudibleAt !== null) {
          active.lastAudibleAt = at;
        }
      });
  };

  const start = ({ systemAudioStrategy, watchesDelivery = false } = {}) => {
    lastTickAt = null;
    session = {
      systemAudioStrategy: systemAudioStrategy ?? null,
      watchesDelivery: watchesDelivery === true,
      // Null until the first chunk: a stream that never delivered at all is the
      // one-shot silence warning's case, not this one. Seeding it with now()
      // would assert a delivery that has not happened and let the watchdog
      // restart during startup, before the renderer is even listening.
      lastChunkAt: null,
      lastAudibleAt: null,
      restarts: 0,
      restartInFlight: false,
      recoveryFailed: false,
      quietReported: false,
    };
  };

  const stop = () => {
    session = null;
    lastTickAt = null;
    detachCapture();
  };

  const recordChunk = (audible = false) => {
    if (!session) {
      return;
    }
    const at = now();
    session.lastChunkAt = at;
    if (audible) {
      session.lastAudibleAt = at;
    }
  };

  const reportDeviceInvalidated = () => {
    requestRestart("device_invalidated");
  };

  // Rebases the delivery evidence across a gap the session did not really live
  // through, so waking from sleep does not read as a dead tap.
  const observeClock = () => {
    const at = now();
    const gap = lastTickAt === null ? 0 : at - lastTickAt;
    lastTickAt = at;
    if (gap > TICK_GAP_MS && session) {
      if (session.lastChunkAt !== null) {
        session.lastChunkAt = at;
      }
      if (session.lastAudibleAt !== null) {
        session.lastAudibleAt = at;
      }
    }
    return at;
  };

  const tick = () => {
    const at = observeClock();
    if (!session || session.restartInFlight) {
      return;
    }

    if (
      session.watchesDelivery &&
      session.lastChunkAt !== null &&
      at - session.lastChunkAt > STALL_MS
    ) {
      requestRestart("no_audio_delivered");
      return;
    }

    if (
      !session.quietReported &&
      session.lastAudibleAt !== null &&
      at - session.lastAudibleAt > GONE_QUIET_MS
    ) {
      session.quietReported = true;
      notify("gone_quiet", false);
    }
  };

  return {
    start,
    stop,
    attachCapture,
    detachCapture,
    recordChunk,
    reportDeviceInvalidated,
    tick,
  };
};

module.exports = createMeetingSystemAudioWatchdog;
module.exports.STALL_MS = STALL_MS;
module.exports.GONE_QUIET_MS = GONE_QUIET_MS;
module.exports.MAX_RESTARTS = MAX_RESTARTS;
module.exports.TICK_GAP_MS = TICK_GAP_MS;
