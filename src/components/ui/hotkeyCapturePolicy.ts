export const MODIFIER_ONLY_HOLD_THRESHOLD_MS = 200;

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
