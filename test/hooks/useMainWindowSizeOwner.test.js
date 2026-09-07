const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Pure ESM/TS modules load directly (no vite SSR needed — same convention as
// test/utils/transitionSettled.test.js and test/helpers/voicePillPresentation.test.js).
const loadTransitionUtils = () => import("../../src/utils/transitionSettled.ts");
const loadVoicePillPresentation = () => import("../../src/helpers/voicePillPresentation.js");

async function mountOwner(t, { waitForShrink, windowProps = {} }) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { electronAPI: {}, ...windowProps } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-main-window-size-owner-test-",
  });
  const { useMainWindowSizeOwner } = await vite.ssrLoadModule("/hooks/useMainWindowSizeOwner.js");

  const requests = [];
  const refs = { assistantOpenRef: { current: false }, liveTranscriptOpenRef: { current: false } };
  let props = {
    requestMainWindowSize: async (key) => {
      requests.push(key);
      return { success: true };
    },
    dictationErrorActionCount: 0,
    toastCount: 0,
    isCommandMenuOpen: false,
    isCompactPill: false,
    handsFreeTipVisible: false,
    assistantOpen: false,
    assistantMounted: false,
    liveTranscriptOpen: false,
    liveTranscriptMounted: false,
    ...refs,
    waitForShrink,
  };
  function Harness() {
    useMainWindowSizeOwner(props);
    return null;
  }
  root = createRoot(container);
  const render = async (next = {}) => {
    props = { ...props, ...next };
    await React.act(async () => {
      root.render(React.createElement(Harness));
    });
  };
  await render();
  return { render, requests };
}

test("a grow applies at once; a shrink waits for the caller's settle promise", async (t) => {
  let settle;
  const { render, requests } = await mountOwner(t, {
    waitForShrink: () => new Promise((resolve) => (settle = resolve)),
  });
  assert.deepEqual(requests, ["BASE"]);

  await render({ isCompactPill: true });
  assert.deepEqual(requests, ["BASE", "RECORDING"]);

  await render({ isCompactPill: false });
  assert.deepEqual(requests, ["BASE", "RECORDING"], "shrink must not be requested yet");

  await React.act(async () => {
    settle();
  });
  assert.deepEqual(requests, ["BASE", "RECORDING", "BASE"]);
});

test("a grow that supersedes a pending shrink cancels it", async (t) => {
  let settle;
  const { render, requests } = await mountOwner(t, {
    waitForShrink: () => new Promise((resolve) => (settle = resolve)),
  });
  await render({ isCompactPill: true });
  await render({ isCompactPill: false });
  await render({ isCommandMenuOpen: true });
  assert.deepEqual(requests, ["BASE", "RECORDING", "WITH_MENU"]);
  await React.act(async () => {
    settle();
  });
  assert.deepEqual(requests, ["BASE", "RECORDING", "WITH_MENU"], "the stale shrink never lands");
});

// The two tests above prove the shrink is gated on *a* promise rather than
// applied immediately — but the promise is hand-resolved, so they can't tell
// a real transitionend-driven wait from a bare timer whose duration happens
// not to matter to the assertions. A review of Task 2 found that kind of gap
// once already (a pinned easing with zero coverage — reverting the whole
// deliverable still left the suite green), so these exercise the REAL
// waitForTransitionEnd against a fake element that fires genuine
// transitionend events, using the same expression App.jsx wires up
// (waitForTransitionEnd(pillEl, "width", settleFallbackMs(expansionMs))).
// That proves three things a hand-resolved promise cannot:
//   1. a transition that never fires still shrinks (the fallback path)
//   2. the fallback's duration is the one settleFallbackMs computes today —
//      not the old bare 340ms, and not some other open-coded number
//   3. a transition that fires EARLY shrinks right then, not after either
//      duration — proof it's event-driven, not a disguised timer

// Minimal fake DOM element: just enough of the EventTarget contract for the
// real waitForTransitionEnd to register on and be fired at.
function fakeElement() {
  const listenersByType = new Map();
  const setFor = (type) => {
    let set = listenersByType.get(type);
    if (!set) {
      set = new Set();
      listenersByType.set(type, set);
    }
    return set;
  };
  return {
    addEventListener: (type, fn) => setFor(type).add(fn),
    removeEventListener: (type, fn) => setFor(type).delete(fn),
    fire(target, propertyName, type = "transitionend") {
      for (const fn of [...setFor(type)]) fn({ target, propertyName, type });
    },
  };
}

