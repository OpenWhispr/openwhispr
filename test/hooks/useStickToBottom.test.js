const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

// Models the platform rule the hook depends on: an observer only hears about the
// box it observes, so a padding change reaches border-box observers alone.
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
    const { scrollRef, handleScroll } = useStickToBottom("messages");
    return React.createElement(
      "div",
      { ref: scrollRef, onScroll: handleScroll },
      React.createElement("div", null, "conversation")
    );
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Scroller)));
  const scroller = container.childNodes[0];
  Object.assign(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
  return { scroller, content: scroller.childNodes[0], resizeObservers };
}

test("added bottom padding keeps a pinned conversation at its end", async (t) => {
  const { scroller, content, resizeObservers } = await mountScroller(t);

  // The focused composer grows over the list and pads the content by the same height.
  scroller.scrollHeight = 1120;
  resizeObservers.resizePadding(content);

  assert.equal(scroller.scrollTop, 720, "the last lines stay above the composer");
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
