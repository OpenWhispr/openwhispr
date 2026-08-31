const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/notes/floatingChatLayout.ts");

function createElement(overrides = {}) {
  const listeners = new Map();
  const styleValues = new Map();

  return {
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    offsetHeight: 0,
    style: {
      setProperty(name, value) {
        styleValues.set(name, value);
      },
      removeProperty(name) {
        styleValues.delete(name);
      },
      getPropertyValue(name) {
        return styleValues.get(name) ?? "";
      },
    },
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
    dispatch(name, event) {
      listeners.get(name)?.(event);
    },
    hasListener(name) {
      return listeners.has(name);
    },
    ...overrides,
  };
}

test("near-bottom detection uses the real scroll range", async () => {
  const { isNearScrollBottom } = await load();

  assert.equal(
    isNearScrollBottom({ scrollHeight: 1232, scrollTop: 700, clientHeight: 300 }),
    false,
    "232px of remaining padded scroll range is not near the bottom"
  );
  assert.equal(
    isNearScrollBottom({ scrollHeight: 1232, scrollTop: 852, clientHeight: 300 }),
    true,
    "80px from the scroll bottom remains pinned"
  );
});

test("viewport resizes preserve pinned content without yanking a reader", async () => {
  const { observeFloatingChatLayout } = await load();
  const panel = createElement({ offsetHeight: 200 });
  const container = createElement();
  const contentRoot = createElement();
  const scroller = createElement({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 });
  const observedElements = [];
  const scheduledFrames = new Map();
  let resizeCallback;
  let nextFrameId = 0;
  let observerDisconnected = false;

  const cleanup = observeFloatingChatLayout(
    {
      panel,
      container,
      contentRoot,
      getActiveScroller: () => scroller,
    },
    {
      createResizeObserver(callback) {
        resizeCallback = callback;
        return {
          observe(element) {
            observedElements.push(element);
          },
          disconnect() {
            observerDisconnected = true;
          },
        };
      },
      requestFrame(callback) {
        const frameId = ++nextFrameId;
        scheduledFrames.set(frameId, () => {
          scheduledFrames.delete(frameId);
          callback();
        });
        return frameId;
      },
      cancelFrame(frameId) {
        scheduledFrames.delete(frameId);
      },
    }
  );

  assert.deepEqual(observedElements, [panel, contentRoot]);
  assert.equal(container.style.getPropertyValue("--floating-inset"), "232px");

  scheduledFrames.get(nextFrameId)();
  scroller.clientHeight = 150;
  resizeCallback();
  scheduledFrames.get(nextFrameId)();
  assert.equal(scroller.scrollTop, 850, "a pinned scroller follows a viewport shrink");

  scroller.scrollTop = 600;
  contentRoot.dispatch("scroll");
  panel.offsetHeight = 240;
  resizeCallback();
  assert.equal(scheduledFrames.size, 0, "a reader away from the bottom is not scheduled to move");
  assert.equal(scroller.scrollTop, 600);

  scroller.scrollTop = 850;
  contentRoot.dispatch("scroll");
  resizeCallback();
  assert.equal(scheduledFrames.size, 1);

  cleanup();
  assert.equal(observerDisconnected, true);
  assert.equal(contentRoot.hasListener("scroll"), false);
  assert.equal(scheduledFrames.size, 0);
  assert.equal(container.style.getPropertyValue("--floating-inset"), "");
});

test("the panel cap leaves the promised note content visible", async () => {
  const {
    FLOATING_CHAT_INSET_EXTRA_PX,
    FLOATING_CHAT_MAX_HEIGHT_CSS,
    FLOATING_CHAT_MIN_VISIBLE_CONTENT_PX,
  } = await load();

  assert.equal(FLOATING_CHAT_INSET_EXTRA_PX, 32);
  assert.equal(FLOATING_CHAT_MIN_VISIBLE_CONTENT_PX, 80);
  assert.equal(FLOATING_CHAT_MAX_HEIGHT_CSS, "calc(100% - 7rem)");
});

function createLayoutHarness(observeFloatingChatLayout, { scroller }) {
  const panel = createElement({ offsetHeight: 200 });
  const container = createElement();
  const contentRoot = createElement();
  const scheduledFrames = new Map();
  const harness = { panel, container, contentRoot, scheduledFrames, nextFrameId: 0 };

  harness.cleanup = observeFloatingChatLayout(
    {
      panel,
      container,
      contentRoot,
      getActiveScroller: () => scroller,
    },
    {
      createResizeObserver(callback) {
        harness.resizeCallback = callback;
        return { observe() {}, disconnect() {} };
      },
      requestFrame(callback) {
        const frameId = ++harness.nextFrameId;
        scheduledFrames.set(frameId, () => {
          scheduledFrames.delete(frameId);
          callback();
        });
        return frameId;
      },
      cancelFrame(frameId) {
        scheduledFrames.delete(frameId);
      },
    }
  );

  return harness;
}

test("upward wheel intent cancels resize pinning until the reader returns to bottom", async () => {
  const { observeFloatingChatLayout } = await load();
  const transcriptRow = { name: "transcript-row" };
  const scroller = createElement({
    scrollHeight: 1000,
    scrollTop: 700,
    clientHeight: 300,
    contains: (target) => target === transcriptRow,
  });
  const { contentRoot, scheduledFrames, resizeCallback, nextFrameId, cleanup } =
    createLayoutHarness(observeFloatingChatLayout, { scroller });

  scheduledFrames.get(nextFrameId)();
  resizeCallback();
  assert.equal(scheduledFrames.size, 1, "a followed resize schedules a bottom correction");

  contentRoot.dispatch("wheel", { deltaY: -8, target: transcriptRow });
  assert.equal(scheduledFrames.size, 0, "upward intent cancels the pending correction");

  scroller.scrollTop = 680;
  contentRoot.dispatch("scroll");
  resizeCallback();
  assert.equal(scheduledFrames.size, 0, "resizes do not re-pin a reader away from bottom");

  scroller.scrollTop = 700;
  contentRoot.dispatch("scroll");
  resizeCallback();
  assert.equal(scheduledFrames.size, 1, "reaching the true bottom restores follow mode");

  cleanup();
});

test("upward wheel over chrome outside the scroller keeps following", async () => {
  const { observeFloatingChatLayout } = await load();
  const recordingHeader = { name: "recording-header" };
  const scroller = createElement({
    scrollHeight: 1000,
    scrollTop: 700,
    clientHeight: 300,
    contains: () => false,
  });
  const harness = createLayoutHarness(observeFloatingChatLayout, { scroller });
  const { contentRoot, scheduledFrames } = harness;

  scheduledFrames.get(harness.nextFrameId)();
  harness.resizeCallback();
  assert.equal(scheduledFrames.size, 1, "a followed resize schedules a bottom correction");

  // The wheel moves nothing (its target never scrolls the active scroller), so
  // no scroll event could ever rejoin — detaching here would wedge follow off.
  contentRoot.dispatch("wheel", { deltaY: -8, target: recordingHeader });
  assert.equal(scheduledFrames.size, 1, "a wheel aimed at chrome is not reader intent");

  scheduledFrames.get(harness.nextFrameId)();
  assert.equal(scroller.scrollTop, 700, "the pending correction still pins the bottom");

  harness.resizeCallback();
  assert.equal(scheduledFrames.size, 1, "later resizes keep following");

  harness.cleanup();
});
