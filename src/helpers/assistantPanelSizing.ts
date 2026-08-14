export const ASSISTANT_PANEL_RATIO = { width: 442, height: 538 } as const;
export const ASSISTANT_PANEL_GUTTER = 24;
export const ASSISTANT_PANEL_MIN_WIDTH = 360;
export const ASSISTANT_PANEL_MAX_WIDTH = 600;

const ratio = ASSISTANT_PANEL_RATIO.width / ASSISTANT_PANEL_RATIO.height;

export const ASSISTANT_PANEL_MIN_HEIGHT = Math.round(ASSISTANT_PANEL_MIN_WIDTH / ratio);
export const ASSISTANT_PANEL_MAX_HEIGHT = Math.round(ASSISTANT_PANEL_MAX_WIDTH / ratio);

export interface AssistantPanelSize {
  surfaceWidth: number;
  surfaceHeight: number;
  windowWidth: number;
  windowHeight: number;
  isOverflowing: boolean;
}

/**
 * Convert the panel's natural content height into a ratio-preserving Electron
 * window size. The 24px window gutter accounts for the surface's `inset-3`.
 */
export function calculateAssistantPanelSize(naturalPanelHeight: number): AssistantPanelSize {
  const safeNaturalHeight = Number.isFinite(naturalPanelHeight)
    ? Math.max(0, Math.ceil(naturalPanelHeight))
    : ASSISTANT_PANEL_MIN_HEIGHT;
  const desiredHeight = Math.max(ASSISTANT_PANEL_MIN_HEIGHT, safeNaturalHeight);

  let surfaceWidth = Math.ceil(desiredHeight * ratio);
  surfaceWidth = Math.min(
    ASSISTANT_PANEL_MAX_WIDTH,
    Math.max(ASSISTANT_PANEL_MIN_WIDTH, surfaceWidth)
  );

  let surfaceHeight = Math.round(surfaceWidth / ratio);
  if (surfaceHeight < desiredHeight && surfaceWidth < ASSISTANT_PANEL_MAX_WIDTH) {
    surfaceWidth += 1;
    surfaceHeight = Math.round(surfaceWidth / ratio);
  }
  surfaceHeight = Math.min(ASSISTANT_PANEL_MAX_HEIGHT, surfaceHeight);

  return {
    surfaceWidth,
    surfaceHeight,
    windowWidth: surfaceWidth + ASSISTANT_PANEL_GUTTER,
    windowHeight: surfaceHeight + ASSISTANT_PANEL_GUTTER,
    isOverflowing: safeNaturalHeight > ASSISTANT_PANEL_MAX_HEIGHT,
  };
}
