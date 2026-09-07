const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/transitionSettled.ts");

// `detachOnRemove: false` builds a deliberately leaky EventTarget — cleanup
// is CALLED but does not actually detach the listener. That isolates the
// settle-once (`done`) guard from removeEventListener's own protection: with
// a normal (detaching) fake, removeEventListener already makes a second
// dispatch impossible, so nothing can tell whether `done` does any work.
// Only the leaky variant can force a genuine second call into `finish()`.
function fakeElement({ detachOnRemove = true } = {}) {
  const listeners = new Set();
  let removeEventListenerCalls = 0;
  return {
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => {
      removeEventListenerCalls++;
      if (detachOnRemove) listeners.delete(fn);
    },
    fire(target, propertyName, type = "transitionend") {
      for (const fn of [...listeners]) fn({ target, propertyName, type });
    },
    get listenerCount() {
      return listeners.size;
    },
    get removeEventListenerCalls() {
      return removeEventListenerCalls;
    },
  };
}

test("resolves on the element's own transitionend for the property and unsubscribes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { waitForTransitionEnd } = await load();
  const el = fakeElement();
  const settled = waitForTransitionEnd(el, "clip-path", 500);
  el.fire({ other: true }, "clip-path"); // a child's event: ignored
  el.fire(el, "opacity"); // another property: ignored
  el.fire(el, "clip-path");
  assert.equal(await settled, "transitionend");
  assert.equal(el.listenerCount, 0);
});

test("falls back to the timeout when no event arrives, and on a missing element", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { waitForTransitionEnd } = await load();
  const el = fakeElement();
  const settled = waitForTransitionEnd(el, "transform", 300);
  t.mock.timers.tick(300);
  assert.equal(await settled, "timeout");
  assert.equal(el.listenerCount, 0);

  const missing = waitForTransitionEnd(null, "transform", 10);
  t.mock.timers.tick(10);
  assert.equal(await missing, "timeout");
});

// The two tests above (from the task brief) prove the happy path and the
// fallback. Neither actually forces a wrong-property event through on its
// own — the brief's first test also fires the right property right after, so
// a buggy implementation that resolved on ANY event would still pass it. The
// tests below isolate that filter, and prove settling is a one-way door from
// both directions (event-then-late-timer and timeout-then-late-event).

test("a transitionend for a different property never resolves the promise — only the timeout does", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { waitForTransitionEnd } = await load();
  const el = fakeElement();
  const settled = waitForTransitionEnd(el, "clip-path", 50);
  el.fire(el, "opacity"); // right target, wrong property: must be ignored
  el.fire({ nested: true }, "clip-path"); // right property, wrong target: must be ignored
  t.mock.timers.tick(50);
  assert.equal(await settled, "timeout");
  assert.equal(el.listenerCount, 0);
});

test("cannot resolve twice: a repeat transitionend after settling is inert", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { waitForTransitionEnd } = await load();
  const el = fakeElement();
  const settled = waitForTransitionEnd(el, "clip-path", 500);
  el.fire(el, "clip-path"); // settles here, as "transitionend"
  assert.equal(await settled, "transitionend");
  assert.equal(el.listenerCount, 0);
  // The listener was removed on settle, so a later firing reaches nobody —
  // and the (already-elapsed) fallback timer must be inert too.
  assert.doesNotThrow(() => el.fire(el, "clip-path"));
  assert.doesNotThrow(() => t.mock.timers.tick(500));
  assert.equal(el.listenerCount, 0);
});

test("cannot resolve twice the other way: a late transitionend after the fallback timeout is inert", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { waitForTransitionEnd } = await load();
  const el = fakeElement();
  const settled = waitForTransitionEnd(el, "clip-path", 20);
  t.mock.timers.tick(20); // settles via timeout; listener must be removed
  assert.equal(await settled, "timeout");
  assert.equal(el.listenerCount, 0);
  assert.doesNotThrow(() => el.fire(el, "clip-path"));
});

