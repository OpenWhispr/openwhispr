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

async function mountOwner(t, { waitForShrink }) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { electronAPI: {} } });
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
