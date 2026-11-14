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

export interface HeldModifiers {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

type ModifierKeyEvent = Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/**
 * Modifiers held once this keydown lands. Chromium on X11 can leave the pressed
 * key's own modifier out of its flags (a MetaLeft keydown reports metaKey false
 * while ControlLeft reports ctrlKey true), so the field saw Ctrl+Meta as Ctrl
 * alone (#2750).
 */
export function heldModifiersAfterKeyDown(e: ModifierKeyEvent): HeldModifiers {
  const pressed = (stem: string) => e.code === `${stem}Left` || e.code === `${stem}Right`;
  return {
    ctrl: e.ctrlKey || pressed("Control"),
    meta: e.metaKey || pressed("Meta"),
    alt: e.altKey || pressed("Alt"),
    shift: e.shiftKey || pressed("Shift"),
  };
}
