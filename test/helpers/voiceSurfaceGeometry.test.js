const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const WINDOW_CONFIG_PATH = require.resolve("../../src/helpers/windowConfig.js");
const OVERRIDDEN_VOICE_SURFACE_GEOMETRY = `
  export const ASSISTANT_PANEL_SIZE_LIMITS = {
    ratioWidth: 500,
    ratioHeight: 625,
    gutter: 31,
    minSurfaceWidth: 300,
    minSurfaceHeight: 120,
    maxSurfaceWidth: 700,
  };
  export const DICTATION_ERROR_SURFACE_LIMITS = { minHeight: 88, maxHeight: 240 };
  export const LIVE_TRANSCRIPT_SURFACE_LIMITS = { minHeight: 91, maxHeight: 321 };
`;

function loadWindowConfigWithGeometry(assistantPanelSizeLimits) {
  const originalLoad = Module._load;
  Module._load = function loadWindowConfig(request, parent, isMain) {
    if (request === "./voiceSurfaceGeometry") {
      return {
        ASSISTANT_PANEL_SIZE_LIMITS: assistantPanelSizeLimits,
        DICTATION_ERROR_SURFACE_LIMITS: { minHeight: 88, maxHeight: 240 },
        LIVE_TRANSCRIPT_SURFACE_LIMITS: { minHeight: 91, maxHeight: 321 },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[WINDOW_CONFIG_PATH];

  try {
    return require(WINDOW_CONFIG_PATH);
  } finally {
    Module._load = originalLoad;
    delete require.cache[WINDOW_CONFIG_PATH];
  }
}

test("the main-process assistant window consumes the shared voice-surface geometry", () => {
  const windowConfig = loadWindowConfigWithGeometry({
    ratioWidth: 500,
    ratioHeight: 625,
    gutter: 31,
    minSurfaceWidth: 300,
    minSurfaceHeight: 120,
    maxSurfaceWidth: 700,
  });

  assert.deepEqual(windowConfig.WINDOW_SIZES.ASSISTANT, { width: 531, height: 656 });
});

test("the main and renderer geometry adapters agree with the native assistant footprint", async () => {
  const geometry = require("../../src/helpers/voiceSurfaceGeometry.js");
  const windowConfig = require(WINDOW_CONFIG_PATH);
  const rendererGeometry = await import("../../src/helpers/voiceSurfaceGeometry.mjs");

  assert.equal(
    windowConfig.WINDOW_SIZES.ASSISTANT.width,
    geometry.ASSISTANT_PANEL_SIZE_LIMITS.ratioWidth + geometry.ASSISTANT_PANEL_SIZE_LIMITS.gutter
  );
  assert.deepEqual(
    rendererGeometry.LIVE_TRANSCRIPT_SURFACE_LIMITS,
    geometry.LIVE_TRANSCRIPT_SURFACE_LIMITS
  );
  assert.deepEqual(
    rendererGeometry.DICTATION_ERROR_SURFACE_LIMITS,
    geometry.DICTATION_ERROR_SURFACE_LIMITS
  );
});

test("renderer presentation consumes the shared live-transcript geometry", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-voice-surface-geometry-test-",
    mockModules: {
      "/voiceSurfaceGeometry.mjs": OVERRIDDEN_VOICE_SURFACE_GEOMETRY,
    },
  });

  const presentation = await vite.ssrLoadModule("/helpers/voicePillPresentation.js");

  assert.deepEqual(presentation.LIVE_TRANSCRIPT_SURFACE_LIMITS, {
    minHeight: 91,
    maxHeight: 321,
  });
});

test("DictationErrorCard reports capped rendered height and exposes dismiss", async (t) => {
  const card = {
    getBoundingClientRect: () => ({ width: 500 }),
    offsetHeight: 120,
    scrollHeight: 900,
  };
  const reportedHeights = [];
  let dismissCount = 0;
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  installBrowserGlobals(t, {
    window: { screen: { availWidth: 1000, availHeight: 1000 } },
  });
  globalThis.__dictationErrorCard = card;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    globalThis.__dictationErrorCardCleanup?.();
    delete globalThis.__dictationErrorCard;
    delete globalThis.__dictationErrorCardCleanup;
    if (originalResizeObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = originalResizeObserver;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dictation-error-geometry-test-",
    noExternal: true,
    mockModules: {
      "react/jsx-dev-runtime": `
        export const Fragment = Symbol.for("react.fragment");
        export function jsxDEV(type, props, key) { return { type, props, key }; }
      `,
      "lucide-react": `
        export function RotateCcw() { return null; }
        export function ScrollText() { return null; }
        export function X() { return null; }
      `,
      react: `
        export function useLayoutEffect(effect) {
          globalThis.__dictationErrorCardCleanup = effect();
        }
        export function useRef(initialValue) {
          return { current: initialValue === null ? globalThis.__dictationErrorCard : initialValue };
        }
      `,
      "/voiceSurfaceGeometry.mjs": OVERRIDDEN_VOICE_SURFACE_GEOMETRY,
    },
  });
  const { DictationErrorCard } = await vite.ssrLoadModule(
    "/components/dictation/DictationErrorCard.tsx"
  );

  const rendered = DictationErrorCard({
    actions: [],
    onAction() {},
    onDismiss: () => {
      dismissCount += 1;
    },
    dismissLabel: "Dismiss",
    onPreferredHeightChange: (height) => reportedHeights.push(height),
  });

  const dismissButton = rendered.props.children.find((child) => child?.type === "button");
  dismissButton.props.onClick();

  assert.deepEqual(reportedHeights, [120]);
  assert.equal(dismissCount, 1);
});
