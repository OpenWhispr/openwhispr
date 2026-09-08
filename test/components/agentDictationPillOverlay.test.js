// The Agent companion pill window (AgentDictationPillOverlay) hosts the SAME
// VoiceModePanelCore as the main window's App.jsx, so it needs the same two
// entrance props on it. Nothing in test/ mentioned this component before, and
// that blind spot is exactly how Task 4's rewrite of the shared surface's
// at-rest state regressed this window's Live Transcript entrance while the
// main window's stayed correct (Finding 1, final review 2026-09-08).
//
// Task 4 changed `.expanding-panel-surface`'s rest state from an invisible
// corner box to a VISIBLE 40px pill circle. Mounting Live Transcript now
// changes clip-path, opacity and transform at once, so it starts a transition
// FROM that circle — which the -open class then retargets mid-flight one
// requestAnimationFrame later. dictation-panel.css's snap-gate suppresses
// that one pre-open frame, but only when the shell carries BOTH
// data-panel-entrance-phase="encapsulate" AND data-panel-fresh-mount="true".
//
// This file mounts the REAL overlay (real useLiveTranscriptPanel, real
// VoiceModePanelCore, real ExpandingPanelShell — nothing on that path mocked)
// and drives it through the same preview IPC the main process uses, so it
// proves the attributes actually reach the rendered shell at the frames that
// matter. What it cannot prove is the browser's own cascade — that the gate
// then wins over the base rule and computes to transition-property: none. The
// CSS half is asserted from stylesheet text in voicePillStructure.test.js, and
// the cascade itself was checked in a real browser (see the fix report).
const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installInteractiveDom,
  findElement,
} = require("../lib/rendererTestHarness");

// installInteractiveDom's requestAnimationFrame runs its callback
// SYNCHRONOUSLY, which would carry openPanel() straight past the pre-open
// frame this file is about (mounted committed, `open` still false). A
// manually-flushable queue is the only way to stop on that frame. Installed
// AFTER installInteractiveDom so it wins. Same shape as the one
// test/hooks/useLiveTranscriptPanel.test.js uses for the hook alone.
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

// Lets the promise chain openPanel() awaits internally (`await
// requestHeight(...)`, backed here by an already-resolved promise) actually
// resume before the test inspects the DOM. A macrotask flush drains every
// queued microtask first, however many `await`s the real implementation
// chains.
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mountOverlay(t) {
  // t.after hooks run FIFO, so the unmount hook must register BEFORE
  // installBrowserGlobals/installInteractiveDom's own cleanup — otherwise
  // window/document are gone by the time root.unmount() runs.
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const previewListeners = {};
  const subscribe = (key) => (callback) => {
    previewListeners[key] = callback;
    return () => {
      delete previewListeners[key];
    };
  };
  const electronAPI = {
    onPreviewText: subscribe("text"),
    onPreviewAppend: subscribe("append"),
    onPreviewHold: subscribe("hold"),
    onPreviewResult: subscribe("result"),
    onPreviewHide: subscribe("hide"),
    onAgentDictationPillStateChanged: subscribe("state"),
    onAgentDictationPillAudioLevelChanged: subscribe("audio"),
    onAgentDictationPillWillHide: subscribe("willHide"),
    onAgentDictationPillWillShow: subscribe("willShow"),
    onAgentDictationPillFinalTranscript: subscribe("final"),
    getAgentDictationPillState: async () => ({
      lifecycle: "recording",
      interactive: true,
      horizontalDirection: "left",
    }),
    resizeAgentDictationPillToContent: async () => ({ success: true, changed: false }),
    setAgentDictationPillInteractivity: async () => {},
  };

  installBrowserGlobals(t, {
    window: {
      electronAPI,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      innerHeight: 800,
    },
  });
  const container = installInteractiveDom(t);
  const raf = installControllableRaf(t);
  // ExpandingPanelShell observes the shell once the panel is OPEN. Nothing
  // here drives a real layout, so these only have to exist.
  class NoopObserver {
    observe() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = NoopObserver;
  globalThis.MutationObserver = NoopObserver;
  t.after(() => {
    delete globalThis.ResizeObserver;
    delete globalThis.MutationObserver;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-agent-dictation-pill-overlay-test-",
    mockModules: {
      "lucide-react": `
        import React from "react";
        const Icon = () => React.createElement("span");
        export const Check = Icon;
        export const ChevronDown = Icon;
        export const ChevronUp = Icon;
        export const Copy = Icon;
        export const X = Icon;
      `,
    },
  });
  const { default: AgentDictationPillOverlay } = await vite.ssrLoadModule(
    "/components/dictation/AgentDictationPillOverlay.tsx"
  );

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(AgentDictationPillOverlay));
  });

  const panelShell = () =>
    findElement(container, (node) => node.getAttribute?.("data-panel-mode") !== null);

  return { container, previewListeners, raf, panelShell };
}

