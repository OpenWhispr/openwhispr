// Shared voice-surface geometry. windowConfig.js (main) sizes the native
// window from it; the renderer's DictationErrorCard and presentation helpers
// must agree with it or the error card never reports its height and the
// pill-to-panel clip origin drifts.
const geometry = require("./voiceSurfaceGeometry.json");

const ASSISTANT_PANEL_SIZE_LIMITS = Object.freeze(geometry.ASSISTANT_PANEL_SIZE_LIMITS);
const LIVE_TRANSCRIPT_SURFACE_LIMITS = Object.freeze(geometry.LIVE_TRANSCRIPT_SURFACE_LIMITS);

module.exports = { ASSISTANT_PANEL_SIZE_LIMITS, LIVE_TRANSCRIPT_SURFACE_LIMITS };
