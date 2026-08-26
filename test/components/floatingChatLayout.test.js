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
    dispatch(name) {
      listeners.get(name)?.();
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
