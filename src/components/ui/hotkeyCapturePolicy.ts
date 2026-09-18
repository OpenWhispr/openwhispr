export const MODIFIER_ONLY_HOLD_THRESHOLD_MS = 200;

/**
 * DOM button values reserve 0 for left and 2 for right. The native listener
 * names middle and auxiliary buttons as MouseButton3 through MouseButton32.
 */
export function mouseButtonHotkeyFromDomButton(button: number): string | null {
  if (button === 1) return "MouseButton3";
  if (!Number.isInteger(button) || button < 3 || button > 31) return null;
  return `MouseButton${button + 1}`;
}

export function isCapturableDomMouseButton(button: number): boolean {
  return mouseButtonHotkeyFromDomButton(button) !== null;
}

export function hasMetModifierOnlyHoldThreshold(holdDurationMs: number): boolean {
  return holdDurationMs >= MODIFIER_ONLY_HOLD_THRESHOLD_MS;
}

export function shouldAcceptModifierOnlyCapture(hotkey: string, holdDurationMs: number): boolean {
  return hotkey.startsWith("Right") || hasMetModifierOnlyHoldThreshold(holdDurationMs);
}

export function shouldRestoreCaptureFocus(
  activeElement: Element | null,
  body: HTMLElement | null
): boolean {
  return activeElement === null || activeElement === body;
}
