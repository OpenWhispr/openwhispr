const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Fix round 2, Finding B (review 2026-09-08): reopening Live Transcript
// DURING its own close animation (close() leaves `mounted` true for
// LIVE_TRANSCRIPT_CLOSE_UNMOUNT_MS = 320ms so the collapse can finish
// visually) re-enters openPanel()'s entrancePhase="encapsulate" branch —
// which is indistinguishable from a genuine fresh mount by entrancePhase
// alone, so dictation-panel.css's fresh-mount snap-gate (Task 4 fix round 1,
// Finding 1) fired for it too, snapping a mid-collapse frame straight to the
// closed corner-box instead of letting it reverse smoothly. `freshMount` is
// the fix: true only when `mounted` was actually false immediately before
// this open (a real rest -> mounted transition), false when reopening while
// already mounted (mid-collapse) — so the CSS gate (which now also requires
// [data-panel-fresh-mount="true"]) only ever fires for a genuine first mount.
//
// installHookDom() stubs requestAnimationFrame to a no-op that never invokes
// its callback (no existing hook test drives rAF-dependent code, so there
// was no established override to reuse) — installControllableRaf replaces it
// with a manually-flushable queue, installed AFTER installHookDom so it wins.

function installControllableRaf(t) {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  let nextId = 1;
  let pending = new Map();
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextId++;
    pending.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    pending.delete(id);
  };
  t.after(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  });
  return {
    async flush() {
      const due = [...pending.values()];
      pending = new Map();
      await React.act(async () => {
        for (const callback of due) callback(0);
      });
    },
  };
}

// Lets any promise chains already queued (e.g. openPanel's
// `await requestHeight(...)`, backed here by an already-resolved promise)
// actually resume and run their synchronous continuation before we inspect
// hook state. A macrotask flush drains every pending microtask first,
// regardless of how many `await`s the real implementation chains internally.
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mountLiveTranscriptHook(t, { cachePrefix }) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {});
  const container = installHookDom(t);
  const raf = installControllableRaf(t);
  const vite = await createRendererServer(t, { cachePrefix });
  const { useLiveTranscriptPanel } = await vite.ssrLoadModule("/hooks/useLiveTranscriptPanel.js");

  let result;
  function Harness() {
    result = useLiveTranscriptPanel({
      resizeToContent: () => Promise.resolve({ success: true, changed: false }),
      assistantOpenRef: { current: false },
      onWillOpen: () => {},
      isRecording: false,
      isProcessing: false,
      isAssistantVoice: false,
    });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  const reopen = async () => {
    await React.act(async () => {
      result.reopen();
      await flushMicrotasks();
    });
  };

  return { raf, reopen, read: () => result };
}

test("a genuine fresh mount (never open before) is tagged freshMount=true, at the exact frame the snap-gate needs", async (t) => {
  const { reopen, read } = await mountLiveTranscriptHook(t, {
    cachePrefix: "openwhispr-live-transcript-fresh-mount-",
  });

  assert.equal(read().mounted, false, "sanity: starts unmounted");
  await reopen();

  // The frame the CSS gate targets: mounted, entering encapsulate, not yet
  // open (setOpen(true) is one requestAnimationFrame later — not flushed
  // here on purpose, to inspect exactly this frame).
  assert.equal(read().mounted, true);
  assert.equal(read().open, false);
  assert.equal(read().entrancePhase, "encapsulate");
  assert.equal(read().freshMount, true, "a real rest -> mounted transition must be tagged fresh");
});

test("reopening WHILE still mounted (mid-collapse, before the 320ms unmount timer fires) is tagged freshMount=false", async (t) => {
  const { raf, reopen, read } = await mountLiveTranscriptHook(t, {
    cachePrefix: "openwhispr-live-transcript-reopen-mid-collapse-",
  });

  // Reach a genuinely open, mounted state first — close() only leaves
  // `mounted` true through its unmount delay if it WAS mounted.
  await reopen();
  assert.equal(read().freshMount, true, "sanity: first open is fresh");
  await raf.flush(); // the open-frame's own rAF: setOpen(true) fires here

  assert.equal(read().open, true, "sanity: now genuinely open");

  // Close. `close()` sets open=false and entrancePhase="idle" synchronously,
  // but leaves `mounted` true for LIVE_TRANSCRIPT_CLOSE_UNMOUNT_MS (320ms) so
  // the collapse animation can finish visually before the DOM node goes away.
  await React.act(async () => {
    read().close();
  });
  assert.equal(read().open, false);
  assert.equal(read().mounted, true, "sanity: still mounted mid-collapse — this is the 320ms window");

  // Reopen well inside that window (the coordinator's own repro used ~80ms).
  await reopen();

  assert.equal(read().mounted, true);
  assert.equal(read().open, false);
  assert.equal(read().entrancePhase, "encapsulate");
  assert.equal(
    read().freshMount,
    false,
    "mounted was already true before this open — not a real rest -> mounted transition, so the CSS snap-gate must not fire for it"
  );
});
