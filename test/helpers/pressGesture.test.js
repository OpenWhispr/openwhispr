const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PressGestureTracker,
  DOUBLE_PRESS_MIN_GAP_MS,
  DOUBLE_PRESS_MAX_GAP_MS,
} = require("../../src/helpers/pressGesture");

const T0 = 100000;
const IN_WINDOW = DOUBLE_PRESS_MIN_GAP_MS + 100; // 250ms with the shipped constants

test("a quick second toggle press after a start press is suppressed (hands-free latch)", () => {
  const tracker = new PressGestureTracker();

  assert.equal(tracker.handleTogglePress("dictation", T0, true, false), false);
  assert.equal(tracker.handleTogglePress("dictation", T0 + IN_WINDOW, false, true), true);
});

test("the toggle press after a latch flows through so it stops the recording", () => {
  const tracker = new PressGestureTracker();

  tracker.handleTogglePress("dictation", T0, true, false);
  tracker.handleTogglePress("dictation", T0 + IN_WINDOW, false, true);
  assert.equal(tracker.handleTogglePress("dictation", T0 + IN_WINDOW * 2, false, true), false);
});

test("a second press is not suppressed when the renderer declined the start", () => {
  // The first press was a start-edge, but nothing is preparing or recording
  // (mic in use, permission denied): the retry press must go through.
  const tracker = new PressGestureTracker();

  tracker.handleTogglePress("dictation", T0, true, false);
  assert.equal(tracker.handleTogglePress("dictation", T0 + IN_WINDOW, true, false), false);
});

test("a second toggle press after a stop press is never suppressed", () => {
  const tracker = new PressGestureTracker();

  tracker.handleTogglePress("dictation", T0, false, true);
  assert.equal(tracker.handleTogglePress("dictation", T0 + IN_WINDOW, true, false), false);
});

test("toggle presses beyond the double-press window flow through", () => {
  const tracker = new PressGestureTracker();

  tracker.handleTogglePress("dictation", T0, true, false);
  assert.equal(
    tracker.handleTogglePress("dictation", T0 + DOUBLE_PRESS_MAX_GAP_MS + 1, false, true),
    false
  );
});

test("toggle presses closer than the duplicate-delivery floor flow through", () => {
  const tracker = new PressGestureTracker();

  tracker.handleTogglePress("dictation", T0, true, false);
  assert.equal(
    tracker.handleTogglePress("dictation", T0 + DOUBLE_PRESS_MIN_GAP_MS - 1, false, true),
    false
  );
});

test("toggle presses of different input kinds never latch each other", () => {
  const tracker = new PressGestureTracker();

  tracker.handleTogglePress("dictation", T0, true, false);
  assert.equal(tracker.handleTogglePress("assistant", T0 + IN_WINDOW, false, true), false);
});

test("a push down with no primed quick release proceeds normally", () => {
  const tracker = new PressGestureTracker();

  assert.equal(tracker.handlePushDown("dictation", T0), "proceed");
  assert.equal(tracker.isHandsFreeActive("dictation"), false);
});

test("a primed quick release followed by a down inside the window latches hands-free", () => {
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("dictation", T0);
  tracker.handlePushQuickRelease("dictation", T0 + 80);
  assert.equal(tracker.handlePushDown("dictation", T0 + IN_WINDOW), "latch");
  assert.equal(tracker.isHandsFreeActive("dictation"), true);
});

test("a down after the double-press window expires proceeds as a fresh push", () => {
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("dictation", T0);
  tracker.handlePushQuickRelease("dictation", T0 + 80);
  assert.equal(tracker.handlePushDown("dictation", T0 + DOUBLE_PRESS_MAX_GAP_MS + 1), "proceed");
  assert.equal(tracker.isHandsFreeActive("dictation"), false);
});

test("a duplicate down delivery inside the dedupe floor is ignored entirely", () => {
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("dictation", T0);
  tracker.handlePushQuickRelease("dictation", T0 + 40);
  assert.equal(tracker.handlePushDown("dictation", T0 + DOUBLE_PRESS_MIN_GAP_MS - 1), "ignore");
});

test("the next push down while hands-free is active stops it", () => {
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("dictation", T0);
  tracker.handlePushQuickRelease("dictation", T0 + 80);
  tracker.handlePushDown("dictation", T0 + IN_WINDOW);

  assert.equal(tracker.handlePushDown("dictation", T0 + 5000), "stop-hands-free");
  assert.equal(tracker.isHandsFreeActive("dictation"), false);
});

test("hands-free state is tracked per input kind", () => {
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("assistant", T0);
  tracker.handlePushQuickRelease("assistant", T0 + 80);
  tracker.handlePushDown("assistant", T0 + IN_WINDOW);

  assert.equal(tracker.isHandsFreeActive("assistant"), true);
  assert.equal(tracker.isHandsFreeActive("dictation"), false);
  assert.equal(tracker.handlePushDown("dictation", T0 + IN_WINDOW + 10), "proceed");
});

