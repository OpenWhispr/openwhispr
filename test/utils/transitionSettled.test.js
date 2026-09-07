const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/transitionSettled.ts");

function fakeElement() {
  const listeners = new Set();
  return {
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    fire(target, propertyName) {
      for (const fn of [...listeners]) fn({ target, propertyName });
    },
    get listenerCount() {
      return listeners.size;
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
