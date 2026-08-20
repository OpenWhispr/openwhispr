const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { createRendererServer } = require("../lib/rendererTestHarness");

const WINDOW_CONFIG_PATH = require.resolve("../../src/helpers/windowConfig.js");

function loadWindowConfigWithGeometry(assistantPanelSizeLimits) {
  const originalLoad = Module._load;
  Module._load = function loadWindowConfig(request, parent, isMain) {
    if (request === "./voiceSurfaceGeometry") {
      return {
        ASSISTANT_PANEL_SIZE_LIMITS: assistantPanelSizeLimits,
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

test("the CommonJS geometry contract agrees with the native assistant footprint", async () => {
  const geometry = require("../../src/helpers/voiceSurfaceGeometry.js");
  const windowConfig = require(WINDOW_CONFIG_PATH);
  const rendererImport = await import("../../src/helpers/voiceSurfaceGeometry.js");

  assert.equal(
    windowConfig.WINDOW_SIZES.ASSISTANT.width,
    geometry.ASSISTANT_PANEL_SIZE_LIMITS.ratioWidth + geometry.ASSISTANT_PANEL_SIZE_LIMITS.gutter
  );
  assert.strictEqual(
    rendererImport.LIVE_TRANSCRIPT_SURFACE_LIMITS,
    geometry.LIVE_TRANSCRIPT_SURFACE_LIMITS
  );
});

test("renderer presentation consumes the shared live-transcript geometry", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-voice-surface-geometry-test-",
    mockModules: {
      "/voiceSurfaceGeometry": `
        export const ASSISTANT_PANEL_SIZE_LIMITS = {
          ratioWidth: 500,
          ratioHeight: 625,
          gutter: 31,
          minSurfaceWidth: 300,
          minSurfaceHeight: 120,
          maxSurfaceWidth: 700,
        };
        export const LIVE_TRANSCRIPT_SURFACE_LIMITS = { minHeight: 91, maxHeight: 321 };
      `,
    },
  });

  const presentation = await vite.ssrLoadModule("/helpers/voicePillPresentation.js");

  assert.deepEqual(presentation.LIVE_TRANSCRIPT_SURFACE_LIMITS, {
    minHeight: 91,
    maxHeight: 321,
  });
});