// Fix round 1, finding 3: a transition that gets INTERRUPTED (re-opening
// mid-close, a recording starting during the hide animation — both reachable
// from later tasks) fires `transitioncancel`, not `transitionend`. Without
// handling it, the chain stalls for the entire fallback window before
// continuing. This widens the resolution set to three reasons.

test("resolves 'transitioncancel' when the transition is interrupted instead of finishing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { waitForTransitionEnd } = await load();
  const el = fakeElement();
  const settled = waitForTransitionEnd(el, "clip-path", 500);
  el.fire(el, "clip-path", "transitioncancel");
  assert.equal(await settled, "transitioncancel");
  assert.equal(el.listenerCount, 0);
});

test("a transitioncancel for a different property or target is ignored, same as transitionend", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { waitForTransitionEnd } = await load();
  const el = fakeElement();
  const settled = waitForTransitionEnd(el, "clip-path", 50);
  el.fire(el, "opacity", "transitioncancel"); // wrong property: ignored
  el.fire({ nested: true }, "clip-path", "transitioncancel"); // wrong target: ignored
  t.mock.timers.tick(50);
  assert.equal(await settled, "timeout");
});

// Fix round 1, finding 4: "+120" was only a convention in the plan's prose,
// so each of the ten later tasks would open-code it independently — one
// knob here instead of four (or ten) drift-prone call sites.

test("settleFallbackMs adds the standard grace window to a pinned duration", async () => {
  const { settleFallbackMs } = await load();
  assert.equal(settleFallbackMs(440), 560); // morph
  assert.equal(settleFallbackMs(200), 320); // zoop
  assert.equal(settleFallbackMs(0), 120);
});

// Fix round 1, finding 6: `clearTimeout(timer)` and the settle-once guard
// (`if (done) return; done = true;`) were both unproven — deleting either
// line still passed every existing test, because a normal (detaching) fake
// already makes a second dispatch impossible, and Promise.resolve() is
// natively idempotent regardless of `done`. These use a spy on the global
// timer API and the leaky fake above to observe the guard's OWN work,
// independent of those two accidents of the test double.

test("settling via transitionend actually calls clearTimeout on the fallback timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { waitForTransitionEnd } = await load();
  const el = fakeElement();
  const originalClearTimeout = global.clearTimeout;
  let clearTimeoutCalls = 0;
  global.clearTimeout = (...args) => {
    clearTimeoutCalls++;
    return originalClearTimeout(...args);
  };
  try {
    const settled = waitForTransitionEnd(el, "clip-path", 500);
    el.fire(el, "clip-path");
    assert.equal(await settled, "transitionend");
    assert.ok(clearTimeoutCalls >= 1, "clearTimeout must run when settling via the event");
  } finally {
    global.clearTimeout = originalClearTimeout;
  }
});

test("the settle-once guard — not just removeEventListener — stops a second finish() from re-running", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { waitForTransitionEnd } = await load();
  // Leaky on purpose: removeEventListener is called but does not detach, so
  // firing twice genuinely reaches the handler twice. Only `done` can stop
  // the second call's body from executing.
  const el = fakeElement({ detachOnRemove: false });
  const originalClearTimeout = global.clearTimeout;
  let clearTimeoutCalls = 0;
  global.clearTimeout = (...args) => {
    clearTimeoutCalls++;
    return originalClearTimeout(...args);
  };
  try {
    const settled = waitForTransitionEnd(el, "clip-path", 500);
    el.fire(el, "clip-path"); // first: genuinely settles
    el.fire(el, "clip-path"); // second: only reaches the handler because this fake doesn't detach
    assert.equal(await settled, "transitionend");
    // finish() unconditionally removes both the transitionend and
    // transitioncancel registrations, so one guarded execution calls
    // removeEventListener twice and clearTimeout once. If `done` were gone,
    // the second dispatch would double both counts.
    assert.equal(clearTimeoutCalls, 1, "a second finish() body must not re-run past the guard");
    assert.equal(el.removeEventListenerCalls, 2, "cleanup must run exactly once, not once per dispatch");
  } finally {
    global.clearTimeout = originalClearTimeout;
  }
});
