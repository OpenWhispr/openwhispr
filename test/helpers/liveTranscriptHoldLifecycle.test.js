const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const FINAL_HIDE_MS = 4000;

function installHookDom(t) {
  const originalDocument = globalThis.document;
  const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const noop = () => {};

  class Element {}
  class HTMLElement extends Element {}
  class HTMLIFrameElement extends HTMLElement {}

  const document = {
    nodeType: 9,
    activeElement: null,
    addEventListener: noop,
    removeEventListener: noop,
  };
  const container = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: noop,
    removeChild: noop,
    insertBefore: noop,
  };
  Object.assign(globalThis.window, {
    Element,
    HTMLElement,
    HTMLIFrameElement,
    document,
    getSelection: () => null,
  });
  document.defaultView = globalThis.window;
  document.documentElement = container;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = noop;

  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  return container;
}

function capturePanelTimers(t) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cancelled: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer && typeof timer === "object" && "cancelled" in timer) {
      timer.cancelled = true;
      return;
    }
    originalClearTimeout(timer);
  };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });
  return () => timers.findLast((timer) => timer.delay === FINAL_HIDE_MS && !timer.cancelled);
}

async function mountLiveTranscript(t, initialProps = {}) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-live-transcript-hold-test-",
  });
  const { useLiveTranscriptPanel } = await vite.ssrLoadModule("/hooks/useLiveTranscriptPanel.js");
  let props = {
    resizeToContent: async () => ({ success: true }),
    assistantOpenRef: { current: false },
    onWillOpen: () => {},
    isRecording: false,
    isProcessing: false,
    isAssistantVoice: false,
    ...initialProps,
  };
  let panel;
  function Harness() {
    panel = useLiveTranscriptPanel(props);
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  return {
    getPanel: () => panel,
    rerender: async (nextProps) => {
      props = { ...props, ...nextProps };
      await React.act(async () => root.render(React.createElement(Harness)));
    },
  };
}

async function showNextFinalAndRunHide(panel, getFinalHideTimer) {
  await React.act(async () => {
    panel.showFinalText("next result");
  });
  const finalHideTimer = getFinalHideTimer();
  assert.ok(finalHideTimer, "fixture setup: the next final result must schedule its hide");
  await React.act(async () => finalHideTimer.callback());
}

test("closing a held final releases the hold before the next final result", async (t) => {
  const { getPanel } = await mountLiveTranscript(t);
  const getFinalHideTimer = capturePanelTimers(t);

  getPanel().holdFinal(true);
  await React.act(async () => getPanel().close({ clear: true }));
  await showNextFinalAndRunHide(getPanel(), getFinalHideTimer);

  assert.equal(getPanel().openRef.current, false);
});

test("replacing a held final with an error releases the hold before the next result", async (t) => {
  const { getPanel } = await mountLiveTranscript(t);
  const getFinalHideTimer = capturePanelTimers(t);

  getPanel().holdFinal(true);
  await React.act(async () => getPanel().dismissForError());
  await showNextFinalAndRunHide(getPanel(), getFinalHideTimer);

  assert.equal(getPanel().openRef.current, false);
});

test("a new recording releases a hold inherited from the prior session", async (t) => {
  const { getPanel, rerender } = await mountLiveTranscript(t);
  const getFinalHideTimer = capturePanelTimers(t);

  getPanel().holdFinal(true);
  await rerender({ isRecording: true });
  await rerender({ isRecording: false });
  await showNextFinalAndRunHide(getPanel(), getFinalHideTimer);

  assert.equal(getPanel().openRef.current, false);
});

test("hovering a final transcript pauses its active hide countdown and leaving restarts it", async (t) => {
  const { getPanel } = await mountLiveTranscript(t);
  const getFinalHideTimer = capturePanelTimers(t);

  await React.act(async () => getPanel().showFinalText("finished transcript"));
  const activeHideTimer = getFinalHideTimer();
  assert.ok(activeHideTimer, "fixture setup: a final result must schedule its hide");

  getPanel().holdFinal(true);

  assert.equal(activeHideTimer.cancelled, true);
  await React.act(async () => activeHideTimer.callback());
  assert.equal(getPanel().openRef.current, true);

  getPanel().holdFinal(false);
  const resumedHideTimer = getFinalHideTimer();
  assert.ok(resumedHideTimer, "leaving the hovered final must schedule a fresh hide");
  assert.notEqual(resumedHideTimer, activeHideTimer);
  assert.equal(resumedHideTimer.delay, FINAL_HIDE_MS);

  await React.act(async () => resumedHideTimer.callback());
  assert.equal(getPanel().openRef.current, false);
});
