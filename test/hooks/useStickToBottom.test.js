const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

// Models the platform rules the hook depends on: an observer only hears about the box
// it observes. Padding an auto-height element grows its border box; padding a
// fixed-size scroller shrinks its content box instead.
function installResizeObservers(t) {
  const original = globalThis.ResizeObserver;
  const observers = new Set();
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.add(this);
    }
    observe(element, options = {}) {
      this.targets.push({ element, box: options.box ?? "content-box" });
    }
    disconnect() {
      observers.delete(this);
    }
  };
  t.after(() => {
    if (original === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = original;
  });
  return {
    resizePadding(element) {
      for (const observer of [...observers]) {
        const hears = observer.targets.some(
          (target) => target.element === element && target.box === "border-box"
        );
        if (hears) observer.callback([]);
      }
    },
    padScroller(element) {
      for (const observer of [...observers]) {
        const hears = observer.targets.some(
          (target) => target.element === element && target.box === "content-box"
        );
        if (hears) observer.callback([]);
      }
    },
  };
}

async function mountScroller(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const resizeObservers = installResizeObservers(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-stick-to-bottom-test-" });
  const { useStickToBottom } = await vite.ssrLoadModule("/hooks/useStickToBottom.ts");
  function Scroller() {
    const { scrollRef, handleScroll, handleWheel, handleTouchStart, handleTouchMove } =
      useStickToBottom("messages");
    return React.createElement(
      "div",
      {
        ref: scrollRef,
        onScroll: handleScroll,
        onWheel: handleWheel,
        onTouchStart: handleTouchStart,
        onTouchMove: handleTouchMove,
      },
      React.createElement(
        "div",
        null,
        "conversation",
        // A card in the conversation whose long body scrolls on its own.
        React.createElement("div", null, React.createElement("p", null, "card body"))
      )
    );
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Scroller)));
  const scroller = container.childNodes[0];
  Object.assign(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
  const content = scroller.childNodes[0];
  const cardBody = content.childNodes.find((node) => node.nodeType === 1);
  Object.assign(cardBody, { scrollHeight: 300, clientHeight: 176, scrollTop: 0 });
  // Only a box that scrolls on its own takes a gesture: the body is one.
  cardBody.overflowY = "auto";
  scroller.ownerDocument.defaultView.getComputedStyle = (element) => ({
    overflowY: element.overflowY ?? "visible",
  });
  return { scroller, content, cardBody, resizeObservers };
}

const dispatch = (target, event) =>
  React.act(async () =>
    target.dispatchEvent({ bubbles: true, preventDefault() {}, stopPropagation() {}, ...event })
  );
const wheelUp = (target, timeStamp) => dispatch(target, { type: "wheel", deltaY: -40, timeStamp });
// A finger moving down the screen scrolls up.
const touchDown = (target, clientY, timeStamp) =>
  dispatch(target, { type: "touchmove", touches: [{ clientY }], timeStamp });

test("added bottom padding keeps a pinned conversation at its end", async (t) => {
  const { scroller, content, resizeObservers } = await mountScroller(t);

  // The focused composer grows over the list and pads the content by the same height.
  scroller.scrollHeight = 1120;
  resizeObservers.resizePadding(content);

  assert.equal(scroller.scrollTop, 720, "the last lines stay above the composer");
});

test("an overlay padding the scroller itself leaves a pinned transcript where it is", async (t) => {
  const { scroller, resizeObservers } = await mountScroller(t);

  // The note chat opens over a transcript and pads its scroller to stay reachable.
  scroller.scrollHeight = 1430;
  resizeObservers.padScroller(scroller);

  assert.equal(scroller.scrollTop, 600);
});

test("added bottom padding never pulls a reader back down", async (t) => {
  const { scroller, content, resizeObservers } = await mountScroller(t);
  scroller.scrollTop = 100;
  await React.act(async () =>
    scroller.dispatchEvent({ type: "scroll", bubbles: false, preventDefault() {} })
  );

  scroller.scrollHeight = 1120;
  resizeObservers.resizePadding(content);

  assert.equal(scroller.scrollTop, 100);
});

test("a wheel up inside a card body that can still scroll up keeps the conversation following", async (t) => {
  const { scroller, content, cardBody, resizeObservers } = await mountScroller(t);
  cardBody.scrollTop = 80;

  // The body takes the wheel; the reply that follows still streams into view.
  await wheelUp(cardBody.childNodes[0]);
  scroller.scrollHeight = 1120;
  resizeObservers.resizePadding(content);

  assert.equal(scroller.scrollTop, 720);
});

test("a wheel up over a clipped box scrolled into view still leaves the bottom", async (t) => {
  const { scroller, content, cardBody, resizeObservers } = await mountScroller(t);
  // scrollIntoView can move a clipped box's content; it doesn't scroll on its own.
  cardBody.overflowY = "hidden";
  cardBody.scrollTop = 80;

  await wheelUp(cardBody.childNodes[0]);
  scroller.scrollHeight = 1120;
  resizeObservers.resizePadding(content);

  assert.equal(scroller.scrollTop, 600, "the reader went up the conversation");
});

test("a wheel up over a card body already at its top leaves the bottom", async (t) => {
  const { scroller, content, cardBody, resizeObservers } = await mountScroller(t);

  await wheelUp(cardBody.childNodes[0]);
  scroller.scrollHeight = 1120;
  resizeObservers.resizePadding(content);

  assert.equal(scroller.scrollTop, 600, "the reader went up the conversation");
});

test("a wheel gesture that goes on after a card body reaches its top stays the body's", async (t) => {
  const { scroller, content, cardBody, resizeObservers } = await mountScroller(t);
  const inBody = cardBody.childNodes[0];
  cardBody.scrollTop = 40;
  await wheelUp(inBody, 1000);
  // The body reached its top; the rest of the gesture (momentum too) stays with it.
  cardBody.scrollTop = 0;
  await wheelUp(inBody, 1016);
  await wheelUp(inBody, 1180);
  scroller.scrollHeight = 1120;
  resizeObservers.resizePadding(content);
  assert.equal(scroller.scrollTop, 720, "still following");

  // A new gesture after a pause moves the conversation itself.
  await wheelUp(inBody, 1500);
  scroller.scrollHeight = 1240;
  resizeObservers.resizePadding(content);
  assert.equal(scroller.scrollTop, 720, "the reader went up the conversation");
});

test("a touch drag that goes on after a card body reaches its top stays the body's", async (t) => {
  const { scroller, content, cardBody, resizeObservers } = await mountScroller(t);
  const inBody = cardBody.childNodes[0];
  cardBody.scrollTop = 40;
  await dispatch(inBody, { type: "touchstart", touches: [{ clientY: 100 }] });
  await touchDown(inBody, 120, 1000);
  cardBody.scrollTop = 0;
  await touchDown(inBody, 140, 1016);
  scroller.scrollHeight = 1120;
  resizeObservers.resizePadding(content);

  assert.equal(scroller.scrollTop, 720);
});
