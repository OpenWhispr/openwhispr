const test = require("node:test");
const assert = require("node:assert/strict");

test("dragging a panel's edge away from it widens it, in either direction and layout", async () => {
  const { resizedWidth } = await import("../../src/hooks/useResizableWidth.ts");
  const limits = { min: 180, max: 420 };

  // The notes list's handle is on its end edge: right in left-to-right, left in right-to-left.
  assert.equal(resizedWidth(208, 40, { edge: "end", rtl: false, ...limits }), 248);
  assert.equal(resizedWidth(208, -40, { edge: "end", rtl: true, ...limits }), 248);
  // The docked chat's is on its start edge, so dragging toward the note widens it.
  assert.equal(resizedWidth(400, -60, { edge: "start", rtl: false, ...limits, max: 1200 }), 460);
  assert.equal(resizedWidth(400, 60, { edge: "start", rtl: true, ...limits, max: 1200 }), 460);

  assert.equal(resizedWidth(208, -500, { edge: "end", rtl: false, ...limits }), 180, "no narrower");
  assert.equal(resizedWidth(208, 500, { edge: "end", rtl: false, ...limits }), 420, "no wider");
});

test("a drag saves the width, and a click or a drag the browser took away does not strand it", async (t) => {
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const { installBrowserGlobals } = require("../lib/rendererTestHarness");
  const { installInteractiveDom } = require("../lib/interactiveDom");
  const { useResizableWidth } = await import("../../src/hooks/useResizableWidth.ts");

  installBrowserGlobals(t);
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ direction: "ltr" });
  const container = installInteractiveDom(t);
  let root;
  t.after(() => {
    globalThis.getComputedStyle = originalGetComputedStyle;
  });

  let resize;
  function Harness() {
    resize = useResizableWidth({
      storageKey: "panelWidth",
      edge: "start",
      min: 100,
      max: 600,
      getDragMax: () => 300,
    });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));

  // The panel's rendered width follows what the hook last asked for, as the DOM does.
  const panel = {
    getBoundingClientRect: () => ({ width: resize.width ?? 200 }),
  };
  resize.panelRef.current = panel;

  const startDrag = async (clientX) => {
    const handle = new EventTarget();
    handle.setPointerCapture = () => {};
    await React.act(async () =>
      resize.startResize({
        button: 0,
        pointerId: 1,
        clientX,
        preventDefault() {},
        currentTarget: handle,
      })
    );
    const move = (x, y = 0) =>
      React.act(async () => {
        const event = new Event("pointermove");
        event.clientX = x;
        event.clientY = y;
        handle.dispatchEvent(event);
      });
    const release = (type) => React.act(async () => handle.dispatchEvent(new Event(type)));
    return { move, release };
  };

  const click = await startDrag(500);
  await click.move(500, 40);
  await click.move(501);
  await click.release("pointerup");
  assert.equal(resize.width, null, "a click keeps the panel's default width");
  assert.equal(localStorage.getItem("panelWidth"), null, "and saves nothing");
  assert.equal(resize.isResizing, false);

  const drag = await startDrag(500);
  await drag.move(300); // The start edge: leftward widens, 200 -> 400, held to the 300 cap.
  await drag.release("pointerup");
  await drag.release("lostpointercapture");
  assert.equal(resize.width, 300, "the drag stops at the panel's cap");
  assert.equal(localStorage.getItem("panelWidth"), "300");

  const taken = await startDrag(500);
  await taken.move(520);
  assert.equal(resize.isResizing, true);
  await taken.release("lostpointercapture");
  assert.equal(resize.isResizing, false, "capture lost without pointerup still ends the drag");
  await React.act(async () => root.unmount());
});
