const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Fix round 2, Finding B (review 2026-09-08): reopening Live Transcript
// DURING its own close animation (close() leaves `mounted` true for
// LIVE_TRANSCRIPT_CLOSE_UNMOUNT_MS = 320ms so the collapse can finish
// visually) re-enters openPanel()'s entrancePhase="encapsulate" branch —
// which is indistinguishable from a genuine fresh mount by entrancePhase
// alone, so dictation-panel.css's fresh-mount snap-gate (Task 4 fix round 1,
// Finding 1) fired for it too, snapping a mid-collapse frame straight to the
// closed corner-box instead of letting it reverse smoothly. `freshMount` is
// the fix: true only when `mounted` was actually false immediately before
// this open (a real rest -> mounted transition), false when reopening while
// already mounted (mid-collapse) — so the CSS gate (which now also requires
// [data-panel-fresh-mount="true"]) only ever fires for a genuine first mount.
//
// installHookDom() stubs requestAnimationFrame to a no-op that never invokes
// its callback (no existing hook test drives rAF-dependent code, so there
// was no established override to reuse) — installControllableRaf replaces it
// with a manually-flushable queue, installed AFTER installHookDom so it wins.

function installControllableRaf(t) {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  let nextId = 1;
  let pending = new Map();
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextId++;
    pending.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    pending.delete(id);
  };
  t.after(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  });
  return {
    async flush() {
      const due = [...pending.values()];
      pending = new Map();
      await React.act(async () => {
        for (const callback of due) callback(0);
      });
    },
  };
}

// Lets any promise chains already queued (e.g. openPanel's
// `await requestHeight(...)`, backed here by an already-resolved promise)
// actually resume and run their synchronous continuation before we inspect
// hook state. A macrotask flush drains every pending microtask first,
// regardless of how many `await`s the real implementation chains internally.
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

// Task 10: the entrance's first two beats race the shell's own clip-path
// transitionend against their old timers, so a test has to be able to see
// exactly which timers were armed, at which delays, and which of them a
// settling stage cancelled. Delay 0 passes straight through to the real
// timer so flushMicrotasks below keeps working while this is installed.
function captureEntranceTimers(t) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay, ...rest) => {
    if (!delay) return originalSetTimeout(callback, delay, ...rest);
    const timer = { callback, delay, cancelled: false, fired: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer && typeof timer === "object" && "cancelled" in timer) {
      timer.cancelled = true;
      return;
    }
    originalClearTimeout(timer);
  };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const live = (delay) =>
    timers.filter((timer) => timer.delay === delay && !timer.cancelled && !timer.fired);
  return {
    live,
    one: (delay, what) => {
      const matches = live(delay);
      assert.equal(matches.length, 1, `${what}: expected exactly one live ${delay}ms timer`);
      return matches[0];
    },
    none: (delay, what) => assert.equal(live(delay).length, 0, what),
    run: async (timer) => {
      timer.fired = true;
      await React.act(async () => {
        timer.callback();
        await flushMicrotasks();
      });
    },
  };
}

async function mountLiveTranscriptHook(t, { cachePrefix, window: windowProps } = {}) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, windowProps ? { window: windowProps } : {});
  const container = installHookDom(t);
  const raf = installControllableRaf(t);
  const vite = await createRendererServer(t, { cachePrefix });
  const { useLiveTranscriptPanel } = await vite.ssrLoadModule("/hooks/useLiveTranscriptPanel.js");

  let result;
  function Harness() {
    result = useLiveTranscriptPanel({
      resizeToContent: () => Promise.resolve({ success: true, changed: false }),
      assistantOpenRef: { current: false },
      onWillOpen: () => {},
      isRecording: false,
      isProcessing: false,
      isAssistantVoice: false,
    });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  const reopen = async () => {
    await React.act(async () => {
      result.reopen();
      await flushMicrotasks();
    });
  };

  const settle = async (stage) => {
    await React.act(async () => {
      result.notifyStageSettled(stage);
      await flushMicrotasks();
    });
  };

  return { raf, reopen, settle, read: () => result };
}

test("a genuine fresh mount (never open before) is tagged freshMount=true, at the exact frame the snap-gate needs", async (t) => {
  const { reopen, read } = await mountLiveTranscriptHook(t, {
    cachePrefix: "openwhispr-live-transcript-fresh-mount-",
  });

  assert.equal(read().mounted, false, "sanity: starts unmounted");
  await reopen();

  // The frame the CSS gate targets: mounted, entering encapsulate, not yet
  // open (setOpen(true) is one requestAnimationFrame later — not flushed
  // here on purpose, to inspect exactly this frame).
  assert.equal(read().mounted, true);
  assert.equal(read().open, false);
  assert.equal(read().entrancePhase, "encapsulate");
  assert.equal(read().freshMount, true, "a real rest -> mounted transition must be tagged fresh");
});