test("the companion window's Live Transcript reaches its pre-open frame carrying BOTH snap-gate attributes", async (t) => {
  const { previewListeners, panelShell } = await mountOverlay(t);

  assert.equal(panelShell(), null, "sanity: nothing is mounted before a transcript arrives");

  await React.act(async () => {
    previewListeners.text("hello there");
  });
  await flushMicrotasks();
  await React.act(async () => {});

  const shell = panelShell();
  assert.ok(shell, "a preview transcript must mount the shared panel surface");
  assert.equal(shell.getAttribute("data-panel-mode"), "live-transcript");
  assert.ok(
    !shell.getAttribute("class").includes("expanding-panel-surface-open"),
    "sanity: this is the pre-open frame — mounted committed, `open` still one rAF away"
  );
  assert.equal(
    shell.getAttribute("data-panel-entrance-phase"),
    "encapsulate",
    "without this the snap-gate cannot match and the entrance starts from the visible pill circle"
  );
  assert.equal(
    shell.getAttribute("data-panel-fresh-mount"),
    "true",
    "the gate requires the fresh-mount tag too; entrance-phase alone also matches a mid-collapse reopen"
  );
});

test("the companion window's Live Transcript opens one rAF after that frame, which is what ends the gate", async (t) => {
  const { previewListeners, raf, panelShell } = await mountOverlay(t);

  await React.act(async () => {
    previewListeners.text("hello there");
  });
  await flushMicrotasks();
  await React.act(async () => {});
  await raf.flush();

  const shell = panelShell();
  assert.ok(shell, "the panel surface stays mounted through the entrance");
  assert.ok(
    shell.getAttribute("class").includes("expanding-panel-surface-open"),
    "one rAF later the real entrance is running"
  );
  // The gate's selector carries :not(.expanding-panel-surface-open), so the
  // attributes may legitimately still be present here — what must be true is
  // that the surface is now open, which is what takes the gate out of play.
  assert.equal(shell.getAttribute("data-panel-mode"), "live-transcript");
});

test("closing the companion window's Live Transcript does NOT carry the fresh-mount phase", async (t) => {
  const { previewListeners, raf, panelShell } = await mountOverlay(t);

  await React.act(async () => {
    previewListeners.text("hello there");
  });
  await flushMicrotasks();
  await React.act(async () => {});
  await raf.flush();

  await React.act(async () => {
    previewListeners.hide();
  });

  const shell = panelShell();
  assert.ok(shell, "close() keeps the surface mounted so its collapse can finish visually");
  assert.equal(shell.getAttribute("data-panel-mode"), "live-transcript");
  assert.ok(
    !shell.getAttribute("class").includes("expanding-panel-surface-open"),
    "closing reaches the same mode + not-open combination the fresh mount does",
  );
  assert.notEqual(
    shell.getAttribute("data-panel-entrance-phase"),
    "encapsulate",
    "a closing panel must keep animating — snapping it would silence its own collapse"
  );
});