test("a shrink whose transition never fires still lands — timed to settleFallbackMs's boundary, not the old bare 340ms", async (t) => {
  const { waitForTransitionEnd, settleFallbackMs } = await loadTransitionUtils();
  const { LISTENING_ENTRANCE_TIMING } = await loadVoicePillPresentation();
  const fallbackMs = settleFallbackMs(LISTENING_ENTRANCE_TIMING.expansionMs);
  assert.equal(
    fallbackMs,
    480,
    "sanity pin: the pill's pinned width duration (360ms) plus the standard 120ms grace"
  );

  const fakeEl = fakeElement(); // deliberately never fired
  const { render, requests } = await mountOwner(t, {
    waitForShrink: () => waitForTransitionEnd(fakeEl, "width", fallbackMs),
  });
  await render({ isCompactPill: true });
  await render({ isCompactPill: false });
  assert.deepEqual(requests, ["BASE", "RECORDING"]);

  // 400ms: past the OLD hard-coded 340ms timer (so a regression back to it
  // would already show the shrink here) but comfortably under the 480ms
  // settleFallbackMs boundary.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(
    requests,
    ["BASE", "RECORDING"],
    "must not have shrunk yet at 400ms — the old bare 340ms timer would already have fired"
  );

  await new Promise((resolve) => setTimeout(resolve, fallbackMs - 400 + 150));
  assert.deepEqual(
    requests,
    ["BASE", "RECORDING", "BASE"],
    "the fallback must eventually land once the transition never fires"
  );
});

test("a shrink whose transition fires EARLY lands right away, not after the fallback", async (t) => {
  const { waitForTransitionEnd, settleFallbackMs } = await loadTransitionUtils();
  const { LISTENING_ENTRANCE_TIMING } = await loadVoicePillPresentation();
  const fallbackMs = settleFallbackMs(LISTENING_ENTRANCE_TIMING.expansionMs);

  const fakeEl = fakeElement();
  const { render, requests } = await mountOwner(t, {
    waitForShrink: () => waitForTransitionEnd(fakeEl, "width", fallbackMs),
  });
  await render({ isCompactPill: true });
  await render({ isCompactPill: false });
  assert.deepEqual(requests, ["BASE", "RECORDING"]);

  await React.act(async () => {
    fakeEl.fire(fakeEl, "width"); // the real event, fired well before 480ms
    await Promise.resolve();
  });
  assert.deepEqual(
    requests,
    ["BASE", "RECORDING", "BASE"],
    "the transitionend itself must drive the shrink immediately, not the fallback timer"
  );
});

// Fix round 1 (review of task-3-report.md, 2026-09-07), findings 1, 2 and 4.
// Finding 1: reduced motion strips `width` from the pill's transition-property
// (index.css), so waitForTransitionEnd could only ever settle via its 480ms
// fallback there — the window sat at the old size doing nothing for the
// whole wait. Finding 2: the hook called `waitForShrink()` with no
// arguments, so App.jsx's callback had no way to tell "the pill's own
// narrow" apart from "a menu/toast/hands-free-tip shrink the pill's width
// isn't part of" — every shrink paid the full wait. Finding 4: `.then()` had
// no `.catch`, so a rejecting `waitForShrink` would strand the window at the
// wrong size (and, today, throw an unhandled rejection) instead of still
// catching up.

test("reduced motion resolves the pill's own narrow at once, instead of waiting out the fallback", async (t) => {
  const { resolvePillShrinkWait } = await loadVoicePillPresentation();
  const fakeEl = fakeElement(); // deliberately never fired
  const { render, requests } = await mountOwner(t, {
    windowProps: { matchMedia: () => ({ matches: true }) },
    waitForShrink: (target, prev) =>
      resolvePillShrinkWait({
        target,
        prev,
        prefersReducedMotion: Boolean(
          globalThis.window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ),
        el: fakeEl,
      }),
  });
  await render({ isCompactPill: true });
  assert.deepEqual(requests, ["BASE", "RECORDING"]);

  // Reduced motion resolves with an already-settled promise, so the shrink
  // must have landed by the time this same render's effects have flushed —
  // there is no "still pending" moment to check first. The old bug could
  // only ever resolve via the 480ms fallback, since reduced motion means no
  // width transitionend can fire for the real waitForTransitionEnd to catch;
  // this assertion, checked with no wait at all, fails against that bug.
  await render({ isCompactPill: false });
  assert.deepEqual(
    requests,
    ["BASE", "RECORDING", "BASE"],
    "reduced motion must resolve at once, not wait out the 480ms fallback"
  );
});