test("reopening WHILE still mounted (mid-collapse, before the 320ms unmount timer fires) is tagged freshMount=false", async (t) => {
  const { raf, reopen, read } = await mountLiveTranscriptHook(t, {
    cachePrefix: "openwhispr-live-transcript-reopen-mid-collapse-",
  });

  // Reach a genuinely open, mounted state first — close() only leaves
  // `mounted` true through its unmount delay if it WAS mounted.
  await reopen();
  assert.equal(read().freshMount, true, "sanity: first open is fresh");
  await raf.flush(); // the open-frame's own rAF: setOpen(true) fires here

  assert.equal(read().open, true, "sanity: now genuinely open");

  // Close. `close()` sets open=false and entrancePhase="idle" synchronously,
  // but leaves `mounted` true for LIVE_TRANSCRIPT_CLOSE_UNMOUNT_MS (320ms) so
  // the collapse animation can finish visually before the DOM node goes away.
  await React.act(async () => {
    read().close();
  });
  assert.equal(read().open, false);
  assert.equal(read().mounted, true, "sanity: still mounted mid-collapse — this is the 320ms window");

  // Reopen well inside that window (the coordinator's own repro used ~80ms).
  await reopen();

  assert.equal(read().mounted, true);
  assert.equal(read().open, false);
  assert.equal(read().entrancePhase, "encapsulate");
  assert.equal(
    read().freshMount,
    false,
    "mounted was already true before this open — not a real rest -> mounted transition, so the CSS snap-gate must not fire for it"
  );
});

// ---------------------------------------------------------------------------
// Task 10: the entrance becomes event-driven. Its STAGES and DURATIONS are
// unchanged — only what triggers each step. The first beat (encapsulate ->
// horizontal) and the second (horizontal -> controls) now start when the
// shell reports its own clip-path transition finished; their old timers stay
// armed behind them, at the stage duration plus a grace window, so a shell
// that never reports still advances. Every instant below is derived from
// LIVE_TRANSCRIPT_ENTRANCE_TIMING / getLiveTranscriptEntranceTimeline, never
// retyped.
const loadEntranceTiming = () => import("../../src/helpers/voicePillPresentation.js");

test("the entrance's first two beats start on the shell's own stage transitions, with the old timers behind them", async (t) => {
  const {
    LIVE_TRANSCRIPT_ENTRANCE_TIMING: timing,
    LIVE_TRANSCRIPT_STAGE_GATE_GRACE_MS: grace,
    getLiveTranscriptEntranceTimeline,
  } = await loadEntranceTiming();
  const timeline = getLiveTranscriptEntranceTimeline();
  const { raf, reopen, settle, read } = await mountLiveTranscriptHook(t, {
    cachePrefix: "openwhispr-live-transcript-entrance-gate-",
  });
  const timers = captureEntranceTimers(t);

  await reopen();
  await raf.flush();
  assert.equal(read().open, true, "sanity: the open frame has run");
  assert.equal(read().entrancePhase, "encapsulate");

  // Beat 1 is armed as a race: the shell's "encapsulated" stage settling, or
  // its own duration plus the grace window.
  const encapsulateFallback = timers.one(
    timing.encapsulateMs + grace,
    "the encapsulate gate's fallback"
  );
  // Everything from `prepare` onward keeps its original absolute instant.
  timers.one(timeline.prepareAtMs, "the prepare timer");
  timers.one(timeline.panelAtMs, "the panel timer");

  await settle("encapsulated");
  assert.equal(
    encapsulateFallback.cancelled,
    true,
    "a settled stage must cancel its own fallback, not run both"
  );
  assert.equal(
    read().entrancePhase,
    "encapsulate",
    "the stage settling only opens the hold; the phase advances after it"
  );

  const hold = timers.one(timing.encapsulateHoldMs, "the encapsulate hold");
  await timers.run(hold);
  assert.equal(read().entrancePhase, "horizontal");

  // Beat 2, same shape, on the footer stage.
  const footerFallback = timers.one(timing.horizontalMs + grace, "the footer gate's fallback");
  await settle("footer");
  assert.equal(footerFallback.cancelled, true);
  assert.equal(read().entrancePhase, "horizontal");

  const controlsDelay = timers.one(timing.controlsDelayMs, "the controls delay");
  await timers.run(controlsDelay);
  assert.equal(read().entrancePhase, "controls");
});