test("a duplicate delivery of the latching press does not stop the fresh hands-free recording", () => {
  // DE-native Linux delivers one physical press twice (DE backend phase plus
  // the low-level listener); the second copy must not undo the latch.
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("dictation", T0);
  tracker.handlePushQuickRelease("dictation", T0 + 80);
  assert.equal(tracker.handlePushDown("dictation", T0 + IN_WINDOW), "latch");
  assert.equal(tracker.handlePushDown("dictation", T0 + IN_WINDOW + 5), "ignore");
  assert.equal(tracker.isHandsFreeActive("dictation"), true);
});

test("a duplicate delivery of the stop press does not start a new session", () => {
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("dictation", T0);
  tracker.handlePushQuickRelease("dictation", T0 + 80);
  tracker.handlePushDown("dictation", T0 + IN_WINDOW);

  assert.equal(tracker.handlePushDown("dictation", T0 + 5000), "stop-hands-free");
  assert.equal(tracker.handlePushDown("dictation", T0 + 5005), "ignore");
});

test("clearHandsFree drops one kind's latch and leaves the others", () => {
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("assistant", T0);
  tracker.handlePushQuickRelease("assistant", T0 + 80);
  tracker.handlePushDown("assistant", T0 + IN_WINDOW);

  tracker.clearHandsFree("dictation");
  assert.equal(tracker.isHandsFreeActive("assistant"), true);
  tracker.clearHandsFree("assistant");
  assert.equal(tracker.isHandsFreeActive("assistant"), false);
});

test("a quick release reports how long the preparation must stay warm", () => {
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("dictation", T0);
  const { cancelDelayMs } = tracker.handlePushQuickRelease("dictation", T0 + 100);
  assert.equal(cancelDelayMs, DOUBLE_PRESS_MAX_GAP_MS - 100);
});

test("the preparation-cancel delay never exceeds the double-press window", () => {
  // A backward clock step must not park the cancel timer far in the future.
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("dictation", T0);
  const { cancelDelayMs } = tracker.handlePushQuickRelease("dictation", T0 - 5000);
  assert.equal(cancelDelayMs, DOUBLE_PRESS_MAX_GAP_MS);
});

test("a deferred cancel only fires for its own prime", () => {
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("dictation", T0);
  const { primeToken } = tracker.handlePushQuickRelease("dictation", T0 + 80);

  // A latch consumed the prime before the timer fired: the stale timer must not cancel.
  tracker.handlePushDown("dictation", T0 + IN_WINDOW);
  assert.equal(tracker.shouldCancelPreparation("dictation", primeToken), false);
});

test("an unconsumed prime cancels exactly once when its timer fires", () => {
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("dictation", T0);
  const { primeToken } = tracker.handlePushQuickRelease("dictation", T0 + 80);

  assert.equal(tracker.shouldCancelPreparation("dictation", primeToken), true);
  assert.equal(tracker.shouldCancelPreparation("dictation", primeToken), false);
});

test("an interrupt while primed asks for the preparation to be cancelled", () => {
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("dictation", T0);
  tracker.handlePushQuickRelease("dictation", T0 + 80);

  assert.equal(tracker.interruptGesture("dictation", T0 + 200), "cancel-preparation");
  assert.equal(tracker.shouldCancelPreparation("dictation", 1), false);
});

test("an interrupt right after a latch cancels the accidental hands-free recording", () => {
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("dictation", T0);
  tracker.handlePushQuickRelease("dictation", T0 + 80);
  tracker.handlePushDown("dictation", T0 + IN_WINDOW);

  assert.equal(tracker.interruptGesture("dictation", T0 + IN_WINDOW + 300), "cancel-recording");
  assert.equal(tracker.isHandsFreeActive("dictation"), false);
});

test("an interrupt long after a latch leaves the hands-free session running", () => {
  const tracker = new PressGestureTracker();

  tracker.handlePushDown("dictation", T0);
  tracker.handlePushQuickRelease("dictation", T0 + 80);
  tracker.handlePushDown("dictation", T0 + IN_WINDOW);

  assert.equal(tracker.interruptGesture("dictation", T0 + IN_WINDOW + 5000), "none");
  assert.equal(tracker.isHandsFreeActive("dictation"), true);
});

test("reset clears primes, latches and hands-free state", () => {
  const tracker = new PressGestureTracker();

  tracker.handleTogglePress("dictation", T0, true, false);
  tracker.handlePushDown("assistant", T0);
  tracker.handlePushQuickRelease("assistant", T0 + 80);
  tracker.handlePushDown("assistant", T0 + IN_WINDOW);
  tracker.reset();

  assert.equal(tracker.isHandsFreeActive("assistant"), false);
  assert.equal(tracker.handleTogglePress("dictation", T0 + IN_WINDOW, false, true), false);
  assert.equal(tracker.handlePushDown("assistant", T0 + IN_WINDOW + 10), "proceed");
});