test("waitForShrink receives the resolved target and the size key it is replacing; an immediately-resolving wait is not held back", async (t) => {
  const calls = [];
  const { render, requests } = await mountOwner(t, {
    waitForShrink: (target, prev) => {
      calls.push([target, prev]);
      return Promise.resolve();
    },
  });
  await render({ isCommandMenuOpen: true });
  assert.deepEqual(requests, ["BASE", "WITH_MENU"]);

  await render({ isCommandMenuOpen: false });
  assert.deepEqual(
    calls,
    [["BASE", "WITH_MENU"]],
    "the hook must pass the resolved target and the size key it is replacing"
  );
  assert.deepEqual(
    requests,
    ["BASE", "WITH_MENU", "BASE"],
    "an immediately-resolving wait must not be held back"
  );
});

test("a rejected wait still lets the window catch up instead of sticking at the old size", async (t) => {
  const { render, requests } = await mountOwner(t, {
    waitForShrink: () => Promise.reject(new Error("simulated failure")),
  });
  await render({ isCompactPill: true });
  await render({ isCompactPill: false });
  assert.deepEqual(
    requests,
    ["BASE", "RECORDING", "BASE"],
    "a rejected wait must not strand the window at the recording size"
  );
});

// Finding 3: the old ternary's "no waitForShrink supplied" branch silently
// guessed 340ms — untested (the hook's only real caller always supplies it)
// and, per this same review round, wrong for the pill's own narrow (480ms is
// the correct wait there). An unverifiable fallback is worse than none, so
// waitForShrink is now required: omitting it must fail fast and loudly on a
// shrink, not silently reintroduce a guess.
test("waitForShrink is required — a shrink with none supplied fails fast instead of silently guessing a duration", async (t) => {
  const { render } = await mountOwner(t, { waitForShrink: undefined });
  await render({ isCompactPill: true }); // a grow needs no wait; must still succeed
  await assert.rejects(
    () => render({ isCompactPill: false }), // a shrink does need one
    /waitForShrink is not a function/
  );
});

// Fix round 2 (review of task-3-report.md's fix round 1, 2026-09-07): round
// 1's resolvePillShrinkWait correctly resolves a HANDS_FREE_TIP -> BASE
// shrink at once — the pill's own width is not part of it — but that shrink
// is only ever safe if handsFreeTipVisible itself has already stopped lying
// about whether the Hold migration card is still on screen. App.jsx now
// computes it via resolveHandsFreeTipLadderVisible, which stays true through
// the card's whole mounted lifetime (visible OR exiting), not just its
// `visible` sub-state. This drives handsFreeTipVisible with the REAL helper
// so the mutation below (in the source file, not a copy in this test) is
// what the bite-check reverts — see the report for what App.jsx's own call
// site is and is not covered by this.
test("a hands-free-tip shrink triggered by the migration card's dismissal does not land before its exit fade finishes", async (t) => {
  const { resolveHandsFreeTipLadderVisible } = await loadVoicePillPresentation();
  const { render, requests } = await mountOwner(t, {
    // resolvePillShrinkWait's real answer for HANDS_FREE_TIP -> BASE: nothing
    // to wait on at the pill level. This shrink's only protection is
    // handsFreeTipVisible staying true long enough — exactly what this test
    // pins, so the fallback duration is irrelevant here and left at 0.
    waitForShrink: () => Promise.resolve(),
  });

  // The migration card is up: mounted and visible.
  await render({
    handsFreeTipVisible: resolveHandsFreeTipLadderVisible({
      tip: null,
      holdMigrationCardVisible: true,
      holdMigrationCardExiting: false,
    }),
  });
  assert.deepEqual(requests, ["BASE", "HANDS_FREE_TIP"]);

  // The user clicks X: holdMigrationCard.visible (visible && !exiting) drops
  // immediately, but the card stays MOUNTED for its 200ms fade.
  await render({
    handsFreeTipVisible: resolveHandsFreeTipLadderVisible({
      tip: null,
      holdMigrationCardVisible: false,
      holdMigrationCardExiting: true,
    }),
  });
  assert.deepEqual(
    requests,
    ["BASE", "HANDS_FREE_TIP"],
    "must not shrink while the card is still mounted and fading"
  );

  // The card's EXIT_MS timer fires and it actually unmounts.
  await render({
    handsFreeTipVisible: resolveHandsFreeTipLadderVisible({
      tip: null,
      holdMigrationCardVisible: false,
      holdMigrationCardExiting: false,
    }),
  });
  assert.deepEqual(
    requests,
    ["BASE", "HANDS_FREE_TIP", "BASE"],
    "shrinks only once the card has actually unmounted"
  );
});
