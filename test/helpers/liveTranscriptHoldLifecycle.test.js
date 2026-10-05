const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const FINAL_HIDE_MS = 4000;

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
  const previewListeners = new Map();
  installBrowserGlobals(t, {
    window: {
      electronAPI: Object.fromEntries(
        ["onPreviewText", "onPreviewAppend", "onPreviewResult", "onPreviewHide"].map((method) => [
          method,
          (listener) => {
            previewListeners.set(method, listener);
            return () => previewListeners.delete(method);
          },
        ])
      ),
    },
  });
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
    emitPreview: async (method, payload) => {
      assert.ok(previewListeners.has(method), `Missing preview listener: ${method}`);
      await React.act(async () => previewListeners.get(method)(payload));
    },
    rerender: async (nextProps) => {
      props = { ...props, ...nextProps };
      await React.act(async () => root.render(React.createElement(Harness)));
    },
  };
}

function capturePresentationClock(t) {
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const timers = new Map();
  let time = 0;
  let nextId = 1;
  globalThis.setTimeout = (callback, delay = 0) => {
    const id = nextId++;
    timers.set(id, { at: time + delay, callback });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(time), 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  t.after(() => Object.assign(globalThis, original));

  return async (duration) => {
    const end = time + duration;
    for (let steps = 0; steps < 1000; steps += 1) {
      const next = [...timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) {
        time = end;
        return;
      }
      const [id, timer] = next;
      time = timer.at;
      timers.delete(id);
      await React.act(async () => {
        // Async measurement callbacks can schedule another animation frame;
        // advance that frame below instead of waiting for it inside this step.
        timer.callback();
      });
    }
    assert.fail("Presentation clock did not settle");
  };
}

test("rapid consecutive recordings update an already-visible final transcript panel", async (t) => {
  let entrances = 0;
  const { getPanel, emitPreview, rerender } = await mountLiveTranscript(t, {
    isRecording: true,
    onWillOpen: () => entrances++,
  });
  const advance = capturePresentationClock(t);

  await emitPreview("onPreviewAppend", "first recording");
  await advance(2200);
  assert.equal(getPanel().text, "first recording");
  assert.equal(getPanel().entrancePhase, "content");

  for (const nextText of ["second recording", "third recording"]) {
    await rerender({ isRecording: false });
    await emitPreview("onPreviewResult", { text: "previous final result" });
    await advance(200);
    assert.equal(getPanel().text, "previous final result");

    await rerender({ isRecording: true });
    assert.equal(getPanel().text, "", "a new recording clears the previous transcript");
    await emitPreview("onPreviewText", "");
    await emitPreview("onPreviewAppend", nextText);
    await advance(400);

    assert.equal(getPanel().open, true);
    assert.equal(getPanel().text, nextText);
    assert.equal(entrances, 1, "an open panel does not replay its entrance");
  }
});

test("a new recording during panel entrance keeps text buffered until the surface is ready", async (t) => {
  const { getPanel, emitPreview, rerender } = await mountLiveTranscript(t, { isRecording: true });
  const advance = capturePresentationClock(t);

  await emitPreview("onPreviewAppend", "old recording");
  await advance(100);
  await rerender({ isRecording: false });
  await rerender({ isRecording: true });
  await emitPreview("onPreviewAppend", "fresh recording");
  await advance(400);
  assert.equal(getPanel().text, "", "text must not bypass the panel entrance");

  await advance(1800);
  assert.equal(getPanel().text, "fresh recording");
});

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
