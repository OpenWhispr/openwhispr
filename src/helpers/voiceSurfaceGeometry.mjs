import geometry from "./voiceSurfaceGeometry.json" with { type: "json" };

export const ASSISTANT_PANEL_SIZE_LIMITS = Object.freeze(geometry.ASSISTANT_PANEL_SIZE_LIMITS);
export const DICTATION_ERROR_SURFACE_LIMITS = Object.freeze(
  geometry.DICTATION_ERROR_SURFACE_LIMITS
);
export const LIVE_TRANSCRIPT_SURFACE_LIMITS = Object.freeze(
  geometry.LIVE_TRANSCRIPT_SURFACE_LIMITS
);
