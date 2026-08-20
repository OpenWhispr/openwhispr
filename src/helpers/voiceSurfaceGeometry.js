// Shared voice-surface geometry. windowConfig.js (main) sizes the native
// window from it; the renderer's DictationErrorCard and presentation helpers
// must agree with it or the error card never reports its height and the
// pill-to-panel clip origin drifts.
const ASSISTANT_PANEL_SIZE_LIMITS = Object.freeze({
  ratioWidth: 442,
  ratioHeight: 538,
  gutter: 24,
  minSurfaceWidth: 360,
  minSurfaceHeight: 152,
  maxSurfaceWidth: 600,
});

const LIVE_TRANSCRIPT_SURFACE_LIMITS = Object.freeze({ minHeight: 152, maxHeight: 538 });

module.exports = { ASSISTANT_PANEL_SIZE_LIMITS, LIVE_TRANSCRIPT_SURFACE_LIMITS };