test("a shell that never reports still advances, on the old timers plus their grace window", async (t) => {
  const { LIVE_TRANSCRIPT_ENTRANCE_TIMING: timing, LIVE_TRANSCRIPT_STAGE_GATE_GRACE_MS: grace } =
    await loadEntranceTiming();
  const { raf, reopen, read } = await mountLiveTranscriptHook(t, {
    cachePrefix: "openwhispr-live-transcript-entrance-fallback-",
  });
  const timers = captureEntranceTimers(t);

  await reopen();
  await raf.flush();

  await timers.run(timers.one(timing.encapsulateMs + grace, "the encapsulate fallback"));
  await timers.run(timers.one(timing.encapsulateHoldMs, "the encapsulate hold"));
  assert.equal(read().entrancePhase, "horizontal");

  await timers.run(timers.one(timing.horizontalMs + grace, "the footer fallback"));
  await timers.run(timers.one(timing.controlsDelayMs, "the controls delay"));
  assert.equal(read().entrancePhase, "controls");
});

// Reduced motion: src/index.css's blanket `*, *::before, *::after` rule sets
// transition-property with !important to a list that EXCLUDES clip-path, so
// the shell's stage clip simply applies and NO transitionend can ever arrive.
// The gate must therefore not be armed at all, and the beat must keep its
// ORIGINAL instant rather than the fallback's stage-duration-plus-grace —
// otherwise the entrance would run slower with reduced motion on than off.
test("reduced motion arms no stage gate and keeps the entrance's original instants", async (t) => {
  const { LIVE_TRANSCRIPT_ENTRANCE_TIMING: timing, LIVE_TRANSCRIPT_STAGE_GATE_GRACE_MS: grace } =
    await loadEntranceTiming();
  const { raf, reopen, settle, read } = await mountLiveTranscriptHook(t, {
    cachePrefix: "openwhispr-live-transcript-entrance-reduced-motion-",
    window: { matchMedia: () => ({ matches: true }) },
  });
  const timers = captureEntranceTimers(t);

  await reopen();
  await raf.flush();

  timers.none(
    timing.encapsulateMs + grace,
    "no fallback-with-grace may be armed when there is no event to fall back FROM"
  );
  const encapsulate = timers.one(timing.encapsulateMs, "the encapsulate beat's own timer");

  // A stray settle (the shell's opacity transition still fires under reduced
  // motion, and a future caller could mis-route one) must change nothing.
  await settle("encapsulated");
  assert.equal(encapsulate.cancelled, false, "no gate is armed, so nothing can cancel this beat");
  assert.equal(read().entrancePhase, "encapsulate");

  await timers.run(encapsulate);
  await timers.run(timers.one(timing.encapsulateHoldMs, "the encapsulate hold"));
  assert.equal(read().entrancePhase, "horizontal");

  timers.none(timing.horizontalMs + grace, "the footer beat likewise arms no gate");
  await timers.run(timers.one(timing.horizontalMs, "the footer beat's own timer"));
  await timers.run(timers.one(timing.controlsDelayMs, "the controls delay"));
  assert.equal(read().entrancePhase, "controls");
});

// Reopening inside close()'s 320ms unmount window starts a SECOND entrance
// while the first one's chain is still suspended on its gate. The old chain
// must be unable to touch the new one: its fallback is cancelled and its gate
// is dropped, so one settling stage advances exactly one entrance.
test("a re-open during the close leaves no stale gate that could advance the new entrance", async (t) => {
  const { LIVE_TRANSCRIPT_ENTRANCE_TIMING: timing, LIVE_TRANSCRIPT_STAGE_GATE_GRACE_MS: grace } =
    await loadEntranceTiming();
  const { raf, reopen, settle, read } = await mountLiveTranscriptHook(t, {
    cachePrefix: "openwhispr-live-transcript-entrance-reopen-",
  });
  const timers = captureEntranceTimers(t);

  await reopen();
  await raf.flush();
  const firstFallback = timers.one(timing.encapsulateMs + grace, "the first entrance's fallback");

  await React.act(async () => {
    read().close();
  });
  assert.equal(read().mounted, true, "sanity: still mounted — this is the 320ms close window");
  assert.equal(firstFallback.cancelled, true, "closing must cancel the entrance's own timers");

  // The abandoned chain's gate must be gone too, not merely its timer.
  await settle("encapsulated");
  timers.none(timing.encapsulateHoldMs, "a closed entrance must not resume on a late stage report");

  await reopen();
  await raf.flush();
  assert.equal(read().freshMount, false, "sanity: a mid-collapse reopen is not a fresh mount");
  timers.one(timing.encapsulateMs + grace, "the second entrance arms exactly one fallback");

  await settle("encapsulated");
  const hold = timers.one(
    timing.encapsulateHoldMs,
    "one settling stage must advance exactly one entrance"
  );
  await timers.run(hold);
  assert.equal(read().entrancePhase, "horizontal");
});
